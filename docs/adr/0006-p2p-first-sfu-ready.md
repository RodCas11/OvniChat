# ADR 0006 — P2P first with an SFU-ready seam

## Status

Accepted initial transport direction. Participant thresholds and any SFU product are future
hypotheses requiring measurement; no RTC transport exists in T0.

## Context

P2P minimizes early infrastructure and media-server complexity for small rooms. Mesh upload and
screen-share fan-out scale poorly, so binding React state directly to mesh peers would make a later
SFU migration expensive.

## Decision

Implement the first voice/media vertical slice with P2P. Keep peer topology, negotiation, and
fan-out inside a generic `rtc-core` transport boundary. Present semantic participants and media
publications to application/UI code. Evaluate an SFU only after measuring the intended room and
screen-sharing workloads.

## Consequences

- Small-room development can progress without an SFU deployment.
- UI and media-source ownership must not assume one peer connection per visible participant.
- Transport diagnostics must expose enough evidence to identify mesh limits.
- Introducing an SFU later still requires protocol and operational work, but not a UI rewrite.

## Alternatives

- **SFU from day one:** deferred until scale justifies cost and product selection.
- **Expose mesh directly to UI:** rejected because it makes P2P permanent by accident.
- **Route media through the realtime service:** rejected for latency, bandwidth, and boundary reasons.
