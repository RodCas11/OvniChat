import {
  generateIdentityKeyPair,
  signWithIdentityKey,
  type IdentityKeyPair,
} from '@disco-voador/identity';
import { buildIdentityAuthPayload, CURRENT_PROTOCOL_VERSION } from '@disco-voador/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

import type { RealtimeConfig } from '../../services/realtime/src/config.js';
import {
  createRealtimeServer,
  type RealtimeServerHandle,
} from '../../services/realtime/src/server.js';

/**
 * These tests start a real `RealtimeServer` bound to an ephemeral localhost port and drive it
 * with real `ws` `WebSocket` clients over the actual network stack — no mocked transport. Every
 * server referenced here is created and stopped within a single test via `beforeEach`/`afterEach`
 * so no listening socket, timer, or open client connection survives past its own test.
 */

const DEFAULT_TEST_CONFIG: RealtimeConfig = {
  host: '127.0.0.1',
  port: 0,
  maxConnections: 100,
  maxMessageBytes: 16 * 1024,
  handshakeTimeoutMs: 300,
  identityChallengeTtlMs: 300,
  heartbeatIntervalMs: 60_000,
  heartbeatTimeoutMs: 60_000,
  rateLimit: { maxMessages: 100, windowMs: 10_000 },
  chatSendRateLimit: { maxMessages: 100, windowMs: 10_000 },
  chatHistoryRateLimit: { maxMessages: 100, windowMs: 10_000 },
  logLevel: 'error',
};

function testConfig(overrides: Partial<RealtimeConfig> = {}): RealtimeConfig {
  return { ...DEFAULT_TEST_CONFIG, ...overrides };
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for a message')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
    });
  });
}

function nextClose(ws: WebSocket, timeoutMs = 2000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for close')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
}

/**
 * Collects the next `count` messages in arrival order. Unlike chaining separate `nextMessage()`
 * calls, the listener is attached once, synchronously, before returning — necessary whenever the
 * server may send several messages back-to-back (e.g. `server:hello` immediately followed by
 * `voice:catalog`) without waiting on anything from the client in between, since two chained
 * `await nextMessage(ws)` calls would risk missing the second message in the gap between them.
 */
function nextMessages(
  ws: WebSocket,
  count: number,
  timeoutMs = 2000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const collected: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      ws.off('message', handleMessage);
      reject(
        new Error(
          `Timed out waiting for ${String(count)} messages (got ${String(collected.length)})`,
        ),
      );
    }, timeoutMs);

    function handleMessage(data: Buffer): void {
      collected.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
      if (collected.length >= count) {
        clearTimeout(timer);
        ws.off('message', handleMessage);
        resolve(collected);
      }
    }

    ws.on('message', handleMessage);
  });
}

let helloCounter = 0;
function helloMessage(
  overrides: Record<string, unknown> = {},
  keyPair: IdentityKeyPair = generateIdentityKeyPair(),
): Record<string, unknown> {
  helloCounter += 1;
  return {
    type: 'client:hello',
    id: `hello-${String(helloCounter)}`,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    client: { name: 'integration-test', version: '0.0.0' },
    nickname: 'Tester',
    publicKey: keyPair.publicKey,
    ...overrides,
  };
}

/** Signs and sends a `client:identity-proof` answering the just-received `server:identity-challenge`. */
function sendIdentityProof(
  ws: WebSocket,
  challenge: Record<string, unknown>,
  keyPair: IdentityKeyPair,
  fields: { protocolVersion: number; nickname: string },
): void {
  const payload = buildIdentityAuthPayload({
    protocolVersion: fields.protocolVersion,
    connectionId: challenge['connectionId'] as string,
    nonce: challenge['nonce'] as string,
    expiresAt: challenge['expiresAt'] as number,
    publicKey: keyPair.publicKey,
    nickname: fields.nickname,
  });
  const signature = signWithIdentityKey(keyPair.privateKey, keyPair.publicKey, payload);
  ws.send(JSON.stringify({ type: 'client:identity-proof', id: 'identity-proof-1', signature }));
}

/**
 * Drives the full T7/T9 handshake — `client:hello` -> `server:identity-challenge` ->
 * `client:identity-proof` -> `server:hello` + `server:authorization-state` + `voice:catalog` —
 * against an already-open socket, using a freshly generated local identity unless one is
 * supplied. Returns what a real client would learn from it: its own `connectionId` and the
 * server-derived `identityId`.
 */
