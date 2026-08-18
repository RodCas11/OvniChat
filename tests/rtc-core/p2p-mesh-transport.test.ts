import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { P2PMeshTransport } from '../../packages/rtc-core/src/p2p-mesh-transport.js';
import type { SignalingPort } from '../../packages/rtc-core/src/types.js';
import { FakePeerConnection, fakeAudioTrack } from './fake-peer-connection.js';

type FakeSignalingPort = SignalingPort & {
  offers: { targetParticipantId: string; sdp: string }[];
  answers: { targetParticipantId: string; sdp: string }[];
  candidates: { targetParticipantId: string; candidate: RTCIceCandidateInit | null }[];
  sendIceCandidateImpl?: (
    targetParticipantId: string,
    candidate: RTCIceCandidateInit | null,
  ) => void;
};

function createFakeSignalingPort(): FakeSignalingPort {
  const offers: { targetParticipantId: string; sdp: string }[] = [];
  const answers: { targetParticipantId: string; sdp: string }[] = [];
  const candidates: { targetParticipantId: string; candidate: RTCIceCandidateInit | null }[] = [];
  const port: FakeSignalingPort = {
    offers,
    answers,
    candidates,
    sendOffer: (targetParticipantId: string, sdp: string) =>
      offers.push({ targetParticipantId, sdp }),
    sendAnswer: (targetParticipantId: string, sdp: string) =>
      answers.push({ targetParticipantId, sdp }),
    sendIceCandidate: (targetParticipantId: string, candidate: RTCIceCandidateInit | null) => {
      port.sendIceCandidateImpl?.(targetParticipantId, candidate);
      candidates.push({ targetParticipantId, candidate });
    },
  };
  return port;
}

function createTransport(): {
  transport: P2PMeshTransport;
  signalingPort: ReturnType<typeof createFakeSignalingPort>;
  connections: Map<string, FakePeerConnection>;
} {
  const signalingPort = createFakeSignalingPort();
  const connections = new Map<string, FakePeerConnection>();
  const transport = new P2PMeshTransport({ iceServers: [] }, signalingPort, {
    createPeerConnection: () => {
      const pc = new FakePeerConnection();
      connections.set(`pc-${connections.size}`, pc);
      return pc;
    },
  });
  return { transport, signalingPort, connections };
}

describe('P2PMeshTransport — offer-ownership by role', () => {
  it('creates and sends an offer only for an initiator participant', async () => {
    const { transport, signalingPort } = createTransport();

    transport.addParticipant('peer-initiator', 'initiator');
    await flushMicrotasks();

    expect(signalingPort.offers).toEqual([
      { targetParticipantId: 'peer-initiator', sdp: 'fake-offer-sdp' },
    ]);
  });

  it('never creates an offer for a responder participant', async () => {
    const { transport, signalingPort } = createTransport();

    transport.addParticipant('peer-responder', 'responder');
    await flushMicrotasks();

    expect(signalingPort.offers).toEqual([]);
  });

  it('adding the same participant twice creates only one peer connection', () => {
    const { transport, connections } = createTransport();

    transport.addParticipant('peer-1', 'initiator');
    transport.addParticipant('peer-1', 'initiator');

    expect(connections.size).toBe(1);
  });
});

describe('P2PMeshTransport — track publication fan-out', () => {
  it('publishes a track added before a participant joins to that participant once it joins', () => {
    const { transport, connections } = createTransport();
    const track = fakeAudioTrack();

    transport.publishTrack(track);
    transport.addParticipant('peer-1', 'responder');

    const pc = [...connections.values()][0];
    expect(pc?.addTrackCalls).toEqual([track]);
  });

  it('publishes a track immediately to every already-connected participant', () => {
    const { transport, connections } = createTransport();
    transport.addParticipant('peer-1', 'responder');
    transport.addParticipant('peer-2', 'responder');
    const track = fakeAudioTrack();

    transport.publishTrack(track);

    for (const pc of connections.values()) {
      expect(pc.addTrackCalls).toEqual([track]);
    }
  });

  it('publishing the same track twice only adds it once per peer', () => {
    const { transport, connections } = createTransport();
    transport.addParticipant('peer-1', 'responder');
    const track = fakeAudioTrack();

    transport.publishTrack(track);
    transport.publishTrack(track);

    const pc = [...connections.values()][0];
    expect(pc?.addTrackCalls).toHaveLength(1);
  });

  it('unpublishing removes the track from every current peer', () => {
    const { transport, connections } = createTransport();
    const track = fakeAudioTrack();
    transport.publishTrack(track);
    transport.addParticipant('peer-1', 'responder');

    transport.unpublishTrack(track);

    const pc = [...connections.values()][0];
    expect(pc?.removeTrackCalls).toHaveLength(1);
  });

  it('unpublishing a track that was never published is a no-op', () => {
    const { transport, connections } = createTransport();
    transport.addParticipant('peer-1', 'responder');

    transport.unpublishTrack(fakeAudioTrack());

    const pc = [...connections.values()][0];
    expect(pc?.removeTrackCalls).toEqual([]);
  });
});

