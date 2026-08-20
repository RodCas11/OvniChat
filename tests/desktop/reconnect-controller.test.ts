import { CLOSE_CODES } from '@disco-voador/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** Mirrors `tests/desktop/realtime-client.test.ts`'s own `FakeWebSocket` exactly (kept local, not
 * shared, matching that file's own convention). */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static lastInstance: FakeWebSocket | undefined;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  closedWith: { code: number; reason: string } | undefined;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.lastInstance = this;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.closedWith = { code, reason };
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close', { code, reason });
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch('open', {});
  }

  simulateMessage(data: unknown): void {
    this.dispatch('message', { data });
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  lastSentMessage(): Record<string, unknown> {
    const raw = this.sent.at(-1);
    if (!raw) throw new Error('no message was sent');
    return JSON.parse(raw) as Record<string, unknown>;
  }
}

vi.stubGlobal('WebSocket', FakeWebSocket);

const { ReconnectController } =
  await import('../../apps/desktop/src/renderer/realtime/reconnect-controller.js');
type IdentitySigner =
  import('../../apps/desktop/src/renderer/realtime/identity-signer.js').IdentitySigner;

function fakeSigner(): IdentitySigner {
  return {
    getPublicIdentity: () =>
      Promise.resolve({ identityId: `dv1_${'A'.repeat(43)}`, publicKey: 'fake-public-key' }),
    getNickname: () => Promise.resolve('Ana'),
    signIdentityChallenge: () => Promise.resolve('fake-signature'),
  };
}

function helloMessage(): Record<string, unknown> {
  return {
    type: 'server:hello',
    id: 'h1',
    protocolVersion: 3,
    connectionId: 'conn-1',
    identityId: `dv1_${'A'.repeat(43)}`,
    serverName: 'Test Server',
    serverCapabilities: ['voice'],
    serverTime: new Date().toISOString(),
    heartbeat: { intervalMs: 15_000, timeoutMs: 10_000 },
  };
}

function identityChallengeMessage(): Record<string, unknown> {
  return {
    type: 'server:identity-challenge',
    id: 'c1',
    connectionId: 'conn-1',
    nonce: 'A'.repeat(43),
    expiresAt: Date.now() + 30_000,
  };
}

/** Drives one socket instance through the full T7 handshake up to `server:hello`, mirroring
 * `realtime-client.test.ts`'s `connectAndHandshake` helper. Operates on whichever socket is
 * currently `FakeWebSocket.lastInstance` at call time. */
async function completeHandshake(): Promise<FakeWebSocket> {
  const socket = FakeWebSocket.lastInstance;
  if (!socket) throw new Error('no socket was constructed');
  socket.simulateOpen();
  await vi.waitFor(() => {
    if (socket.sent.length === 0) throw new Error('client:hello not sent yet');
  });
  socket.simulateMessage(JSON.stringify(identityChallengeMessage()));
  await vi.waitFor(() => {
    if (socket.sent.length < 2) throw new Error('client:identity-proof not sent yet');
  });
  socket.simulateMessage(JSON.stringify(helloMessage()));
  return socket;
}

