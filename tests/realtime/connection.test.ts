import { EventEmitter } from 'node:events';

import { CURRENT_PROTOCOL_VERSION } from '@disco-voador/protocol';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';

import type { RealtimeConfig } from '../../services/realtime/src/config.js';
import { Connection } from '../../services/realtime/src/connection.js';
import { createNoopLogger } from '../../services/realtime/src/logging.js';
import { DEFAULT_VOICE_CHANNELS } from '../../services/realtime/src/voice/catalog.js';
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
      new VoiceRegistry(DEFAULT_VOICE_CHANNELS),
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
