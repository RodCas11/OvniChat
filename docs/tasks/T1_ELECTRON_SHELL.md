# T1 — Electron desktop shell and application foundation

## Goal

Deliver the smallest secure Windows Electron application shell that starts, renders a minimal React
surface, shuts down cleanly, and packages into an artifact whose security boundaries are verified.

## Context

T0 selected Electron 43, Electron Forge 7, Vite 7, React 19, and the Main/Preload/Renderer boundary.
The current desktop source files are marker modules only. Forge’s Vite plugin is experimental and
its pnpm/monorepo packaging behavior must be validated rather than assumed.

Before work, re-check current security/release notes and
[`../references/VERSION_DECISIONS.md`](../references/VERSION_DECISIONS.md). Upgrade only through an
intentional, compatible toolchain decision.

## In scope

- Electron Main lifecycle and one BrowserWindow on Windows;
- an explicit secure BrowserWindow configuration;
- secure application content loading and restrictive CSP;
- a minimal Preload bridge boundary (zero or one harmless typed diagnostic capability);
- a minimal React shell that states product features are not implemented;
- development start and production build/package scripts;
- one local Windows x64 application directory produced by `electron-forge package`;
- automated unit/configuration tests and Electron start/load/quit smoke coverage;
- documentation of actual commands, artifact location, and limitations.

## Out of scope

- server selection, channels, navigation product UX, authentication, settings, or persistence;
- WebSocket/realtime behavior;
- microphone, camera, screen, system/process audio, or WebRTC;
- production updater, signing, installer hardening, or release distribution;
- Forge makers and installer artifacts; those belong to T11;
- generic IPC framework, state framework, design system, or speculative service abstractions.

## Architecture constraints

- Use `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true` explicitly.
- Do not expose raw `ipcRenderer`, Node, filesystem, shell, or arbitrary channel APIs.
- Validate IPC sender and payload for any capability added.
- Deny navigation, new-window, unexpected protocol, and media permission requests by default.
- Prefer a registered standard/secure custom app protocol over `file://`; document any temporary
  exception with a follow-up criterion.
- Renderer must not import Node or Electron.
- Keep all RTC/media/realtime functionality out of T1.
- Preserve pnpm `node-linker=hoisted` and aligned Electron Forge package versions.

## Relevant packages

- `apps/desktop`
- root build/test/tooling configuration only where needed for the shell

## Relevant agents

- `electron-desktop-engineer` for implementation design and Forge/Electron review;
- `security-reviewer` for BrowserWindow, content loading, navigation, permissions, and IPC;
- `qa-engineer` before completion for smoke/package evidence;
- `software-architect` only if a package-boundary change is proposed.

## Relevant skills

- `project-orientation`
- `planning-feature`
- `electron-development`
- `security-review`
- `testing-quality`

## Acceptance criteria

- `pnpm dev` launches the desktop shell on supported Windows and the Renderer shows an accurate
  “foundation only” React surface.
- Closing all windows and application activation/quit follow expected Windows Electron lifecycle.
- Automated checks assert actual BrowserWindow security preferences and denied navigation/window
  creation/permissions.
- Renderer has no privileged imports or unrestricted bridge.
- Production assets load without development-server dependence.
- The local Windows application directory produced by `electron-forge package` starts and exits
  cleanly; a Forge maker/installer is not required in T1.
- Root `pnpm check` passes and documentation no longer describes `pnpm dev` as T0 watch-only.
- No product capability beyond the shell is claimed or implemented.

## Required tests

- unit tests for window-option construction and URL/navigation allowlists;
- tests for Preload API shape and argument validation if a capability exists;
- repository forbidden-import guardrail;
- Electron smoke test for start, content load, one visible window, and clean quit;
- packaged-artifact smoke test on Windows;
- failure test proving unexpected navigation/window creation and media permission are denied.

## Manual verification

On Windows 10 or 11 x64, record OS build, Node/pnpm versions, commands, startup result, visible
surface, developer-console/CSP errors, quit behavior, package path, and packaged startup result.
Do not count a Vite build alone as packaging verification.

## Definition of Done

Meet all acceptance criteria, applicable items in [`../DEFINITION_OF_DONE.md`](../DEFINITION_OF_DONE.md),
security review, QA review, and actual Windows smoke evidence. Update architecture/security/reference
docs and create/supersede an ADR if the loading, IPC, or packaging boundary changes.

## Handoff notes

Implemented. Main/Preload/Renderer are real (not markers); see `apps/desktop/src/{main,preload,renderer}/`.
Reviewed by `electron-desktop-engineer`, `security-reviewer`, and `qa-engineer`; every actionable
finding from those reviews (an IPC double-registration hazard, a `decodeURIComponent` edge case, a
missing application menu suppression, missing `X-Content-Type-Options`/`Referrer-Policy` headers,
and a real-but-unwired automated smoke-test gap) was fixed, and the fixes were re-verified below
rather than only re-run in unit tests.

