# RTC core package boundary

The generic, UI-independent WebRTC transport abstraction (see `docs/ARCHITECTURE.md` and ADR 0006,
P2P-first/SFU-ready). It does not depend on Electron, React, Windows APIs, Node-only modules, or
`@disco-voador/windows-media` — only standard Web/DOM platform types (`RTCPeerConnection`,
`MediaStream`, `MediaStreamTrack`, etc.).

## What T3 implements

- `MediaTransport` (`src/types.ts`): the environment-neutral contract — participants, offer/answer
  role assignment, remote signaling handlers, track publication, stats, and lifecycle events. A
  future SFU-backed transport can implement the same contract without changing any caller.
- `P2PMeshTransport` (`src/p2p-mesh-transport.ts`): the first transport, ADR 0006's mesh — one
  `RTCPeerConnection` per remote participant. Owns mesh topology, offer-vs-answer role assignment
  (the existing channel member is `'initiator'` toward a newcomer; the newcomer is `'responder'`
  toward every participant already present — this is the only place that decision is made), track
  fan-out to every current and future peer, and event fan-out (`remoteTrack`, `peerStateChanged`,
  `peerClosed`).
- `Peer` (`src/peer.ts`): owns exactly one remote participant's `RTCPeerConnection` for its full
  lifecycle — local-track attachment, remote-track/ICE/state wiring, offer/answer creation, ICE
  candidate queueing, and cleanup. Every method is a controlled no-op once the peer has started
  closing, rather than throwing or leaving an unhandled rejection — teardown can race any in-flight
  negotiation step.
- `IceCandidateQueue` (`src/ice-candidate-queue.ts`): a remote ICE candidate can arrive over
  signaling before the matching remote offer/answer has finished applying (trickle ICE). This
  queues candidates that arrive too early and hands them back, in order, once the remote
  description is set — including a queued `null` (the platform's end-of-candidates signal).
- `isTerminalPeerConnectionState` (`src/connection-state.ts`): `'failed'`/`'closed'` are terminal;
  `'disconnected'` is treated as transient per the WebRTC specification and does not trigger
  cleanup. T3 does not implement ICE-restart recovery for `'disconnected'` — see "Remaining risks"
  in the T3 handoff.
- `createRtcPeerConnection` / `RtcPeerConnectionLike` (`src/rtc-peer-connection.ts`): the single
  place an `RTCPeerConnection` is constructed from `RtcTransportConfig`, and the narrow surface of
  it this package actually depends on (enabling a fully-typed test fake without every deprecated
  legacy DOM overload).

## What this package does not do

- It does not talk to `services/realtime` or any transport (WebSocket or otherwise) directly — it
  receives a `SignalingPort` from its caller and only calls that to send; the caller is responsible
  for delivering inbound signaling messages to `handleRemoteOffer`/`handleRemoteAnswer`/
  `handleRemoteIceCandidate`.
- It does not implement perfect negotiation/glare recovery — T3's deterministic initiator/responder
  role assignment means a correctly behaving pair never has both sides create an offer.
- It does not implement ICE restart on `'disconnected'`.

## Testing

Pure logic (`IceCandidateQueue`, `isTerminalPeerConnectionState`, `toRtcIceServers`) and
`Peer`/`P2PMeshTransport` orchestration (role-based offer ownership, ICE queueing, race handling,
cleanup idempotency, event fan-out, error containment) are unit-tested under `tests/rtc-core/`
against a hand-written `RtcPeerConnectionLike` fake — deliberately not a mock of the full
`RTCPeerConnection` DOM interface, and not a substitute for real negotiation. Real SDP generation,
ICE gathering, and an actual two-peer connection reaching `'connected'` require a real browser
engine (jsdom/happy-dom do not implement WebRTC) and are verified when this package is wired into
`apps/desktop` and exercised with two real Electron instances.
