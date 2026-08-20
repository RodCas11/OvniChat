# Development workflow

The main Claude session owns implementation and integration. Specialized subagents perform focused
analysis or bounded changes and return evidence; they do not form an autonomous swarm.

## Standard task loop

1. Read [`../CLAUDE.md`](../CLAUDE.md) and the requested file in [`tasks/`](tasks/).
2. Run the `project-orientation` skill when the area or repository state is unfamiliar.
3. Inspect current code, tests, relevant ADRs, and status. Do not design from the roadmap alone.
4. Use `planning-feature` for substantial work; identify packages, interfaces, security, tests,
   architecture impact, acceptance criteria, and Definition of Done.
5. Ask only relevant specialist subagents for focused analysis. The main session decides and
   integrates.
6. Implement the smallest coherent vertical slice within task scope.
7. Add tests alongside behavior and reproduce regressions before fixing them when practical.
8. Run the smallest relevant checks while iterating, then all applicable quality gates.
9. Request security/QA review when the changed surface triggers a gate.
10. Update documentation and add/supersede an ADR when architecture changes.
11. Report changed behavior, actual commands/results, residual risks, and manual checks.
12. Update [`tasks/STATUS.md`](tasks/STATUS.md) only after all acceptance criteria and DoD are met.

## Architecture review gates

| Change                                                | Consult                                          |
| ----------------------------------------------------- | ------------------------------------------------ |
| Package boundaries or cross-cutting design            | `software-architect`                             |
| Electron Main/Preload/Renderer or packaging           | `electron-desktop-engineer`                      |
| Privileged IPC or Electron permission surface         | `electron-desktop-engineer`, `security-reviewer` |
| RTC negotiation, tracks, ICE, stats, or transport     | `webrtc-media-engineer`                          |
| Windows screen/system/process capture                 | `windows-media-engineer`                         |
| Protocol, WebSocket, presence, signaling, text events | `realtime-backend-engineer`                      |
| Coturn, Compose, TLS, reverse proxy, deployment       | `infrastructure-engineer`                        |
| Security-sensitive surface                            | `security-reviewer`                              |
| Large feature completion or difficult regression      | `qa-engineer`                                    |

Use judgment: small documentation fixes do not need every reviewer. Delegation prompts should name
the question, scope, files, constraints, and expected evidence.

## Commands

```text
pnpm install       install exactly from the lockfile in CI
pnpm dev           launches the Electron desktop shell (apps/desktop) via `electron-forge start`
pnpm --filter @disco-voador/realtime run dev
                   launches the realtime connection/session library's own dev CLI (services/realtime)
pnpm --filter @disco-voador/dedicated-server run dev
                   launches the Disco Voador Dedicated Server product (services/dedicated-server) —
                   the entrypoint a self-hoster actually runs; composes services/realtime
pnpm audit         fail on known high/critical dependency advisories
pnpm format        write Prettier formatting
pnpm format:check  verify formatting
pnpm lint          ESLint source and tooling
pnpm typecheck     strict no-emit TypeScript check
pnpm test          Vitest suite
pnpm build         compile workspace marker/source projects
pnpm verify        deterministic architecture/infrastructure/harness/doc/secret checks
pnpm check         complete quality gate
```

Do not report a command as passing unless it was run in the current state. A successful unit suite
does not replace manual Electron/media/package verification when those surfaces change.

## Test layers

- **Unit:** deterministic domain, schema, lifecycle, configuration, and error behavior.
- **Integration:** client/server protocol, storage adapters, IPC contracts, and module boundaries.
- **Electron smoke:** secure window settings, load/start/quit, navigation denial, IPC capability,
  and packaged artifact—not only Vite output.
- **Two-client realtime:** presence, join/leave, signaling delivery, chat ordering, reconnect.
- **Two-client WebRTC:** media establishment, mute/stop, camera + screen coexistence, ICE/TURN
  failure/recovery, cleanup, and stats.
- **Windows/manual:** device permission, source picker, system/process audio, output-device changes,
  protected content behavior, installer, update/repair/uninstall.

See the `testing-quality` skill for selecting applicable layers.

## Architecture changes

An architecture change modifies ownership, dependency direction, trust boundaries, persistence,
transport strategy, or an accepted ADR. Before changing it: describe the observed need, consult the
architect/security specialists as applicable, compare alternatives, create or supersede an ADR,
and update diagrams/guardrails. New abstractions require a real consumer and testable purpose.

## Dependency changes

Check the official package/release source, engine and peer ranges, maintenance/security state,
license, bundle/native impact, and lockfile diff. Keep related Electron Forge packages aligned.
Never upgrade Electron or its build stack without a start/package smoke test on Windows.
Security overrides are build-stack changes: keep them exact, run `pnpm audit`, and repeat the T1
package/start smoke gate when they move.
