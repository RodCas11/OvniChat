import { isTerminalPeerConnectionState } from './connection-state.js';
import { IceCandidateQueue } from './ice-candidate-queue.js';
import type { RtcPeerConnectionLike } from './rtc-peer-connection.js';
import type { ParticipantId, SignalingPort } from './types.js';

export interface PeerCallbacks {
  onRemoteTrack(track: MediaStreamTrack, stream: MediaStream): void;
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
 * initiator/responder role split, ICE candidate queueing (see `IceCandidateQueue`), and cleanup.
 *
 * Every method here treats "this peer already closed" as a controlled no-op rather than a thrown
 * or rejected failure — `close()` may race any in-flight negotiation step, and callers (see
 * `P2PMeshTransport`) must never see an unhandled rejection out of that race.
 */
export class Peer {
  readonly participantId: ParticipantId;
  readonly role: 'initiator' | 'responder';

  private readonly pc: RtcPeerConnectionLike;
  private readonly callbacks: PeerCallbacks;
  private readonly iceQueue = new IceCandidateQueue();
  private readonly senders = new Map<MediaStreamTrack, RTCRtpSender>();
  private closed = false;

  constructor(
    participantId: ParticipantId,
    role: 'initiator' | 'responder',
    pc: RtcPeerConnectionLike,
    callbacks: PeerCallbacks,
  ) {
    this.participantId = participantId;
    this.role = role;
    this.pc = pc;
    this.callbacks = callbacks;

    pc.ontrack = (event) => {
      if (this.closed) return;
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      this.callbacks.onRemoteTrack(event.track, stream);
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

  /** T3's initiator side: create and send the one offer this pair will ever need. */
  async createAndSendOffer(signalingPort: SignalingPort): Promise<void> {
    if (this.closed) return;
    const offer = await this.pc.createOffer();
    if (this.closed) return;
    await this.pc.setLocalDescription(offer);
    if (this.closed) return;
    if (offer.sdp !== undefined) signalingPort.sendOffer(this.participantId, offer.sdp);
  }

  /** T3's responder side: apply the inbound offer, flush queued ICE, then answer. */
  async handleRemoteOffer(sdp: string, signalingPort: SignalingPort): Promise<void> {
    if (this.closed) return;
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    if (this.closed) return;
    await this.markRemoteDescriptionSetAndFlush();
    if (this.closed) return;
    const answer = await this.pc.createAnswer();
    if (this.closed) return;
    await this.pc.setLocalDescription(answer);
    if (this.closed) return;
    if (answer.sdp !== undefined) signalingPort.sendAnswer(this.participantId, answer.sdp);
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
