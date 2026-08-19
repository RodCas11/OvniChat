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
  /** Settable by tests to simulate an outstanding local offer for collision scenarios. */
  signalingState: RTCSignalingState = 'stable';
  /** Mirrors what a real `RTCPeerConnection.localDescription` would report after the calls below. */
  localDescription: RTCSessionDescription | null = null;

  ontrack: ((event: RTCTrackEvent) => void) | null = null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null = null;
  onconnectionstatechange: ((event: Event) => void) | null = null;
  oniceconnectionstatechange: ((event: Event) => void) | null = null;
  onnegotiationneeded: ((event: Event) => void) | null = null;

  readonly addTrackCalls: MediaStreamTrack[] = [];
  readonly removeTrackCalls: RTCRtpSender[] = [];
  readonly setLocalDescriptionCalls: RTCSessionDescriptionInit[] = [];
  readonly setRemoteDescriptionCalls: RTCSessionDescriptionInit[] = [];
  readonly addIceCandidateCalls: (RTCIceCandidateInit | null | undefined)[] = [];
  closeCallCount = 0;

  private readonly sendersByTrack = new Map<MediaStreamTrack, RTCRtpSender>();
  /**
   * Mirrors real negotiation closely enough for `Peer.reportLocalTrackMids` to be testable: each
   * `addTrack` gets a transceiver with `mid: null`; a parameterless `setLocalDescription()` call
   * (an offer — see that method below) assigns the next sequential mid ("0", "1", ...) to any
   * transceiver that does not have one yet, in creation order. Real `mid` values are not
   * necessarily small sequential integers, but *some* stable, unique string per transceiver is all
   * `Peer`'s logic (or any test asserting on it) actually depends on.
   */
  private readonly transceivers: { sender: RTCRtpSender; mid: string | null }[] = [];

  getTransceivers(): RTCRtpTransceiver[] {
    return this.transceivers as unknown as RTCRtpTransceiver[];
  }

  /**
   * Simulates what a real `RTCPeerConnection.setLocalDescription()` computes internally when
   * called with no argument (creating an offer or answer as appropriate). Kept as a
   * separately-controllable field — as it was pre-T5, when `Peer` called `createOffer()`
   * directly — so existing timing/failure-injection tests keep working unchanged; see
   * `setLocalDescription` below for how it is now invoked.
   */
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
    // Mirrors a real, live-verified `RTCPeerConnection.addTrack()` behavior (see `Peer`'s
    // `wireRemoteVideoTrack` doc comment in `use-voice-channel.ts`, and
    // `docs/architecture/WEBRTC_SCREEN_SHARE.md`'s "Media source identity" section): a transceiver
    // whose sender's track was cleared by a prior `removeTrack()` gets *reused* by the next
    // `addTrack()` call of a compatible kind — it keeps its already-negotiated `mid`, it does not
    // get a fresh one — rather than always creating a brand-new transceiver/m-line. Modeling this
    // (the previous version of this fake always pushed a new transceiver per `addTrack`, which
    // could never represent this reuse case at all) lets tests exercise "a *different* local track
    // ends up reported under an old, already-`mid`-known transceiver" — the exact precondition for
    // T5's mid-reuse-after-source-change scenario.
    const reusable = this.transceivers.find(
      (t) => (t.sender as unknown as { track: MediaStreamTrack | null }).track === null,
    );
    if (reusable) {
      reusable.sender = sender;
    } else {
      this.transceivers.push({ sender, mid: null });
    }
    return sender;
  }

  removeTrack(sender: RTCRtpSender): void {
    this.removeTrackCalls.push(sender);
    // Real `removeTrack()` clears the sender's track (direction moves toward recvonly/inactive) but
    // leaves the transceiver itself — and its already-assigned `mid` — in place. See `addTrack`'s
    // reuse logic above.
    (sender as unknown as { track: MediaStreamTrack | null }).track = null;
  }

  senderFor(track: MediaStreamTrack): RTCRtpSender | undefined {
    return this.sendersByTrack.get(track);
  }

  createAnswer(): Promise<RTCSessionDescriptionInit> {
    return this.createAnswerImpl();
  }

  /**
   * A parameterless call (the only form `Peer.createAndSendOffer` now uses — see that method's
   * doc comment) synthesizes the description via `createOfferImpl` first, exactly like a real
   * atomic `setLocalDescription()`; an explicit description (answer or rollback, from
   * `Peer.handleRemoteOffer`) is applied as-is. Either way, `localDescription` is updated to
   * reflect what actually ended up applied, and `setLocalDescriptionCalls` records the *effective*
   * description — so tests asserting on that array observe the same values as before the T5 fix,
   * regardless of which form triggered them.
   */
  async setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void> {
    const isOffer = description === undefined;
    const effective = description ?? (await this.createOfferImpl());
    this.setLocalDescriptionCalls.push(effective);
    await this.setLocalDescriptionImpl(effective);
    this.localDescription =
      effective.type === 'rollback' ? null : (effective as RTCSessionDescription);
    if (isOffer) {
      let nextMid = this.transceivers.filter((t) => t.mid !== null).length;
      for (const transceiver of this.transceivers) {
        if (transceiver.mid === null) {
          transceiver.mid = String(nextMid);
          nextMid += 1;
        }
      }
    }
  }

  /**
   * Mirrors a real platform's behavior for an *inbound offer* specifically: `mid` values are
   * decided by the offerer and carried in the offer's SDP, so the answerer's own transceivers
   * (matched/created while parsing that offer) already have their `mid` populated as soon as
   * `setRemoteDescription({type: 'offer', ...})` resolves — *before* the answerer ever calls its
   * own `setLocalDescription(answer)`. This is exactly the precondition `Peer.handleRemoteOffer`'s
   * `reportLocalTrackMids()` call (T6 fix — a locally-published track seeded before the initial
   * handshake, e.g. microphone, must have its mid reported after *answering* too, not only after
   * *offering*) depends on. An answer or rollback assigns nothing here — mids are never decided by
   * this side's own descriptions.
   */
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void> {
    this.setRemoteDescriptionCalls.push(description);
    if (description.type === 'offer') {
      let nextMid = this.transceivers.filter((t) => t.mid !== null).length;
      for (const transceiver of this.transceivers) {
        if (transceiver.mid === null) {
          transceiver.mid = String(nextMid);
          nextMid += 1;
        }
      }
    }
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
