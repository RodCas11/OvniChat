# Definition of Done

“Implemented,” “working,” and “complete” are evidence-backed statements. A task is done only when
its own acceptance criteria and every applicable item below are satisfied.

## Required baseline

- The requested behavior exists; a placeholder, interface, or mock is not presented as production
  implementation.
- Scope matches the task, including explicit out-of-scope items.
- Code follows repository boundaries and contains no unrelated architecture change.
- New behavior and regressions have tests at the appropriate level.
- Formatting, lint, typecheck, tests, and build pass for affected workspaces.
- Deterministic repository guardrails pass.
- Errors, cleanup, cancellation, and relevant edge cases are handled.
- No secrets, sensitive media metadata, or production credentials are committed or logged.
- Security implications are reviewed for the changed attack surface.
- Documentation, task notes, and ADRs accurately reflect the resulting state.
- Dependencies and copied/derived material have known provenance and acceptable licensing.
- No unreviewed high/critical dependency advisory remains in the lockfile; documented temporary
  acceptance requires an owner, expiry, mitigation, and follow-up task.

## Verification evidence

The handoff lists:

- exact commands run and whether each passed;
- manual scenarios actually performed, including environment/OS when relevant;
- tests not run and the reason;
- known limitations, follow-up work, and residual risk.

“Looks correct,” compilation alone, mocked success alone, or code inspection alone is insufficient.

## Surface-specific completion

### Electron

- Secure BrowserWindow preferences are asserted.
- Main/Preload/Renderer boundaries and IPC sender/input validation are tested.
- Start, load, quit, navigation denial, and relevant permission paths are smoke-tested.
- A packaged artifact is validated when packaging/runtime dependencies change.

### Realtime/protocol

- Runtime schemas and shared types cover client and server.
- Invalid, unknown, oversized, unauthorized, duplicated, and reordered/replayed inputs have defined
  behavior where relevant.
- A real two-client scenario validates connection and recovery claims.

### WebRTC/media

- A two-client scenario validates actual tracks, not only signaling mocks.
- Start/stop/replacement, negotiation collision, ICE state, TURN fallback, teardown, and unrelated
  source coexistence are exercised as applicable.
- Stats/diagnostics support the claimed behavior without logging sensitive content.

### Windows/native

- Supported Windows builds are stated and runtime capability failure is explicit.
- Device/source/process exit, permission, silence, output change, cleanup, and helper crash paths are
  considered.
- Manual verification occurs on real supported Windows where simulation is insufficient.

### Infrastructure

- Configuration contains no real secrets and has safe failure behavior.
- Deployment docs match actual ports, TLS, persistence, backup, and upgrade behavior.
- TURN is verified through real allocations/forced relay, not process liveness alone.

## Status updates

Only the main implementation session updates [`tasks/STATUS.md`](tasks/STATUS.md), and only after
reviewing this checklist and the task-specific Definition of Done. Partial completion remains
`IN PROGRESS` with clear handoff notes.
