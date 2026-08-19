import { isTerminalPeerConnectionState } from './connection-state.js';
import { IceCandidateQueue } from './ice-candidate-queue.js';
import type { RtcPeerConnectionLike } from './rtc-peer-connection.js';
import type { ParticipantId, SignalingPort } from './types.js';

export interface PeerCallbacks {
  onRemoteTrack(track: MediaStreamTrack, stream: MediaStream, mid: string | null): void;
  /** See `LocalTrackMidEvent` (`types.ts`) for what this reports and why T5 needs it. */
  onLocalTrackMid(track: MediaStreamTrack, mid: string): void;
  onStateChanged(
    connectionState: RTCPeerConnectionState,
    iceConnectionState: RTCIceConnectionState,
  ): void;
  /** The peer connection reached `'failed'`/`'closed'` on its own (see `connection-state.ts`). */
  onTerminal(): void;
  onIceCandidate(candidate: RTCIceCandidateInit | null): void;
}

/**
 * Owns exactly one remote participant's `RTCPeerConnection` for its full lifecycle: creation
 * (already done by the caller — `Peer` receives an already-constructed `RtcPeerConnectionLike`),
 * local-track attachment, remote-track/ICE/state-change wiring, offer/answer creation per T3's
 * initiator/responder role split, ICE candidate queueing (see `IceCandidateQueue`), T4's
 * renegotiation for tracks added/removed after the initial offer/answer cycle, and cleanup.
 *
 * ## Renegotiation (T4)
 *
 * T3's role split (`role: 'initiator' | 'responder'`) decides who sends the *first* offer for a
 * pair; it is reused as-is here to also decide who is "polite" for every *subsequent*
 * renegotiation — the responder (`polite = role === 'responder'`) always yields to a colliding
 * inbound offer, the initiator never does. This is the standard WebRTC "perfect negotiation"
 * pattern (see MDN's "Establishing a perfect negotiation" article) anchored to state this package
 * already computes deterministically; no second, independent polite/impolite coordination exists.
 *
 * `negotiated` starts `false` and only flips to `true` once the very first offer/answer cycle for
 * this pair completes (end of a successful initial `createAndSendOffer` for the initiator, end of
 * a successful initial `handleRemoteOffer` for the responder). The platform fires
 * `negotiationneeded` for `addTrack`/`removeTrack` calls made *during* that initial setup too (e.g.
 * `P2PMeshTransport.addParticipant` seeding already-published tracks before the first offer is even
 * sent) — `onnegotiationneeded` no-ops while `negotiated` is still `false` specifically to avoid a
 * duplicate/premature offer racing the initial handshake. Once `negotiated` is `true`,
 * `onnegotiationneeded` reuses `createAndSendOffer` to send a fresh offer for whatever changed.
 *
 * Every method here treats "this peer already closed" as a controlled no-op rather than a thrown
 * or rejected failure — `close()` may race any in-flight negotiation step, and callers (see
 * `P2PMeshTransport`) must never see an unhandled rejection out of that race.
 */
export class Peer {
  readonly participantId: ParticipantId;
  readonly role: 'initiator' | 'responder';
  /** The side that yields (rolls back its own outstanding offer) on a renegotiation collision. */
  readonly polite: boolean;

  private readonly pc: RtcPeerConnectionLike;
  private readonly signalingPort: SignalingPort;
  private readonly callbacks: PeerCallbacks;
  private readonly iceQueue = new IceCandidateQueue();
  private readonly senders = new Map<MediaStreamTrack, RTCRtpSender>();
  private closed = false;
  /** True once the first offer/answer cycle for this pair has completed. */
  private negotiated = false;
  /** True while an offer created by this side (initial or renegotiation) is in flight. */
  private makingOffer = false;

