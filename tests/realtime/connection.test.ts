import { EventEmitter } from 'node:events';

import {
  generateIdentityKeyPair,
  signWithIdentityKey,
  type IdentityKeyPair,
} from '@disco-voador/identity';
import {
  buildIdentityAuthPayload,
  CURRENT_PROTOCOL_VERSION,
  type ServerIdentityChallengeMessage,
  type ServerMessage,
  type ServerTurnCredentialsMessage,
} from '@disco-voador/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { createNoopAuthorizationPort } from '../../services/realtime/src/authorization-port.js';
import { createNoopChannelPort } from '../../services/realtime/src/channel-port.js';
import { createNoopChatPort } from '../../services/realtime/src/chat-port.js';
import type { RealtimeConfig } from '../../services/realtime/src/config.js';
import { Connection } from '../../services/realtime/src/connection.js';
import { createNoopLogger } from '../../services/realtime/src/logging.js';
import { PresenceRegistry } from '../../services/realtime/src/presence/registry.js';
import { createNoopProfilePort } from '../../services/realtime/src/profile-port.js';
import type { Logger } from '../../services/realtime/src/logging.js';
import {
  createNoopTurnCredentialPort,
  type TurnCredentialPort,
} from '../../services/realtime/src/turn-credential-port.js';
import { TemporaryChannelRegistry } from '../../services/realtime/src/voice/temporary-channels.js';
import { VoiceRegistry } from '../../services/realtime/src/voice/registry.js';

/**
 * A minimal stand-in for a `ws` `WebSocket` implementing only what `Connection` actually calls,
 * so the safety-net behavior below can be exercised without a real socket or server.
 */
class FakeSocket extends EventEmitter {
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSING = 2;
  readonly CLOSED = 3;
  readyState = 1;
  readonly sent: string[] = [];
  closedWith: { code: number; reason: string } | undefined;

  ping(): void {
    // no-op; heartbeat behavior is covered by the real-socket integration tests
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.closedWith = { code, reason };
    this.readyState = this.CLOSING;
  }

  terminate(): void {
    this.readyState = this.CLOSED;
  }
}

const TEST_CONFIG: RealtimeConfig = {
  host: '127.0.0.1',
  port: 0,
  maxConnections: 100,
  maxMessageBytes: 16 * 1024,
  handshakeTimeoutMs: 60_000,
  identityChallengeTtlMs: 60_000,
  heartbeatIntervalMs: 60_000,
  heartbeatTimeoutMs: 60_000,
  rateLimit: { maxMessages: 100, windowMs: 10_000 },
  chatSendRateLimit: { maxMessages: 100, windowMs: 10_000 },
  chatHistoryRateLimit: { maxMessages: 100, windowMs: 10_000 },
  channelPasswordRateLimit: { maxMessages: 100, windowMs: 10_000 },
  profileMutationRateLimit: { maxMessages: 100, windowMs: 10_000 },
  avatarFetchRateLimit: { maxMessages: 100, windowMs: 10_000 },
  logLevel: 'error',
};

describe('Connection — unexpected handler failure containment', () => {
  it('sends INTERNAL_ERROR and closes the connection instead of throwing, when a handler unexpectedly fails', () => {
    const socket = new FakeSocket();

    // The 1st call is Connection's own constructor (`connectedAt`); the 2nd is inside
    // `handleClientHello`'s response building, which is where we want the failure to surface.
    let callCount = 0;
    const now = (): Date => {
      callCount += 1;
      if (callCount === 1) return new Date('2026-08-18T00:00:00.000Z');
      throw new Error('boom: unexpected failure deep in handler logic');
    };

    const connection = new Connection(
      socket as unknown as WebSocket,
      TEST_CONFIG,
      createNoopLogger(),
      new VoiceRegistry(),
      { name: 'Test Server', capabilities: [] },
      createNoopAuthorizationPort(),
      createNoopChatPort(),
      createNoopChannelPort(),
      new TemporaryChannelRegistry(),
      createNoopProfilePort(),
      new PresenceRegistry(),
      createNoopTurnCredentialPort(),
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
      now,
    );

    const hello = JSON.stringify({
      type: 'client:hello',
      id: 'hello-1',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      client: { name: 'test', version: '0.0.0' },
      nickname: 'Alice',
      publicKey: 'A'.repeat(43),
    });

    expect(() => {
      socket.emit('message', Buffer.from(hello, 'utf8'), false);
    }).not.toThrow();

    expect(socket.sent).toHaveLength(1);
    const errorSent = JSON.parse(socket.sent[0] ?? '') as { message: string };
    expect(errorSent).toMatchObject({ type: 'server:error', code: 'INTERNAL_ERROR' });
    // The real exception message/stack must never reach the client — only the server log does.
    expect(errorSent.message).not.toContain('boom');

    expect(socket.closedWith).toEqual({ code: 4500, reason: 'INTERNAL_ERROR' });
    expect(connection.state).toBe('closing');
  });
});

