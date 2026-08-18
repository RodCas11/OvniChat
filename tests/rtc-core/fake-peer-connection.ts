import type { RtcPeerConnectionLike } from '../../packages/rtc-core/src/rtc-peer-connection.js';

/**
 * Not a `.test.ts` file — a shared test helper, excluded from vitest's `tests/**\/*.test.ts`
 * include pattern by name.
 *
 * A controllable stand-in for the platform `RTCPeerConnection`, implementing exactly
 * `RtcPeerConnectionLike` (see `rtc-peer-connection.ts` for why that narrower surface exists and
 * why it is safe to fake). This exercises `Peer`/`P2PMeshTransport` orchestration, sequencing, and
 * cleanup logic deterministically; it intentionally does not simulate real SDP negotiation, ICE
 * gathering, or media flow — those require a real browser engine (see the T3 report for what that
 * still requires).
 */
export class FakePeerConnection implements RtcPeerConnectionLike {
  connectionState: RTCPeerConnectionState = 'new';
  iceConnectionState: RTCIceConnectionState = 'new';

  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: ((event: Event) => void) | null = null;
  oniceconnectionstatechange: ((event: Event) => void) | null = null;

  readonly addTrackCalls: MediaStreamTrack[] = [];
  readonly removeTrackCalls: RTCRtpSender[] = [];
  readonly setLocalDescriptionCalls: RTCSessionDescriptionInit[] = [];
  readonly setRemoteDescriptionCalls: RTCSessionDescriptionInit[] = [];
  readonly addIceCandidateCalls: (RTCIceCandidateInit | null | undefined)[] = [];
  closeCallCount = 0;

  private readonly sendersByTrack = new Map<MediaStreamTrack, RTCRtpSender>();

  createOfferImpl: () => Promise<RTCSessionDescriptionInit> = () =>
    Promise.resolve({ type: 'offer', sdp: 'fake-offer-sdp' });
  createAnswerImpl: () => Promise<RTCSessionDescriptionInit> = () =>
    Promise.resolve({ type: 'answer', sdp: 'fake-answer-sdp' });
  setLocalDescriptionImpl: (description: RTCSessionDescriptionInit) => Promise<void> = () =>
    Promise.resolve();
  setRemoteDescriptionImpl: (description: RTCSessionDescriptionInit) => Promise<void> = () =>
    Promise.resolve();
  addIceCandidateImpl: (candidate: RTCIceCandidateInit | null | undefined) => Promise<void> = () =>
    Promise.resolve();
  getStatsImpl: () => Promise<RTCStatsReport> = () => Promise.resolve({} as RTCStatsReport);

  addTrack(track: MediaStreamTrack): RTCRtpSender {
    this.addTrackCalls.push(track);
    const sender = { track } as unknown as RTCRtpSender;
    this.sendersByTrack.set(track, sender);
    return sender;
  }

  removeTrack(sender: RTCRtpSender): void {
    this.removeTrackCalls.push(sender);
  }

  senderFor(track: MediaStreamTrack): RTCRtpSender | undefined {
    return this.sendersByTrack.get(track);
  }

  createOffer(): Promise<RTCSessionDescriptionInit> {
    return this.createOfferImpl();
  }

  createAnswer(): Promise<RTCSessionDescriptionInit> {
    return this.createAnswerImpl();
  }

  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.setLocalDescriptionCalls.push(description);
    return this.setLocalDescriptionImpl(description);
  }

  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.setRemoteDescriptionCalls.push(description);
    return this.setRemoteDescriptionImpl(description);
  }

  addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void> {
    this.addIceCandidateCalls.push(candidate);
    return this.addIceCandidateImpl(candidate);
  }

  getStats(): Promise<RTCStatsReport> {
    return this.getStatsImpl();
  }

  close(): void {
    this.closeCallCount += 1;
  }
}

/** An externally resolvable/rejectable promise, for controlling exactly when an await resumes. */
export function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function fakeAudioTrack(id = 'track-1'): MediaStreamTrack {
  return { id, kind: 'audio' } as unknown as MediaStreamTrack;
}
