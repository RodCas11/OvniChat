# Engineering handoff

## What is this project?

Disco Voador is a planned lightweight self-hosted Windows desktop communication application. The
target product combines text/voice channels, microphone, camera, screen/window streaming, and
optional Windows audio without becoming a browser product or requiring external SaaS.

## What exists now?

T0 provides:

- a pnpm TypeScript monorepo with explicit package boundaries;
- strict TypeScript, ESLint, Prettier, Vitest, CI, and deterministic repository checks;
- current Electron/Forge/Vite dependency decisions and a non-executable Forge configuration;
- marker modules that compile but implement no product behavior;
- Claude Code project instructions, conservative settings, eight specialist subagents, and eleven
  reusable skills;
- product, architecture, security, workflow, licensing, reference, ADR, task, and roadmap docs;
- Coturn/Docker configuration templates that are not a deployed service.

Read [`tasks/STATUS.md`](tasks/STATUS.md) for the authoritative status and
[`references/VERSION_DECISIONS.md`](references/VERSION_DECISIONS.md) before changing the toolchain.

## What does not exist?

There is no Electron window or UI, IPC bridge, WebSocket listener, protocol schema, presence,
signaling, WebRTC peer connection, device capture, chat, database schema, running Coturn stack,
installer, or production configuration. Marker exports ending in `Status = 'not-implemented'` are
truthful scaffold sentinels, not feature stubs.

## What should happen next?

**T1 — Electron desktop shell and application foundation.**

Use its detailed task document, [`tasks/T1_ELECTRON_SHELL.md`](tasks/T1_ELECTRON_SHELL.md), then run
`project-orientation`, `planning-feature`, and `electron-development`. Consult
`electron-desktop-engineer`; consult `security-reviewer` for the BrowserWindow, custom protocol,
navigation/permission, and IPC boundary. Do not start T2 or media implementation as part of T1.

## Fixed foundation decisions

- Windows desktop, Electron, React, TypeScript, Vite, and Electron Forge.
- Main/Preload/sandboxed Renderer trust boundary.
- Self-hostable core services; no mandatory SaaS.
- One internally modular realtime service may initially own signaling and text.
- Signaling/text are WebSocket; media is WebRTC and never relayed by that service.
- P2P first with an SFU-ready UI/transport seam.
- Independent microphone, camera, screen-video, and screen-audio sources.
- Windows-specific media isolated in `packages/windows-media`.
- SQLite first behind a storage boundary.
- VDO.Ninja/reference code follows the conservative provenance/license policy.

See accepted ADRs in [`adr/`](adr/); supersede them explicitly if evidence changes a decision.

## Decisions still open

- Concrete application state, routing, and UI component choices.
- WebSocket and runtime-schema libraries, protocol envelope, auth/session model.
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

Then perform the task’s required manual/platform checks. Apply
[`DEFINITION_OF_DONE.md`](DEFINITION_OF_DONE.md) and update status only when every applicable item
is evidenced. T1 specifically needs actual Windows Electron start/quit and packaged-artifact smoke
tests; T0’s passing TypeScript build is not a packaging claim.
