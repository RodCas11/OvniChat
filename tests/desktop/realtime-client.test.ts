import { CURRENT_PROTOCOL_VERSION } from '@disco-voador/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A minimal stand-in for the platform `WebSocket`, implementing only what `RealtimeClient`
 * actually calls — mirrors `tests/realtime/connection.test.ts`'s `FakeSocket` pattern for `ws`.
 * `lastInstance` lets a test reach the socket a `RealtimeClient` created internally.
 */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static lastInstance: FakeWebSocket | undefined;

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  closedWith: { code: number; reason: string } | undefined;
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.lastInstance = this;
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

const { RealtimeClient } =
  await import('../../apps/desktop/src/renderer/realtime/realtime-client.js');
type IdentitySigner =
  import('../../apps/desktop/src/renderer/realtime/identity-signer.js').IdentitySigner;

/** A minimal, deterministic stand-in for the IPC-backed `IdentitySigner` — no Electron/IPC
 * involved, so `RealtimeClient`'s own hello/challenge/proof orchestration can be tested in
 * isolation from Main's real crypto (which `packages/identity`'s own tests already cover). */
function fakeSigner(overrides: Partial<IdentitySigner> = {}): IdentitySigner {
  return {
    getPublicIdentity: () =>
      Promise.resolve({ identityId: `dv1_${'A'.repeat(43)}`, publicKey: 'fake-public-key' }),
    getNickname: () => Promise.resolve('Ana'),
    signIdentityChallenge: () => Promise.resolve('fake-signature'),
    ...overrides,
  };
}

function helloMessage(id: string): Record<string, unknown> {
  return {
    type: 'server:hello',
    id,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    connectionId: 'conn-1',
    identityId: `dv1_${'A'.repeat(43)}`,
    serverName: 'Test Server',
    serverCapabilities: ['voice'],
    serverTime: new Date().toISOString(),
    heartbeat: { intervalMs: 15_000, timeoutMs: 10_000 },
  };
}

function identityChallengeMessage(id: string): Record<string, unknown> {
  return {
    type: 'server:identity-challenge',
    id,
    connectionId: 'conn-1',
    nonce: 'A'.repeat(43),
    expiresAt: Date.now() + 30_000,
  };
}