describe('P2PMeshTransport — removal, closeAll, and idempotency', () => {
  it('removeParticipant closes the peer connection and emits peerClosed exactly once', () => {
    const { transport, connections } = createTransport();
    transport.addParticipant('peer-1', 'responder');
    const closed: string[] = [];
    transport.on('peerClosed', (participantId) => closed.push(participantId));

    transport.removeParticipant('peer-1');
    transport.removeParticipant('peer-1'); // idempotent: already gone

    const pc = [...connections.values()][0];
    expect(pc?.closeCallCount).toBe(1);
    expect(closed).toEqual(['peer-1']);
  });

  it('removing an unknown participant is a controlled no-op', () => {
    const { transport } = createTransport();

    expect(() => transport.removeParticipant('never-added')).not.toThrow();
  });

  it('closeAll closes every peer and is idempotent', () => {
    const { transport, connections } = createTransport();
    transport.addParticipant('peer-1', 'responder');
    transport.addParticipant('peer-2', 'responder');
    const closed: string[] = [];
    transport.on('peerClosed', (participantId) => closed.push(participantId));

    transport.closeAll();
    transport.closeAll();

    for (const pc of connections.values()) expect(pc.closeCallCount).toBe(1);
    expect(closed.sort()).toEqual(['peer-1', 'peer-2']);
  });

  it('addParticipant after closeAll is a no-op — the transport does not resurrect', () => {
    const { transport, connections } = createTransport();
    transport.closeAll();

    transport.addParticipant('peer-1', 'responder');

    expect(connections.size).toBe(0);
  });

  it('publishTrack after closeAll is accepted silently and never reaches a live peer connection', () => {
    // Unlike addParticipant, publishTrack does not check the closedAll flag — it always records
    // the track in `publishedTracks` and only fans it out to the (now-empty) `peers` map. A caller
    // that races the last publishTrack call against a closeAll (e.g. an in-flight microphone
    // acquisition finishing just after a component unmount tears the transport down) gets no error
    // and no signal that the track will never be wired to a peer — see the T3 QA report on
    // `apps/desktop/src/renderer/voice/use-voice-channel.ts`'s join()/unmount race for the concrete
    // consumer-side consequence (a microphone that is never released).
    const { transport, connections } = createTransport();
    transport.closeAll();
    const track = fakeAudioTrack();

    expect(() => transport.publishTrack(track)).not.toThrow();

    // Confirmed unreachable: addParticipant is itself a no-op post-closeAll, so there is no way,
    // through this transport instance, for the published track to ever reach a real peer
    // connection again.
    transport.addParticipant('peer-1', 'responder');
    expect(connections.size).toBe(0);
  });
});

describe('P2PMeshTransport — races with removal', () => {
  it('a remote offer/answer/ICE candidate for an already-removed participant is a controlled no-op', async () => {
    const { transport } = createTransport();
    transport.addParticipant('peer-1', 'responder');
    transport.removeParticipant('peer-1');

    await expect(transport.handleRemoteOffer('peer-1', 'sdp')).resolves.toBeUndefined();
    await expect(transport.handleRemoteAnswer('peer-1', 'sdp')).resolves.toBeUndefined();
    await expect(transport.handleRemoteIceCandidate('peer-1', null)).resolves.toBeUndefined();
  });

  it('a remote offer/answer/ICE candidate for a participant that was never added is a controlled no-op', async () => {
    const { transport } = createTransport();

    await expect(transport.handleRemoteOffer('never-added', 'sdp')).resolves.toBeUndefined();
    await expect(transport.handleRemoteAnswer('never-added', 'sdp')).resolves.toBeUndefined();
    await expect(transport.handleRemoteIceCandidate('never-added', null)).resolves.toBeUndefined();
  });

  it('getStats for an unknown or removed participant resolves undefined, never throws', async () => {
    const { transport } = createTransport();

    await expect(transport.getStats('never-added')).resolves.toBeUndefined();
  });
});

