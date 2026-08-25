import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  ICE_RECOVERY_INITIAL_DELAY_MS,
  ICE_RECOVERY_MAX_ATTEMPTS,
  Peer,
  type PeerCallbacks,
} from '../../packages/rtc-core/src/peer.js';
import type { SignalingPort } from '../../packages/rtc-core/src/types.js';
import { FakePeerConnection, createDeferred, fakeAudioTrack } from './fake-peer-connection.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

function createCallbacks(): PeerCallbacks & {
  remoteTracks: { track: MediaStreamTrack; stream: MediaStream; mid: string | null }[];
  localTrackMids: { track: MediaStreamTrack; mid: string }[];
  stateChanges: {
    connectionState: RTCPeerConnectionState;
    iceConnectionState: RTCIceConnectionState;
  }[];
  terminalCount: number;
  iceCandidates: (RTCIceCandidateInit | null)[];
} {
  const remoteTracks: { track: MediaStreamTrack; stream: MediaStream; mid: string | null }[] = [];
  const localTrackMids: { track: MediaStreamTrack; mid: string }[] = [];
  const stateChanges: {
    connectionState: RTCPeerConnectionState;
    iceConnectionState: RTCIceConnectionState;
  }[] = [];
  const iceCandidates: (RTCIceCandidateInit | null)[] = [];
  const callbacks = {
    remoteTracks,
    localTrackMids,
    stateChanges,
    iceCandidates,
    terminalCount: 0,
    onRemoteTrack: (track: MediaStreamTrack, stream: MediaStream, mid: string | null) => {
      remoteTracks.push({ track, stream, mid });
    },
    onLocalTrackMid: (track: MediaStreamTrack, mid: string) => {
      localTrackMids.push({ track, mid });
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
    const peer = new Peer('peer-1', 'initiator', pc, signalingPort, createCallbacks());

    await peer.createAndSendOffer();

    expect(pc.setLocalDescriptionCalls).toEqual([{ type: 'offer', sdp: 'fake-offer-sdp' }]);
    expect(signalingPort.offers).toEqual([
      { targetParticipantId: 'peer-1', sdp: 'fake-offer-sdp' },
    ]);
    expect(signalingPort.answers).toEqual([]);
  });

  it('a responder never creates an offer, only answers an inbound one', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'responder', pc, signalingPort, createCallbacks());

    await peer.handleRemoteOffer('remote-offer-sdp');

    expect(signalingPort.offers).toEqual([]);
    expect(pc.setRemoteDescriptionCalls).toEqual([{ type: 'offer', sdp: 'remote-offer-sdp' }]);
    expect(pc.setLocalDescriptionCalls).toEqual([{ type: 'answer', sdp: 'fake-answer-sdp' }]);
    expect(signalingPort.answers).toEqual([
      { targetParticipantId: 'peer-1', sdp: 'fake-answer-sdp' },
    ]);
  });

  it(
    'T6 regression: a track published before the initial handshake (e.g. microphone, seeded before ' +
      'the first offer/answer) has its mid reported even on the *responder* side, which only ever ' +
      'answers and never offers for that initial cycle',
    async () => {
      // Live-found gap: `createAndSendOffer()` always called `reportLocalTrackMids()`, but
      // `handleRemoteOffer()` (the responder's only path for the initial handshake) never did.
      // Harmless as long as every track needing an announcement was added *after* the initial
      // handshake (true for camera/screen, always user-enabled post-join, so their mids were always
      // reported via a later renegotiation `createAndSendOffer()` regardless of role) — but T6 made
      // microphone require the same announcement mechanism, and microphone is seeded *before* the
      // peer connection is even created, landing it in the very first offer/answer cycle. A pure
      // responder (this test) would previously never report its own microphone's mid at all.
      const pc = new FakePeerConnection();
      const signalingPort = createFakeSignalingPort();
      const callbacks = createCallbacks();
      const peer = new Peer('peer-1', 'responder', pc, signalingPort, callbacks);
      const micTrack = fakeAudioTrack('mic-track');
      peer.addTrack(micTrack); // seeded before any negotiation, mirroring P2PMeshTransport.addParticipant

      await peer.handleRemoteOffer('remote-offer-sdp');

      const micMidEvent = callbacks.localTrackMids.find((event) => event.track === micTrack);
      expect(micMidEvent?.mid).toBeDefined();
    },
  );
});

