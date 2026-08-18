/**
 * `RTCPeerConnection.connectionState` aggregates ICE and DTLS transport state into one value (see
 * the WebRTC specification's "RTCPeerConnectionState" enum). `'disconnected'` is explicitly
 * transient per spec — a temporary network hiccup can produce it and then recover on its own — so
 * it must not be treated as terminal. Only `'failed'` (negotiation/connectivity conclusively did
 * not work) and `'closed'` (this side, or `close()`, ended it) mean the peer connection is done and
 * its resources should be released.
 *
 * T3 does not implement an ICE-restart recovery path for `'disconnected'`; see this package's
 * README for that documented follow-up.
 */
export function isTerminalPeerConnectionState(state: RTCPeerConnectionState): boolean {
  return state === 'failed' || state === 'closed';
}
