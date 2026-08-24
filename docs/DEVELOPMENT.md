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
                   launches the Chantivo Dedicated Server product (services/dedicated-server) —
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
- **Renderer component (T13.1):** `@testing-library/react` + `jsdom`, scoped per test file via a
  `// @vitest-environment jsdom` docblock pragma — the global Vitest environment stays `node` for
  every other test. Covers presentation behavior (interaction rules, conditional rendering, prop
  wiring) with real application state mocked at the `use-voice-channel.ts`/IPC boundary, never
  hook-internal logic.
- **Integration:** client/server protocol, storage adapters, IPC contracts, and module boundaries.
- **Electron smoke:** secure window settings, load/start/quit, navigation denial, IPC capability,
  and packaged artifact—not only Vite output.
- **Two-client realtime:** presence, join/leave, signaling delivery, chat ordering, reconnect.
- **Two-client WebRTC:** media establishment, mute/stop, camera + screen coexistence, ICE/TURN
  failure/recovery, cleanup, and stats.
- **Windows/manual:** device permission, source picker, system/process audio, output-device changes,
  protected content behavior, installer, update/repair/uninstall.

See the `testing-quality` skill for selecting applicable layers.

## Regression testing: impact, not habit

**Since T13.4**, choosing which E2E scripts to re-run at the end of a task is a deliberate,
diff-driven decision — not a fixed checklist run every time regardless of what changed. This
repository now has enough historical E2E scripts (voice, camera, screen, screen-audio,
process-audio, identity, authorization, channels, profiles, settings, reconnect, product-shell) that
running all of them per task wastes development time and session context, and several of them are
genuinely intrusive on the operator's real machine — they open the camera, capture the screen, or
drive real Windows native audio capture. Running them when the actual change could not possibly
affect them is not "being thorough," it is noise that also has a real-world side effect the operator
did not ask for.

**Before choosing final regression E2Es:**

1. Inspect the final `git diff` for the task (files actually changed, not the task's own
   description of itself).
2. Identify which subsystems those files belong to, including genuinely shared dependencies (e.g. a
   change to `packages/rtc-core`'s `MediaTransport` interface is shared by voice, camera, screen, and
   screen-audio; a change scoped to `apps/desktop/src/renderer/voice/RemoteAudio.tsx`'s
   volume/gain handling is not, by itself, a camera or screen change).
3. Run the E2E scripts that exercise those subsystems, plus any new scripts the task itself added.
4. Run the full historical E2E matrix only at an explicit milestone/release gate (e.g. before a
   version tag or install-candidate build) or after a change that is genuinely cross-cutting
   (a shared transport/protocol/IPC boundary change with no way to scope it to fewer scripts) — never
   as routine per-task hygiene.

**State the reasoning, not just the result.** A task's final report should include a short impact
matrix: what changed, which E2Es were selected because of it, and — just as importantly — which
historically-relevant-looking E2Es were deliberately _not_ run and why their dependency path was
untouched. "I ran the full suite to be safe" is not an acceptable substitute for this reasoning; it
is exactly the habit this policy replaces.

**Intrusive/physical-side-effect E2Es require explicit justification before running, every time:**
`e2e:camera-smoke` (opens the real camera), `e2e:screen-smoke`/`e2e:screen-audio-smoke` (captures the
real screen/system audio), `e2e:process-audio-smoke` (drives the real native Windows process-loopback
helper). Before running any of these, state the exact changed dependency that requires it (e.g. "this
task changed `packages/rtc-core`'s shared renegotiation path, which all four media sources go
through"). Do not run them "just in case" or because a task touched an adjacent, non-shared file in
the same directory.

**Audible tests are not a routine regression default.** A test that plays a real, audible tone
through the operator's actual speakers (or drives a real microphone-to-speaker loop) must not run
as part of ordinary automated development — it makes noise on a real machine every time the suite
runs, which is a genuine, avoidable disruption. Prefer an instrumented, non-audible proof wherever
one is practical: a fake/mocked audio sink, an assertion on playback-triggering events or computed
gain/level values, or a synthetic Web Audio signal fed through the real processing path with output
captured programmatically rather than played. Reserve an actual audible run for deliberate, manual,
explicitly-opted-into verification (e.g. a human confirming a notification sound's real loudness
once, by choice) — never as something an agent or CI triggers by default.

This policy does not relax the underlying `DEFINITION_OF_DONE.md` requirement that a real,
non-mocked scenario validate a claimed capability — it only changes _which_ real scenarios run _by
default_ for a given task, and requires the choice to be reasoned from the actual diff rather than
copied from the last task's checklist.

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
