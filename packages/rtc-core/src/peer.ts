import { classifyPeerTransportHealth, type PeerTransportHealth } from './connection-state.js';
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
  /**
   * This peer connection is done and its resources should be released: either it reached
   * `'closed'`, or (T15.2) it reached `'failed'` and every bounded ICE-restart recovery attempt has
   * been spent without reaching a working transport. Never fired for a merely `'disconnected'`
   * connection, and — since T15.2 — no longer fired the instant `'failed'` is first observed.
   */
  onTerminal(): void;
  onIceCandidate(candidate: RTCIceCandidateInit | null): void;
}

/**
 * T15.2 — bounded ICE-failure recovery budget for a single peer connection.
 *
 * `MAX_ATTEMPTS` ICE restarts, spaced by an exponential backoff of
 * `INITIAL_DELAY_MS * BACKOFF_FACTOR ** attemptsAlreadyMade`, i.e. **1s, 3s, 9s** before attempts
 * one, two and three, and a final **27s** verdict window after the third. A peer that is still
 * `'failed'` when that last window elapses is declared terminal (≈40s after the first failure).
 *
 * Chosen for two concrete reasons rather than as round numbers:
 * - The first delay is deliberately non-zero. `'failed'` can be re-dispatched several times in a
 *   row (`connectionstatechange` and `iceconnectionstatechange` both fire for the same underlying
 *   transition), and an immediate restart per dispatch is exactly the retry storm this must not
 *   produce. One armed timer at a time, re-checked on fire, makes the storm structurally impossible.
 * - Each delay also doubles as the "did the previous attempt work?" observation window, so it must
 *   stay comfortably larger than a real ICE restart's gather+check cycle as that cycle grows more
 *   expensive (host-only, then STUN, then a relay allocation). The final 27s window is the one that
 *   decides a user-visible failure, so it is the most generous.
 *
 * These are exported so a test can assert against the real values instead of hard-coding a
 * duplicate copy of them, and so the numbers have exactly one definition.
 */
