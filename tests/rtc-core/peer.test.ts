import { afterEach, describe, expect, it, vi } from 'vitest';

import { Peer, type PeerCallbacks } from '../../packages/rtc-core/src/peer.js';
import type { SignalingPort } from '../../packages/rtc-core/src/types.js';
import { FakePeerConnection, createDeferred, fakeAudioTrack } from './fake-peer-connection.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function createCallbacks(): PeerCallbacks & {
  remoteTracks: { track: MediaStreamTrack; stream: MediaStream }[];
  stateChanges: {
    connectionState: RTCPeerConnectionState;
    iceConnectionState: RTCIceConnectionState;
  }[];
  terminalCount: number;
  iceCandidates: (RTCIceCandidateInit | null)[];
} {
  const remoteTracks: { track: MediaStreamTrack; stream: MediaStream }[] = [];
  const stateChanges: {
    connectionState: RTCPeerConnectionState;
    iceConnectionState: RTCIceConnectionState;
  }[] = [];
  const iceCandidates: (RTCIceCandidateInit | null)[] = [];
  const callbacks = {
    remoteTracks,
    stateChanges,
    iceCandidates,
    terminalCount: 0,
    onRemoteTrack: (track: MediaStreamTrack, stream: MediaStream) => {
      remoteTracks.push({ track, stream });
    },
    onStateChanged: (
      connectionState: RTCPeerConnectionState,
      iceConnectionState: RTCIceConnectionState,
    ) => {
      stateChanges.push({ connectionState, iceConnectionState });
    },
    onTerminal: () => {
      callbacks.terminalCount += 1;
    },
    onIceCandidate: (candidate: RTCIceCandidateInit | null) => {
      iceCandidates.push(candidate);
    },
  };
  return callbacks;
}

function createFakeSignalingPort(): SignalingPort & {
  offers: { targetParticipantId: string; sdp: string }[];
  answers: { targetParticipantId: string; sdp: string }[];
  candidates: { targetParticipantId: string; candidate: RTCIceCandidateInit | null }[];
} {
  const offers: { targetParticipantId: string; sdp: string }[] = [];
  const answers: { targetParticipantId: string; sdp: string }[] = [];
  const candidates: { targetParticipantId: string; candidate: RTCIceCandidateInit | null }[] = [];
  return {
    offers,
    answers,
    candidates,
    sendOffer: (targetParticipantId, sdp) => offers.push({ targetParticipantId, sdp }),
    sendAnswer: (targetParticipantId, sdp) => answers.push({ targetParticipantId, sdp }),
    sendIceCandidate: (targetParticipantId, candidate) =>
      candidates.push({ targetParticipantId, candidate }),
  };
}

describe('Peer — offer/answer role ownership', () => {
  it('an initiator creates and sends exactly one offer', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'initiator', pc, createCallbacks());

    await peer.createAndSendOffer(signalingPort);

    expect(pc.setLocalDescriptionCalls).toEqual([{ type: 'offer', sdp: 'fake-offer-sdp' }]);
    expect(signalingPort.offers).toEqual([
      { targetParticipantId: 'peer-1', sdp: 'fake-offer-sdp' },
    ]);
    expect(signalingPort.answers).toEqual([]);
  });

  it('a responder never creates an offer, only answers an inbound one', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'responder', pc, createCallbacks());

    await peer.handleRemoteOffer('remote-offer-sdp', signalingPort);

    expect(signalingPort.offers).toEqual([]);
    expect(pc.setRemoteDescriptionCalls).toEqual([{ type: 'offer', sdp: 'remote-offer-sdp' }]);
    expect(pc.setLocalDescriptionCalls).toEqual([{ type: 'answer', sdp: 'fake-answer-sdp' }]);
    expect(signalingPort.answers).toEqual([
      { targetParticipantId: 'peer-1', sdp: 'fake-answer-sdp' },
    ]);
  });
});

describe('Peer — ICE candidate queueing', () => {
  it('queues a candidate that arrives before the remote description is applied, then flushes it in order', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'responder', pc, createCallbacks());
    const early: RTCIceCandidateInit = { candidate: 'candidate:early', sdpMLineIndex: 0 };

    await peer.handleRemoteIceCandidate(early);
    expect(pc.addIceCandidateCalls).toEqual([]); // not applied yet — queued

    await peer.handleRemoteOffer('remote-offer-sdp', signalingPort);

    expect(pc.addIceCandidateCalls).toEqual([early]);
  });

  it('applies a candidate immediately once the remote description is already set', async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createCallbacks());

    await peer.handleRemoteAnswer('remote-answer-sdp');
    const late: RTCIceCandidateInit = { candidate: 'candidate:late', sdpMLineIndex: 0 };

    await peer.handleRemoteIceCandidate(late);

    expect(pc.addIceCandidateCalls).toEqual([late]);
  });

  it('queues and flushes a null end-of-candidates signal like any other candidate', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'responder', pc, createCallbacks());

    await peer.handleRemoteIceCandidate(null);
    await peer.handleRemoteOffer('remote-offer-sdp', signalingPort);

    expect(pc.addIceCandidateCalls).toEqual([null]);
  });
});

