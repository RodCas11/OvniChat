# ADR 0007: Isolate Windows-specific media

## Status

Accepted for the T0 foundation. The package and trust boundaries are accepted; no Windows capture
implementation exists in T0.

## Context

System-loopback and process-tree audio use Windows- and Electron-specific capabilities with
different support floors and security properties. Letting these details leak into React, generic
media lifecycle, or RTC transport would couple the product to unstable platform behavior and widen
the privileged attack surface.

## Decision

**Accepted:** Windows capture adapters belong in `packages/windows-media`. Generic source ownership
and lifecycle remain in `packages/media-core`, and environment-neutral transport remains in
`packages/rtc-core`. Privileged enumeration and capture are owned by Electron Main; a sandboxed
Renderer can request only narrow capabilities through Preload and receives opaque target identifiers
and minimal serializable state. System-loopback and process-tree capture are distinct capabilities
with explicit runtime support results, user intent, an active indicator, stop behavior, and cleanup.

**Hypotheses, not accepted implementation:** Electron's exact system-loopback path, native addon
versus isolated signed helper, native IPC and PCM transport, target-selection UX, and advanced
process-capture support remain for T6 and T9 spikes. Process-loopback is expected to require Windows
build 20348 or later, practically Windows 11, but a future implementation must feature-test rather
than infer support from a product label.

## Consequences

- React and generic RTC/media packages remain testable without Windows APIs and cannot issue raw
  native commands.
- Main must validate sender, arguments, target lifetime, and PID reuse/exit races. Source names,
  thumbnails, device data, and process metadata remain sensitive.
- Process-tree capture must not be described as exact-window audio. Protected content may be silent
  and must not be bypassed.
- A native boundary adds packaging, signing, failure-recovery, buffering, and performance work; an
  isolated helper may also add copies and local-IPC complexity.

## Alternatives

- **Put Windows capture directly in the Renderer or Preload:** rejected because it expands the
  privileged surface and breaks the Electron trust boundary.
- **Embed Windows behavior in `media-core` or `rtc-core`:** rejected because it reverses dependency
  direction and contaminates environment-neutral contracts.
- **Choose an addon or helper in T0:** deferred because the choice requires a real Windows capture,
  lifecycle, latency, packaging, and crash-isolation spike.