  constructor(
    participantId: ParticipantId,
    role: 'initiator' | 'responder',
    pc: RtcPeerConnectionLike,
    signalingPort: SignalingPort,
    callbacks: PeerCallbacks,
  ) {
    this.participantId = participantId;
    this.role = role;
    this.polite = role === 'responder';
    this.pc = pc;
    this.signalingPort = signalingPort;
    this.callbacks = callbacks;

    pc.ontrack = (event) => {
      if (this.closed) return;
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.callbacks.onRemoteTrack(event.track, stream, event.transceiver?.mid ?? null);
    };
    pc.onicecandidate = (event) => {
      if (this.closed) return;
      this.callbacks.onIceCandidate(event.candidate ? event.candidate.toJSON() : null);
    };
    pc.onconnectionstatechange = () => {
      if (this.closed) return;
      this.callbacks.onStateChanged(pc.connectionState, pc.iceConnectionState);
      if (isTerminalPeerConnectionState(pc.connectionState)) this.callbacks.onTerminal();
    };
    pc.oniceconnectionstatechange = () => {
      if (this.closed) return;
      this.callbacks.onStateChanged(pc.connectionState, pc.iceConnectionState);
    };
    pc.onnegotiationneeded = () => {
      // Re-entrancy guard: if an offer created by this side is already in flight, a second
      // `negotiationneeded` firing before it settles (e.g. two local track changes landing close
      // together — observed live during T5 stabilization's camera-smoke runs, where both sides
      // enable a camera at near-simultaneous startup) must not start a second concurrent
      // `createAndSendOffer()`. That would call the atomic `setLocalDescription()` twice
      // overlapping on one `RTCPeerConnection` and could send two offers for one negotiation
      // cycle. Safe to simply drop the extra firing: per the WebRTC "update the negotiation-needed
      // flag" algorithm, the flag stays set (and the event re-fires once signaling returns to
      // `stable`) if changes made during the in-flight offer are not yet reflected in it — so
      // nothing pending is lost, it is just picked up by this side's *next* offer.
      if (this.closed || !this.negotiated || this.makingOffer) return;
      this.createAndSendOffer().catch((error: unknown) => {
        if (this.closed) return;
        console.error(`rtc-core: failed to create/send a renegotiation offer`, {
          participantId: this.participantId,
          error,
        });
      });
    };
  }

  get isClosed(): boolean {
    return this.closed;
  }

  addTrack(track: MediaStreamTrack): void {
    if (this.closed || this.senders.has(track)) return;
    this.senders.set(track, this.pc.addTrack(track));
  }

  removeTrack(track: MediaStreamTrack): void {
    if (this.closed) return;
    const sender = this.senders.get(track);
    if (!sender) return;
    this.senders.delete(track);
    this.pc.removeTrack(sender);
  }

  /**
   * Creates and sends an offer: the initiator's first offer for this pair, or (once `negotiated`)
   * any later renegotiation offer — both the initial and every later call reuse this same logic.
   *
   * ## T5 negotiation-race fix
   *
   * This used to call `createOffer()` and then `setLocalDescription(offer)` as two separate
   * awaited steps, with a `this.closed` check in between but no protection against a *remote*
   * state change landing in that same gap: if this side is polite and a colliding remote offer
   * arrived and was fully applied (via `handleRemoteOffer`, which a polite peer does not ignore)
   * while `setLocalDescription(offer)` was still pending, that call would apply a now-stale local
   * offer on top of the just-negotiated state, corrupting `signalingState` for the pair.
   *
   * The fix calls the parameterless `setLocalDescription()` instead. Per the WebRTC specification,
   * this is a single atomic operation that creates an offer (or answer, depending on
   * `signalingState`) and applies it as one step — there is no application-observable gap between
   * "offer computed" and "offer applied" for a collision to land in. The actually-applied SDP is
   * then read back from `localDescription`. See `tests/rtc-core/peer.test.ts`'s
   * "polite side mid-offer" regression test for the exact race this closes.
   */
  async createAndSendOffer(): Promise<void> {
    if (this.closed) return;
    this.makingOffer = true;
    try {
      await this.pc.setLocalDescription();
      if (this.closed) return;
      const sdp = this.pc.localDescription?.sdp;
      if (sdp !== undefined) this.signalingPort.sendOffer(this.participantId, sdp);
      this.negotiated = true;
      this.reportLocalTrackMids();
    } finally {
      this.makingOffer = false;
    }
  }

