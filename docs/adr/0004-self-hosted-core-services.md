# ADR 0004: Self-hosted core services

## Status

Accepted for the T0 foundation. This status accepts an architectural direction; T0 does not
contain deployed or production-ready services.

## Context

The product must support text, presence, signaling, persistent state, and WebRTC relay without
requiring a vendor account or hosted SaaS. Operators therefore need a complete deployable path,
including the security, backup, networking, and upgrade work that self-hosting entails.

## Decision

**Accepted:** every service required for core communication will have an operator-controlled,
self-hostable implementation. The initial shape is one internally modular realtime service for
signaling and text, storage colocated with that service, and an independent Coturn service for TURN.
Media flows through WebRTC peers or a later media transport, never through the realtime WebSocket
service. Managed services may be optional integrations but cannot be required for core operation.

**Hypotheses, not accepted implementation:** the authentication model, public deployment topology,
TLS termination, secret delivery, backup procedure, high availability, scaling thresholds, and
exact Coturn integration remain for T2, T7, and T10 to implement and verify. The checked-in
templates are examples, not evidence of a running or secure deployment.

## Consequences

- Operators retain control of core data and service availability and can operate without vendor
  lock-in.
- The project must provide secure configuration, migration, backup/restore, observability, upgrade,
  abuse-control, and fresh-host validation rather than transferring those duties to a SaaS vendor.
- TURN requires direct or layer-4-aware network exposure and short-lived server-minted credentials;
  an HTTP reverse proxy and process-liveness check are insufficient.
- Optional hosted integrations must preserve the same product contracts and cannot become a hidden
  prerequisite.

## Alternatives

- **Require hosted signaling, persistence, or TURN:** rejected because it violates the core
  self-hosting goal.
- **Run every concern in one process:** rejected as a fixed constraint; Coturn has different network
  and security responsibilities, while signaling and text may initially share one modular service.
- **Design production clustering now:** deferred until measured load and operational requirements
  justify it.
