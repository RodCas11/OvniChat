# Disco Voador project instructions

Disco Voador targets a simple, self-hosted, low-latency **Windows 10/11 x64 desktop** communication
app. It is not a browser product. Target technologies are Electron + React + TypeScript + Vite,
WebSocket signaling/text, WebRTC media, SQLite, and Coturn. T0 is scaffold only; consult
[`docs/tasks/STATUS.md`](docs/tasks/STATUS.md) before claiming any capability exists.

## Map and sources of truth

- Product and non-goals: [`docs/PRODUCT.md`](docs/PRODUCT.md)
- Target architecture and package ownership: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Security rules: [`docs/SECURITY.md`](docs/SECURITY.md)
- Workflow and review gates: [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)
- Completion standard: [`docs/DEFINITION_OF_DONE.md`](docs/DEFINITION_OF_DONE.md)
- Current handoff: [`docs/HANDOFF.md`](docs/HANDOFF.md)
- Decisions: [`docs/adr/`](docs/adr/); tasks: [`docs/tasks/`](docs/tasks/)

Workspaces are `apps/desktop`, `services/realtime`, and `packages/{protocol,rtc-core,media-core,windows-media,config,shared}`.

## Non-negotiable boundaries

- Keep Renderer sandboxed: `nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`.
- Expose only narrow, validated Preload/IPC capabilities; never raw Node/Electron primitives.
- Keep generic RTC independent of Electron, React, Windows APIs, and mesh-specific UI assumptions.
- Keep Windows/native capture in `packages/windows-media`.
- Treat microphone, camera, screen-video, and screen-audio as independent sources; screen sharing must not end voice.
- Send text/signaling over the realtime service, never media payloads; use WebRTC for media.
- Keep core communication fully self-hostable; external SaaS cannot be required.
- Treat P2P as the first transport, not a permanent UI contract; preserve an SFU seam.
- Never commit credentials. Validate all network and IPC inputs. Do not log secrets or media.
- Do not copy VDO.Ninja code casually; follow [`docs/references/VDO_NINJA.md`](docs/references/VDO_NINJA.md).

## Workflow

Read the requested task before implementation, inspect existing code before changing architecture,
and invoke the relevant project skill. Use specialized subagents for focused cross-cutting work;
the main session remains the orchestrator. Do not make casual package-boundary changes. Record
accepted architecture changes in an ADR and update affected docs.

Run applicable tests plus `pnpm lint`, `pnpm typecheck`, and `pnpm build`; use `pnpm check` before a
large handoff. Report only checks actually run. A task is complete only when its acceptance criteria
and [`docs/DEFINITION_OF_DONE.md`](docs/DEFINITION_OF_DONE.md) are satisfied.

## Regression testing policy (impact-based, since T13.4)

Do not run the full historical E2E matrix as a habit at the end of every task. Inspect the actual
git diff, identify which subsystems genuinely changed (including shared dependencies), and run only
the E2E scenarios that exercise those subsystems. Run the full historical matrix only at an explicit
milestone/release gate or after a truly cross-cutting architecture change — never as routine
per-task hygiene. See [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md)'s "Regression testing: impact,
not habit" section for the full policy and worked examples.

Intrusive media E2Es (`e2e:camera-smoke`, `e2e:screen-smoke`, `e2e:screen-audio-smoke`,
`e2e:process-audio-smoke`) open the camera, capture the screen, or run native Windows audio capture
on the operator's real machine — never run one without first stating the exact changed dependency
that requires it. Audible tests that play real tones through real speakers require the same
justification and, where a non-audible instrumented alternative exists (fake sinks, playback-event
assertions, level-meter data instead of sound), prefer it — a real audible run is opt-in/manual, not
a routine regression default.
