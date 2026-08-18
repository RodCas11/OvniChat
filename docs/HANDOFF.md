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

T3 added voice channels, microphone capture, and P2P WebRTC on top of the T2 realtime service:

- `packages/protocol`: `voice:*`/`webrtc:*` message schemas (join/leave/catalog/participant
  notifications, offer/answer/ICE-candidate forwarding with server-verified source identity), three
  new non-fatal error codes.
- `services/realtime`: a hardcoded voice-channel catalog, an in-memory `VoiceRegistry` (membership,
  same-channel-only signaling authorization, abrupt-disconnect cleanup).
- `packages/rtc-core`: environment-neutral `MediaTransport`/`P2PMeshTransport`/`Peer`, deterministic
  offer/answer ownership (no glare-avoidance logic needed), ICE candidate queueing.
- `packages/media-core`: audio-only `acquireMicrophone()`, mute-without-reacquire, stop semantics.
- `apps/desktop`: a Renderer `RealtimeClient` (implements `rtc-core`'s `SignalingPort` directly), a
  voice-channel UI (join/leave, participants, mute/deafen, remote audio playback), audio-only
  same-origin microphone permission gating, CSP `connect-src` allowlisting the configured realtime
  origin, and an automated two-Electron-instance fake-media E2E smoke test.

**T3 is implemented and unit/integration-tested (331 Vitest tests, real-socket protocol/realtime
coverage, hand-written-fake coverage for `rtc-core`/`media-core`/the Renderer's `RealtimeClient`),
but the actual completion bar — two real Electron clients establishing a real WebRTC connection and
exchanging live microphone audio — has NOT been verified live in this environment.** See
[`tasks/T3_VOICE_WEBRTC.md`](tasks/T3_VOICE_WEBRTC.md)'s handoff notes for exactly why (a
methodically-isolated tool-environment Chromium instability, confirmed unrelated to this
implementation) and what to run on ordinary Windows hardware to close that gap.

Read [`tasks/STATUS.md`](tasks/STATUS.md) for the authoritative status,
[`tasks/T1_ELECTRON_SHELL.md`](tasks/T1_ELECTRON_SHELL.md) /
[`tasks/T2_REALTIME_PROTOCOL.md`](tasks/T2_REALTIME_PROTOCOL.md) /
[`tasks/T3_VOICE_WEBRTC.md`](tasks/T3_VOICE_WEBRTC.md) for their full verification records, and
[`references/VERSION_DECISIONS.md`](references/VERSION_DECISIONS.md) before changing the toolchain
— it records a real Forge/`@electron/packager` incompatibility T1 found and worked around.
[`architecture/REALTIME_PROTOCOL.md`](architecture/REALTIME_PROTOCOL.md) documents the full T2
protocol design; [`architecture/WEBRTC_VOICE.md`](architecture/WEBRTC_VOICE.md) documents T3's voice/
WebRTC design including a full join/signaling sequence diagram.

## What does not exist?

There is no camera/screen/system-audio capture, text chat, database schema, running Coturn stack
(templates exist but no TURN credential minting), installer/maker artifact, authentication/session
model, SFU, or production configuration/TLS termination. A live two-Electron-instance voice call has
not yet been verified end-to-end on real hardware (see above) even though every layer up to that
point is implemented and tested.

## What should happen next?

**First: close T3's live-verification gap** — run `pnpm --filter @disco-voador/desktop run
e2e:voice-smoke` and the manual two-instance check from `tasks/T3_VOICE_WEBRTC.md` on ordinary
Windows hardware, then update `tasks/STATUS.md`/`tasks/T3_VOICE_WEBRTC.md` to COMPLETE once they
pass.

**Then: T4 — camera streaming**, following the same pattern (task document under `tasks/`,
`project-orientation`, `planning-feature`, `webrtc-media-engineer` for `rtc-core`/`media-core`
extensions, `security-reviewer` for the new permission/signaling surface). Do not implement screen
sharing or text chat as part of T4 unless its task explicitly says so.

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

T3's clean-state evidence, 2026-08-18, is the same gate with 331 Vitest tests (no new
dependency-audit advisories) — formatting, lint, typecheck, build, and `verify-repository.mjs` all
pass. Unlike T1/T2, **T3's own required real-runtime evidence (two live Electron instances actually
exchanging audio) is explicitly outstanding** — this session's tool environment could not sustain any
Electron/Chromium window long enough to attempt it, confirmed unrelated to the implementation itself
(see [`tasks/T3_VOICE_WEBRTC.md`](tasks/T3_VOICE_WEBRTC.md)'s handoff notes for the full isolation
process). Do not treat T3's passing `pnpm check` as equivalent to T1/T2's runtime-verified status —
it is not, until the two-instance check in that task doc has actually been run and recorded.

Then perform the task’s required manual/platform checks. Apply
[`DEFINITION_OF_DONE.md`](DEFINITION_OF_DONE.md) and update status only when every applicable item
is evidenced. Electron-surface tasks specifically need actual Windows Electron start/quit and
packaged-artifact smoke tests; a passing TypeScript build alone is not a packaging claim.
