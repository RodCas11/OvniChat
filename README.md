# Disco Voador

> **Status: engineering scaffold — product implementation has not started.**

Disco Voador is the working name for a lightweight, low-latency, self-hosted Windows desktop
communication application. The target stack is Electron, React, TypeScript, Vite, WebSocket,
WebRTC, SQLite, and Coturn. The intended product eventually includes text and voice channels,
camera, screen/window sharing, and optional Windows audio sharing.

T0 deliberately contains no working window, UI, signaling server, chat, persistence, WebRTC,
device capture, or installer. It establishes repository boundaries, tooling, documentation, and a
Claude Code development harness so later tasks can implement those capabilities safely.

## Repository map

```text
apps/desktop             Electron Main/Preload/Renderer composition (future)
services/realtime        WebSocket signaling, presence, and text service (future)
packages/protocol        Canonical runtime-validated communication contracts (future)
packages/rtc-core        Environment-neutral WebRTC transport (future)
packages/media-core      Semantic media-source abstractions (future)
packages/windows-media   Windows-only capture/native boundary (future)
packages/config          Typed configuration (future)
packages/shared          Small, justified cross-cutting primitives (future)
infrastructure           Self-hosting templates; not a deployed stack
docs                     Engineering source of truth
.claude                  Project agents, skills, and conservative settings
tests                    Repository guardrail tests at T0
```

Start with [`CLAUDE.md`](CLAUDE.md) when using Claude Code or [`AGENTS.md`](AGENTS.md) with another
engineering agent. The product and target design live in [`docs/PRODUCT.md`](docs/PRODUCT.md) and
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md). Current status and the next task are in
[`docs/HANDOFF.md`](docs/HANDOFF.md).

## Prerequisites

- Windows 10/11 x64 for product work and platform verification
- Node.js 24 LTS
- Corepack with the repository-pinned pnpm 11 release
- Git for Windows; Claude Code may use native Windows or WSL according to its current support docs

```powershell
corepack enable
corepack prepare pnpm@11.22.0 --activate
pnpm install
pnpm check
```

If `corepack enable` cannot create a global shim without administrator access, keep the repository
pin and invoke the same commands as `corepack pnpm install` and `corepack pnpm check`.

The root `pnpm dev` command currently runs TypeScript in watch mode; it does **not** launch a
desktop product. T1 will create and verify the Electron shell.

## Standard commands

| Command          | Purpose                                                        |
| ---------------- | -------------------------------------------------------------- |
| `pnpm dev`       | Watch the T0 TypeScript scaffold                               |
| `pnpm audit`     | Fail on known high/critical dependency advisories              |
| `pnpm format`    | Format source, configuration, and documentation                |
| `pnpm lint`      | Run ESLint                                                     |
| `pnpm typecheck` | Type-check without emitting                                    |
| `pnpm test`      | Run Vitest guardrail tests                                     |
| `pnpm build`     | Compile package marker modules                                 |
| `pnpm verify`    | Check architecture, infrastructure, harness, docs, and secrets |
| `pnpm check`     | Run the complete local/CI quality gate                         |

## Project licensing

No license has been selected for this project; the package metadata is `UNLICENSED`. Do not assume
permission to redistribute it. Upstream reference and dependency licensing is documented in
[`docs/LICENSING.md`](docs/LICENSING.md).