describe('RealtimeClient', () => {
  let socket: FakeWebSocket;

  beforeEach(() => {
    FakeWebSocket.lastInstance = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Opens the socket and waits for the async `sendHello()` (identity lookup over the fake
   * signer) to actually run — `client:hello` is not sent synchronously anymore (T7). */
  async function connectAndOpen(
    signer: IdentitySigner = fakeSigner(),
  ): Promise<InstanceType<typeof RealtimeClient>> {
    const client = new RealtimeClient('ws://127.0.0.1:8090', signer);
    client.connect();
    const created = FakeWebSocket.lastInstance;
    if (!created) throw new Error('RealtimeClient did not construct a WebSocket');
    socket = created;
    socket.simulateOpen();
    await vi.waitFor(() => {
      if (socket.sent.length === 0) throw new Error('client:hello not sent yet');
    });
    return client;
  }

  /** Drives the full hello -> challenge -> proof flow using the fake signer, ending with a real
   * `server:hello` received (so the client is `ready`, matching what most other tests need). */
  async function connectAndHandshake(
    signer: IdentitySigner = fakeSigner(),
  ): Promise<InstanceType<typeof RealtimeClient>> {
    const client = await connectAndOpen(signer);
    socket.simulateMessage(JSON.stringify(identityChallengeMessage('c1')));
    await vi.waitFor(() => {
      if (socket.sent.length < 2) throw new Error('client:identity-proof not sent yet');
    });
    socket.simulateMessage(JSON.stringify(helloMessage('h1')));
    return client;
  }

  it('sends client:hello (with nickname/publicKey from the signer) once the socket opens', async () => {
    await connectAndOpen();
    const hello = socket.lastSentMessage();
    expect(hello).toMatchObject({
      type: 'client:hello',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      nickname: 'Ana',
      publicKey: 'fake-public-key',
    });
  });

  it('answers a server:identity-challenge with a signed client:identity-proof', async () => {
    const signChallenge = vi.fn(() => Promise.resolve('the-signature'));
    await connectAndOpen(fakeSigner({ signIdentityChallenge: signChallenge }));

    socket.simulateMessage(JSON.stringify(identityChallengeMessage('c1')));
    await vi.waitFor(() => {
      if (socket.sent.length < 2) throw new Error('client:identity-proof not sent yet');
    });

    expect(signChallenge).toHaveBeenCalledWith({
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      connectionId: 'conn-1',
      nonce: 'A'.repeat(43),
      expiresAt: expect.any(Number) as unknown as number,
      nickname: 'Ana',
    });
    expect(socket.lastSentMessage()).toMatchObject({
      type: 'client:identity-proof',
      signature: 'the-signature',
    });
  });

  it('transitions to "open" only after server:hello, not merely after the socket opens or the challenge', async () => {
    const client = await connectAndOpen();
    const states: string[] = [];
    client.on('stateChange', (state) => states.push(state));

    expect(states).toEqual([]);
    socket.simulateMessage(JSON.stringify(identityChallengeMessage('c1')));
    await vi.waitFor(() => {
      if (socket.sent.length < 2) throw new Error('client:identity-proof not sent yet');
    });
    expect(states).toEqual([]);

    socket.simulateMessage(JSON.stringify(helloMessage('h1')));
    expect(states).toEqual(['open']);
  });

  it('emits "authenticating" once client:hello is sent, before any server reply arrives', async () => {
    const client = new RealtimeClient('ws://127.0.0.1:8090', fakeSigner());
    const states: string[] = [];
    client.on('stateChange', (state) => states.push(state));

    client.connect();
    const created = FakeWebSocket.lastInstance;
    if (!created) throw new Error('RealtimeClient did not construct a WebSocket');
    socket = created;
    socket.simulateOpen();

    expect(states).toEqual(['connecting']);
    await vi.waitFor(() => {
      if (socket.sent.length === 0) throw new Error('client:hello not sent yet');
    });
    expect(states).toEqual(['connecting', 'authenticating']);
  });

  it('emits serverInfo with the server name/capabilities alongside the "open" transition', async () => {
    const client = await connectAndOpen();
    const infos: unknown[] = [];
    client.on('serverInfo', (info) => infos.push(info));

    socket.simulateMessage(JSON.stringify(identityChallengeMessage('c1')));
    await vi.waitFor(() => {
      if (socket.sent.length < 2) throw new Error('client:identity-proof not sent yet');
    });
    socket.simulateMessage(JSON.stringify(helloMessage('h1')));

    expect(infos).toEqual([{ serverName: 'Test Server', serverCapabilities: ['voice'] }]);
  });

  it('closes the socket instead of throwing when the signer fails to load an identity', async () => {
    const client = new RealtimeClient(
      'ws://127.0.0.1:8090',
      fakeSigner({ getPublicIdentity: () => Promise.reject(new Error('locked out')) }),
    );
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    client.connect();
    const created = FakeWebSocket.lastInstance;
    if (!created) throw new Error('RealtimeClient did not construct a WebSocket');
    socket = created;
    socket.simulateOpen();

    await vi.waitFor(() => {
      if (!socket.closedWith) throw new Error('not closed yet');
    });
    expect(socket.sent).toEqual([]);
    consoleError.mockRestore();
  });

  it('emits the voice catalog when it arrives', async () => {
    const client = await connectAndHandshake();
    const catalogs: unknown[] = [];
    client.on('catalog', (message) => catalogs.push(message));

    socket.simulateMessage(
      JSON.stringify({
        type: 'voice:catalog',
        id: 'c1',
        channels: [{ channelId: 'general', name: 'General' }],
      }),
    );

    expect(catalogs).toEqual([
      { type: 'voice:catalog', id: 'c1', channels: [{ channelId: 'general', name: 'General' }] },
    ]);
  });

  it('sends a well-formed voice:join message', async () => {
    const client = await connectAndHandshake();
    client.joinVoiceChannel('general', 'Ana');

    const message = socket.lastSentMessage();
    expect(message).toMatchObject({ type: 'voice:join', channelId: 'general', displayName: 'Ana' });
    expect(typeof message['id']).toBe('string');
  });

  it('sends a well-formed voice:leave message', async () => {
    const client = await connectAndHandshake();
    client.leaveVoiceChannel();

    expect(socket.lastSentMessage()).toMatchObject({ type: 'voice:leave' });
  });

  it('implements SignalingPort.sendOffer by sending webrtc:offer with the target participant', async () => {
    const client = await connectAndHandshake();
    client.sendOffer('participant-b', 'v=0\r\n...offer-sdp');

    expect(socket.lastSentMessage()).toMatchObject({
      type: 'webrtc:offer',
      targetParticipantId: 'participant-b',
      sdp: 'v=0\r\n...offer-sdp',
    });
  });

  it('implements SignalingPort.sendAnswer by sending webrtc:answer with the target participant', async () => {
    const client = await connectAndHandshake();
    client.sendAnswer('participant-a', 'v=0\r\n...answer-sdp');

    expect(socket.lastSentMessage()).toMatchObject({
      type: 'webrtc:answer',
      targetParticipantId: 'participant-a',
      sdp: 'v=0\r\n...answer-sdp',
    });
  });

  it('implements SignalingPort.sendIceCandidate, passing a real candidate through', async () => {
    const client = await connectAndHandshake();
    client.sendIceCandidate('participant-b', {
      candidate: 'candidate:1 1 UDP 1 127.0.0.1 5000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });

    expect(socket.lastSentMessage()).toMatchObject({
      type: 'webrtc:ice-candidate',
      targetParticipantId: 'participant-b',
      candidate: {
        candidate: 'candidate:1 1 UDP 1 127.0.0.1 5000 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
      },
    });
  });

  it('implements SignalingPort.sendIceCandidate, passing null through as the end-of-candidates signal', async () => {
    const client = await connectAndHandshake();
    client.sendIceCandidate('participant-b', null);

    expect(socket.lastSentMessage()).toMatchObject({
      type: 'webrtc:ice-candidate',
      targetParticipantId: 'participant-b',
      candidate: null,
    });
  });

  it('dispatches inbound webrtc:offer/answer/ice-candidate to their own listeners', async () => {
    const client = await connectAndHandshake();
    const offers: unknown[] = [];
    const answers: unknown[] = [];
    const candidates: unknown[] = [];
    client.on('webrtcOffer', (m) => offers.push(m));
    client.on('webrtcAnswer', (m) => answers.push(m));
    client.on('webrtcIceCandidate', (m) => candidates.push(m));

    socket.simulateMessage(
      JSON.stringify({
        type: 'webrtc:offer',
        id: 'o1',
        sourceParticipantId: 'participant-a',
        sdp: 'offer-sdp',
      }),
    );
    socket.simulateMessage(
      JSON.stringify({
        type: 'webrtc:answer',
        id: 'a1',
        sourceParticipantId: 'participant-a',
        sdp: 'answer-sdp',
      }),
    );
    socket.simulateMessage(
      JSON.stringify({
        type: 'webrtc:ice-candidate',
        id: 'i1',
        sourceParticipantId: 'participant-a',
        candidate: null,
      }),
    );

    expect(offers).toHaveLength(1);
    expect(answers).toHaveLength(1);
    expect(candidates).toHaveLength(1);
  });

  it('announces a track source by sending a targeted media:track-source (mid-scoped, not broadcast)', async () => {
    const client = await connectAndHandshake();
    client.announceTrackSource('participant-b', '1', 'screen-video');

    const message = socket.lastSentMessage();
    expect(message).toMatchObject({
      type: 'media:track-source',
      targetParticipantId: 'participant-b',
      mid: '1',
      source: 'screen-video',
    });
  });

  it('dispatches an inbound media:track-source to its own listener', async () => {
    const client = await connectAndHandshake();
    const announcements: unknown[] = [];
    client.on('mediaTrackSource', (m) => announcements.push(m));

    socket.simulateMessage(
      JSON.stringify({
        type: 'media:track-source',
        id: 'm1',
        sourceParticipantId: 'participant-a',
        mid: '1',
        source: 'camera',
      }),
    );

    expect(announcements).toEqual([
      {
        type: 'media:track-source',
        id: 'm1',
        sourceParticipantId: 'participant-a',
        mid: '1',
        source: 'camera',
      },
    ]);
  });

  it('emits serverError for server:error without closing anything', async () => {
    const client = await connectAndHandshake();
    const errors: unknown[] = [];
    client.on('serverError', (m) => errors.push(m));

    socket.simulateMessage(
      JSON.stringify({
        type: 'server:error',
        id: 'e1',
        code: 'NOT_IN_VOICE_CHANNEL',
        message: 'Not currently in a voice channel',
      }),
    );

    expect(errors).toHaveLength(1);
  });

  it('ignores malformed JSON instead of throwing', async () => {
    await connectAndHandshake();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => socket.simulateMessage('not valid json{{{')).not.toThrow();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('ignores a message that fails protocol validation instead of throwing', async () => {
    await connectAndHandshake();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => socket.simulateMessage(JSON.stringify({ type: 'not:a-real-type' }))).not.toThrow();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('drops outbound messages instead of throwing when the socket is not open', () => {
    const client = new RealtimeClient('ws://127.0.0.1:8090', fakeSigner());
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => client.joinVoiceChannel('general', 'Ana')).not.toThrow();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('closes the socket normally on disconnect and reports state as closed', async () => {
    const client = await connectAndHandshake();
    const states: string[] = [];
    client.on('stateChange', (state) => states.push(state));

    client.disconnect();

    expect(socket.closedWith).toMatchObject({ code: 1000 });
    expect(states).toEqual(['closed']);
  });

  it('emits "closed" with the code/reason before "stateChange closed", on an explicit disconnect', async () => {
    const client = await connectAndHandshake();
    const events: string[] = [];
    let closedInfo: unknown;
    client.on('closed', (info) => {
      closedInfo = info;
      events.push('closed');
    });
    client.on('stateChange', (state) => {
      if (state === 'closed') events.push('stateChange:closed');
    });

    client.disconnect();

    expect(closedInfo).toEqual({ code: 1000, reason: 'client disconnect' });
    expect(events).toEqual(['closed', 'stateChange:closed']);
  });

  it('reports state as closed when the server closes the connection', async () => {
    const client = await connectAndHandshake();
    const states: string[] = [];
    client.on('stateChange', (state) => states.push(state));

    // A server-initiated close still arrives to the client as a 'close' event on its own socket.
    socket.close(4402, 'handshake timeout');

    expect(states).toEqual(['closed']);
  });

  it('emits "closed" with the server-chosen code/reason for a server-initiated close', async () => {
    const client = await connectAndHandshake();
    let closedInfo: unknown;
    client.on('closed', (info) => {
      closedInfo = info;
    });

    socket.close(4421, 'you are banned');

    expect(closedInfo).toEqual({ code: 4421, reason: 'you are banned' });
  });

  it('stops emitting to a listener after off() removes it', async () => {
    const client = await connectAndHandshake();
    const catalogs: unknown[] = [];
    const listener = (message: unknown): void => {
      catalogs.push(message);
    };
    client.on('catalog', listener);
    client.off('catalog', listener);

    socket.simulateMessage(JSON.stringify({ type: 'voice:catalog', id: 'c1', channels: [] }));

    expect(catalogs).toEqual([]);
  });
});