describe('Peer — connection-state forwarding and terminal cleanup', () => {
  it('forwards every state change and signals terminal exactly once on failure', () => {
    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    new Peer('peer-1', 'initiator', pc, callbacks);

    pc.connectionState = 'connecting';
    pc.onconnectionstatechange?.(new Event('connectionstatechange'));
    pc.connectionState = 'failed';
    pc.onconnectionstatechange?.(new Event('connectionstatechange'));
    // A second dispatch of the same terminal state must not double-count.
    pc.onconnectionstatechange?.(new Event('connectionstatechange'));

    expect(callbacks.stateChanges).toHaveLength(3);
    expect(callbacks.terminalCount).toBe(2); // once per dispatch while already in "failed"
  });

  it('does not treat "disconnected" as terminal', () => {
    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    new Peer('peer-1', 'initiator', pc, callbacks);

    pc.connectionState = 'disconnected';
    pc.onconnectionstatechange?.(new Event('connectionstatechange'));

    expect(callbacks.terminalCount).toBe(0);
  });
});

describe('Peer — ICE candidate forwarding to signaling', () => {
  it('forwards a locally generated candidate via onicecandidate', () => {
    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    new Peer('peer-1', 'initiator', pc, callbacks);
    const candidate = { toJSON: () => ({ candidate: 'candidate:1', sdpMLineIndex: 0 }) };

    pc.onicecandidate?.({ candidate } as unknown as RTCPeerConnectionIceEvent);

    expect(callbacks.iceCandidates).toEqual([{ candidate: 'candidate:1', sdpMLineIndex: 0 }]);
  });

  it('forwards null for the end-of-candidates signal', () => {
    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    new Peer('peer-1', 'initiator', pc, callbacks);

    pc.onicecandidate?.({ candidate: null } as unknown as RTCPeerConnectionIceEvent);

    expect(callbacks.iceCandidates).toEqual([null]);
  });
});

describe('Peer — close() idempotency and cleanup', () => {
  it('closes the underlying connection exactly once no matter how many times close() is called', () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createCallbacks());

    peer.close();
    peer.close();
    peer.close();

    expect(pc.closeCallCount).toBe(1);
  });

  it('detaches every event handler on close so late platform dispatches are inert', () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createCallbacks());

    peer.close();

    expect(pc.ontrack).toBeNull();
    expect(pc.onicecandidate).toBeNull();
    expect(pc.onconnectionstatechange).toBeNull();
    expect(pc.oniceconnectionstatechange).toBeNull();
  });

  it('reports isClosed after close()', () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createCallbacks());

    expect(peer.isClosed).toBe(false);
    peer.close();
    expect(peer.isClosed).toBe(true);
  });

  it('every public method is a no-op once closed, never throwing or rejecting', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'initiator', pc, createCallbacks());
    peer.close();

    peer.addTrack(fakeAudioTrack());
    await expect(peer.createAndSendOffer(signalingPort)).resolves.toBeUndefined();
    await expect(peer.handleRemoteOffer('sdp', signalingPort)).resolves.toBeUndefined();
    await expect(peer.handleRemoteAnswer('sdp')).resolves.toBeUndefined();
    await expect(peer.handleRemoteIceCandidate(null)).resolves.toBeUndefined();
    await expect(peer.getStats()).resolves.toBeUndefined();

    expect(pc.addTrackCalls).toEqual([]);
    expect(pc.setLocalDescriptionCalls).toEqual([]);
    expect(pc.setRemoteDescriptionCalls).toEqual([]);
    expect(pc.addIceCandidateCalls).toEqual([]);
    expect(signalingPort.offers).toEqual([]);
  });
});