describe('ReconnectController', () => {
  beforeEach(() => {
    FakeWebSocket.lastInstance = undefined;
    FakeWebSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reaches "open" on a normal first connect, without emitting "reconnected"', async () => {
    const controller = new ReconnectController('ws://127.0.0.1:8090', fakeSigner());
    const states: string[] = [];
    const reconnectedEvents: number[] = [];
    controller.on('stateChange', (s) => states.push(s));
    controller.on('reconnected', () => reconnectedEvents.push(1));

    controller.connect();
    await completeHandshake();

    expect(states).toEqual(['connecting', 'authenticating', 'open']);
    expect(reconnectedEvents).toEqual([]);
  });

  it('does not attempt to reconnect after an explicit disconnect', async () => {
    const controller = new ReconnectController('ws://127.0.0.1:8090', fakeSigner());
    const states: string[] = [];
    controller.on('stateChange', (s) => states.push(s));

    controller.connect();
    await completeHandshake();
    states.length = 0;

    controller.disconnect();
    expect(states).toEqual(['closed']);

    // Advance well past the maximum possible backoff — no new WebSocket should ever be constructed.
    const instancesBefore = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances.length).toBe(instancesBefore);
    expect(states).toEqual(['closed']);
  });

  it('automatically retries after an unexpected (retryable) close, and emits "reconnected" on success', async () => {
    const controller = new ReconnectController('ws://127.0.0.1:8090', fakeSigner());
    const states: string[] = [];
    const reconnectingEvents: unknown[] = [];
    const reconnectedEvents: number[] = [];
    controller.on('stateChange', (s) => states.push(s));
    controller.on('reconnecting', (e) => reconnectingEvents.push(e));
    controller.on('reconnected', () => reconnectedEvents.push(1));

    controller.connect();
    const firstSocket = await completeHandshake();
    states.length = 0;

    // Simulate an abnormal network drop (no application close code).
    firstSocket.close(1006, '');

    expect(states).toEqual(['closed', 'reconnecting']);
    expect(reconnectingEvents).toHaveLength(1);
    expect((reconnectingEvents[0] as { attempt: number }).attempt).toBe(1);

    await vi.advanceTimersByTimeAsync(2000);
    expect(FakeWebSocket.instances.length).toBe(2);

    await completeHandshake();
    expect(states).toEqual(['closed', 'reconnecting', 'connecting', 'authenticating', 'open']);
    expect(reconnectedEvents).toEqual([1]);
  });

  it('does not reconnect after a non-retryable close (e.g. BANNED), and emits connectionFailed', async () => {
    const controller = new ReconnectController('ws://127.0.0.1:8090', fakeSigner());
    const states: string[] = [];
    const failedEvents: unknown[] = [];
    controller.on('stateChange', (s) => states.push(s));
    controller.on('connectionFailed', (e) => failedEvents.push(e));

    controller.connect();
    const socket = await completeHandshake();

    socket.close(CLOSE_CODES.BANNED, 'you are banned');

    expect(states.at(-1)).toBe('closed');
    expect(failedEvents).toEqual([{ code: CLOSE_CODES.BANNED, reason: 'you are banned' }]);

    const instancesBefore = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances.length).toBe(instancesBefore);
  });

  it('never retries a first connection attempt that fails before ever reaching "open" — even with an otherwise-retryable code', async () => {
    const controller = new ReconnectController('ws://127.0.0.1:8090', fakeSigner());
    const states: string[] = [];
    const failedEvents: unknown[] = [];
    controller.on('stateChange', (s) => states.push(s));
    controller.on('connectionFailed', (e) => failedEvents.push(e));

    controller.connect();
    const socket = FakeWebSocket.lastInstance;
    if (!socket) throw new Error('no socket');

    // 1006 (abnormal closure) is ordinarily retryable, but this connection never reached 'open' —
    // a first attempt must fail clearly, not silently retry-loop.
    socket.close(1006, '');

    expect(states.at(-1)).toBe('closed');
    expect(failedEvents).toEqual([{ code: 1006, reason: '' }]);

    const instancesBefore = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances.length).toBe(instancesBefore);
  });

  it('uses a bounded, doubling backoff across repeated failures (after an already-established session), capped at 30s', async () => {
    const controller = new ReconnectController('ws://127.0.0.1:8090', fakeSigner());
    const delays: number[] = [];
    controller.on('reconnecting', (e) => delays.push(e.delayMs));

    controller.connect();
    let socket: FakeWebSocket | undefined = await completeHandshake();

    // Fail four times in a row without ever reaching "open" again — each failure should schedule a
    // strictly larger (or equal, once capped) delay than the last, and never exceed the cap.
    for (let i = 0; i < 4; i += 1) {
      socket.close(1006, '');
      await vi.advanceTimersByTimeAsync(delays.at(-1) ?? 0);
      socket = FakeWebSocket.lastInstance;
      if (!socket) throw new Error('no socket');
    }

    expect(delays).toHaveLength(4);
    for (const delay of delays) {
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(30_000);
    }
    // Each successive base delay at least doubles (before the cap) — jitter keeps this a
    // greater-than check, not an exact-value check, but a strictly increasing floor still holds
    // for these first few attempts, which are well below the 30s cap.
    expect(delays[1]).toBeGreaterThan(delays[0] ?? 0);
    expect(delays[2]).toBeGreaterThan(delays[1] ?? 0);
  });

  it('resets the backoff after a successful reconnect, so the next loss starts small again', async () => {
    const controller = new ReconnectController('ws://127.0.0.1:8090', fakeSigner());
    const delays: number[] = [];
    controller.on('reconnecting', (e) => delays.push(e.delayMs));

    controller.connect();
    const firstSocket = await completeHandshake();

    firstSocket.close(1006, '');
    await vi.advanceTimersByTimeAsync(delays.at(-1) ?? 0);
    await completeHandshake();

    const secondSocket = FakeWebSocket.lastInstance;
    if (!secondSocket) throw new Error('no socket');
    secondSocket.close(1006, '');

    expect(delays).toHaveLength(2);
    // The second failure's delay is back near the initial 1s base (with jitter: [0.5s, 1s]),
    // nowhere near what a continued doubling from the first failure would have produced.
    expect(delays[1]).toBeLessThan(1500);
  });

  it('a manual connect() cancels a pending reconnect timer instead of racing it (stale-attempt guard)', async () => {
    const controller = new ReconnectController('ws://127.0.0.1:8090', fakeSigner());
    controller.connect();
    const firstSocket = await completeHandshake();

    firstSocket.close(1006, '');
    // A reconnect is now pending (timer scheduled), but not yet fired.
    const instancesBeforeManualConnect = FakeWebSocket.instances.length;

    // The user manually reconnects (e.g. picked a different bookmark) before the timer fires.
    controller.connect();
    expect(FakeWebSocket.instances.length).toBe(instancesBeforeManualConnect + 1);

    // Advancing time must not construct a second, stale extra socket from the old timer.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances.length).toBe(instancesBeforeManualConnect + 1);
  });

  it('cancelReconnect() stops a pending retry and returns to closed', async () => {
    const controller = new ReconnectController('ws://127.0.0.1:8090', fakeSigner());
    const states: string[] = [];
    controller.on('stateChange', (s) => states.push(s));

    controller.connect();
    const socket = await completeHandshake();
    states.length = 0;

    socket.close(1006, '');
    expect(states).toEqual(['closed', 'reconnecting']);

    controller.cancelReconnect();
    expect(states).toEqual(['closed', 'reconnecting', 'closed']);

    const instancesBefore = FakeWebSocket.instances.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWebSocket.instances.length).toBe(instancesBefore);
  });

  it('resets the backoff after EACH of several consecutive successful open/loss cycles, not only the first', async () => {
    // Guards against a regression where `backoffMs`/`attempt` reset correctly once but drift or
    // fail to reset on a later cycle (e.g. an off-by-one in which reset happens before vs. after
    // the doubling that already occurred for THIS loss).
    const controller = new ReconnectController('ws://127.0.0.1:8090', fakeSigner());
    const delays: number[] = [];
    controller.on('reconnecting', (e) => delays.push(e.delayMs));

    controller.connect();
    let socket: FakeWebSocket | undefined = await completeHandshake();

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const delaysBefore = delays.length;
      socket?.close(1006, '');
      // Fail twice in a row within this cycle so the *next* cycle would clearly still be doubled
      // if the reset had not actually happened.
      await vi.advanceTimersByTimeAsync(delays.at(-1) ?? 0);
      socket = FakeWebSocket.lastInstance;
      socket?.close(1006, '');
      await vi.advanceTimersByTimeAsync(delays.at(-1) ?? 0);
      socket = FakeWebSocket.lastInstance;

      const cycleDelays = delays.slice(delaysBefore);
      expect(cycleDelays).toHaveLength(2);
      // Every cycle's first failure starts back near the ~1s initial base, regardless of how many
      // prior cycles already doubled and reset — never inherits the previous cycle's doubled value.
      expect(cycleDelays[0]).toBeLessThan(1500);
      // Within the same cycle, the second failure still doubles from the first, proving the reset
      // only happens on a genuine recovery, not on every single failure.
      expect(cycleDelays[1]).toBeGreaterThan(cycleDelays[0] ?? 0);

      await completeHandshake();
    }
  });

  it("an old controller's pending reconnect timer never fires after disconnect(), even while a new controller for a different server is already connecting (Server A -> Server B race)", async () => {
    // Mirrors `use-voice-channel.ts`'s real pattern: React's effect cleanup calls
    // `controller.disconnect()` on the OLD controller synchronously before a NEW effect run
    // constructs a brand new `ReconnectController` for the new `realtimeConfig.url` — this is the
    // production shape of T11 Section 45/82's "connect to a different server while a reconnect for
    // the old one is pending" race, one level above the same-controller `connect()` case already
    // covered above.
    const controllerA = new ReconnectController('ws://server-a:8090', fakeSigner());
    controllerA.connect();
    const socketA = await completeHandshake();

    socketA.close(1006, '');
    // A reconnect for server A is now pending (timer scheduled), but not yet fired.
    const instancesBeforeSwitch = FakeWebSocket.instances.length;

    // The user picks a different bookmark (server B) — the hook's effect cleanup disconnects A...
    controllerA.disconnect();
    // ...then a fresh controller is constructed for B and told to connect.
    const controllerB = new ReconnectController('ws://server-b:8090', fakeSigner());
    controllerB.connect();
    expect(FakeWebSocket.instances.length).toBe(instancesBeforeSwitch + 1);

    // Advancing time must never construct a stale extra socket from A's now-dead timer — only B's
    // own connection activity is allowed to create new sockets.
    const bStates: string[] = [];
    controllerB.on('stateChange', (s) => bStates.push(s));
    await completeHandshake();
    expect(bStates).toContain('open');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(controllerA.getState()).toBe('closed');
  });
});
