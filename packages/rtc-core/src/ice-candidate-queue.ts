/**
 * A remote ICE candidate can arrive over signaling before this side has finished applying the
 * matching remote offer/answer (`setRemoteDescription`) — trickle ICE races the SDP exchange by
 * design, not by accident (see the WebRTC specification's trickle ICE section). Calling
 * `RTCPeerConnection.addIceCandidate` before a remote description exists rejects. This queue holds
 * candidates that arrive too early and hands them back, in arrival order, once the remote
 * description is in place — pure bookkeeping, deliberately kept free of any `RTCPeerConnection`
 * reference so the queueing *decision* is independently testable.
 *
 * `null` is a legitimate queued value: it is the platform's end-of-candidates signal
 * (`RTCIceCandidateInit | null`), not an absent one, so it must be queued and later flushed like
 * any other candidate rather than dropped.
 */
export class IceCandidateQueue {
  private remoteDescriptionSet = false;
  private queued: (RTCIceCandidateInit | null)[] = [];

  /** Whether a candidate arriving right now would apply immediately or need to be queued. */
  isRemoteDescriptionSet(): boolean {
    return this.remoteDescriptionSet;
  }

  /** Marks the remote description as applied. Idempotent; does not itself drain the queue. */
  markRemoteDescriptionSet(): void {
    this.remoteDescriptionSet = true;
  }

  /** Queues a candidate that arrived before the remote description was applied. */
  enqueue(candidate: RTCIceCandidateInit | null): void {
    this.queued.push(candidate);
  }

  /** Returns and clears every queued candidate, in the order they were enqueued. */
  drain(): (RTCIceCandidateInit | null)[] {
    const drained = this.queued;
    this.queued = [];
    return drained;
  }
}
