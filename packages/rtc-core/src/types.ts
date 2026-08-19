/**
 * Environment-neutral WebRTC transport contract for Disco Voador (see
 * `docs/ARCHITECTURE.md` "RTC transport strategy" and ADR 0006). This module only declares
 * shapes; it must stay free of Electron, React, Node, and Windows dependencies so any transport
 * implementation (P2P mesh today, a future SFU-backed transport) can satisfy it identically.
 */

export type ParticipantId = string;

export interface RtcIceServerConfig {
  readonly urls: string | readonly string[];
  readonly username?: string;
  readonly credential?: string;
}

export interface RtcTransportConfig {
  readonly iceServers: readonly RtcIceServerConfig[];
}

/**
 * What the transport needs from whoever owns the actual signaling connection. The transport does
 * not know or care how these are delivered (WebSocket, anything else) — it only calls these to
 * send, and expects its caller to call `handleRemoteOffer`/`handleRemoteAnswer`/
 * `handleRemoteIceCandidate` when a matching message arrives from the other side.
 */
export interface SignalingPort {
  sendOffer(targetParticipantId: ParticipantId, sdp: string): void;
  sendAnswer(targetParticipantId: ParticipantId, sdp: string): void;
  sendIceCandidate(targetParticipantId: ParticipantId, candidate: RTCIceCandidateInit | null): void;
}

export interface RemoteTrackEvent {
  readonly participantId: ParticipantId;
  readonly track: MediaStreamTrack;
  readonly stream: MediaStream;
  /**
   * The SDP media identification (`a=mid:`) this track's transceiver negotiated, read from
   * `RTCTrackEvent.transceiver.mid` at `ontrack` time. `null` only if the platform genuinely did
   * not report one (should not happen once negotiation completes, per spec) — never a placeholder
   * to guess with. See `LocalTrackMidEvent` for why T5 needs this: a locally-published track's own
   * `MediaStreamTrack.id` was empirically found NOT to survive across the connection unchanged on
   * at least some Electron/Chromium negotiation paths (confirmed via live two-instance testing, not
   * assumed from the spec) — `mid` is the mechanism that does, so it is what T5's media-source-
   * identity protocol (`media:track-source`) correlates on instead. See
   * `docs/architecture/WEBRTC_SCREEN_SHARE.md`.
   */
  readonly mid: string | null;
}

export interface PeerConnectionStateEvent {
  readonly participantId: ParticipantId;
  readonly connectionState: RTCPeerConnectionState;
  readonly iceConnectionState: RTCIceConnectionState;
}

/**
 * Reports that one of *our own* locally-published tracks now has a known `mid` for a specific
 * peer connection — mid is assigned per-connection during that connection's own negotiation, so
 * the same local track can (and in practice sometimes does) end up with a different `mid` on
 * different peer connections in a mesh; there is deliberately no single global "this track's mid"
 * value. Fired once per successful `Peer.createAndSendOffer()` for every currently-attached local
 * sender that has one — see `Peer`'s `reportLocalTrackMids` for exactly when/why.
 */
export interface LocalTrackMidEvent {
  readonly participantId: ParticipantId;
  readonly track: MediaStreamTrack;
  readonly mid: string;
}

export interface MediaTransportEvents {
  remoteTrack: (event: RemoteTrackEvent) => void;
  localTrackMid: (event: LocalTrackMidEvent) => void;
  peerStateChanged: (event: PeerConnectionStateEvent) => void;
  peerClosed: (participantId: ParticipantId) => void;
}

/**
 * `role` implements T3's deterministic offer-ownership strategy: the existing channel member
 * initiates the offer toward a newcomer — when a caller learns a new participant joined its
 * channel, it adds them with role `'initiator'` and this transport creates and sends an offer;
 * when a caller has just joined and learns about participants already present, it adds each with
 * role `'responder'` and this transport only reacts to their inbound offer. This is the only place
 * offer-vs-answer ownership is decided — a correctly behaving pair of peers never has both sides
 * create an offer for each other.
 */
export interface MediaTransport {
  addParticipant(participantId: ParticipantId, role: 'initiator' | 'responder'): void;
  removeParticipant(participantId: ParticipantId): void;

  handleRemoteOffer(participantId: ParticipantId, sdp: string): Promise<void>;
  handleRemoteAnswer(participantId: ParticipantId, sdp: string): Promise<void>;
  handleRemoteIceCandidate(
    participantId: ParticipantId,
    candidate: RTCIceCandidateInit | null,
  ): Promise<void>;

  /** Publishes this track to every current and future peer connection. */
  publishTrack(track: MediaStreamTrack): void;
  unpublishTrack(track: MediaStreamTrack): void;

  getStats(participantId: ParticipantId): Promise<RTCStatsReport | undefined>;

  on<K extends keyof MediaTransportEvents>(event: K, listener: MediaTransportEvents[K]): void;
  off<K extends keyof MediaTransportEvents>(event: K, listener: MediaTransportEvents[K]): void;

  /** Closes every peer connection and releases all resources. Idempotent. */
  closeAll(): void;
}