describe('Connection — periodic TURN credential refresh (T15.2)', () => {
  const TTL_SECONDS = 21_600; // the shipped default: 6 hours
  const START = Date.parse('2026-08-25T00:00:00.000Z');
  /** These tests advance hours of fake time. The real heartbeat would fire hundreds of pings against
   * a `FakeSocket` that never pongs and terminate the connection long before the first refresh is
   * due, so it is pushed a week out — this suite is about the credential timer, not liveness. A week
   * and not a month, deliberately: a `setTimeout`/`setInterval` delay above 2^31-1 ms (~24.8 days)
   * overflows and fires on the next tick instead, which silently terminated this very connection on
   * the first attempt at writing this suite. It is the same hazard
   * `TURN_CREDENTIAL_REFRESH_MAX_DELAY_MS` exists to cap. */
  const NO_HEARTBEAT_CONFIG: RealtimeConfig = {
    ...TEST_CONFIG,
    heartbeatIntervalMs: 7 * 24 * 60 * 60 * 1_000,
    heartbeatTimeoutMs: 7 * 24 * 60 * 60 * 1_000,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * A stand-in for the Dedicated Server's real `mintTurnCredentials`, using the same
   * "username is the credential's own expiry in epoch seconds" convention so each successive mint is
   * observably distinct without this test ever needing a real shared secret.
   */
  function countingTurnPort(): TurnCredentialPort & { mintCount: number } {
    const port = {
      mintCount: 0,
      mint: () => {
        port.mintCount += 1;
        const expiryEpochSeconds = Math.floor(Date.now() / 1_000) + TTL_SECONDS;
        return {
          iceServers: [
            {
              urls: 'turn:turn.example.com:3478',
              username: String(expiryEpochSeconds),
              credential: `fake-credential-${port.mintCount}`,
            },
          ],
          expiresAt: new Date(expiryEpochSeconds * 1_000).toISOString(),
        };
      },
    };
    return port;
  }

  function capturingLogger(): Logger & { lines: string[] } {
    const lines: string[] = [];
    const record = (level: string) => (event: string, fields?: Record<string, unknown>) => {
      lines.push(`${level} ${event} ${JSON.stringify(fields ?? {})}`);
    };
    return {
      lines,
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    };
  }

  function makeConnection(
    turnCredentials: TurnCredentialPort,
    logger: Logger = createNoopLogger(),
  ): { socket: FakeSocket; connection: Connection } {
    const socket = new FakeSocket();
    const connection = new Connection(
      socket as unknown as WebSocket,
      NO_HEARTBEAT_CONFIG,
      logger,
      new VoiceRegistry(),
      { name: 'Test Server', capabilities: [] },
      createNoopAuthorizationPort(),
      createNoopChatPort(),
      createNoopChannelPort(),
      new TemporaryChannelRegistry(),
      createNoopProfilePort(),
      new PresenceRegistry(),
      turnCredentials,
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
      () => {},
      () => new Date(),
    );
    return { socket, connection };
  }

  /** Drives the real hello -> challenge -> identity-proof handshake so the connection genuinely
   * reaches `ready` through the same path production does — the refresh timer is armed by that
   * transition, so faking it would prove nothing. */
  function completeHandshake(
    socket: FakeSocket,
    connection: Connection,
    keyPair: IdentityKeyPair,
  ): void {
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'client:hello',
          id: 'hello-1',
          protocolVersion: CURRENT_PROTOCOL_VERSION,
          client: { name: 'test', version: '0.0.0' },
          nickname: 'Alice',
          publicKey: keyPair.publicKey,
        }),
        'utf8',
      ),
      false,
    );

    const challenge = JSON.parse(socket.sent[0] ?? '') as ServerIdentityChallengeMessage;
    const payload = buildIdentityAuthPayload({
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      connectionId: connection.id,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      publicKey: keyPair.publicKey,
      nickname: 'Alice',
    });
    socket.emit(
      'message',
      Buffer.from(
        JSON.stringify({
          type: 'client:identity-proof',
          id: 'proof-1',
          signature: signWithIdentityKey(keyPair.privateKey, keyPair.publicKey, payload),
        }),
        'utf8',
      ),
      false,
    );
  }

  function turnMessages(socket: FakeSocket): ServerTurnCredentialsMessage[] {
    return socket.sent
      .map((raw) => JSON.parse(raw) as ServerMessage)
      .filter(
        (message): message is ServerTurnCredentialsMessage =>
          message.type === 'server:turn-credentials',
      );
  }

  it('pushes a second credential set at half the first one’s lifetime, and keeps going', () => {
    const turn = countingTurnPort();
    const { socket, connection } = makeConnection(turn);
    completeHandshake(socket, connection, generateIdentityKeyPair());

    expect(turnMessages(socket)).toHaveLength(1);

    // Just before the halfway point of the 6-hour credential: still exactly one push.
    vi.advanceTimersByTime(3 * 60 * 60 * 1_000 - 1);
    expect(turnMessages(socket)).toHaveLength(1);

    vi.advanceTimersByTime(1);
    const afterFirstRefresh = turnMessages(socket);
    expect(afterFirstRefresh).toHaveLength(2);
    // A genuinely new credential, not a replay of the first — a replayed one would expire on the
    // original schedule and defeat the whole mechanism.
    expect(afterFirstRefresh[1]?.expiresAt).not.toBe(afterFirstRefresh[0]?.expiresAt);
    expect(afterFirstRefresh[1]?.iceServers[0]?.username).not.toBe(
      afterFirstRefresh[0]?.iceServers[0]?.username,
    );

    // The chain re-arms itself: another three hours, another push.
    vi.advanceTimersByTime(3 * 60 * 60 * 1_000);
    expect(turnMessages(socket)).toHaveLength(3);
  });

  it('uses the exact same message type and shape for a refresh as for the initial push', () => {
    const turn = countingTurnPort();
    const { socket, connection } = makeConnection(turn);
    completeHandshake(socket, connection, generateIdentityKeyPair());
    vi.advanceTimersByTime(3 * 60 * 60 * 1_000);

    const [first, second] = turnMessages(socket);
    expect(second?.type).toBe('server:turn-credentials');
    expect(Object.keys(second ?? {}).sort()).toEqual(Object.keys(first ?? {}).sort());
    // No protocol change was needed: an existing client consumes an Nth push with the same handler.
    expect(second?.iceServers[0]?.urls).toBe('turn:turn.example.com:3478');
  });

  it('never pushes or schedules anything when this server has no TURN configured', () => {
    let mintCalls = 0;
    const noopPort = createNoopTurnCredentialPort();
    const countedNoop: TurnCredentialPort = {
      mint: () => {
        mintCalls += 1;
        return noopPort.mint();
      },
    };
    const { socket, connection } = makeConnection(countedNoop);
    completeHandshake(socket, connection, generateIdentityKeyPair());
    vi.advanceTimersByTime(24 * 60 * 60 * 1_000);

    expect(turnMessages(socket)).toHaveLength(0);
    // Exactly the one mint the handshake itself performs — no refresh chain was ever armed.
    expect(mintCalls).toBe(1);
  });

  it('cancels the refresh chain when the socket closes — no timer outlives the connection', () => {
    const turn = countingTurnPort();
    const { socket, connection } = makeConnection(turn);
    completeHandshake(socket, connection, generateIdentityKeyPair());
    expect(turn.mintCount).toBe(1);

    socket.emit('close', 1000, Buffer.from('bye'));
    vi.advanceTimersByTime(24 * 60 * 60 * 1_000);

    expect(turn.mintCount).toBe(1);
    expect(turnMessages(socket)).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(connection.state).toBe('closed');
  });

  it('never logs a TURN username or credential when refreshing', () => {
    const turn = countingTurnPort();
    const logger = capturingLogger();
    const { socket, connection } = makeConnection(turn, logger);
    completeHandshake(socket, connection, generateIdentityKeyPair());
    vi.advanceTimersByTime(6 * 60 * 60 * 1_000);

    expect(turnMessages(socket).length).toBeGreaterThan(1);
    const allLogs = logger.lines.join('\n');
    expect(allLogs).toContain('turn_credentials_refreshed');
    expect(allLogs).not.toContain('fake-credential');
    for (const message of turnMessages(socket)) {
      const username = message.iceServers[0]?.username;
      if (username) expect(allLogs).not.toContain(username);
    }
  });
});
