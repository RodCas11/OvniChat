# ADR 0005 — One internally modular realtime service

## Status

Accepted architectural decision for the initial implementation. No realtime service is implemented
in T0.

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
