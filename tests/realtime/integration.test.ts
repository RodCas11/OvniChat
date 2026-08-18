import { CURRENT_PROTOCOL_VERSION } from '@disco-voador/protocol';
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
  heartbeatIntervalMs: 60_000,
  heartbeatTimeoutMs: 60_000,
  rateLimit: { maxMessages: 100, windowMs: 10_000 },
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

let helloCounter = 0;
function helloMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  helloCounter += 1;
  return {
    type: 'client:hello',
    id: `hello-${String(helloCounter)}`,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    client: { name: 'integration-test', version: '0.0.0' },
    ...overrides,
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

  it('completes a handshake: hello -> server:hello with a connection id and matching protocol version', async () => {
    const ws = track(await connect(url));
    const helloResponse = nextMessage(ws);
    ws.send(JSON.stringify(helloMessage()));

    const response = await helloResponse;
    expect(response).toMatchObject({
      type: 'server:hello',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
    });
    expect(typeof response['connectionId']).toBe('string');
    expect((response['connectionId'] as string).length).toBeGreaterThan(0);
  });

  it('gives two independently-connected clients distinct connection ids', async () => {
    const wsA = track(await connect(url));
    const wsB = track(await connect(url));

    const helloA = nextMessage(wsA);
    const helloB = nextMessage(wsB);
    wsA.send(JSON.stringify(helloMessage()));
    wsB.send(JSON.stringify(helloMessage()));

    const [responseA, responseB] = await Promise.all([helloA, helloB]);
    expect(responseA['connectionId']).not.toBe(responseB['connectionId']);
  });

  it('answers client:ping with server:pong echoing the same id', async () => {
    const ws = track(await connect(url));
    const helloResponse = nextMessage(ws);
    ws.send(JSON.stringify(helloMessage()));
    await helloResponse;

    const pongResponse = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'client:ping', id: 'ping-xyz' }));
    expect(await pongResponse).toEqual({ type: 'server:pong', id: 'ping-xyz' });
  });

  it('removes the connection once the client disconnects', async () => {
    const ws = track(await connect(url));
    const helloResponse = nextMessage(ws);
    ws.send(JSON.stringify(helloMessage()));
    await helloResponse;
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
    const helloResponse = nextMessage(ws);
    ws.send(JSON.stringify(helloMessage()));
    await helloResponse;

    const closed = nextClose(ws);
    await server.stop();
    const { code } = await closed;
    expect(code).toBe(1001);
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
      const helloResponse = nextMessage(ws);
      ws.send(JSON.stringify(helloMessage()));
      await helloResponse;

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
      const helloResponse = nextMessage(ws);
      ws.send(JSON.stringify(helloMessage()));
      await helloResponse;

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
      const helloResponse = nextMessage(good);
      good.send(JSON.stringify(helloMessage()));
      expect((await helloResponse)['type']).toBe('server:hello');
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

    it('closes a connection that never sends hello with HANDSHAKE_TIMEOUT (4403)', async () => {
      const ws = track(await connect(url));
      const closed = nextClose(ws, 2000);
      expect((await closed).code).toBe(4403);
    });

    it('rejects a duplicate hello after ready with UNEXPECTED_MESSAGE and closes 4404', async () => {
      const ws = track(await connect(url));
      const helloResponse = nextMessage(ws);
      ws.send(JSON.stringify(helloMessage()));
      await helloResponse;

      const closed = nextClose(ws);
      ws.send(JSON.stringify(helloMessage()));
      expect((await closed).code).toBe(4404);
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
      const ws = track(await connect(url));
      // Use a dedicated server with a tiny limit so this test does not depend on the shared
      // default rate limit budget used by the handshake itself.
      const limited = createRealtimeServer(
        testConfig({ rateLimit: { maxMessages: 2, windowMs: 10_000 } }),
      );
      const address = await limited.start();
      const limitedWs = track(await connect(`ws://${address.host}:${String(address.port)}`));
      const closed = nextClose(limitedWs);

      limitedWs.send(JSON.stringify(helloMessage()));
      limitedWs.send(JSON.stringify({ type: 'client:ping', id: 'p1' }));
      limitedWs.send(JSON.stringify({ type: 'client:ping', id: 'p2' }));

      expect((await closed).code).toBe(4429);
      await limited.stop();
      ws.close();
    });

    it('rejects a new connection once REALTIME_MAX_CONNECTIONS is reached, without disturbing existing connections', async () => {
      const capped = createRealtimeServer(testConfig({ maxConnections: 1 }));
      const address = await capped.start();
      const cappedUrl = `ws://${address.host}:${String(address.port)}`;

      const first = track(await connect(cappedUrl));
      const firstHello = nextMessage(first);
      first.send(JSON.stringify(helloMessage()));
      await firstHello;
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
      const helloResponse = nextMessage(good);
      good.send(JSON.stringify(helloMessage()));
      expect((await helloResponse)['type']).toBe('server:hello');
      expect(server.connectionCount).toBe(1);
    });
  });
});
