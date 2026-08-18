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

Not started. T0 intentionally left the source marker-only and did not run Forge start/package.