  /**
   * Reports each currently-attached local sender's negotiated `mid`, once this side's own offer
   * (initial or a later renegotiation — every local track eventually gets its own m-line through
   * *this* side's own offer, whichever role sends it; see `Peer`'s class-level doc comment) has
   * been applied locally. A `mid` becomes authoritative for the offerer as soon as
   * `setLocalDescription()` succeeds — no need to wait for the remote answer.
   *
   * `RTCRtpSender` has no back-reference to its transceiver (see `RtcPeerConnectionLike.
   * getTransceivers`'s doc comment), so each sender's transceiver is found by identity via
   * `getTransceivers()`. Harmless to call again on every later offer — an already-known `mid` is
   * just re-reported; the caller (`P2PMeshTransport`) does not need this de-duplicated.
   */
  private reportLocalTrackMids(): void {
    const transceivers = this.pc.getTransceivers();
    for (const [track, sender] of this.senders) {
      const mid = transceivers.find((t) => t.sender === sender)?.mid;
      if (mid) this.callbacks.onLocalTrackMid(track, mid);
    }
  }

  /**
   * Applies an inbound offer — the responder's first offer for this pair, or a later renegotiation
   * offer from the initiator, or (rarely, since the initiator never yields) a colliding offer this
   * side must decide whether to ignore or accept via rollback.
   *
   * Implements standard "perfect negotiation" collision handling: a collision exists if this side
   * is itself mid-offer (`makingOffer`) or already has a local offer outstanding
   * (`signalingState !== 'stable'`). The impolite side (`!polite`) ignores a colliding offer
   * outright — its own offer will win. The polite side rolls back its own local description before
   * applying the inbound offer, guaranteeing the pair converges on exactly one offer either way.
   */
  async handleRemoteOffer(sdp: string): Promise<void> {
    if (this.closed) return;
    const offerCollision = this.makingOffer || this.pc.signalingState !== 'stable';
    const ignoreOffer = !this.polite && offerCollision;
    if (ignoreOffer) return;

    if (offerCollision) {
      await Promise.all([
        this.pc.setLocalDescription({ type: 'rollback' }),
        this.pc.setRemoteDescription({ type: 'offer', sdp }),
      ]);
    } else {
      await this.pc.setRemoteDescription({ type: 'offer', sdp });
    }
    if (this.closed) return;
    await this.markRemoteDescriptionSetAndFlush();
    if (this.closed) return;
    const answer = await this.pc.createAnswer();
    if (this.closed) return;
    await this.pc.setLocalDescription(answer);
    if (this.closed) return;
    if (answer.sdp !== undefined) this.signalingPort.sendAnswer(this.participantId, answer.sdp);
    this.negotiated = true;
  }

  async handleRemoteAnswer(sdp: string): Promise<void> {
    if (this.closed) return;
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
    if (this.closed) return;
    await this.markRemoteDescriptionSetAndFlush();
  }

  /**
   * Queues the candidate if the remote description has not been applied yet (see
   * `IceCandidateQueue`); otherwise applies it immediately.
   */
  async handleRemoteIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (this.closed) return;
    if (!this.iceQueue.isRemoteDescriptionSet()) {
      this.iceQueue.enqueue(candidate);
      return;
    }
    await this.applyIceCandidate(candidate);
  }

  async getStats(): Promise<RTCStatsReport | undefined> {
    if (this.closed) return undefined;
    return this.pc.getStats();
  }

  /** Idempotent: detaches handlers and closes the underlying connection at most once. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pc.ontrack = null;
    this.pc.onicecandidate = null;
    this.pc.onconnectionstatechange = null;
    this.pc.oniceconnectionstatechange = null;
    this.pc.onnegotiationneeded = null;
    this.senders.clear();
    this.pc.close();
  }

  private async markRemoteDescriptionSetAndFlush(): Promise<void> {
    this.iceQueue.markRemoteDescriptionSet();
    for (const candidate of this.iceQueue.drain()) {
      if (this.closed) return;
      await this.applyIceCandidate(candidate);
    }
  }

  private async applyIceCandidate(candidate: RTCIceCandidateInit | null): Promise<void> {
    if (this.closed) return;
    try {
      await this.pc.addIceCandidate(candidate);
    } catch (error) {
      // A candidate applied after this peer started closing (teardown raced the async apply) is
      // an expected no-op, not a failure worth surfacing; anything else is a genuine negotiation
      // problem the caller should still learn about.
      if (this.closed) return;
      throw error;
    }
  }
}