describe('Peer — ICE candidate queueing', () => {
  it('queues a candidate that arrives before the remote description is applied, then flushes it in order', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'responder', pc, signalingPort, createCallbacks());
    const early: RTCIceCandidateInit = { candidate: 'candidate:early', sdpMLineIndex: 0 };

    await peer.handleRemoteIceCandidate(early);
    expect(pc.addIceCandidateCalls).toEqual([]); // not applied yet — queued

    await peer.handleRemoteOffer('remote-offer-sdp');

    expect(pc.addIceCandidateCalls).toEqual([early]);
  });

  it('applies a candidate immediately once the remote description is already set', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'initiator', pc, signalingPort, createCallbacks());

    await peer.handleRemoteAnswer('remote-answer-sdp');
    const late: RTCIceCandidateInit = { candidate: 'candidate:late', sdpMLineIndex: 0 };

    await peer.handleRemoteIceCandidate(late);

    expect(pc.addIceCandidateCalls).toEqual([late]);
  });

  it('queues and flushes a null end-of-candidates signal like any other candidate', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'responder', pc, signalingPort, createCallbacks());

    await peer.handleRemoteIceCandidate(null);
    await peer.handleRemoteOffer('remote-offer-sdp');

    expect(pc.addIceCandidateCalls).toEqual([null]);
  });
});

describe('Peer — connection-state forwarding and terminal cleanup', () => {
  it('forwards every state change, and no longer reports terminal the instant "failed" appears (T15.2)', () => {
    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), callbacks);

    pc.connectionState = 'connecting';
    pc.onconnectionstatechange?.(new Event('connectionstatechange'));
    pc.connectionState = 'failed';
    pc.onconnectionstatechange?.(new Event('connectionstatechange'));
    // A second dispatch of the same state must stay absorbed, not restart or terminate anything.
    pc.onconnectionstatechange?.(new Event('connectionstatechange'));

    expect(callbacks.stateChanges).toHaveLength(3);
    // Pre-T15.2 this was the point a failed peer was destroyed for the rest of the session. It now
    // enters bounded ICE-restart recovery instead; terminal is only reported once that is spent
    // (covered in detail by the recovery suite below).
    expect(callbacks.terminalCount).toBe(0);
  });

  it('reports terminal immediately for "closed" — no recovery is possible for a gone connection', () => {
    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), callbacks);

    pc.connectionState = 'closed';
    pc.onconnectionstatechange?.(new Event('connectionstatechange'));

    expect(callbacks.terminalCount).toBe(1);
  });

  it('does not treat "disconnected" as terminal', () => {
    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), callbacks);

    pc.connectionState = 'disconnected';
    pc.onconnectionstatechange?.(new Event('connectionstatechange'));

    expect(callbacks.terminalCount).toBe(0);
  });
});

