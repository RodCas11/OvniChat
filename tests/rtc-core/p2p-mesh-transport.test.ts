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

  it('a newly-added peer receives every currently published track, even multiple ones added mid-session', () => {
    const { transport, connections } = createTransport();
    const micTrack = fakeAudioTrack('mic-track');
    const cameraTrack = fakeAudioTrack('camera-track'); // kind is irrelevant to this transport

    transport.publishTrack(micTrack);
    transport.addParticipant('peer-1', 'responder');
    transport.publishTrack(cameraTrack); // published after peer-1 already joined

    // peer-2 joins later, after both tracks are already published — regression coverage for T4's
    // camera-as-a-second-track scenario: no special-casing needed for a late joiner.
    transport.addParticipant('peer-2', 'responder');

    const pcs = [...connections.values()];
    expect(pcs).toHaveLength(2);
    for (const pc of pcs) {
      expect(pc.addTrackCalls).toEqual(expect.arrayContaining([micTrack, cameraTrack]));
      expect(pc.addTrackCalls).toHaveLength(2);
    }
  });

  it('a participant publishing mic + camera + a second independent video track (screen) reaches an existing peer and a newly-added peer, and unpublishing one video track leaves the other two intact (T5 regression)', () => {
    // Coverage for T5's three-simultaneous-source scenario (microphone + camera + screen-video):
    // this transport is track-kind-agnostic and was already proven for two simultaneous tracks
    // (T4's camera-as-a-second-track case above) — this proves the same holds for three, including
    // two video tracks published side by side, with zero transport code changes.
    const { transport, connections } = createTransport();
    const micTrack = fakeAudioTrack('mic-track');
    const cameraTrack = fakeAudioTrack('camera-track'); // kind is irrelevant to this transport
    const screenTrack = fakeAudioTrack('screen-track'); // a second, independent video-shaped track

    transport.addParticipant('peer-existing', 'responder');
    transport.publishTrack(micTrack);
    transport.publishTrack(cameraTrack);
    transport.publishTrack(screenTrack);

    const existingPc = [...connections.values()][0];
    expect(existingPc?.addTrackCalls).toEqual(
      expect.arrayContaining([micTrack, cameraTrack, screenTrack]),
    );
    expect(existingPc?.addTrackCalls).toHaveLength(3);

    // A newly-added peer, joining after all three tracks are already published, receives all three
    // with no special-casing needed for a late joiner.
    transport.addParticipant('peer-new', 'responder');
    const newPc = [...connections.values()][1];
    expect(newPc?.addTrackCalls).toEqual(
      expect.arrayContaining([micTrack, cameraTrack, screenTrack]),
    );
    expect(newPc?.addTrackCalls).toHaveLength(3);

    // Unpublishing just the screen track removes only that track's sender from every peer, leaving
    // the microphone and camera tracks (in particular, the *other* video track) untouched.
    transport.unpublishTrack(screenTrack);

    for (const pc of [existingPc, newPc]) {
      expect(pc?.removeTrackCalls).toHaveLength(1);
      expect(pc?.addTrackCalls).toEqual(
        expect.arrayContaining([micTrack, cameraTrack, screenTrack]),
      );
    }
  });

  it('a participant publishing all four sources (mic + camera + screen-video + screen-audio) reaches an existing peer and a newly-added peer, and unpublishing screen-audio leaves the other three intact (T6 regression)', () => {
    // Coverage for T6's fourth simultaneous source (screen-audio): this transport is
    // track-kind-agnostic and was already proven for three simultaneous tracks (T5's test above) —
    // this proves the same holds for four, including two audio tracks published side by side
    // (mirroring T5's two-video-tracks case), with zero transport code changes.
    const { transport, connections } = createTransport();
    const micTrack = fakeAudioTrack('mic-track');
    const cameraTrack = fakeAudioTrack('camera-track'); // kind is irrelevant to this transport
    const screenVideoTrack = fakeAudioTrack('screen-video-track');
    const screenAudioTrack = fakeAudioTrack('screen-audio-track'); // a second, independent audio-shaped track

    transport.addParticipant('peer-existing', 'responder');
    transport.publishTrack(micTrack);
    transport.publishTrack(cameraTrack);
    transport.publishTrack(screenVideoTrack);
    transport.publishTrack(screenAudioTrack);

    const existingPc = [...connections.values()][0];
    expect(existingPc?.addTrackCalls).toEqual(
      expect.arrayContaining([micTrack, cameraTrack, screenVideoTrack, screenAudioTrack]),
    );
    expect(existingPc?.addTrackCalls).toHaveLength(4);

    // A newly-added peer, joining after all four tracks are already published, receives all four
    // with no special-casing needed for a late joiner.
    transport.addParticipant('peer-new', 'responder');
    const newPc = [...connections.values()][1];
    expect(newPc?.addTrackCalls).toEqual(
      expect.arrayContaining([micTrack, cameraTrack, screenVideoTrack, screenAudioTrack]),
    );
    expect(newPc?.addTrackCalls).toHaveLength(4);

    // Unpublishing just screen-audio removes only that track's sender from every peer, leaving the
    // microphone (the *other* audio track), camera, and screen-video untouched.
    transport.unpublishTrack(screenAudioTrack);

    for (const pc of [existingPc, newPc]) {
      expect(pc?.removeTrackCalls).toHaveLength(1);
      expect(pc?.addTrackCalls).toEqual(
        expect.arrayContaining([micTrack, cameraTrack, screenVideoTrack, screenAudioTrack]),
      );
    }
  });

  it('repeated publish/unpublish/publish cycles on the same track do not accumulate sender bookkeeping (T5 regression)', () => {
    // Coverage for T5's requirement that screen share's on/off/on/off/on toggling never leaks or
    // duplicates sender state — exercises `Peer`'s own `Map<MediaStreamTrack, RTCRtpSender>`
    // bookkeeping (`packages/rtc-core/src/peer.ts`) across several cycles on the *same* track
    // object, the shape a repeated screen-share toggle actually produces (unlike camera/mic, which
    // acquire a fresh track each time, screen sharing's own `acquireScreen()` also always returns a
    // fresh track per T5's design — this test additionally covers the same-track-object case in
    // case a future caller ever reuses one).
    const { transport, connections } = createTransport();
    transport.addParticipant('peer-1', 'responder');
    const track = fakeAudioTrack('screen-track');

    transport.publishTrack(track);
    transport.unpublishTrack(track);
    transport.publishTrack(track);
    transport.unpublishTrack(track);
    transport.publishTrack(track);

    const pc = [...connections.values()][0];
    // Three publishes, two unpublishes — each cycle re-adds cleanly with no extra or missing calls
    // from stale bookkeeping (e.g. a later `addTrack` silently no-op'ing because `Peer.senders`
    // still held a reference from a previous, already-unpublished cycle).
    expect(pc?.addTrackCalls).toHaveLength(3);
    expect(pc?.removeTrackCalls).toHaveLength(2);
  });

  it('unpublishing a track that was never published is a no-op', () => {
    const { transport, connections } = createTransport();
    transport.addParticipant('peer-1', 'responder');

    transport.unpublishTrack(fakeAudioTrack());

    const pc = [...connections.values()][0];
    expect(pc?.removeTrackCalls).toEqual([]);
  });
});

