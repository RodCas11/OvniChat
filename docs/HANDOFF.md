# Engineering handoff

## What is this project?

Disco Voador is a planned lightweight self-hosted Windows desktop communication application. The
target product combines text/voice channels, microphone, camera, screen/window streaming, and
optional Windows audio without becoming a browser product or requiring external SaaS.

## What exists now?

T0 provided the pnpm TypeScript monorepo scaffold: package boundaries, strict TypeScript/ESLint/
Prettier/Vitest/CI, dependency decisions, marker modules, the Claude Code harness, and docs.

T1 replaced the `apps/desktop` markers with a real, verified Electron application:

- a secure Main process (`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`,
  `webSecurity: true`, no application menu, default-deny navigation/window-open/permissions);
- a narrow typed Preload bridge (`window.desktopApp.getVersionInfo()`) with sender-origin-validated
  IPC — no raw `ipcRenderer`, no generic channel access;
- a custom `app://` protocol for packaged content loading (not `file://`), with a path-traversal
  containment check and CSP/`X-Content-Type-Options`/`Referrer-Policy` response headers;
- a minimal React Renderer that states which product capabilities are not implemented yet;
- a working `pnpm dev` (launches `electron-forge start`) and `electron-forge package` producing a
  runnable Windows x64 artifact, plus a scripted launch/load/quit smoke test
  (`apps/desktop/scripts/smoke.mjs`).

T2 replaced the `packages/protocol`, `packages/config`, and `services/realtime` markers with a
real, verified realtime connection backbone:

- `packages/protocol`: typed + `zod`-runtime-validated wire contracts (`client:hello`,
  `client:ping` / `server:hello`, `server:pong`, `server:error`), explicit protocol versioning, a
  closed `ErrorCode` set, and parse helpers that never throw on hostile input. Platform-neutral —
  no Electron/React/Node-fs/Windows/WebRTC dependency.
- `packages/config`: small reusable `zod`-based env-parsing/validation primitives.
- `services/realtime`: a real `ws`-based WebSocket server with an explicit handshake (with
  timeout), server-driven heartbeat liveness detection, a per-connection rate limiter, a
  configurable connection cap, `ws`'s own max-message-size enforcement, structured JSON logging,
  a single-connection exception containment boundary (one connection's bug can't crash the shared
  process), and programmatic `createRealtimeServer(config) -> {start(), stop()}` used by both the
  CLI bootstrap and the test suite.
- 141 Vitest tests including real (non-mocked) `ws` server/client integration tests covering the
  full handshake, two independent clients, heartbeat liveness, and an 11-case hostile-client
  matrix.

Read [`tasks/STATUS.md`](tasks/STATUS.md) for the authoritative status,
[`tasks/T1_ELECTRON_SHELL.md`](tasks/T1_ELECTRON_SHELL.md) /
[`tasks/T2_REALTIME_PROTOCOL.md`](tasks/T2_REALTIME_PROTOCOL.md) for their full verification
records, and [`references/VERSION_DECISIONS.md`](references/VERSION_DECISIONS.md) before changing
the toolchain — it records a real Forge/`@electron/packager` incompatibility T1 found and worked
around. [`architecture/REALTIME_PROTOCOL.md`](architecture/REALTIME_PROTOCOL.md) documents the
full T2 protocol design.

## What does not exist?

There is no WebRTC peer connection, device capture (microphone/camera/screen), chat, database
schema, running Coturn stack, installer/maker artifact, authentication/session model, or
production configuration/TLS termination. The Electron shell and the realtime connection backbone
are both real, not markers, but the realtime service claims no capability beyond "a client can
connect, negotiate, stay alive, and be safely rejected when it misbehaves" — no presence beyond
raw connection lifecycle, no voice/text messages.

## What should happen next?

**T3 — Voice channels and microphone WebRTC vertical slice.**

Use its detailed task document (create/update under `tasks/` following the T1/T2 pattern if it
does not already exist), then run `project-orientation` and `planning-feature`. Consult
`webrtc-media-engineer` for `packages/rtc-core`/`packages/media-core` and `realtime-backend-engineer`
for the `voice:*`/`webrtc:*` signaling messages this adds to `packages/protocol`; consult
`security-reviewer` for the new signaling surface. Do not implement camera, screen sharing, or text
chat as part of T3 unless its task explicitly says so.