describe('Peer — bounded ICE-failure recovery (T15.2)', () => {
  const turnServers: RTCIceServer[] = [
    { urls: 'turn:turn.example.com:3478', username: 'fake-user', credential: 'fake-credential' },
  ];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Drives a `Peer` to `'failed'` through the same platform dispatch a real connection would. */
  function fail(pc: FakePeerConnection): void {
    pc.connectionState = 'failed';
    pc.iceConnectionState = 'failed';
    pc.onconnectionstatechange?.(new Event('connectionstatechange'));
  }

  function establish(pc: FakePeerConnection): void {
    pc.connectionState = 'connected';
    pc.iceConnectionState = 'connected';
    pc.onconnectionstatechange?.(new Event('connectionstatechange'));
  }

  it('does not restart ICE immediately on failure — the first attempt waits out the initial backoff', () => {
    const pc = new FakePeerConnection();
    new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());

    fail(pc);
    expect(pc.restartIceCallCount).toBe(0);

    vi.advanceTimersByTime(ICE_RECOVERY_INITIAL_DELAY_MS - 1);
    expect(pc.restartIceCallCount).toBe(0);

    vi.advanceTimersByTime(1);
    expect(pc.restartIceCallCount).toBe(1);
  });

  it('makes exactly ICE_RECOVERY_MAX_ATTEMPTS restarts, spaced by the documented exponential backoff', () => {
    const pc = new FakePeerConnection();
    new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());

    fail(pc);

    // 1s, then 3s, then 9s — the connection stays "failed" throughout, as a genuinely broken path
    // would.
    vi.advanceTimersByTime(1_000);
    expect(pc.restartIceCallCount).toBe(1);
    vi.advanceTimersByTime(2_999);
    expect(pc.restartIceCallCount).toBe(1);
    vi.advanceTimersByTime(1);
    expect(pc.restartIceCallCount).toBe(2);
    vi.advanceTimersByTime(9_000);
    expect(pc.restartIceCallCount).toBe(3);

    // And then no more, ever — not after the next window, not after an hour.
    vi.advanceTimersByTime(60 * 60 * 1_000);
    expect(pc.restartIceCallCount).toBe(ICE_RECOVERY_MAX_ATTEMPTS);
  });

  it('a storm of repeated "failed" dispatches produces no extra restarts', () => {
    const pc = new FakePeerConnection();
    new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());

    // Both platform events fire for the same transition, and a real connection re-dispatches while
    // it stays failed. None of this may multiply the retry budget.
    for (let i = 0; i < 25; i += 1) {
      pc.connectionState = 'failed';
      pc.iceConnectionState = 'failed';
      pc.onconnectionstatechange?.(new Event('connectionstatechange'));
      pc.oniceconnectionstatechange?.(new Event('iceconnectionstatechange'));
    }
    vi.advanceTimersByTime(60 * 60 * 1_000);

    expect(pc.restartIceCallCount).toBe(ICE_RECOVERY_MAX_ATTEMPTS);
  });

  it('reports terminal exactly once, only after the final attempt has had its own verdict window', () => {
    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), callbacks);

    fail(pc);
    // 1 + 3 + 9 = 13s covers all three attempts; terminal must not be declared yet.
    vi.advanceTimersByTime(13_000);
    expect(pc.restartIceCallCount).toBe(3);
    expect(callbacks.terminalCount).toBe(0);

    // The 27s window after the third attempt is what decides the user-visible failure.
    vi.advanceTimersByTime(26_999);
    expect(callbacks.terminalCount).toBe(0);
    vi.advanceTimersByTime(1);
    expect(callbacks.terminalCount).toBe(1);

    vi.advanceTimersByTime(60 * 60 * 1_000);
    expect(callbacks.terminalCount).toBe(1);
  });

  it('stops the chain the moment the peer recovers, and never reports terminal', () => {
    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), callbacks);

    fail(pc);
    vi.advanceTimersByTime(1_000);
    expect(pc.restartIceCallCount).toBe(1);

    establish(pc);
    vi.advanceTimersByTime(60 * 60 * 1_000);

    expect(pc.restartIceCallCount).toBe(1);
    expect(callbacks.terminalCount).toBe(0);
  });

  it('a peer that failed, recovered, then fails again much later gets a full fresh retry budget', () => {
    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), callbacks);

    fail(pc);
    vi.advanceTimersByTime(4_000); // two attempts spent
    expect(pc.restartIceCallCount).toBe(2);
    establish(pc);
    vi.advanceTimersByTime(60 * 60 * 1_000);
    expect(pc.restartIceCallCount).toBe(2);

    // A completely unrelated later failure must not inherit the one remaining attempt.
    fail(pc);
    vi.advanceTimersByTime(13_000);
    expect(pc.restartIceCallCount).toBe(2 + ICE_RECOVERY_MAX_ATTEMPTS);
    expect(callbacks.terminalCount).toBe(0);
    vi.advanceTimersByTime(27_000);
    expect(callbacks.terminalCount).toBe(1);
  });

  it('leaves a restart that is still checking alone, and resumes the remaining budget when the platform gives up again', () => {
    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), callbacks);

    fail(pc);
    vi.advanceTimersByTime(1_000);
    expect(pc.restartIceCallCount).toBe(1);

    // The restart is genuinely in progress: nothing has failed *again* yet, so nothing may be
    // retried or declared terminal on this side — the ICE agent's own timeouts own this window.
    pc.connectionState = 'connecting';
    pc.iceConnectionState = 'checking';
    vi.advanceTimersByTime(60 * 60 * 1_000);
    expect(pc.restartIceCallCount).toBe(1);
    expect(callbacks.terminalCount).toBe(0);

    // The platform eventually gives up. The chain resumes with what is left of the budget — two more
    // attempts, not a fresh three, because this is the same unresolved incident.
    fail(pc);
    vi.advanceTimersByTime(3_000 + 9_000);
    expect(pc.restartIceCallCount).toBe(ICE_RECOVERY_MAX_ATTEMPTS);
    vi.advanceTimersByTime(27_000);
    expect(callbacks.terminalCount).toBe(1);
  });

  it('never restarts a peer that is merely "disconnected" — the transient state stays untouched', () => {
    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), callbacks);

    pc.connectionState = 'disconnected';
    pc.iceConnectionState = 'disconnected';
    pc.onconnectionstatechange?.(new Event('connectionstatechange'));
    pc.oniceconnectionstatechange?.(new Event('iceconnectionstatechange'));
    vi.advanceTimersByTime(60 * 60 * 1_000);

    expect(pc.restartIceCallCount).toBe(0);
    expect(pc.setConfigurationCalls).toEqual([]);
    expect(callbacks.terminalCount).toBe(0);
  });

  it('recovers against the newest known ICE servers, including a refresh that arrived while it was healthy', () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());

    // Established first: a replacement credential must be recorded but must not disturb the call.
    establish(pc);
    expect(peer.applyIceServers(turnServers)).toBe(false);
    expect(pc.setConfigurationCalls).toEqual([]);
    expect(pc.restartIceCallCount).toBe(0);

    fail(pc);
    vi.advanceTimersByTime(1_000);

    expect(pc.setConfigurationCalls).toHaveLength(1);
    expect(pc.setConfigurationCalls[0]?.iceServers).toEqual(turnServers);
    expect(pc.restartIceCallCount).toBe(1);
  });

  it('restarts without touching the configuration when no ICE server list was ever supplied', () => {
    const pc = new FakePeerConnection();
    new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());

    fail(pc);
    vi.advanceTimersByTime(1_000);

    expect(pc.setConfigurationCalls).toEqual([]);
    expect(pc.restartIceCallCount).toBe(1);
  });

  it('close() cancels an armed recovery timer — a departed participant leaks nothing', () => {
    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    const peer = new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), callbacks);

    fail(pc);
    peer.close();
    vi.advanceTimersByTime(60 * 60 * 1_000);

    expect(pc.restartIceCallCount).toBe(0);
    expect(callbacks.terminalCount).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a connection that throws on every restart still converges on terminal instead of looping', () => {
    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const peer = new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), callbacks);
    // A known ICE server list is what makes the recovery path call `setConfiguration` at all.
    peer.applyIceServers(turnServers);
    pc.setConfigurationImpl = () => {
      throw new Error('InvalidStateError');
    };

    fail(pc);
    vi.advanceTimersByTime(60 * 60 * 1_000);

    // Every attempt threw, yet the budget was still consumed and the verdict was still reached —
    // the alternative (a rejected restart not counting) would be an unbounded loop.
    expect(callbacks.terminalCount).toBe(1);
    expect(consoleError).toHaveBeenCalledTimes(ICE_RECOVERY_MAX_ATTEMPTS);
    consoleError.mockRestore();
  });

  it('never logs a credential value from the retry path, at any level', () => {
    const pc = new FakePeerConnection();
    const logged: string[] = [];
    const capture = (...args: unknown[]): void => {
      logged.push(args.map((a) => JSON.stringify(a) ?? String(a)).join(' '));
    };
    const spies = [
      vi.spyOn(console, 'error').mockImplementation(capture),
      vi.spyOn(console, 'warn').mockImplementation(capture),
      vi.spyOn(console, 'info').mockImplementation(capture),
      vi.spyOn(console, 'log').mockImplementation(capture),
      vi.spyOn(console, 'debug').mockImplementation(capture),
    ];
    const peer = new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());
    peer.applyIceServers(turnServers);
    // Force the retry path's own error branch, which is the one place a naive implementation would
    // dump the whole configuration into a log line.
    pc.setConfigurationImpl = () => {
      throw new Error('InvalidStateError');
    };

    fail(pc);
    vi.advanceTimersByTime(60 * 60 * 1_000);

    for (const spy of spies) spy.mockRestore();
    expect(logged.join('\n')).not.toContain('fake-credential');
    expect(logged.join('\n')).not.toContain('fake-user');
  });

  it('an already-negotiated peer turns a recovery restart into a real renegotiation offer', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'initiator', pc, signalingPort, createCallbacks());
    await peer.createAndSendOffer();
    expect(signalingPort.offers).toHaveLength(1);

    fail(pc);
    await vi.advanceTimersByTimeAsync(1_000);

    // Produced by the platform's own negotiationneeded -> createAndSendOffer path, not by a second
    // offer-scheduling mechanism inside the recovery code.
    expect(signalingPort.offers).toHaveLength(2);
  });
});