describe('Peer — track publication', () => {
  it('adds a track to the underlying connection and removes it via the returned sender', () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createCallbacks());
    const track = fakeAudioTrack();

    peer.addTrack(track);
    expect(pc.addTrackCalls).toEqual([track]);
    const sender = pc.senderFor(track);
    expect(sender).toBeDefined();

    peer.removeTrack(track);
    expect(pc.removeTrackCalls).toEqual([sender]);
  });

  it('does not add the same track twice', () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createCallbacks());
    const track = fakeAudioTrack();

    peer.addTrack(track);
    peer.addTrack(track);

    expect(pc.addTrackCalls).toHaveLength(1);
  });

  it('removing an untracked track is a no-op', () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createCallbacks());

    peer.removeTrack(fakeAudioTrack());

    expect(pc.removeTrackCalls).toEqual([]);
  });
});

describe('Peer — races between negotiation and local teardown', () => {
  it('close() during an in-flight handleRemoteOffer prevents the answer from ever being sent', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'responder', pc, createCallbacks());
    const deferred = createDeferred<undefined>();
    pc.setRemoteDescriptionImpl = () => deferred.promise;

    const handling = peer.handleRemoteOffer('remote-offer-sdp', signalingPort);
    expect(pc.setRemoteDescriptionCalls).toHaveLength(1); // the call started

    peer.close();
    deferred.resolve(undefined); // the remote description "finishes applying" only after teardown began

    await expect(handling).resolves.toBeUndefined();
    expect(pc.setLocalDescriptionCalls).toEqual([]); // never reached createAnswer/setLocalDescription
    expect(signalingPort.answers).toEqual([]);
  });

  it('close() during an in-flight createAndSendOffer prevents the offer from ever being sent', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'initiator', pc, createCallbacks());
    const deferred = createDeferred<RTCSessionDescriptionInit>();
    pc.createOfferImpl = () => deferred.promise;

    const creating = peer.createAndSendOffer(signalingPort);
    peer.close();
    deferred.resolve({ type: 'offer', sdp: 'too-late-offer-sdp' });

    await expect(creating).resolves.toBeUndefined();
    expect(pc.setLocalDescriptionCalls).toEqual([]);
    expect(signalingPort.offers).toEqual([]);
  });

  it('a candidate arriving for a peer that started closing mid-apply is a controlled no-op', async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createCallbacks());
    await peer.handleRemoteAnswer('remote-answer-sdp'); // marks remote description set
    const deferred = createDeferred<undefined>();
    pc.addIceCandidateImpl = () => deferred.promise;

    const applying = peer.handleRemoteIceCandidate({ candidate: 'candidate:1', sdpMLineIndex: 0 });
    peer.close();
    deferred.resolve(undefined);

    await expect(applying).resolves.toBeUndefined();
  });
});

describe('Peer — genuine (non-race) negotiation failures still propagate', () => {
  it('rejects when addIceCandidate genuinely fails and the peer is not closing', async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createCallbacks());
    await peer.handleRemoteAnswer('remote-answer-sdp');
    const failure = new Error('m-line mismatch');
    pc.addIceCandidateImpl = () => Promise.reject(failure);

    await expect(
      peer.handleRemoteIceCandidate({ candidate: 'candidate:1', sdpMLineIndex: 0 }),
    ).rejects.toBe(failure);
  });
});

describe('Peer — remote track and stats', () => {
  it('forwards the first stream from an ontrack event', () => {
    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    new Peer('peer-1', 'initiator', pc, callbacks);
    const track = fakeAudioTrack();
    const stream = {} as MediaStream;

    pc.ontrack?.({ track, streams: [stream] } as unknown as RTCTrackEvent);

    expect(callbacks.remoteTracks).toEqual([{ track, stream }]);
  });

  it('synthesizes a stream when ontrack provides an empty streams array', () => {
    class FakeMediaStream {
      constructor(public readonly tracks: MediaStreamTrack[]) {}
    }
    vi.stubGlobal('MediaStream', FakeMediaStream);

    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    new Peer('peer-1', 'initiator', pc, callbacks);
    const track = fakeAudioTrack();

    pc.ontrack?.({ track, streams: [] } as unknown as RTCTrackEvent);

    expect(callbacks.remoteTracks).toHaveLength(1);
    expect(callbacks.remoteTracks[0]?.track).toBe(track);
    expect(callbacks.remoteTracks[0]?.stream).toBeInstanceOf(FakeMediaStream);
  });

  it('delegates getStats to the underlying connection', async () => {
    const pc = new FakePeerConnection();
    const statsReport = { fake: true } as unknown as RTCStatsReport;
    pc.getStatsImpl = () => Promise.resolve(statsReport);
    const peer = new Peer('peer-1', 'initiator', pc, createCallbacks());

    await expect(peer.getStats()).resolves.toBe(statsReport);
  });
});
