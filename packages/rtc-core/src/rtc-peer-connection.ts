import { toRtcIceServers } from './ice-servers.js';
import type { RtcTransportConfig } from './types.js';

/**
 * The exact subset of the platform `RTCPeerConnection` interface `Peer` depends on — deliberately
 * declared with the modern (non-deprecated, non-callback) overload of each method. A real
 * `RTCPeerConnection` structurally satisfies this without a cast; a test fake only has to
 * implement this narrow surface (matching this repository's existing "minimal stand-in
 * implementing only what the caller actually calls" pattern used for `ws`'s `WebSocket` in
 * `tests/realtime/connection.test.ts`), instead of every deprecated legacy overload the full DOM
 * type carries.
 */
export interface RtcPeerConnectionLike {
  readonly connectionState: RTCPeerConnectionState;
  readonly iceConnectionState: RTCIceConnectionState;
  /**
   * Needed for T4's "perfect negotiation" collision handling (`Peer.handleRemoteOffer`): an offer
   * collision is detected in part by `signalingState !== 'stable'` (the local side already has an
   * offer outstanding). A real `RTCPeerConnection` already exposes this read-only.
   */
  readonly signalingState: RTCSignalingState;
  ontrack: ((event: RTCTrackEvent) => void) | null;
  onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null;
  onconnectionstatechange: ((event: Event) => void) | null;
  oniceconnectionstatechange: ((event: Event) => void) | null;
  /**
   * Fired by the platform whenever local state (e.g. `addTrack`/`removeTrack` on an already
   * negotiated connection) requires a fresh offer/answer round. `Peer` wires this to trigger T4's
   * renegotiation (see `Peer`'s class-level comment).
   */
  onnegotiationneeded: ((event: Event) => void) | null;
  addTrack(track: MediaStreamTrack, ...streams: MediaStream[]): RTCRtpSender;
  removeTrack(sender: RTCRtpSender): void;
  createOffer(): Promise<RTCSessionDescriptionInit>;
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  setLocalDescription(description: RTCSessionDescriptionInit): Promise<void>;
  setRemoteDescription(description: RTCSessionDescriptionInit): Promise<void>;
  addIceCandidate(candidate?: RTCIceCandidateInit | null): Promise<void>;
  getStats(): Promise<RTCStatsReport>;
  close(): void;
}

/**
 * The single place an `RTCPeerConnection` is constructed. Every peer connection this package
 * creates goes through this factory (directly, or via an injected replacement in tests) so
 * `RtcTransportConfig` -> ICE-server translation and construction never happens ad hoc anywhere
 * else in this package.
 */
export function createRtcPeerConnection(config: RtcTransportConfig): RtcPeerConnectionLike {
  return new RTCPeerConnection({ iceServers: toRtcIceServers(config) });
}