## Fixed foundation decisions

- Windows desktop, Electron, React, TypeScript, Vite, and Electron Forge.
- Main/Preload/sandboxed Renderer trust boundary.
- Self-hostable core services; no mandatory SaaS.
- One internally modular realtime service may initially own signaling and text.
- Signaling/text are WebSocket (`ws`); media is WebRTC and never relayed by that service.
- Runtime validation uses `zod`, shared by `packages/protocol` and `packages/config`.
- P2P first with an SFU-ready UI/transport seam.
- Independent microphone, camera, screen-video, and screen-audio sources.
- Windows-specific media isolated in `packages/windows-media`.
- SQLite first behind a storage boundary.
- VDO.Ninja/reference code follows the conservative provenance/license policy.

See accepted ADRs in [`adr/`](adr/); supersede them explicitly if evidence changes a decision.

## Decisions still open

- Concrete application state, routing, and UI component choices.
- Auth/session model (T2's `connectionId` is explicitly not an identity signal).
- Exact RTC transport API, negotiation topology, diagnostics model, and room limits.
- Storage interface and SQLite driver/schema/migration tooling.
- Native addon versus isolated helper for advanced Windows audio.
- Installer/signing/update approach and production deployment topology.
- Whether/when measured scale justifies an SFU and which implementation to use.

## How should Claude work here?

Read [`../CLAUDE.md`](../CLAUDE.md), the task, affected architecture/security docs, and relevant ADRs.
The main session owns implementation. Delegate focused questions according to
[`DEVELOPMENT.md`](DEVELOPMENT.md); use skills as procedures, not as substitute product specs.
Inspect reality before changing architecture and report actual verification.

## How is work verified?

During iteration, run targeted tests/checks. Before a substantial handoff run:

```text
pnpm check
```

T0's final clean-state evidence on 2026-08-18 was a frozen-lockfile install followed by this full
gate: formatting, lint, typecheck, 16 Vitest tests, composite build, repository verification, and
the high/critical dependency audit all passed. See
[`tasks/T0_REPOSITORY_HARNESS.md`](tasks/T0_REPOSITORY_HARNESS.md) for environment details and
limitations.

T1's clean-state evidence, also 2026-08-18, is the same gate with 55 Vitest tests (one documented,
patched dependency-audit exception; see `references/VERSION_DECISIONS.md`), plus actual Windows
runtime evidence beyond `pnpm check`: `electron-forge start` and `electron-forge package` both
verified by launching real windows (development and the packaged `.exe` independently), an
automated launch/load/quit smoke script, and `@electron/fuses read` against the packaged binary.
See [`tasks/T1_ELECTRON_SHELL.md`](tasks/T1_ELECTRON_SHELL.md) for the full record.

T2's clean-state evidence, also 2026-08-18, is the same gate with 141 Vitest tests (the same one
documented dependency-audit exception; T2 introduced no new advisories), plus real-runtime
evidence: `pnpm --filter @disco-voador/realtime run dev` actually listening, and a real external
`ws` client (a separate OS process, not part of the Vitest run) completing a full
hello/hello/ping/pong/close round trip against it, cross-checked against the server's own
structured logs. See [`tasks/T2_REALTIME_PROTOCOL.md`](tasks/T2_REALTIME_PROTOCOL.md) for the full
record, including the one Windows-specific testing limitation it documents (`SIGINT`/`SIGTERM`
signal-handler wiring cannot be exercised via a cross-process signal on Windows, per Node's own
documented behavior — the underlying `server.stop()` logic it calls is thoroughly tested).

Then perform the task’s required manual/platform checks. Apply
[`DEFINITION_OF_DONE.md`](DEFINITION_OF_DONE.md) and update status only when every applicable item
is evidenced. Electron-surface tasks specifically need actual Windows Electron start/quit and
packaged-artifact smoke tests; a passing TypeScript build alone is not a packaging claim.
