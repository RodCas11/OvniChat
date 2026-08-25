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
- `classifyPeerTransportHealth` / `isTerminalPeerConnectionState` (`src/connection-state.ts`): the
  single shared `'closed' | 'failed' | 'established' | 'pending'` classification every lifecycle
  decision in this package uses — "may a credential refresh disturb this peer?", "should ICE
  recovery run?", and "is this peer done?" all read the same function, so they cannot drift apart.
  `'disconnected'` is `'pending'`, never `'failed'`: the WebRTC specification describes it as
  transient, so it triggers neither a restart nor a teardown. T3 does not implement ICE-restart
  recovery for `'disconnected'` — see "Remaining risks" in the T3 handoff.
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
- It does not implement ICE restart on `'disconnected'` — that state is transient per the
  specification and is deliberately left alone.
- It **does**, since T15.2, implement bounded ICE-failure recovery. A peer that reaches `'failed'` is
  no longer closed on the spot: `Peer` re-applies the freshest ICE server list it knows about and
  calls `restartIce()` up to `ICE_RECOVERY_MAX_ATTEMPTS` (3) times with exponential backoff (1s, 3s,
  9s, then a 27s verdict window), letting the existing perfect-negotiation `negotiationneeded` path
  carry the renegotiation. Only once that budget is spent does it report terminal, at which point the
  transport closes and removes it exactly as before — the participant's last observed state stays
  `'failed'`, which is what a caller surfaces as a per-participant connection-problem indication. A
  successful reconnection resets the budget; `close()` cancels any armed retry, so a departed
  participant leaks no timer.
- The other ICE restart it performs is T15.1's: `setIceServers()` applies a newly-known ICE server
  list to every existing peer that has not yet established a working transport, via
  `RTCPeerConnection.setConfiguration()` + `restartIce()`, so a peer created before usable ICE servers
  were known is not stuck host-only forever. Already-working peers are never restarted — since T15.2
  they do record the new list, so a later failure recovers against current credentials rather than
  possibly-expired ones.

## Testing

Pure logic (`IceCandidateQueue`, `isTerminalPeerConnectionState`, `toRtcIceServers`) and
`Peer`/`P2PMeshTransport` orchestration (role-based offer ownership, ICE queueing, race handling,
cleanup idempotency, event fan-out, error containment) are unit-tested under `tests/rtc-core/`
against a hand-written `RtcPeerConnectionLike` fake — deliberately not a mock of the full
`RTCPeerConnection` DOM interface, and not a substitute for real negotiation. Real SDP generation,
ICE gathering, and an actual two-peer connection reaching `'connected'` require a real browser
engine (jsdom/happy-dom do not implement WebRTC) and are verified when this package is wired into
`apps/desktop` and exercised with two real Electron instances.