describe('Peer — ICE candidate forwarding to signaling', () => {
  it('forwards a locally generated candidate via onicecandidate', () => {
    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), callbacks);
    const candidate = { toJSON: () => ({ candidate: 'candidate:1', sdpMLineIndex: 0 }) };

    pc.onicecandidate?.({ candidate } as unknown as RTCPeerConnectionIceEvent);

    expect(callbacks.iceCandidates).toEqual([{ candidate: 'candidate:1', sdpMLineIndex: 0 }]);
  });

  it('forwards null for the end-of-candidates signal', () => {
    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), callbacks);

    pc.onicecandidate?.({ candidate: null } as unknown as RTCPeerConnectionIceEvent);

    expect(callbacks.iceCandidates).toEqual([null]);
  });
});

describe('Peer — close() idempotency and cleanup', () => {
  it('closes the underlying connection exactly once no matter how many times close() is called', () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());

    peer.close();
    peer.close();
    peer.close();

    expect(pc.closeCallCount).toBe(1);
  });

  it('detaches every event handler on close so late platform dispatches are inert', () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());

    peer.close();

    expect(pc.ontrack).toBeNull();
    expect(pc.onicecandidate).toBeNull();
    expect(pc.onconnectionstatechange).toBeNull();
    expect(pc.oniceconnectionstatechange).toBeNull();
    expect(pc.onnegotiationneeded).toBeNull();
  });

  it('reports isClosed after close()', () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());

    expect(peer.isClosed).toBe(false);
    peer.close();
    expect(peer.isClosed).toBe(true);
  });

  it('every public method is a no-op once closed, never throwing or rejecting', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'initiator', pc, signalingPort, createCallbacks());
    peer.close();

    peer.addTrack(fakeAudioTrack());
    await expect(peer.createAndSendOffer()).resolves.toBeUndefined();
    await expect(peer.handleRemoteOffer('sdp')).resolves.toBeUndefined();
    await expect(peer.handleRemoteAnswer('sdp')).resolves.toBeUndefined();
    await expect(peer.handleRemoteIceCandidate(null)).resolves.toBeUndefined();
    await expect(peer.getStats()).resolves.toBeUndefined();
    // A late negotiationneeded dispatch (the platform racing a synchronous close()) must also be
    // impossible to observe as work — but close() already nulled the handler, so this is really
    // asserting there is nothing left to dispatch to.
    expect(pc.onnegotiationneeded).toBeNull();

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
    const peer = new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());
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
    const peer = new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());
    const track = fakeAudioTrack();

    peer.addTrack(track);
    peer.addTrack(track);

    expect(pc.addTrackCalls).toHaveLength(1);
  });

  it('removing an untracked track is a no-op', () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());

    peer.removeTrack(fakeAudioTrack());

    expect(pc.removeTrackCalls).toEqual([]);
  });
});