export const ICE_RECOVERY_MAX_ATTEMPTS = 3;
export const ICE_RECOVERY_INITIAL_DELAY_MS = 1_000;
export const ICE_RECOVERY_BACKOFF_FACTOR = 3;

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
 * ## ICE-failure recovery (T15.2)
 *
 * `'failed'` is no longer immediately terminal. A peer that reaches it runs a bounded ICE-restart
 * chain (`ICE_RECOVERY_MAX_ATTEMPTS`, exponential backoff) against the freshest ICE servers it has
 * been told about, reusing the same perfect-negotiation path above to carry the resulting
 * renegotiation; only once that budget is spent does it report `onTerminal()`. `'closed'` remains
 * immediately terminal. A peer that is merely `'disconnected'`, or one that is `'established'`, is
 * never touched by any of this — see `connection-state.ts`'s single shared classifier.
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
  /**
   * T15.2 — the most recent ICE server list this peer was told about, whether or not it was applied
   * at the time (see {@link applyIceServers}). Remembered so a later ICE-failure recovery re-gathers
   * against the freshest known TURN credentials rather than whatever this connection happened to be
   * constructed with, which for a long-lived session may be an already-expired credential.
   * `undefined` means no list was ever supplied, in which case recovery restarts ICE without
   * touching the configuration at all.
   */
  private latestIceServers: readonly RTCIceServer[] | undefined;
  /** How many ICE restarts this peer has already spent out of {@link ICE_RECOVERY_MAX_ATTEMPTS}. */
  private iceRecoveryAttempts = 0;
  /** The single armed recovery timer, if any — never more than one at a time, by construction. */
  private iceRecoveryTimer: ReturnType<typeof setTimeout> | undefined;
  /** True once the recovery budget was spent and `onTerminal` was reported, so it is reported once. */
  private iceRecoveryExhausted = false;

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
      this.reactToTransportHealth();
    };
    pc.oniceconnectionstatechange = () => {
      if (this.closed) return;
      this.callbacks.onStateChanged(pc.connectionState, pc.iceConnectionState);
      // T15.2 — both dispatches feed the same single classification. `iceconnectionstatechange` is
      // the one that fires first for a pure ICE failure on some platforms, and it previously did
      // nothing but forward state, which is part of why a failed peer had no recovery path at all.
      this.reactToTransportHealth();
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

  /**
   * True once this peer has a working end-to-end transport — i.e. ICE selected a candidate pair and
   * (for `connectionState`) DTLS completed. Anything else — `'new'`, `'checking'`, `'connecting'`,
   * `'disconnected'`, `'failed'` — means connectivity is not currently established on this
   * connection, which is exactly the population {@link applyIceServers} is allowed to disturb.
   *
   * Delegates to the package's one shared classifier (`connection-state.ts`) rather than
   * re-deriving the same condition here, so this getter, `applyIceServers`'s "never disturb a
   * working call" rule, and T15.2's ICE-failure recovery can never disagree about what "working"
   * means.
   */
  get hasEstablishedTransport(): boolean {
    return this.currentTransportHealth() === 'established';
  }

  /** Deliberately a method, not a getter: control-flow narrowing would otherwise carry an earlier
   * `!== 'failed'` guard across the whole rest of a function body and make a genuine later re-read
   * (the connection's state can change between the two, which is the entire point) look impossible
   * to the compiler. */
  private currentTransportHealth(): PeerTransportHealth {
    return classifyPeerTransportHealth(this.pc.connectionState, this.pc.iceConnectionState);
  }

  /**
   * T15.1 — applies a newly-known ICE server list to this *already-constructed* peer connection and,
   * unless it is already working, triggers a standards-based ICE restart so the connection actually
   * re-gathers against that list instead of staying stuck on whatever it was created with.
   *
   * This exists because of a real, field-reproduced failure mode: a peer connection created before
   * usable ICE servers were known (or created with an ICE server that turned out to be unreachable)
   * had no recovery path at all — `RTCPeerConnection`'s constructor argument is a one-shot, and this
   * package previously never touched a live connection's configuration. The result was a peer
   * permanently limited to host candidates for the rest of the session, with no mechanism able to
   * fix it short of leaving and rejoining the channel.
   *
   * Deliberately a no-op for a peer that already {@link hasEstablishedTransport}: a working
   * connection must never be disturbed by a routine credential refresh. Returns whether it actually
   * applied, so the caller can report/count healed peers without re-deriving the same condition.
   *
   * ## T15.2 — the list is always *remembered*, even when it is not applied
   *
   * Now that credentials really are re-minted and re-pushed before they expire
   * (`services/realtime`'s per-connection refresh timer), the common case for an established peer is
   * a *replacement* credential arriving mid-call. That must not restart anything — but throwing it
   * away entirely was its own quiet trap: if that same peer later reached `'failed'`, the only ICE
   * servers it could re-gather against were the ones it was constructed with, which by then may be
   * long expired (Coturn answers an expired `use-auth-secret` credential with `401 Unauthorized`
   * and the connection gets no relay candidate at all). So every call records the list, and only the
   * decision to *act* on it right now depends on the peer's health.
   *
   * `restartIce()` does not itself send anything. It sets the platform's own "replace local ICE
   * credentials" state, and the platform then fires `negotiationneeded` once signaling is stable —
   * which this class already handles (see the constructor's `onnegotiationneeded` wiring and this
   * class's doc comment) via the same "perfect negotiation" path every other renegotiation uses,
   * including glare handling if both sides of a pair restart at once. Calling it on a connection
   * that has not yet produced a local description is harmless: there are no local ICE credentials to
   * replace yet, so it changes nothing and the fresh configuration is simply used by that
   * connection's first gathering.
   */
  applyIceServers(iceServers: RTCIceServer[]): boolean {
    if (this.closed) return false;
    this.latestIceServers = iceServers;
    if (this.hasEstablishedTransport) return false;
    this.pc.setConfiguration({ iceServers });
    this.pc.restartIce();
    return true;
  }

  // --- T15.2: bounded ICE-failure recovery -------------------------------------------------------

  /**
   * The single place a peer connection's current state turns into a lifecycle decision. Called after
   * every `connectionstatechange`/`iceconnectionstatechange` dispatch, and never anywhere else, so
   * there is exactly one place that decides "tear this down", "heal this", or "leave this alone".
   *
   * Through T15.1 this logic was a one-liner (`'failed'` or `'closed'` -> `onTerminal()`), which is
   * what made a failed peer permanently dead: the transport closed and removed it, and the
   * participant sat in the roster with no media and no mechanism able to try again for the rest of
   * the session. `'closed'` still means exactly that — the platform object is gone, and only a new
   * `RTCPeerConnection` could ever help. `'failed'` does not: an ICE restart replaces the local ICE
   * credentials and re-gathers, which is a standard, specified recovery for precisely this state.
   */
  private reactToTransportHealth(): void {
    if (this.closed) return;
    switch (this.currentTransportHealth()) {
      case 'closed':
        this.callbacks.onTerminal();
        return;
      case 'established':
        // A successful (re)connection always restores a full retry budget: a peer that failed,
        // recovered, and much later fails again for an entirely unrelated reason must get its own
        // three attempts, never the exhausted remainder of the previous incident.
        this.resetIceRecovery();
        return;
      case 'failed':
        this.armIceRecoveryTimer();
        return;
      case 'pending':
        // `'disconnected'`/`'checking'`/`'connecting'` — nothing has conclusively failed, so nothing
        // is started, and (importantly) an already-armed recovery timer is left alone: a restart in
        // progress legitimately passes through these states on its way to succeeding or failing.
        return;
    }
  }

  /**
   * Arms the next recovery step, unless one is already armed (the deliberate anti-storm guard: the
   * platform re-dispatches `'failed'` on both state-change events, and every extra dispatch must be
   * absorbed, not turned into another restart) or the budget was already declared spent.
   */
  private armIceRecoveryTimer(): void {
    if (this.closed || this.iceRecoveryTimer !== undefined || this.iceRecoveryExhausted) return;
    const delayMs =
      ICE_RECOVERY_INITIAL_DELAY_MS * ICE_RECOVERY_BACKOFF_FACTOR ** this.iceRecoveryAttempts;
    this.iceRecoveryTimer = setTimeout(() => {
      this.iceRecoveryTimer = undefined;
      this.runIceRecoveryStep();
    }, delayMs);
  }

  /**
   * One step of the recovery chain. Deliberately self-driving — it arms its own successor rather
   * than waiting to be re-triggered by another `'failed'` dispatch: an ICE restart that produces no
   * observable state change at all (for instance because the platform had nothing left to re-gather)
   * would otherwise leave this peer suspended forever, never recovering and never reaching a
   * definite verdict either.
   *
   * The delay that armed *this* step is therefore also the observation window for the previous
   * attempt. If the peer is no longer `'failed'` when the window elapses, this step does nothing and
   * the chain pauses: `'established'` means it worked (and `reactToTransportHealth` has already
   * restored the budget), while `'pending'` means a restart is genuinely still in progress and the
   * ICE agent's own timeouts — not this class — own that window. Should the platform later give up
   * again, the `'failed'` dispatch re-arms the chain with whatever budget is left, because it is the
   * same unresolved incident.
   */
  private runIceRecoveryStep(): void {
    if (this.closed || this.currentTransportHealth() !== 'failed') return;

    if (this.iceRecoveryAttempts >= ICE_RECOVERY_MAX_ATTEMPTS) {
      // Budget spent and still failed. The last state this peer reported to its callbacks was
      // `'failed'`, and `close()` detaches every handler before closing the platform object, so that
      // stays the peer's final observable state — which is what a caller surfaces as its
      // per-participant "connection problem" indication. No new signal is invented for this.
      this.iceRecoveryExhausted = true;
      this.callbacks.onTerminal();
      return;
    }

    this.iceRecoveryAttempts += 1;
    try {
      // Freshest known ICE servers first, then the restart — recovering against a credential that
      // has since been replaced is the single most likely way for these attempts to be wasted.
      if (this.latestIceServers) {
        this.pc.setConfiguration({ iceServers: [...this.latestIceServers] });
      }
      this.pc.restartIce();
    } catch (error) {
      // A connection that rejects the restart (e.g. it is mid-teardown and the platform throws
      // `InvalidStateError`) must not throw out of a timer callback. The attempt still counts, so a
      // permanently-rejecting connection still converges on the terminal verdict instead of looping.
      // Never logs `latestIceServers` — it carries a live TURN username/credential pair.
      console.error(`rtc-core: an ICE-restart recovery attempt failed`, {
        participantId: this.participantId,
        attempt: this.iceRecoveryAttempts,
        error,
      });
    }
    // Arm the next step for anything short of an outright success. Deliberately *not* conditioned on
    // still being `'failed'`: a restart that has already moved the connection into `'checking'`/
    // `'connecting'` is exactly the case that still needs a window to be judged in, and skipping the
    // re-arm there would abandon the chain with no verdict at all.
    if (this.closed || this.currentTransportHealth() === 'established') return;
    this.armIceRecoveryTimer();
  }

  private resetIceRecovery(): void {
    this.clearIceRecoveryTimer();
    this.iceRecoveryAttempts = 0;
    this.iceRecoveryExhausted = false;
  }

  private clearIceRecoveryTimer(): void {
    if (this.iceRecoveryTimer === undefined) return;
    clearTimeout(this.iceRecoveryTimer);
    this.iceRecoveryTimer = undefined;
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
   * T11: swaps `oldTrack`'s already-negotiated `RTCRtpSender` to send `newTrack` instead — see
   * `MediaTransport.replaceTrack` (`types.ts`) for the full contract this implements. Looks up the
   * sender by identity of `oldTrack` in `senders` (the same map `addTrack`/`removeTrack` maintain)
   * and re-keys it to `newTrack`, so a later `removeTrack(newTrack)` or another
   * `replaceTrack(newTrack, ...)` call finds the same sender.
   *
   * Unlike `addTrack`/`removeTrack`, an unknown `oldTrack` is not a silent no-op here: it means the
   * caller tried to replace a track that was never published through this peer, which should never
   * happen if `publishTrack`/`addTrack` was called for it first — a caller bug, not a runtime race,
   * so this throws a clear, actionable error instead of doing nothing.
   *
   * `RTCRtpSender.replaceTrack()` returns a `Promise<void>` per spec, but this method stays
   * synchronous from the caller's point of view, matching `addTrack`/`removeTrack`'s existing
   * fire-and-forget convention for sender-level platform calls (neither of those awaits `pc.addTrack`/
   * `pc.removeTrack` either, since both are themselves synchronous on a real `RTCPeerConnection`) —
   * the one difference is `replaceTrack()` itself is genuinely async on the platform, so this method
   * does not await it but does attach a `.catch()` to avoid an unhandled rejection, logging (not
   * throwing) if the underlying platform call itself fails.
   *
   * Deliberately does not trigger renegotiation: `replaceTrack()` does not change the transceiver's
   * direction or m-line, so the platform never fires `negotiationneeded` for it, and this method must
   * not simulate one — that is the entire point of using `replaceTrack` for device switching instead
   * of `removeTrack` + `addTrack`.
   */
  replaceTrack(oldTrack: MediaStreamTrack, newTrack: MediaStreamTrack): void {
    if (this.closed) return;
    const sender = this.senders.get(oldTrack);
    if (!sender) {
      throw new Error(
        `rtc-core: Peer.replaceTrack(participantId=${this.participantId}) called for a track with ` +
          `no known sender — oldTrack must already be published (addTrack/publishTrack) before it ` +
          `can be replaced`,
      );
    }
    this.senders.delete(oldTrack);
    this.senders.set(newTrack, sender);
    sender.replaceTrack(newTrack).catch((error: unknown) => {
      console.error(`rtc-core: RTCRtpSender.replaceTrack failed`, {
        participantId: this.participantId,
        error,
      });
    });
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
    // T6 fix: a real, previously-latent gap this session found live. `createAndSendOffer()` always
    // reported local track mids after its own `setLocalDescription()`, but this method never did
    // after *its* `setLocalDescription(answer)` — harmless as long as every locally-published track
    // needing an announcement was always added *after* the initial handshake (true for T4/T5's
    // camera/screen, which are always user-enabled post-join, so their mids were always reported via
    // a later `createAndSendOffer()` renegotiation regardless of which side answered first). T6
    // made microphone require the same announcement mechanism (closing an absence-based-inference
    // gap — see `packages/protocol/src/messages/media.ts`'s `TrackSource` doc comment), and
    // microphone *is* seeded into the very first offer/answer cycle (published before
    // `addParticipant` even creates the peer connection) — so the responder side of a pair (the one
    // that only ever answers, never offers, for that initial cycle) was live-found to never report
    // its own microphone's mid at all, leaving the remote side's reconciliation waiting forever for
    // an announcement that would never arrive. Mirrors `createAndSendOffer()`'s identical call.
    this.reportLocalTrackMids();
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

  /**
   * Idempotent: detaches handlers and closes the underlying connection at most once. Also cancels
   * any armed ICE-recovery timer (T15.2) — a participant who left, or a mesh that was torn down,
   * must never leave a retry chain running against a connection nobody is watching any more.
   */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.clearIceRecoveryTimer();
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
