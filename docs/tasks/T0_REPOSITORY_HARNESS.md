# T0 — Repository and Claude development harness

## Goal

Prepare a reproducible Windows-first monorepo, engineering knowledge base, task system, and focused
Claude Code harness from which a separate implementation session can start T1 safely.

## Context

This phase establishes guardrails and records the target architecture. It must not implement the
Electron product, realtime behavior, media capture, chat, persistence, or deployment.

## In scope

- pnpm workspaces, strict TypeScript, ESLint, Prettier, Vitest, build references, and Windows CI;
- marker-only package boundaries for desktop, realtime, protocol, RTC, media, configuration, and
  shared code;
- concise root instructions, specialist Claude agents, reusable project skills, and conservative
  project settings;
- product, architecture, security, workflow, configuration, completion, handoff, roadmap, task,
  licensing, primary-reference, and ADR documentation;
- deterministic checks for package boundaries, dependency provenance, pinned CI actions, harness
  structure, local documentation links, and likely secrets;
- non-deployed Coturn, Docker Compose, and reverse-proxy examples.

## Out of scope

- any working window, Renderer UI, IPC capability, WebSocket listener, signaling, WebRTC, device or
  desktop capture, text chat, application database schema, installer, or deployed service;
- Forge start/package claims, which require the real T1 shell;
- choosing the project owner's distribution license.

## Architecture constraints

Preserve every guardrail in [`../ARCHITECTURE.md`](../ARCHITECTURE.md) and accepted record under
[`../adr/`](../adr/). Target-state diagrams and conceptual interfaces are not implementation.

## Relevant packages

All workspace boundaries and repository-level tooling/documentation. Source entrypoints remain
truthful `not-implemented` markers.

## Relevant agents

- `software-architect` for boundary/ADR review;
- domain specialists for Electron, WebRTC, Windows media, realtime, and infrastructure research;
- `security-reviewer` and `qa-engineer` for guardrail and evidence review.

## Relevant skills

- `project-orientation`
- `planning-feature`
- `security-review`
- `testing-quality`

## Acceptance criteria

- The requested tree, documents, nine ADRs, eight agents, eleven skills, roadmap, status index, and
  detailed T1 task exist and agree about current implementation state.
- Package manifests and the lockfile contain compatible exact JavaScript package pins; the stable
  Forge suite remains aligned.
- Root install, format, lint, typecheck, tests, build, and repository verification pass.
- No product feature or production service is implemented or claimed.
- A cold-start agent can orient itself and produce a bounded T1 plan from repository artifacts.

## Required tests

- Vitest executes every repository verifier.
- The composite TypeScript build compiles all marker workspaces.
- A frozen-lockfile install proves dependency reproducibility.
- Installed Electron, Forge, and Vite binaries report the recorded versions.

## Manual verification

On Windows x64, inspect the complete tracked-intent tree, all package manifests, Claude agent/skill
frontmatter, ignored secret paths, task/document consistency, and source files for accidental
product behavior. No Electron/product smoke test applies because T0 intentionally has no runnable
application.

## Definition of Done

Apply [`../DEFINITION_OF_DONE.md`](../DEFINITION_OF_DONE.md). The final local gate is `pnpm check`
(invoked as `corepack pnpm check` when the global pnpm shim is unavailable).

## Handoff notes

Completed locally on 2026-08-18 with Windows, Node `24.18.1`, Corepack `0.35.0`, and pnpm `11.22.0`.
The repository/CI development selector is Node `24.19.0`; the current host's compatible earlier
Node 24 patch was recorded rather than misreported.

Evidence:

- `corepack pnpm install --frozen-lockfile` — passed for all nine workspace projects;
- `corepack pnpm check` — passed formatting, ESLint, no-emit typecheck, 16 Vitest tests, composite
  build, repository verification, and the high/critical dependency audit;
- `corepack pnpm -r run typecheck` and `corepack pnpm -r run build` — passed in all eight child
  workspaces;
- Electron `43.4.0`, Forge `7.11.2`, and Vite `7.3.6` installed-version checks — passed;
- JSON manifest parsing, workspace enumeration, ignore-rule probes, mojibake/path scans, and a
  read-only cold-start orientation/plan audit — passed.

Claude Code itself is not installed on this host, so CLI `/doctor`, discovery, and effective
permission diagnostics were not available. `pnpm` also lacks a global shim because this
non-administrative environment could not enable one; the documented `corepack pnpm` fallback was
used. These environment limits do not change repository content and should be rechecked when the
project is first opened in Claude Code.

No Git commit was created by T0. Review and establish the desired repository baseline before T1 if
the owner wants a clean commit boundary.