describe('Peer — renegotiation (T4)', () => {
  it('does not offer when negotiationneeded fires before the initial handshake completes', () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'initiator', pc, signalingPort, createCallbacks());

    // Mirrors what a real browser does: addTrack (e.g. seeding an already-published microphone
    // track before the first offer is even sent) schedules negotiationneeded on its own.
    peer.addTrack(fakeAudioTrack());
    pc.onnegotiationneeded?.(new Event('negotiationneeded'));

    expect(signalingPort.offers).toEqual([]);
  });

  it('a track added to an already-negotiated peer triggers a fresh offer', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'initiator', pc, signalingPort, createCallbacks());

    await peer.createAndSendOffer(); // completes the initial handshake -> negotiated = true
    expect(signalingPort.offers).toHaveLength(1);

    peer.addTrack(fakeAudioTrack('camera-track'));
    pc.onnegotiationneeded?.(new Event('negotiationneeded'));
    await flushMicrotasks();

    expect(signalingPort.offers).toHaveLength(2);
    expect(pc.setLocalDescriptionCalls).toHaveLength(2);
  });

  it('a track removed from an already-negotiated peer triggers a fresh offer', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'initiator', pc, signalingPort, createCallbacks());
    const track = fakeAudioTrack('camera-track');
    peer.addTrack(track);

    await peer.createAndSendOffer();
    expect(signalingPort.offers).toHaveLength(1);

    peer.removeTrack(track);
    pc.onnegotiationneeded?.(new Event('negotiationneeded'));
    await flushMicrotasks();

    expect(signalingPort.offers).toHaveLength(2);
  });

  it('the responder also renegotiates once negotiated, after its initial handleRemoteOffer', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'responder', pc, signalingPort, createCallbacks());

    await peer.handleRemoteOffer('remote-offer-sdp'); // negotiated = true
    expect(signalingPort.answers).toHaveLength(1);

    peer.addTrack(fakeAudioTrack('camera-track'));
    pc.onnegotiationneeded?.(new Event('negotiationneeded'));
    await flushMicrotasks();

    expect(signalingPort.offers).toHaveLength(1);
  });

  it('a failed renegotiation offer is contained — no unhandled rejection escapes the handler', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'initiator', pc, signalingPort, createCallbacks());
    await peer.createAndSendOffer();

    const failure = new Error('createOffer failed');
    pc.createOfferImpl = () => Promise.reject(failure);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => pc.onnegotiationneeded?.(new Event('negotiationneeded'))).not.toThrow();
    await flushMicrotasks();

    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });

  it('a second negotiationneeded firing while an offer is already in flight does not start a second overlapping offer', async () => {
    // T5 stabilization: live camera-smoke runs showed both sides enabling a camera at
    // near-simultaneous startup, which can fire `negotiationneeded` again before this side's own
    // in-flight offer has resolved. Reproduces that by leaving `createOfferImpl` pending and firing
    // the event twice before letting it settle — the second firing must be dropped, not start a
    // second concurrent `setLocalDescription()`/offer.
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'initiator', pc, signalingPort, createCallbacks());
    await peer.createAndSendOffer(); // completes the initial handshake -> negotiated = true
    expect(signalingPort.offers).toHaveLength(1);

    const deferred = createDeferred<RTCSessionDescriptionInit>();
    pc.createOfferImpl = () => deferred.promise;

    peer.addTrack(fakeAudioTrack('camera-track'));
    pc.onnegotiationneeded?.(new Event('negotiationneeded')); // starts the renegotiation offer, still pending
    pc.onnegotiationneeded?.(new Event('negotiationneeded')); // must be dropped

    deferred.resolve({ type: 'offer', sdp: 'renegotiation-offer-sdp' });
    await flushMicrotasks();

    expect(signalingPort.offers).toHaveLength(2); // one initial + exactly one renegotiation offer
    expect(pc.setLocalDescriptionCalls).toHaveLength(2);
  });
});

