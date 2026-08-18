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
    this.dispatch('close', {});
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

function helloMessage(id: string): Record<string, unknown> {
  return {
    type: 'server:hello',
    id,
    protocolVersion: 1,
    connectionId: 'conn-1',
    serverTime: new Date().toISOString(),
    heartbeat: { intervalMs: 15_000, timeoutMs: 10_000 },
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

  function connectAndHandshake(): InstanceType<typeof RealtimeClient> {
    const client = new RealtimeClient('ws://127.0.0.1:8090');
    client.connect();
    const created = FakeWebSocket.lastInstance;
    if (!created) throw new Error('RealtimeClient did not construct a WebSocket');
    socket = created;
    socket.simulateOpen();
    return client;
  }

  it('sends client:hello immediately once the socket opens', () => {
    connectAndHandshake();
    const hello = socket.lastSentMessage();
    expect(hello['type']).toBe('client:hello');
    expect(hello['protocolVersion']).toBe(1);
  });

  it('transitions to "open" only after server:hello, not merely after the socket opens', () => {
    const client = connectAndHandshake();
    const states: string[] = [];
    client.on('stateChange', (state) => states.push(state));

    expect(states).toEqual([]);
    socket.simulateMessage(JSON.stringify(helloMessage('h1')));

    expect(states).toEqual(['open']);
  });

  it('emits the voice catalog when it arrives', () => {
    const client = connectAndHandshake();
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

  it('sends a well-formed voice:join message', () => {
    const client = connectAndHandshake();
    client.joinVoiceChannel('general', 'Ana');

    const message = socket.lastSentMessage();
    expect(message).toMatchObject({ type: 'voice:join', channelId: 'general', displayName: 'Ana' });
    expect(typeof message['id']).toBe('string');
  });

  it('sends a well-formed voice:leave message', () => {
    const client = connectAndHandshake();
    client.leaveVoiceChannel();

    expect(socket.lastSentMessage()).toMatchObject({ type: 'voice:leave' });
  });

  it('implements SignalingPort.sendOffer by sending webrtc:offer with the target participant', () => {
    const client = connectAndHandshake();
    client.sendOffer('participant-b', 'v=0\r\n...offer-sdp');

    expect(socket.lastSentMessage()).toMatchObject({
      type: 'webrtc:offer',
      targetParticipantId: 'participant-b',
      sdp: 'v=0\r\n...offer-sdp',
    });
  });

  it('implements SignalingPort.sendAnswer by sending webrtc:answer with the target participant', () => {
    const client = connectAndHandshake();
    client.sendAnswer('participant-a', 'v=0\r\n...answer-sdp');

    expect(socket.lastSentMessage()).toMatchObject({
      type: 'webrtc:answer',
      targetParticipantId: 'participant-a',
      sdp: 'v=0\r\n...answer-sdp',
    });
  });

  it('implements SignalingPort.sendIceCandidate, passing a real candidate through', () => {
    const client = connectAndHandshake();
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

  it('implements SignalingPort.sendIceCandidate, passing null through as the end-of-candidates signal', () => {
    const client = connectAndHandshake();
    client.sendIceCandidate('participant-b', null);

    expect(socket.lastSentMessage()).toMatchObject({
      type: 'webrtc:ice-candidate',
      targetParticipantId: 'participant-b',
      candidate: null,
    });
  });

  it('dispatches inbound webrtc:offer/answer/ice-candidate to their own listeners', () => {
    const client = connectAndHandshake();
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

  it('emits serverError for server:error without closing anything', () => {
    const client = connectAndHandshake();
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

  it('ignores malformed JSON instead of throwing', () => {
    connectAndHandshake();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => socket.simulateMessage('not valid json{{{')).not.toThrow();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('ignores a message that fails protocol validation instead of throwing', () => {
    connectAndHandshake();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => socket.simulateMessage(JSON.stringify({ type: 'not:a-real-type' }))).not.toThrow();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('drops outbound messages instead of throwing when the socket is not open', () => {
    const client = new RealtimeClient('ws://127.0.0.1:8090');
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => client.joinVoiceChannel('general', 'Ana')).not.toThrow();
    expect(consoleError).toHaveBeenCalled();

    consoleError.mockRestore();
  });

  it('closes the socket normally on disconnect and reports state as closed', () => {
    const client = connectAndHandshake();
    const states: string[] = [];
    client.on('stateChange', (state) => states.push(state));

    client.disconnect();

    expect(socket.closedWith).toMatchObject({ code: 1000 });
    expect(states).toEqual(['closed']);
  });

  it('reports state as closed when the server closes the connection', () => {
    const client = connectAndHandshake();
    const states: string[] = [];
    client.on('stateChange', (state) => states.push(state));

    // A server-initiated close still arrives to the client as a 'close' event on its own socket.
    socket.close(4402, 'handshake timeout');

    expect(states).toEqual(['closed']);
  });

  it('stops emitting to a listener after off() removes it', () => {
    const client = connectAndHandshake();
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
