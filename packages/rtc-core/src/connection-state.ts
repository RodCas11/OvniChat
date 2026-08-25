/**
 * The single classification every part of this package uses to decide what an
 * `RTCPeerConnection`'s current state means for *this* peer's transport, so "is this peer healthy?",
 * "may a credential refresh disturb it?", and "should ICE recovery run?" can never drift apart into
 * two independently-maintained answers.
 *
 * - `'closed'` — the connection is gone (this side closed it, or the platform did). Irrecoverable;
 *   no ICE restart can bring it back, only a brand-new `RTCPeerConnection`.
 * - `'failed'` — ICE (and therefore, in practice, `connectionState`) conclusively gave up on the
 *   current candidate set. Per the WebRTC specification this is *not* the end of the road: an ICE
 *   restart replaces the local ICE credentials and re-gathers, which is exactly what
 *   `Peer`'s bounded recovery does (T15.2).
 * - `'established'` — ICE selected a candidate pair and/or DTLS completed: media can actually flow.
 *   Both axes are checked because they legitimately disagree for short windows —
 *   `iceConnectionState` reaches `'connected'`/`'completed'` before DTLS finishes, and can report
 *   `'completed'` while `connectionState` momentarily reports `'disconnected'` on a transient
 *   hiccup. This is the population that must never be disturbed by a routine TURN credential
 *   refresh.
 * - `'pending'` — everything else (`'new'`, `'checking'`, `'connecting'`, `'disconnected'`):
 *   connectivity has not been established (or has transiently lapsed) but nothing has conclusively
 *   failed. `'disconnected'` deliberately lands here, never in `'failed'`: the specification
 *   describes it as transient and recoverable without any intervention, so it must never trigger a
 *   restart or a teardown on its own.
 *
 * Evaluation order matters and is deliberate: `'closed'` wins over everything, then `'failed'`,
 * then `'established'`. A connection reporting both a failed ICE transport and a stale
 * `'connected'`/`'completed'` value on the other axis is genuinely broken, and treating it as
 * healthy would leave it permanently unrecoverable — the exact dead end T15.1 already had to fix
 * once.
 */
export type PeerTransportHealth = 'closed' | 'failed' | 'established' | 'pending';

export function classifyPeerTransportHealth(
  connectionState: RTCPeerConnectionState,
  iceConnectionState: RTCIceConnectionState,
): PeerTransportHealth {
  if (connectionState === 'closed' || iceConnectionState === 'closed') return 'closed';
  if (connectionState === 'failed' || iceConnectionState === 'failed') return 'failed';
  if (
    connectionState === 'connected' ||
    iceConnectionState === 'connected' ||
    iceConnectionState === 'completed'
  ) {
    return 'established';
  }
  return 'pending';
}

/**
 * `RTCPeerConnection.connectionState` aggregates ICE and DTLS transport state into one value (see
 * the WebRTC specification's "RTCPeerConnectionState" enum). `'disconnected'` is explicitly
 * transient per spec — a temporary network hiccup can produce it and then recover on its own — so
 * it must not be treated as terminal. `'failed'` and `'closed'` both mean no media is flowing on
 * this connection right now.
 *
 * ## What this does and does not decide (T15.2)
 *
 * This predicate answers "is this connection currently carrying nothing?", which is *not* the same
 * question as "should this peer be torn down?". Through T15.1 the two were conflated: `Peer` closed
 * itself the moment `connectionState` reached `'failed'`, so a failed peer was unrecoverable for
 * the rest of the session. T15.2 separates them — `'closed'` is still immediately terminal, while
 * `'failed'` now first goes through `Peer`'s bounded ICE-restart recovery and only becomes terminal
 * once that budget is spent. Use {@link classifyPeerTransportHealth} for lifecycle decisions; this
 * predicate remains for callers that only want the coarser "nothing is flowing" answer.
 */
export function isTerminalPeerConnectionState(state: RTCPeerConnectionState): boolean {
  return state === 'failed' || state === 'closed';
}