describe('Peer — glare (perfect negotiation)', () => {
  it('the polite (responder) side rolls back its own offer and accepts a colliding inbound offer', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'responder', pc, signalingPort, createCallbacks());

    // Simulate this side already having a local offer outstanding when the collision happens.
    pc.signalingState = 'have-local-offer';

    await peer.handleRemoteOffer('colliding-offer-sdp');

    expect(pc.setLocalDescriptionCalls[0]).toEqual({ type: 'rollback' });
    expect(pc.setRemoteDescriptionCalls).toEqual([{ type: 'offer', sdp: 'colliding-offer-sdp' }]);
    expect(signalingPort.answers).toEqual([
      { targetParticipantId: 'peer-1', sdp: 'fake-answer-sdp' },
    ]);
  });

  it('the impolite (initiator) side ignores a colliding inbound offer outright', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'initiator', pc, signalingPort, createCallbacks());

    pc.signalingState = 'have-local-offer';

    await peer.handleRemoteOffer('colliding-offer-sdp');

    expect(pc.setRemoteDescriptionCalls).toEqual([]);
    expect(pc.setLocalDescriptionCalls).toEqual([]);
    expect(signalingPort.answers).toEqual([]);
  });

  it('the impolite side ignores a colliding offer that arrives while it is itself mid-createOffer', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'initiator', pc, signalingPort, createCallbacks());
    const deferred = createDeferred<RTCSessionDescriptionInit>();
    pc.createOfferImpl = () => deferred.promise;

    const offering = peer.createAndSendOffer(); // makingOffer = true while this is in flight
    await peer.handleRemoteOffer('colliding-offer-sdp');

    expect(pc.setRemoteDescriptionCalls).toEqual([]);
    expect(signalingPort.answers).toEqual([]);

    deferred.resolve({ type: 'offer', sdp: 'my-offer-sdp' });
    await offering;
  });

  it('T5 regression: the polite side handles a colliding remote offer while its own offer synthesis is still pending, without corruption once that pending offer resolves', async () => {
    // Reproduces the exact race the T4 security review flagged and T5 required fixed before
    // building further renegotiation on top of it: the *polite* side (the only side that does not
    // ignore a colliding inbound offer) starts its own renegotiation offer, and — before that
    // offer's `setLocalDescription()` call resolves — a colliding remote offer arrives and is
    // fully processed (rollback + apply + answer). See `Peer.createAndSendOffer`'s doc comment for
    // why routing through the atomic parameterless `setLocalDescription()` (rather than the old
    // separately-awaited `createOffer()` then `setLocalDescription(offer)` two-step) closes this:
    // there is no longer an application-observable gap for the collision to land in and no stale
    // pre-computed SDP is ever forwarded — `createAndSendOffer` always reads back whatever the
    // platform (`pc.localDescription`) reports as actually applied.
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'responder', pc, signalingPort, createCallbacks()); // polite
    const deferred = createDeferred<RTCSessionDescriptionInit>();
    pc.createOfferImpl = () => deferred.promise; // this side's own offer synthesis, left pending
    pc.signalingState = 'have-local-offer'; // this side already has a local offer outstanding

    const offering = peer.createAndSendOffer(); // makingOffer = true while this is in flight

    // The collision must still be handled (polite side never ignores), even though this side's own
    // offer synthesis has not resolved yet.
    await peer.handleRemoteOffer('colliding-offer-sdp');

    expect(pc.setLocalDescriptionCalls[0]).toEqual({ type: 'rollback' });
    expect(pc.setRemoteDescriptionCalls).toEqual([{ type: 'offer', sdp: 'colliding-offer-sdp' }]);
    expect(signalingPort.answers).toEqual([
      { targetParticipantId: 'peer-1', sdp: 'fake-answer-sdp' },
    ]);

    // The pending offer synthesis (started before the collision) now finally resolves. This must
    // not throw, and the answer already sent above must remain the pair's one settled outcome —
    // resolving late must not retroactively corrupt or duplicate what was already negotiated.
    deferred.resolve({ type: 'offer', sdp: 'late-offer-sdp' });
    await expect(offering).resolves.toBeUndefined();
    expect(signalingPort.answers).toHaveLength(1);
  });

  it('no collision (stable signaling state) still answers normally regardless of politeness', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'initiator', pc, signalingPort, createCallbacks());

    await peer.handleRemoteOffer('remote-offer-sdp');

    expect(pc.setRemoteDescriptionCalls).toEqual([{ type: 'offer', sdp: 'remote-offer-sdp' }]);
    expect(signalingPort.answers).toEqual([
      { targetParticipantId: 'peer-1', sdp: 'fake-answer-sdp' },
    ]);
  });
});

