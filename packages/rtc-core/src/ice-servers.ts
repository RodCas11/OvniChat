import type { RtcIceServerConfig, RtcTransportConfig } from './types.js';

/**
 * Translates this package's own {@link RtcTransportConfig} shape into the platform's
 * `RTCIceServer[]`. Kept as its own pure function so `createRtcPeerConnection` (the single place
 * that actually constructs an `RTCPeerConnection`) stays trivial, and so the translation itself is
 * independently testable without touching the platform WebRTC objects at all.
 */
export function toRtcIceServers(config: RtcTransportConfig): RTCIceServer[] {
  return config.iceServers.map(toRtcIceServer);
}

function toRtcIceServer(server: RtcIceServerConfig): RTCIceServer {
  const iceServer: RTCIceServer = {
    urls: typeof server.urls === 'string' ? server.urls : [...server.urls],
  };
  if (server.username !== undefined) iceServer.username = server.username;
  if (server.credential !== undefined) iceServer.credential = server.credential;
  return iceServer;
}