async function handshake(
  ws: WebSocket,
  overrides: Record<string, unknown> = {},
  keyPair: IdentityKeyPair = generateIdentityKeyPair(),
): Promise<{ connectionId: string; identityId: string }> {
  const hello = helloMessage(overrides, keyPair);

  const challengeReceived = nextMessage(ws);
  ws.send(JSON.stringify(hello));
  const challenge = await challengeReceived;

  const readyReplies = nextMessages(ws, 3); // server:hello, server:authorization-state, voice:catalog
  sendIdentityProof(ws, challenge, keyPair, {
    protocolVersion: hello['protocolVersion'] as number,
    nickname: hello['nickname'] as string,
  });
  const [serverHello] = await readyReplies;

  return {
    connectionId: serverHello?.['connectionId'] as string,
    identityId: serverHello?.['identityId'] as string,
  };
}

let joinCounter = 0;
function joinMessage(channelId: string, displayName: string): Record<string, unknown> {
  joinCounter += 1;
  return { type: 'voice:join', id: `join-${String(joinCounter)}`, channelId, displayName };
}

interface ConnectedClient {
  readonly ws: WebSocket;
  readonly connectionId: string;
}

async function connectAndHandshake(url: string): Promise<ConnectedClient> {
  const ws = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  const { connectionId } = await handshake(ws);
  return { ws, connectionId };
}

async function joinChannel(
  ws: WebSocket,
  channelId: string,
  displayName: string,
): Promise<{ participantId: string; participants: unknown[] }> {
  const response = nextMessage(ws);
  ws.send(JSON.stringify(joinMessage(channelId, displayName)));
  const joined = await response;
  return {
    participantId: joined['participantId'] as string,
    participants: joined['participants'] as unknown[],
  };
}