describe('Peer — races between negotiation and local teardown', () => {
  it('close() during an in-flight handleRemoteOffer prevents the answer from ever being sent', async () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'responder', pc, signalingPort, createCallbacks());
    const deferred = createDeferred<undefined>();
    pc.setRemoteDescriptionImpl = () => deferred.promise;

    const handling = peer.handleRemoteOffer('remote-offer-sdp');
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
    const peer = new Peer('peer-1', 'initiator', pc, signalingPort, createCallbacks());
    const deferred = createDeferred<RTCSessionDescriptionInit>();
    pc.createOfferImpl = () => deferred.promise;

    const creating = peer.createAndSendOffer();
    peer.close();
    deferred.resolve({ type: 'offer', sdp: 'too-late-offer-sdp' });

    // Since the T5 negotiation-race fix, `setLocalDescription()` is a single atomic call from
    // `Peer`'s point of view (see `Peer.createAndSendOffer`'s doc comment) — there is no longer an
    // intermediate checkpoint between "offer computed" and "offer applied" for `Peer` to bail out
    // of early, so the platform (here, the fake) does still end up with a local description
    // applied. What actually matters — and what a real closed `RTCPeerConnection` guarantees too,
    // since `Peer.close()` calls `this.pc.close()` synchronously before this resolves — is that the
    // now-closed `Peer` never forwards that stale offer to the signaling channel.
    await expect(creating).resolves.toBeUndefined();
    expect(signalingPort.offers).toEqual([]);
  });

  it('a candidate arriving for a peer that started closing mid-apply is a controlled no-op', async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());
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
    const peer = new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());
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
    new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), callbacks);
    const track = fakeAudioTrack();
    const stream = {} as MediaStream;

    pc.ontrack?.({ track, streams: [stream] } as unknown as RTCTrackEvent);

    expect(callbacks.remoteTracks).toEqual([{ track, stream, mid: null }]);
  });

  it('synthesizes a stream when ontrack provides an empty streams array', () => {
    class FakeMediaStream {
      constructor(public readonly tracks: MediaStreamTrack[]) {}
    }
    vi.stubGlobal('MediaStream', FakeMediaStream);

    const pc = new FakePeerConnection();
    const callbacks = createCallbacks();
    new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), callbacks);
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
    const peer = new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());

    await expect(peer.getStats()).resolves.toBe(statsReport);
  });
});