describe('P2PMeshTransport — renegotiation wiring (T4)', () => {
  it('publishing a track to an already-negotiated peer triggers a fresh offer once negotiationneeded fires', async () => {
    const { transport, connections, signalingPort } = createTransport();
    transport.addParticipant('peer-1', 'initiator');
    await flushMicrotasks(); // the initial offer completes -> that peer's Peer.negotiated becomes true
    expect(signalingPort.offers).toHaveLength(1);

    const cameraTrack = fakeAudioTrack('camera-track');
    transport.publishTrack(cameraTrack);
    const pc = [...connections.values()][0];
    pc?.onnegotiationneeded?.(new Event('negotiationneeded'));
    await flushMicrotasks();

    expect(signalingPort.offers).toHaveLength(2);
  });

  it('does not double-offer when negotiationneeded fires before the initial offer is sent', () => {
    const { transport, connections, signalingPort } = createTransport();
    transport.addParticipant('peer-1', 'initiator');
    // Fires synchronously, before the initial createAndSendOffer's awaited setLocalDescription()
    // resolves — negotiated is still false at this point.
    const pc = [...connections.values()][0];
    pc?.onnegotiationneeded?.(new Event('negotiationneeded'));

    expect(signalingPort.offers).toEqual([]);
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
    const events: { participantId: string; track: MediaStreamTrack; mid: string | null }[] = [];
    transport.on('remoteTrack', (event) => events.push(event));

    const pc = [...connections.values()][0];
    const track = fakeAudioTrack();
    const stream = {} as MediaStream;
    pc?.ontrack?.({ track, streams: [stream] } as unknown as RTCTrackEvent);

    expect(events).toEqual([{ participantId: 'peer-1', track, stream, mid: null }]);
  });

  it('attributes a remote track to its negotiated mid when the platform reports one', () => {
    const { transport, connections } = createTransport();
    transport.addParticipant('peer-1', 'responder');
    const events: { participantId: string; track: MediaStreamTrack; mid: string | null }[] = [];
    transport.on('remoteTrack', (event) => events.push(event));

    const pc = [...connections.values()][0];
    const track = fakeAudioTrack();
    const stream = {} as MediaStream;
    pc?.ontrack?.({
      track,
      streams: [stream],
      transceiver: { mid: '2' },
    } as unknown as RTCTrackEvent);

    expect(events).toEqual([{ participantId: 'peer-1', track, stream, mid: '2' }]);
  });

  it('reports a local track mid once this side sends an offer that includes it (T5)', async () => {
    const { transport, signalingPort } = createTransport();
    const midEvents: { participantId: string; track: MediaStreamTrack; mid: string }[] = [];
    transport.on('localTrackMid', (event) => midEvents.push(event));

    const track = fakeAudioTrack('screen-track');
    transport.publishTrack(track);
    transport.addParticipant('peer-1', 'initiator'); // seeds the track, then sends the initial offer
    await flushMicrotasks();

    expect(signalingPort.offers).toHaveLength(1);
    expect(midEvents).toEqual([{ participantId: 'peer-1', track, mid: '0' }]);
  });

  it(
    'QA regression (T5 finding): unpublishing one video-shaped track and publishing a ' +
      'different one reuses the freed transceiver and its already-negotiated mid, exactly like a ' +
      'real platform reusing a transceiver whose sender track was cleared',
    async () => {
      // This is deliberately NOT exercised by the higher-level renderer reconciliation
      // (`use-voice-channel.ts`) or by the T5 E2E smoke test, which never frees and then reuses a
      // video-kind transceiver for a *different* semantic source in the same run (camera stays on
      // for the whole scenario; screen always gets its own fresh transceiver). This test only
      // establishes the mid-reuse *precondition* is real and reachable through the actual
      // `P2PMeshTransport`/`Peer` product code path — see `FakePeerConnection.addTrack`'s doc
      // comment for why the fake now models this (it previously always created a brand-new
      // transceiver per `addTrack`, which could never represent this case). It intentionally does
      // NOT assert anything about `use-voice-channel.ts`'s `wireRemoteVideoTrack` reconciliation,
      // which lives in the renderer and has no test harness yet (flagged separately in QA review) —
      // if that reconciliation's 'mute'/'unmute' listeners are bound once at first-wire time using
      // the source known *then*, this mid-reuse precondition is what would let a later, different
      // source's frames be delivered under a stale camera/screen classification.
      const { transport, connections, signalingPort } = createTransport();
      const midEvents: { participantId: string; track: MediaStreamTrack; mid: string }[] = [];
      transport.on('localTrackMid', (event) => midEvents.push(event));

      transport.addParticipant('peer-1', 'initiator');
      await flushMicrotasks();
      expect(signalingPort.offers).toHaveLength(1);

      const pc = [...connections.values()][0];
      const cameraTrack = fakeAudioTrack('camera-track'); // kind is irrelevant to this transport/fake
      transport.publishTrack(cameraTrack);
      pc?.onnegotiationneeded?.(new Event('negotiationneeded'));
      await flushMicrotasks();
      expect(signalingPort.offers).toHaveLength(2);
      const cameraMidEvent = midEvents.find((event) => event.track === cameraTrack);
      expect(cameraMidEvent?.mid).toBeDefined();
      const cameraMid = cameraMidEvent?.mid;

      transport.unpublishTrack(cameraTrack);
      pc?.onnegotiationneeded?.(new Event('negotiationneeded'));
      await flushMicrotasks();
      expect(signalingPort.offers).toHaveLength(3);

      const screenTrack = fakeAudioTrack('screen-track'); // a different track, a different source
      transport.publishTrack(screenTrack);
      pc?.onnegotiationneeded?.(new Event('negotiationneeded'));
      await flushMicrotasks();
      expect(signalingPort.offers).toHaveLength(4);

      const screenMidEvent = midEvents.find((event) => event.track === screenTrack);
      // The crux of the finding: the *different* track (screen) is reported under the exact same
      // mid the camera track previously held — this is real transceiver reuse, not a fresh m-line —
      // proving `(participantId, mid)` alone cannot assume it always identifies a *single* logical
      // track's lifetime; the same key can legitimately carry a different semantic source over time.
      expect(screenMidEvent?.mid).toBe(cameraMid);
    },
  );

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