describe('P2PMeshTransport — remote track / state events carry the participant id', () => {
  it('attributes a remote track to the correct participant', () => {
    const { transport, connections } = createTransport();
    transport.addParticipant('peer-1', 'responder');
    const events: { participantId: string; track: MediaStreamTrack }[] = [];
    transport.on('remoteTrack', (event) => events.push(event));

    const pc = [...connections.values()][0];
    const track = fakeAudioTrack();
    const stream = {} as MediaStream;
    pc?.ontrack?.({ track, streams: [stream] } as unknown as RTCTrackEvent);

    expect(events).toEqual([{ participantId: 'peer-1', track, stream }]);
  });

  it('a peer reaching "failed" both emits peerStateChanged and triggers cleanup/peerClosed', () => {
    const { transport, connections } = createTransport();
    transport.addParticipant('peer-1', 'responder');
    const stateEvents: RTCPeerConnectionState[] = [];
    const closedEvents: string[] = [];
    transport.on('peerStateChanged', (event) => stateEvents.push(event.connectionState));
    transport.on('peerClosed', (participantId) => closedEvents.push(participantId));

    const pc = [...connections.values()][0];
    if (pc) pc.connectionState = 'failed';
    pc?.onconnectionstatechange?.(new Event('connectionstatechange'));

    expect(stateEvents).toEqual(['failed']);
    expect(closedEvents).toEqual(['peer-1']);
    expect(pc?.closeCallCount).toBe(1);
  });

  it('off() stops a listener from receiving further events', () => {
    const { transport } = createTransport();
    const closed: string[] = [];
    const listener = (participantId: string): void => {
      closed.push(participantId);
    };
    transport.on('peerClosed', listener);
    transport.off('peerClosed', listener);

    transport.addParticipant('peer-1', 'responder');
    transport.removeParticipant('peer-1');

    expect(closed).toEqual([]);
  });
});

describe('P2PMeshTransport — error containment (never an unhandled rejection)', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('a rejected offer creation is logged, not thrown, and does not break the transport', async () => {
    const signalingPort = createFakeSignalingPort();
    const failure = new Error('createOffer failed');
    const transport = new P2PMeshTransport({ iceServers: [] }, signalingPort, {
      createPeerConnection: () => {
        const pc = new FakePeerConnection();
        pc.createOfferImpl = () => Promise.reject(failure);
        return pc;
      },
    });

    expect(() => transport.addParticipant('peer-1', 'initiator')).not.toThrow();
    await flushMicrotasks();

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(signalingPort.offers).toEqual([]);
    // The transport is still usable afterward.
    expect(() => transport.removeParticipant('peer-1')).not.toThrow();
  });

  it('a genuinely failing remote offer/answer/ICE handling resolves (never rejects) and is logged', async () => {
    const { transport, connections } = createTransport();
    transport.addParticipant('peer-1', 'responder');
    const pc = [...connections.values()][0];
    const failure = new Error('setRemoteDescription failed');
    if (pc) pc.setRemoteDescriptionImpl = () => Promise.reject(failure);

    await expect(transport.handleRemoteOffer('peer-1', 'sdp')).resolves.toBeUndefined();
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('a signaling port that throws synchronously while sending an ICE candidate does not crash the transport', () => {
    const signalingPort = createFakeSignalingPort();
    signalingPort.sendIceCandidateImpl = () => {
      throw new Error('signaling transport is down');
    };
    let pc: FakePeerConnection | undefined;
    const transport = new P2PMeshTransport({ iceServers: [] }, signalingPort, {
      createPeerConnection: () => {
        pc = new FakePeerConnection();
        return pc;
      },
    });
    transport.addParticipant('peer-1', 'responder');

    expect(() => {
      pc?.onicecandidate?.({
        candidate: { toJSON: () => ({ candidate: 'candidate:1', sdpMLineIndex: 0 }) },
      } as unknown as RTCPeerConnectionIceEvent);
    }).not.toThrow();

    expect(consoleErrorSpy).toHaveBeenCalled();
    // The transport is still usable afterward.
    expect(() => transport.removeParticipant('peer-1')).not.toThrow();
  });
});

describe('P2PMeshTransport — getStats delegates to the underlying connection', () => {
  it('resolves with the real getStats() report for a known participant', async () => {
    const { transport, connections } = createTransport();
    transport.addParticipant('peer-1', 'responder');
    const statsReport = { fake: true } as unknown as RTCStatsReport;
    const pc = [...connections.values()][0];
    if (pc) pc.getStatsImpl = () => Promise.resolve(statsReport);

    await expect(transport.getStats('peer-1')).resolves.toBe(statsReport);
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
