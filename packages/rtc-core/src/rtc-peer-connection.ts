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
  /**
   * Needed so `Peer.createAndSendOffer` can read back what the platform actually applied after
   * the atomic parameterless `setLocalDescription()` call (see that method for why).
   */
  readonly localDescription: RTCSessionDescription | null;
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
  /**
   * T5's media-source-identity mechanism (see `Peer.createAndSendOffer`'s "reportLocalTrackMids"
   * step) needs each local sender's negotiated `mid` — `RTCRtpSender` itself has no back-reference
   * to its transceiver (confirmed against the platform's own type definitions, not assumed), so
   * this is how `Peer` finds it: `getTransceivers().find(t => t.sender === sender)`.
   */
  getTransceivers(): RTCRtpTransceiver[];
  createAnswer(): Promise<RTCSessionDescriptionInit>;
  /**
   * `Peer.createAndSendOffer` always calls this with no argument (see that method's doc comment
   * for the T5 negotiation-race fix this enables). `handleRemoteOffer` still calls it with an
   * explicit `{type:'answer',...}` or `{type:'rollback'}` description. A real `RTCPeerConnection`
   * has always accepted an optional description here per the WebRTC specification; there was
   * previously no caller in this package that needed the parameterless form.
   */
  setLocalDescription(description?: RTCSessionDescriptionInit): Promise<void>;
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