### Manual and scripted verification record

- **Environment:** Windows 11 Pro build 10.0.26200, Node `24.18.1` (local host baseline; project/CI
  target `24.19.0` per T0's documented exception), pnpm `11.22.0`.
- **Development launch:** `corepack pnpm --filter @disco-voador/desktop run start` (= root
  `pnpm dev`) → `electron-forge start`. Result: main+preload built, a real `BrowserWindow` titled
  "Projeto Disco Voador" opened, screenshotted showing "Electron 43.4.0 / App version 0.0.0 / T1
  Electron Shell — Ready" (values fetched live through the preload bridge's `app:get-version-info`
  IPC round-trip — this can only render if Main, Preload, and Renderer are all working together).
  No console/CSP errors in the captured log. Closing the window triggered `window-all-closed` →
  `app.quit()`; the whole `electron-forge start` process exited with code 0 and zero
  `@disco-voador-desktop`/`electron` processes remained (verified via `Get-Process`).
- **Forge compatibility:** Electron `43.4.0` + Forge `7.11.2` + Vite `7.3.6` + TypeScript `6.0.3`
  work together for both `start` and `package`, but **only** with `@electron/packager` at its
  natural Forge-compatible `18.4.4` — packager `20.3.0` (T0's provisional pin) crashes Forge's
  packaging pipeline outright. Full root-cause and the resulting `extract-zip` patch are recorded
  in `docs/references/VERSION_DECISIONS.md`.
- **Package:** `corepack pnpm --filter @disco-voador/desktop run package` → `electron-forge
package`. Result: completed cleanly, producing
  `apps/desktop/out/@disco-voador-desktop-win32-x64/@disco-voador-desktop.exe`. Re-run after the
  post-review fixes; still completes cleanly.
- **Packaged EXE verification:** launched the exe directly (not through Forge). Result: window
  opened titled "Projeto Disco Voador", screenshotted showing the same live version info — served
  through the `app://renderer/index.html` custom protocol (production path, no dev server),
  confirming the protocol handler, CSP, and preload bridge all work in the packaged build. Pressing
  Alt after the review fix does not reveal any native menu (`Menu.setApplicationMenu(null)`;
  re-screenshotted to confirm). Closing the window quit the process cleanly; zero processes
  remained afterward. `npx @electron/fuses read` against the exe confirmed all six configured
  fuses are actually set: `RunAsNode` disabled, `EnableCookieEncryption` enabled,
  `EnableNodeOptionsEnvironmentVariable` disabled, `EnableNodeCliInspectArguments` disabled,
  `EnableEmbeddedAsarIntegrityValidation` enabled, `OnlyLoadAppFromAsar` enabled.
- **Automated Electron smoke test:** `apps/desktop/scripts/smoke.mjs` (run via
  `pnpm --filter @disco-voador/desktop run smoke`) launches the packaged exe with
  `DISCO_VOADOR_SMOKE_TEST=1`, which arms a `did-finish-load`/`did-fail-load`-gated auto-quit in
  `apps/desktop/src/main/index.ts`; the script asserts the `SMOKE_OK` marker and exit code 0
  within a timeout. This was flagged by both the security and QA reviews as a real gap (the
  auto-quit flag existed but nothing invoked it) and has been closed: run twice against the final
  code (once immediately after packaging, once after the security-hardening fixes), both passed.
  It is not wired into `.github/workflows/quality.yml`; that is a separate, deliberately deferred
  decision (see "Known limitations" in the final report) since CI pipeline changes are treated as
  a distinct, higher-scrutiny action.

### Automated tests

55 Vitest tests total (39 under `tests/desktop/*.test.ts`; this repository's tests live under
top-level `tests/`, not colocated with source, plus 16 pre-existing `tests/repository/` tests that
now also exercise the real T1 source instead of markers): secure `BrowserWindow` option construction; the CSP builder
(strict in production, one documented dev-only relaxation for Vite/React-Refresh's inline
preamble); origin computation and the `app://` protocol's path-traversal containment (including
the WHATWG URL parser's own forward-slash/percent-encoded dot-segment normalization vs. the
backslash-traversal case that actually exercises the manual containment check on Windows);
navigation/window-open/permission default-deny behavior; IPC sender-origin validation
(trusted/untrusted paths, and idempotent handler registration across a simulated window
recreation — the double-registration hazard the electron-desktop-engineer review found); the
`app://` protocol handler's response headers (CSP, `X-Content-Type-Options`, `Referrer-Policy`)
and its 404 path for an unexpected host; the preload bridge's exposed shape (`{getVersionInfo}`
only, no raw `ipcRenderer`); and a renderer shell render test via `react-dom/server` (chosen to
avoid adding a jsdom/happy-dom dependency for T1's scope).
