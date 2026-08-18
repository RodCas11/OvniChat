# ADR 0005 — One internally modular realtime service

## Status

**Accepted and implemented.** T0 accepted the decision with no realtime service implemented. T2
implemented the connection/protocol-handling module of the "one internally modular service": a
real WebSocket server with an explicit handshake, versioned runtime-validated contracts in
`packages/protocol`, heartbeat liveness, and safe rejection of invalid input. Presence,
voice-signaling, and text-chat modules described below remain unimplemented — they are later
tasks (T3+, T7) building inside this same service, not yet-separate deployables. See
[`../architecture/REALTIME_PROTOCOL.md`](../architecture/REALTIME_PROTOCOL.md) and
[`../tasks/T2_REALTIME_PROTOCOL.md`](../tasks/T2_REALTIME_PROTOCOL.md).

## Context

Presence, WebRTC signaling, voice-channel state, and text delivery all need authenticated realtime
connections. Separate deployables would add routing, coordination, and operating cost before scale
or ownership boundaries justify them. Combining them without internal boundaries would create a
monolith and make later scaling difficult.

## Decision

Start with one self-hosted WebSocket service. Keep connection/session, presence, voice signaling,
text chat, and protocol handling as explicit internal modules. Define contracts in
`packages/protocol` and runtime-validate every message at ingress. Media payloads never traverse
this service.

## Consequences

- Initial deployment and debugging remain simple.
- Modules can share a connection/session boundary without duplicating infrastructure.
- Internal ownership and tests must prevent cross-domain state coupling.
- A module may become a separate service later if measured scaling or operational needs justify it.

## Alternatives

- **Separate signaling/chat/presence services now:** rejected as premature operational complexity.
- **One unstructured handler:** rejected because it hides boundaries and couples unrelated flows.
- **WebRTC data channels for text:** rejected because durable chat and offline history require the
  realtime/persistence path.