describe('Peer — replaceTrack (T11)', () => {
  it('swaps the sender to the new track without touching addTrack/removeTrack or triggering renegotiation', () => {
    const pc = new FakePeerConnection();
    const signalingPort = createFakeSignalingPort();
    const peer = new Peer('peer-1', 'initiator', pc, signalingPort, createCallbacks());
    const oldTrack = fakeAudioTrack('mic-old');
    const newTrack = fakeAudioTrack('mic-new');
    peer.addTrack(oldTrack);
    const sender = pc.senderFor(oldTrack);

    peer.replaceTrack(oldTrack, newTrack);

    expect(pc.replaceTrackCalls).toEqual([{ sender, newTrack }]);
    // No renegotiation: replaceTrack must not call addTrack/removeTrack again, and must not create
    // an offer — this is the entire point of using replaceTrack over remove+add.
    expect(pc.addTrackCalls).toEqual([oldTrack]);
    expect(pc.removeTrackCalls).toEqual([]);
    expect(pc.setLocalDescriptionCalls).toEqual([]);
    expect(signalingPort.offers).toEqual([]);
  });

  it('re-keys the internal sender map so removeTrack(newTrack) finds the same sender afterward', () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());
    const oldTrack = fakeAudioTrack('mic-old');
    const newTrack = fakeAudioTrack('mic-new');
    peer.addTrack(oldTrack);
    const sender = pc.senderFor(oldTrack);

    peer.replaceTrack(oldTrack, newTrack);
    peer.removeTrack(newTrack);

    expect(pc.removeTrackCalls).toEqual([sender]);
  });

  it('removeTrack(oldTrack) after a replaceTrack is a no-op — the old key is gone', () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());
    const oldTrack = fakeAudioTrack('mic-old');
    const newTrack = fakeAudioTrack('mic-new');
    peer.addTrack(oldTrack);

    peer.replaceTrack(oldTrack, newTrack);
    peer.removeTrack(oldTrack);

    expect(pc.removeTrackCalls).toEqual([]);
  });

  it('throws a clear error for a track with no known sender (never published to this peer)', () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());

    expect(() =>
      peer.replaceTrack(fakeAudioTrack('never-published'), fakeAudioTrack('new')),
    ).toThrow(/no known sender/);
  });

  it("is a no-op (not a throw) once the peer is closed, matching every other method's closed-is-controlled-no-op contract", () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());
    const oldTrack = fakeAudioTrack('mic-old');
    peer.addTrack(oldTrack);
    peer.close();

    expect(() => peer.replaceTrack(oldTrack, fakeAudioTrack('new'))).not.toThrow();
    expect(pc.replaceTrackCalls).toEqual([]);
  });

  it('a rejected platform replaceTrack() is logged, not thrown, and does not produce an unhandled rejection', async () => {
    const pc = new FakePeerConnection();
    const peer = new Peer('peer-1', 'initiator', pc, createFakeSignalingPort(), createCallbacks());
    const oldTrack = fakeAudioTrack('mic-old');
    peer.addTrack(oldTrack);
    const failure = new Error('replaceTrack failed');
    pc.replaceTrackImpl = () => Promise.reject(failure);
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => peer.replaceTrack(oldTrack, fakeAudioTrack('new'))).not.toThrow();
    await flushMicrotasks();

    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
