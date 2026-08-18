# ADR 0003: Electron main, preload, and renderer boundaries

## Status

**Accepted (security boundary target).** T0 documents and verifies structure only; T1 must implement and test the desktop processes.

## Context

Electron combines a privileged Node.js main process with a web renderer. The application will eventually request media permissions, enumerate desktop sources, and invoke Windows adapters. A compromised renderer must not become arbitrary filesystem, shell, process, IPC, or native-helper access.

## Decision

**Accepted decisions:**

- Main owns application/window lifecycle, Electron sessions and permissions, desktop-source grants, external navigation policy, packaging security, and all native or operating-system integration.
- Preload is a small translation boundary that exposes one typed `contextBridge` capability per approved operation. It must not expose raw `ipcRenderer`, generic send/invoke methods, Node globals, filesystem, shell, or command execution.
- Renderer is sandboxed and treated as untrusted. It owns React UI and application orchestration but receives only minimal serializable results from privileged operations.
- Every window explicitly uses `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true`, with `webSecurity` enabled and a restrictive CSP.
- Main runtime-validates arguments and verifies sender frame and origin for every privileged IPC request. Permissions default to deny and use both Electron permission-check and permission-request handlers.
- Unexpected navigation and windows are denied. Any external URL is strictly allowlisted. Production content uses a standard, secure application protocol rather than weakening protections around `file://`.

**Hypotheses requiring later validation:**

- Exact bridge method names, IPC channels, schemas, error envelopes, and event subscription shapes belong to T1 and later vertical slices.
- The custom scheme name, display-source picker flow, and permission allowlist values must be proven against packaged production origins.
- The process boundary for a future Windows audio helper is deferred to T9; it must remain behind main and never be directly reachable from renderer.

## Consequences

Compromise of renderer content has a deliberately narrow path to privileged capabilities, and platform details remain testable outside React. This adds explicit IPC contracts, validation, lifecycle cleanup, and integration tests. New privileged behavior requires a reviewed capability rather than a convenient generic escape hatch.

## Alternatives

- **Node integration in renderer:** rejected because it turns renderer compromise into direct operating-system access.
- **Raw or generic IPC exposed through preload:** rejected because channel names are not authorization and the surface becomes difficult to audit.
- **Business logic in preload:** rejected because preload should remain a small security adapter, not a second application runtime.
- **Renderer calling native helpers directly:** rejected because it bypasses sender validation, permission policy, and process isolation.