describe('realtime server integration (real sockets)', () => {
  let server: RealtimeServerHandle;
  let url: string;
  const openSockets: WebSocket[] = [];

  beforeEach(async () => {
    server = createRealtimeServer(testConfig());
    const address = await server.start();
    url = `ws://${address.host}:${String(address.port)}`;
  });

  afterEach(async () => {
    for (const ws of openSockets.splice(0)) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.terminate();
    }
    await server.stop();
  });

  function track(ws: WebSocket): WebSocket {
    openSockets.push(ws);
    return ws;
  }

  it('starts and binds to a real, non-zero ephemeral port', () => {
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+$/);
    expect(url.endsWith(':0')).toBe(false);
  });

  it('completes a handshake: hello -> identity-challenge -> identity-proof -> server:hello with a connection id, identityId, and matching protocol version', async () => {
    const ws = track(await connect(url));
    const keyPair = generateIdentityKeyPair();
    const hello = helloMessage({}, keyPair);

    const challengeReceived = nextMessage(ws);
    ws.send(JSON.stringify(hello));
    const challenge = await challengeReceived;
    expect(challenge).toMatchObject({ type: 'server:identity-challenge' });

    const helloReplies = nextMessages(ws, 2);
    sendIdentityProof(ws, challenge, keyPair, {
      protocolVersion: hello['protocolVersion'] as number,
      nickname: hello['nickname'] as string,
    });
    const [response] = await helloReplies;

    expect(response).toMatchObject({
      type: 'server:hello',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
    });
    expect(typeof response?.['connectionId']).toBe('string');
    expect((response?.['connectionId'] as string).length).toBeGreaterThan(0);
    expect(response?.['identityId']).toMatch(/^dv1_[A-Za-z0-9_-]{43}$/u);
  });

  it('gives two independently-connected clients distinct connection ids and identity ids', async () => {
    const wsA = track(await connect(url));
    const wsB = track(await connect(url));

    const [resultA, resultB] = await Promise.all([handshake(wsA), handshake(wsB)]);

    expect(resultA.connectionId).not.toBe(resultB.connectionId);
    expect(resultA.identityId).not.toBe(resultB.identityId);
  });

  it('gives the same local identity the same identityId across two separate connections', async () => {
    const keyPair = generateIdentityKeyPair();
    const wsA = track(await connect(url));
    const wsB = track(await connect(url));

    const resultA = await handshake(wsA, {}, keyPair);
    const resultB = await handshake(wsB, {}, keyPair);

    expect(resultA.connectionId).not.toBe(resultB.connectionId);
    expect(resultA.identityId).toBe(resultB.identityId);
  });

  it('keeps the same identityId across a nickname change and reconnect (nickname is not identity)', async () => {
    const keyPair = generateIdentityKeyPair();

    const wsBeforeRename = track(await connect(url));
    const before = await handshake(wsBeforeRename, { nickname: 'Alice' }, keyPair);
    wsBeforeRename.close(1000, 'switching nickname');

    const wsAfterRename = track(await connect(url));
    const after = await handshake(wsAfterRename, { nickname: 'Bob' }, keyPair);

    // A new connection naturally gets a new connectionId — only identityId is expected to stay
    // fixed; no new keypair was ever generated for the nickname change.
    expect(before.connectionId).not.toBe(after.connectionId);
    expect(after.identityId).toBe(before.identityId);
  });

  it('answers client:ping with server:pong echoing the same id', async () => {
    const ws = track(await connect(url));
    await handshake(ws);

    const pongResponse = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'client:ping', id: 'ping-xyz' }));
    expect(await pongResponse).toEqual({ type: 'server:pong', id: 'ping-xyz' });
  });

  it('removes the connection once the client disconnects', async () => {
    const ws = track(await connect(url));
    await handshake(ws);
    expect(server.connectionCount).toBe(1);

    const closed = nextClose(ws);
    ws.close(1000, 'done');
    await closed;

    // The client observes its own 'close' event as soon as its side of the close handshake
    // finishes, which is not guaranteed to be strictly after the server has finished removing
    // the connection from its own tracking map — poll briefly rather than assuming instant
    // ordering between the two sides.
    await vi.waitFor(() => expect(server.connectionCount).toBe(0), { timeout: 1000 });
  });

  it('stops cleanly: tracked connections are closed with a defined code', async () => {
    const ws = track(await connect(url));
    await handshake(ws);

    const closed = nextClose(ws);
    await server.stop();
    const { code } = await closed;
    expect(code).toBe(1001);
  });

  it('T8: an injected voiceChannels/serverMetadata dependency is used instead of the defaults', async () => {
    const injected = createRealtimeServer(testConfig(), {
      voiceChannels: [{ channelId: 'lobby', name: 'Lobby' }],
      serverMetadata: { name: 'Injected Server', capabilities: ['voice'] },
    });
    const address = await injected.start();
    const injectedUrl = `ws://${address.host}:${String(address.port)}`;

    const ws = track(await connect(injectedUrl));
    const keyPair = generateIdentityKeyPair();
    const hello = helloMessage({}, keyPair);

    const challengeReceived = nextMessage(ws);
    ws.send(JSON.stringify(hello));
    const challenge = await challengeReceived;

    const helloAndCatalog = nextMessages(ws, 3);
    sendIdentityProof(ws, challenge, keyPair, {
      protocolVersion: hello['protocolVersion'] as number,
      nickname: hello['nickname'] as string,
    });
    const [serverHello, , catalog] = await helloAndCatalog;

    expect(serverHello).toMatchObject({
      type: 'server:hello',
      serverName: 'Injected Server',
      serverCapabilities: ['voice'],
    });
    expect(catalog).toMatchObject({
      type: 'voice:catalog',
      channels: [{ channelId: 'lobby', name: 'Lobby' }],
    });

    await injected.stop();
  });

  describe('heartbeat liveness (real sockets)', () => {
    // The shared `server`/`url` from the outer `beforeEach` use a deliberately inert heartbeat
    // (60s interval/timeout) so the other tests in this file are not affected by it. These two
    // tests spin up their own dedicated server with a short heartbeat so the real wire-level
    // protocol-level ping/pong path — as opposed to `HeartbeatMonitor`'s unit tests, which only
    // exercise it via directly-injected callbacks, never a real socket — is actually proven.
    it('keeps a responsive real client connected across multiple heartbeat cycles', async () => {
      const beating = createRealtimeServer(
        testConfig({ heartbeatIntervalMs: 40, heartbeatTimeoutMs: 40 }),
      );
      const address = await beating.start();
      const ws = track(await connect(`ws://${address.host}:${String(address.port)}`));
      await handshake(ws);

      // `ws` auto-responds to protocol-level pings by default (no application code involved);
      // wait through several heartbeat cycles and confirm the server never declared it dead.
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(ws.readyState).toBe(ws.OPEN);
      expect(beating.connectionCount).toBe(1);
      await beating.stop();
    });

    it('terminates a real client that never answers a protocol-level ping', async () => {
      const beating = createRealtimeServer(
        testConfig({ heartbeatIntervalMs: 40, heartbeatTimeoutMs: 40 }),
      );
      const address = await beating.start();
      const beatingUrl = `ws://${address.host}:${String(address.port)}`;
      const ws = track(
        await new Promise<WebSocket>((resolve, reject) => {
          // `autoPong: false` disables the client's automatic protocol-level pong response, so
          // this real socket genuinely never answers the server's heartbeat ping.
          const client = new WebSocket(beatingUrl, { autoPong: false });
          client.once('open', () => resolve(client));
          client.once('error', reject);
        }),
      );
      await handshake(ws);

      const closed = nextClose(ws, 2000);
      await closed;
      expect(ws.readyState).toBe(ws.CLOSED);
      await beating.stop();
    });
  });

  describe('hostile/invalid clients', () => {
    it('rejects malformed JSON with an INVALID_MESSAGE error and closes 4400; server stays healthy', async () => {
      const bad = track(await connect(url));
      const errorMessage = nextMessage(bad);
      const closed = nextClose(bad);
      bad.send('{not valid json');

      const error = await errorMessage;
      expect(error).toMatchObject({ type: 'server:error', code: 'INVALID_MESSAGE' });
      expect((await closed).code).toBe(4400);

      const good = track(await connect(url));
      const { connectionId } = await handshake(good);
      expect(connectionId.length).toBeGreaterThan(0);
    });

    it('rejects an unknown message type with INVALID_MESSAGE and closes 4400', async () => {
      const ws = track(await connect(url));
      const closed = nextClose(ws);
      ws.send(JSON.stringify({ type: 'client:unknown', id: 'x' }));
      expect((await closed).code).toBe(4400);
    });

    it('rejects a message missing required fields with INVALID_MESSAGE and closes 4400', async () => {
      const ws = track(await connect(url));
      const closed = nextClose(ws);
      ws.send(JSON.stringify({ type: 'client:hello', id: 'x' }));
      expect((await closed).code).toBe(4400);
    });

    it('rejects a wrong-typed field with INVALID_MESSAGE and closes 4400', async () => {
      const ws = track(await connect(url));
      const closed = nextClose(ws);
      ws.send(JSON.stringify(helloMessage({ protocolVersion: 'one' })));
      expect((await closed).code).toBe(4400);
    });

    it('rejects an unsupported protocol version with UNSUPPORTED_PROTOCOL and closes 4401', async () => {
      const ws = track(await connect(url));
      const errorMessage = nextMessage(ws);
      const closed = nextClose(ws);
      ws.send(JSON.stringify(helloMessage({ protocolVersion: 999 })));

      expect(await errorMessage).toMatchObject({
        type: 'server:error',
        code: 'UNSUPPORTED_PROTOCOL',
      });
      expect((await closed).code).toBe(4401);
    });

    it('rejects a message sent before hello with HANDSHAKE_REQUIRED and closes 4402', async () => {
      const ws = track(await connect(url));
      const closed = nextClose(ws);
      ws.send(JSON.stringify({ type: 'client:ping', id: 'too-early' }));
      expect((await closed).code).toBe(4402);
    });

    it('rejects an identity-proof with no outstanding challenge with IDENTITY_PROTOCOL_ERROR and closes 4413', async () => {
      const ws = track(await connect(url));
      const closed = nextClose(ws);
      ws.send(
        JSON.stringify({ type: 'client:identity-proof', id: 'p1', signature: 'A'.repeat(86) }),
      );
      expect((await closed).code).toBe(4413);
    });

    it('closes a connection that never sends hello with HANDSHAKE_TIMEOUT (4403)', async () => {
      const ws = track(await connect(url));
      const closed = nextClose(ws, 2000);
      expect((await closed).code).toBe(4403);
    });

    it('closes a connection that sends hello but never answers the identity challenge with HANDSHAKE_TIMEOUT (4403)', async () => {
      const ws = track(await connect(url));
      const challengeReceived = nextMessage(ws);
      ws.send(JSON.stringify(helloMessage()));
      await challengeReceived;

      const closed = nextClose(ws, 2000);
      expect((await closed).code).toBe(4403);
    });

    it('rejects a duplicate hello after ready with UNEXPECTED_MESSAGE and closes 4404', async () => {
      const ws = track(await connect(url));
      await handshake(ws);

      const closed = nextClose(ws);
      ws.send(JSON.stringify(helloMessage()));
      expect((await closed).code).toBe(4404);
    });

    it('rejects a signature from the wrong private key with IDENTITY_INVALID_SIGNATURE and closes 4411', async () => {
      const ws = track(await connect(url));
      const claimedKeyPair = generateIdentityKeyPair();
      const attackerKeyPair = generateIdentityKeyPair();
      const hello = helloMessage({}, claimedKeyPair);

      const challengeReceived = nextMessage(ws);
      ws.send(JSON.stringify(hello));
      const challenge = await challengeReceived;

      const closed = nextClose(ws);
      sendIdentityProof(ws, challenge, attackerKeyPair, {
        protocolVersion: hello['protocolVersion'] as number,
        nickname: hello['nickname'] as string,
      });
      expect((await closed).code).toBe(4411);
    });

    it('closes an oversized frame with the standard 1009 code', async () => {
      const ws = track(await connect(url));
      const closed = nextClose(ws);
      const oversizedHello = helloMessage({
        client: { name: 'x'.repeat(64 * 1024), version: '0.0.0' },
      });
      ws.send(JSON.stringify(oversizedHello));
      expect((await closed).code).toBe(1009);
    });

    it('rejects a binary frame with INVALID_MESSAGE and closes 4400', async () => {
      const ws = track(await connect(url));
      const closed = nextClose(ws);
      ws.send(Buffer.from([1, 2, 3, 4]));
      expect((await closed).code).toBe(4400);
    });

    it('rejects a client that floods past the per-connection rate limit', async () => {
      // The limit must be large enough to complete a real handshake (hello + identity-proof, 2
      // incoming messages) before the flood begins, or the connection would be closed for an
      // unrelated reason (HANDSHAKE_REQUIRED) before the flood ever has a chance to trip the
      // rate limiter.
      const limited = createRealtimeServer(
        testConfig({ rateLimit: { maxMessages: 4, windowMs: 10_000 } }),
      );
      const address = await limited.start();
      const limitedWs = track(await connect(`ws://${address.host}:${String(address.port)}`));
      await handshake(limitedWs); // consumes 2 of the 4 allowed messages

      const closed = nextClose(limitedWs);
      limitedWs.send(JSON.stringify({ type: 'client:ping', id: 'p1' })); // 3/4
      limitedWs.send(JSON.stringify({ type: 'client:ping', id: 'p2' })); // 4/4
      limitedWs.send(JSON.stringify({ type: 'client:ping', id: 'p3' })); // 5th exceeds the limit

      expect((await closed).code).toBe(4429);
      await limited.stop();
    });

    it('rejects a new connection once REALTIME_MAX_CONNECTIONS is reached, without disturbing existing connections', async () => {
      const capped = createRealtimeServer(testConfig({ maxConnections: 1 }));
      const address = await capped.start();
      const cappedUrl = `ws://${address.host}:${String(address.port)}`;

      const first = track(await connect(cappedUrl));
      await handshake(first);
      expect(capped.connectionCount).toBe(1);

      // Unlike every other hostile-client case in this file, the server reacts as soon as the
      // connection opens rather than waiting for the client to send something first — so there is
      // no guarantee the client is idle long enough for `connect()` (which resolves on 'open',
      // requiring an extra microtask hop) to return before the rejection message/close arrive.
      // Attach listeners synchronously on the socket itself, before yielding control at all.
      const second = track(new WebSocket(cappedUrl));
      const secondErrorMessage = nextMessage(second);
      const secondClosed = nextClose(second);

      expect(await secondErrorMessage).toMatchObject({
        type: 'server:error',
        code: 'SERVER_AT_CAPACITY',
      });
      expect((await secondClosed).code).toBe(4503);

      // Rejecting the second connection must not have touched the first, and must not itself
      // count toward connectionCount (it was never tracked).
      expect(capped.connectionCount).toBe(1);
      const pingResponse = nextMessage(first);
      first.send(JSON.stringify({ type: 'client:ping', id: 'still-alive' }));
      expect(await pingResponse).toEqual({ type: 'server:pong', id: 'still-alive' });

      await capped.stop();
    });

    it('server remains healthy after a sequence of different hostile clients', async () => {
      const malformed = track(await connect(url));
      const malformedClosed = nextClose(malformed);
      malformed.send('not json');
      await malformedClosed;

      const wrongVersion = track(await connect(url));
      const wrongVersionClosed = nextClose(wrongVersion);
      wrongVersion.send(JSON.stringify(helloMessage({ protocolVersion: 42 })));
      await wrongVersionClosed;

      const tooEarly = track(await connect(url));
      const tooEarlyClosed = nextClose(tooEarly);
      tooEarly.send(JSON.stringify({ type: 'client:ping', id: 'x' }));
      await tooEarlyClosed;

      const good = track(await connect(url));
      const { connectionId } = await handshake(good);
      expect(connectionId.length).toBeGreaterThan(0);
      expect(server.connectionCount).toBe(1);
    });
  });

  describe('voice channels and WebRTC signaling (real sockets)', () => {
    it('A and B join the same channel, learn about each other, and negotiate a full offer/answer/ICE exchange', async () => {
      const a = track((await connectAndHandshake(url)).ws);
      const b = track((await connectAndHandshake(url)).ws);

      const { participantId: participantIdA, participants: aSnapshot } = await joinChannel(
        a,
        'general',
        'Rodrigo',
      );
      expect(aSnapshot).toEqual([]);

      // Only start listening for "someone joined" now that A's own join reply is already
      // consumed — otherwise this listener could catch A's own reply instead.
      const bJoinedNotice = nextMessage(a);
      const { participantId: participantIdB, participants: bSnapshot } = await joinChannel(
        b,
        'general',
        'Arthur',
      );
      expect(bSnapshot).toEqual([
        { participantId: participantIdA, displayName: 'Rodrigo', groups: [] },
      ]);

      const notice = await bJoinedNotice;
      expect(notice).toMatchObject({
        type: 'voice:participant-joined',
        channelId: 'general',
        participant: { participantId: participantIdB, displayName: 'Arthur' },
      });

      // A (already present) initiates the offer toward B (the newcomer) — the deterministic
      // offer-ownership strategy documented in docs/architecture/WEBRTC_VOICE.md.
      const offerAtB = nextMessage(b);
      a.send(
        JSON.stringify({
          type: 'webrtc:offer',
          id: 'o1',
          targetParticipantId: participantIdB,
          sdp: 'v=0\r\no=- offer-from-a',
        }),
      );
      const offerReceived = await offerAtB;
      expect(offerReceived).toMatchObject({
        type: 'webrtc:offer',
        sourceParticipantId: participantIdA,
        sdp: 'v=0\r\no=- offer-from-a',
      });

      const answerAtA = nextMessage(a);
      b.send(
        JSON.stringify({
          type: 'webrtc:answer',
          id: 'a1',
          targetParticipantId: participantIdA,
          sdp: 'v=0\r\no=- answer-from-b',
        }),
      );
      const answerReceived = await answerAtA;
      expect(answerReceived).toMatchObject({
        type: 'webrtc:answer',
        sourceParticipantId: participantIdB,
        sdp: 'v=0\r\no=- answer-from-b',
      });

      const iceAtB = nextMessage(b);
      a.send(
        JSON.stringify({
          type: 'webrtc:ice-candidate',
          id: 'i1',
          targetParticipantId: participantIdB,
          candidate: { candidate: 'candidate:1 1 UDP 1 192.0.2.1 1 typ host' },
        }),
      );
      const iceReceived = await iceAtB;
      expect(iceReceived).toMatchObject({
        type: 'webrtc:ice-candidate',
        sourceParticipantId: participantIdA,
        candidate: { candidate: 'candidate:1 1 UDP 1 192.0.2.1 1 typ host' },
      });
    });

    it('a participant in one channel cannot signal a participant in another channel', async () => {
      const a = track((await connectAndHandshake(url)).ws);
      const c = track((await connectAndHandshake(url)).ws);

      await joinChannel(a, 'general', 'A');
      const { participantId: participantIdC } = await joinChannel(c, 'games', 'C');

      const errorAtA = nextMessage(a);
      a.send(
        JSON.stringify({
          type: 'webrtc:offer',
          id: 'o1',
          targetParticipantId: participantIdC,
          sdp: 'v=0',
        }),
      );
      const error = await errorAtA;
      expect(error).toMatchObject({ type: 'server:error', code: 'SIGNALING_TARGET_INVALID' });

      // Non-fatal: the connection must still be open and usable afterward.
      expect(a.readyState).toBe(a.OPEN);
      const pingResponse = nextMessage(a);
      a.send(JSON.stringify({ type: 'client:ping', id: 'still-open' }));
      expect(await pingResponse).toEqual({ type: 'server:pong', id: 'still-open' });
    });

    it('abrupt disconnect (no explicit voice:leave) removes the participant and notifies the remaining member', async () => {
      const a = track((await connectAndHandshake(url)).ws);
      const b = track((await connectAndHandshake(url)).ws);

      await joinChannel(a, 'general', 'A');
      const participantJoinedAtA = nextMessage(a);
      await joinChannel(b, 'general', 'B');
      await participantJoinedAtA; // drain A's notice that B joined, before listening for the next one

      const departureNoticeAtA = nextMessage(a);
      b.terminate(); // abrupt loss, not a clean close/leave

      const notice = await departureNoticeAtA;
      expect(notice).toMatchObject({ type: 'voice:participant-left', channelId: 'general' });

      // Server stays healthy: A can still signal against a channel snapshot with B truly gone.
      const rejoin = track((await connectAndHandshake(url)).ws);
      const { participants } = await joinChannel(rejoin, 'general', 'C');
      expect(participants).toHaveLength(1); // only A remains
    });

    it('switching channels notifies the old channel, joins the new one cleanly, and leaves no duplicate membership', async () => {
      const a = track((await connectAndHandshake(url)).ws);
      const b = track((await connectAndHandshake(url)).ws);

      await joinChannel(a, 'general', 'A');
      const participantJoinedAtA = nextMessage(a);
      await joinChannel(b, 'general', 'B');
      await participantJoinedAtA; // drain A's notice that B joined, before listening for the next one

      const switchNotice = nextMessage(b); // B should learn A left "general"
      await joinChannel(a, 'games', 'A'); // A switches general -> games

      const notice = await switchNotice;
      expect(notice).toMatchObject({ type: 'voice:participant-left', channelId: 'general' });

      // A is now only reachable via signaling from within "games", not "general".
      const cInGames = track((await connectAndHandshake(url)).ws);
      const { participants: gamesSnapshot } = await joinChannel(cInGames, 'games', 'C');
      expect(gamesSnapshot).toHaveLength(1); // A
    });

    it('supports three simultaneous participants in the same channel', async () => {
      const a = track((await connectAndHandshake(url)).ws);
      const b = track((await connectAndHandshake(url)).ws);
      const c = track((await connectAndHandshake(url)).ws);

      await joinChannel(a, 'general', 'A');
      await joinChannel(b, 'general', 'B');
      const { participants } = await joinChannel(c, 'general', 'C');

      expect(participants).toHaveLength(2);
      const names = (participants as { displayName: string }[]).map((p) => p.displayName).sort();
      expect(names).toEqual(['A', 'B']);
    });

    it('rejects voice:join for an unknown channel without closing the connection', async () => {
      const a = track((await connectAndHandshake(url)).ws);

      const errorAtA = nextMessage(a);
      a.send(JSON.stringify(joinMessage('does-not-exist', 'A')));
      expect(await errorAtA).toMatchObject({ type: 'server:error', code: 'CHANNEL_NOT_FOUND' });

      expect(a.readyState).toBe(a.OPEN);
    });

    it('rejects voice:leave and webrtc signaling when not currently in a voice channel', async () => {
      const a = track((await connectAndHandshake(url)).ws);

      const leaveError = nextMessage(a);
      a.send(JSON.stringify({ type: 'voice:leave', id: 'l1' }));
      expect(await leaveError).toMatchObject({
        type: 'server:error',
        code: 'NOT_IN_VOICE_CHANNEL',
      });

      const signalError = nextMessage(a);
      a.send(
        JSON.stringify({
          type: 'webrtc:offer',
          id: 'o1',
          targetParticipantId: 'whoever',
          sdp: 'v=0',
        }),
      );
      expect(await signalError).toMatchObject({
        type: 'server:error',
        code: 'NOT_IN_VOICE_CHANNEL',
      });

      expect(a.readyState).toBe(a.OPEN);
    });
  });
});
