# T12 — Windows per-process/game audio capture

## Goal

Let a user share a single running Windows application's audio (e.g. a game) instead of the entire
system output T6 already provides — using the real Windows process-loopback API
(`ActivateAudioInterfaceAsync` / `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`), publishing the
result through the exact same `screen-audio` semantic RTC source T6 established, with no new remote
protocol.

## Context

T0–T11 built the full communication platform in TypeScript/Electron/WebRTC only — no native/compiled
code has existed anywhere in this repository until T12. `packages/windows-media` has been a T0-era
marker package since the beginning, explicitly reserved (per
[`adr/0007-windows-media-isolation.md`](../adr/0007-windows-media-isolation.md)) for "Windows-specific
screen/audio capture, WASAPI integration, process-loopback research, and any native helper." T6's own
system-wide loopback needed zero native code (Electron/Chromium do the WASAPI work internally for
that case); process-scoped loopback has no such shortcut — Electron exposes no PID-scoped capture API
(confirmed by this repo's own prior primary-source research,
[`references/WINDOWS_MEDIA.md`](../references/WINDOWS_MEDIA.md)) — so T12 is genuinely this project's
first native Windows code.

## In scope

- Real Windows process-loopback audio capture (`ActivateAudioInterfaceAsync`,
  `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, `PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`).
- An out-of-process native helper (C++), a framed local IPC protocol, and a PCM-to-`MediaStreamTrack`
  bridge, all entirely client-local.
- A local application picker (None / System audio / Application audio), reusing T6's screen-share
  flow.
- Publishing the resulting track through the existing `screen-audio` semantic source — no new remote
  signaling.
- Runtime Windows-build detection with an honest "unavailable" state on unsupported systems — never a
  silent fallback to broader (system) capture.
- A deterministic, frequency-isolation E2E proof: two independently running processes producing known,
  different tones; the remote side must receive the selected one and demonstrably not the other.

## Out of scope (explicitly deferred)

- T13 (TURN/TLS/Docker production self-hosting), T14 (installer/release distribution), an SFU,
  monetization, cloud infrastructure.
- Virtual audio drivers, DLL injection, game hooks/overlays, Rich Presence, game-activity tracking or
  history, any process telemetry.
- Complex game-launcher process-genealogy resolution beyond straightforward process-tree inclusion.
- Hot-switching the audio mode without stopping/restarting the share, unless `replaceTrack` makes it
  trivially cheap to add without expanding scope.

## Architecture constraints

- The remote WebRTC source remains `screen-audio` — no new remote source type, no new signaling
  message. If implementation pressure ever suggests otherwise, that is a design smell to stop and
  reconsider, not a requirement to work around.
- Native code lives entirely in `packages/windows-media` (both the C++ helper source and its TS
  supervisor/client) — never leaking Win32/WASAPI concerns into `rtc-core`, `media-core`, the
  Renderer, or the Dedicated Server. See
  [`adr/0017-windows-process-loopback-native-boundary.md`](../adr/0017-windows-process-loopback-native-boundary.md).
- Process selection, PCM audio, and all capture metadata are entirely client-local — the Dedicated
  Server and remote peers receive only the existing `screen-audio` track, nothing else.
- No silent broadening of capture scope: if process-loopback is unavailable or fails, the UI must say
  so plainly — never silently substitute system-wide audio for what the user explicitly scoped to one
  application.
- Camera/screen-video/system-audio's existing T4-T11 lifecycle, reconnect, and output-routing
  guarantees are preserved unchanged; process audio follows the identical non-auto-restore-after-
  reconnect policy T11 established.

## Relevant packages

`packages/windows-media` (native helper + TS supervisor, new), `packages/media-core` (capture-session
abstraction), `packages/rtc-core` (unchanged — reused as-is), `apps/desktop` (Main process lifecycle/
IPC/packaging, Renderer picker UI + PCM bridge).

## Relevant agents

`windows-media-engineer` and `webrtc-media-engineer` (primary specialists), `electron-desktop-engineer`
(Main/Preload/Renderer/packaging integration), `software-architect` (consulted for the native
integration strategy — see ADR 0017), `security-reviewer` and `qa-engineer` (final gates).

## Relevant skills

`project-orientation`, `planning-feature`, `electron-development`, `webrtc-development`,
`windows-media-capture`, `testing-quality`, `security-review`.

## Acceptance criteria

See [`docs/DEFINITION_OF_DONE.md`](../DEFINITION_OF_DONE.md) and the exhaustive T12 checklist the
task's own brief specified — summarized in the Handoff notes below with each item's actual evidence.
The single non-negotiable proof: two independently running Windows processes produce different known
tones; the user selects one; the remote client receives that process's audio and demonstrably does
not receive the other's.

## Definition of Done

Complete only when every applicable item in `docs/DEFINITION_OF_DONE.md` and the task's own checklist
is satisfied with real evidence — a compiled, running native helper proven against real Windows audio
hardware, not a design document — all E2E scripts pass their required consecutive runs, security and
QA review findings are addressed, and documentation reflects actual behavior. Otherwise: IN PROGRESS.

## Handoff notes

### What is real and verified

- **`packages/windows-media/src/protocol.ts`** — the full framed wire protocol between the native
  helper and its TS supervisor (all 11 message types, `FrameDecoder` stream reassembly, every length
  bounded). Pure TypeScript, no dependencies, no native/Electron code involved. 27 unit tests
  (`tests/windows-media/protocol.test.ts`) cover round-trip encode/decode for every message type,
  split/coalesced-chunk reassembly, oversized-length rejection, and malformed-payload rejection —
  which caught and fixed a real bug (`exeName`'s 260-byte bound exceeded `string8`'s 255-byte
  length-prefix ceiling, silently corrupting frames; fixed by switching `exeName` to `string16`).
- **`packages/windows-media/src/capability.ts`** — Windows-build feature detection
  (`detectProcessAudioCapability`), parsing the numeric build out of `os.release()` rather than any
  product-name string, per this task's own firsthand confirmation that this machine's registry
  `ProductName` ("Windows 10 Pro") disagrees with its real `CurrentBuild`/`os.release()` (`26200`).
  Unit-tested (`tests/windows-media/capability.test.ts`).
- **`docs/adr/0017-windows-process-loopback-native-boundary.md`** — records the native-helper-vs-addon
  decision and the PCM bridge/packaging shape, per the `software-architect` consult.
- **`packages/windows-media/src/process-loopback-supervisor.ts`** — `ProcessLoopbackSupervisor`, the
  Node/Electron-Main-side owner of one helper process's lifecycle: spawns it, connects to the named
  pipe the helper creates (helper is the pipe server, Main is the client — see the pipe-topology
  note in this file's own doc comment and ADR 0017 for why), completes the Hello/Ready handshake,
  and re-exposes `enumerateResponse`/`format`/`audioFrame`/`targetEnded`/`error`/`stopped`/
  `helperExit` as a typed `on`/`off` event surface matching this repo's existing
  `ReconnectController` convention. Implements bounded/backpressured PCM delivery
  (`acknowledgeAudioFrame()` + a high/low watermark pausing the socket). 8 unit tests
  (`tests/windows-media/process-loopback-supervisor.test.ts`) run against a hand-written plain-JS
  stub helper (`tests/windows-media/fixtures/stub-helper.mjs`, deliberately not importing
  `protocol.ts` to avoid test/build ordering coupling) covering handshake success, enumerate,
  Start/Format/AudioFrame, clean stop, unexpected helper exit, and two handshake-failure modes.
- **`packages/media-core/src/process-audio-track.ts`** — `createProcessAudioTrack`, the
  environment-neutral Renderer-side PCM-to-`MediaStreamTrack` synthesis session: given an
  already-connected `MessagePort` speaking a small format/audioFrame/ended/error message contract
  (this module's own design, documented in its doc comment, deliberately not importing
  `windows-media/protocol.ts` to keep this package independent of the native-adjacent one), it builds
  a live `MediaStreamTrack` via `MediaStreamTrackGenerator({ kind: 'audio' })` (primary — confirmed
  shipped unflagged since Chromium 94, well before this repo's pinned Electron 43.4.0/Chromium 150)
  with a runtime-feature-detected `AudioContext`/`AudioWorkletNode` fallback for an environment
  lacking it. Implements a bounded (64-frame), drop-oldest backpressured queue plus a per-frame `ack`
  message back to the sender, and never applies microphone-style processing (no echo
  cancellation/noise suppression/AGC). 17 unit tests (`tests/media-core/process-audio-track.test.ts`)
  against hand-stubbed globals (this repo's tests run under Node, with no real `MessagePort`/
  `AudioContext`/`MediaStreamTrackGenerator`) cover both synthesis paths, format-change handling,
  backpressure, and full teardown. Reviewed and one real gap fixed during review: `AudioData` chunks
  written into the generator path were never explicitly `close()`d, which the WebCodecs spec does not
  do automatically on `write()` — left as-is it would rely on GC and risk resource-pressure warnings
  under a sustained real-time stream; now closed in a `finally` block after every write.
- **`packages/windows-media/native/process-loopback-helper/`** — the native C++ WASAPI process-
  loopback helper: `CreateNamedPipeW` with `FILE_FLAG_FIRST_PIPE_INSTANCE` and a current-user-SID-
  restricted DACL (`D:P(A;;GA;;;<SID>)`), a real constant-time Hello-token compare, `ActivateAudioInterfaceAsync`
  process-loopback capture with `IAgileObject`/`CoCreateFreeThreadedMarshaler` on the completion
  handler (a real `E_ILLEGAL_METHOD_CALL` was hit and fixed this way), PID-reuse-safe target
  monitoring via `WaitForMultipleObjects` on a held process handle, real `IAudioSessionEnumerator`-
  based enumeration (never a window-title heuristic), and bounds-checked `AudioFrame` chunking
  against `MAX_FRAME_PAYLOAD_BYTES`. A real deadlock (a pending control-thread `ReadFile` blocking a
  concurrent capture-thread `WriteFile` on the same synchronous pipe handle) was found and fixed by
  switching to `FILE_FLAG_OVERLAPPED` with per-call `GetOverlappedResult(..., bWait=TRUE)`. Built via
  a reproducible `build.ps1` (locates the installed MSVC toolchain, drives `cl`/`link` directly — no
  CMake on this machine); output is gitignored, never committed. Reviewed and independently
  re-verified in this session: rebuilt from clean via `build.ps1` (zero errors), and the real,
  already-unit-tested TypeScript `ProcessLoopbackSupervisor` was run against the real compiled
  `.exe` (not a stub) — a real Hello/Ready handshake, real `EnumerateResponse` with genuinely running
  processes (`steam.exe`, `Discord.exe` ×2), and a real clean `Stop`/`Stopped`/exit — proving the
  independently-built TypeScript and C++ halves are actually wire-compatible with each other, not
  merely each independently compliant with `protocol.ts` in isolation. Separately, live testing
  during the helper's own build confirmed real non-silent PCM capture from an active audio-producing
  process and genuine per-process isolation (a second, non-audio-producing process captured as pure
  silence while the first was actively producing sound).
- **Main-process IPC/lifecycle wiring, the `MessageChannelMain` PCM bridge, the Renderer picker UI,
  and packaging are now built** (`apps/desktop/src/main/process-audio.ts`, `main/ipc.ts`,
  `preload/index.ts`, `renderer/media/process-audio-bridge.ts`, `renderer/voice/ScreenSourcePicker.tsx`
  /`use-voice-channel.ts`, `forge.config.ts`) and verified against a real Electron runtime, both in
  dev mode and a real packaged `.exe` — see `docs/adr/0017-windows-process-loopback-native-boundary.md`'s
  "Consequences" section for a packaging correction found and fixed during this pass (`extraResource`,
  not `asar.unpack` — the latter, as originally planned, does not work with this project's Vite-bundled
  Main/Preload build). Real evidence gathered via Chrome DevTools Protocol against a live Renderer:
  `getProcessAudioCapability` -> `{supported:true}` on this machine; `listProcessAudioCandidates` ->
  real native helper spawn + Hello/Ready handshake + `EnumerateResponse` listing genuinely running
  processes (`steam.exe`, `Discord.exe` ×2, plus a deliberately-launched audio-producing
  `powershell.exe` test process); `acquireProcessAudioTrack` -> a real `MessageChannelMain` port
  transfer -> `createProcessAudioTrack` -> a live `MediaStreamTrack` (`readyState: 'live'`) whose
  audio was sampled via a real `AnalyserNode` and found genuinely non-silent (`maxDeviation: 43` out
  of a possible 128 around the silence baseline); an explicit `stop()` cleanly ended the track; and,
  separately, externally killing the captured target process produced a real `TargetEnded` from the
  native helper, propagated as `{type:'ended'}` over the port (cleanly ending the synthesized track)
  and as a separate `processAudioEnded` push notification correlated by session id. The same
  capability/enumeration round-trip was independently re-verified against the actual packaged `.exe`
  (helper spawned from `resources/process-loopback-helper.exe` via `process.resourcesPath`, not the
  dev-tree path).
- **`apps/desktop/scripts/e2e-process-audio-smoke.mjs`** (new) — the mandatory frequency-isolation
  proof harness: two standalone real Windows processes (`scripts/lib/tone-process/main.mjs`, each a
  genuinely separate Electron process rendering one continuous, deterministic sine tone — 500 Hz and
  750 Hz, deliberately non-harmonically related so a codec artifact of one tone can never be mistaken
  for the other's fundamental) plus a real publisher/viewer pair exercising the actual production
  path (`ScreenSourcePicker`'s "Application audio" pick, real native capture, real WebRTC, a new
  FFT-based `e2e-frequency-probe.ts` on the remote side — see that file's own doc comment for the
  threshold/margin design closing T6's own RMS-only evidence gap). Building and running this
  surfaced and fixed two real bugs before the mandatory proof could even be attempted: (1) T12 had no
  dedicated Main-process `console-message` relay (every other E2E scenario has its own
  `armE2E<Scenario>Relay`; without `armE2EProcessAudioSmokeRelay`, no Renderer marker ever reached
  the orchestrator's stdout at all); (2) a tone process's own `process.pid` is not the PID that ends
  up owning its real WASAPI audio session — live enumeration proved it belongs to a _child_ Electron
  process (Chromium's multi-process model) — fixed by having the orchestrator discover each tone
  process's real audio-session PID via enumeration diffing through a `ProcessLoopbackSupervisor`
  instance driven directly from the orchestration script. **A third, deeper real bug was then found
  and fixed**: once a real PID was correctly selected (`E2E_PROCESS_AUDIO_SELECTED` confirmed), the
  resulting process-audio track never reached the viewer as a remote `screen-audio` stream in a
  genuine two-instance WebRTC topology, while screen _video_ for the same share arrived normally
  every time. The eventual root cause was **not** the renegotiation-timing hypothesis originally
  suspected (recorded in an earlier draft of this note): live tracing found `VoiceChannelView.tsx`'s
  pre-existing T5 generic auto-screen-share effect and this task's own new process-audio auto-select
  effect both fire from the same `voiceReady` transition and both call `enableScreenShare` — the
  generic T5 effect needs one fewer awaited IPC round trip (no `listProcessAudioCandidates` step), so
  it always won `enableScreenShare`'s single-share acquisition guard first, silently turning the
  process-audio effect's own later call into a permanent no-op with no error anywhere (screen video
  published normally from the T5 effect's video-only share; the intentionally-selected
  application-audio track was simply never acquired). Fixed by excluding the generic T5 effect
  whenever a process-audio target is configured (see `VoiceChannelView.tsx`'s own doc comment on that
  exclusion for the full detail) — `e2e:screen-audio-smoke` (T6) does not hit the same race in
  practice, since its own scripted phase 1 also shares audio-off, so either effect "winning" produces
  an identical result. With this fix in place, `e2e:process-audio-smoke` passed **3 consecutive clean
  runs** on the final, security-fixed code (see "Security and QA review" below), each run measuring
  68-78 dB of frequency-isolation margin (against a 20 dB minimum threshold) in both selection
  directions, across all four scenarios (dual-direction frequency isolation, mid-share mic-mute/
  clean-stop lifecycle, and target-process-exit cleanup with an orphan-helper check).
- **Regression sweep, now complete against the final code**: `e2e:identity-persistence`,
  `e2e:settings-persistence`, `e2e:authorization`, `e2e:text-chat-persistence`,
  `e2e:connection-smoke`, `e2e:reconnect-smoke`, `e2e:voice-smoke`, `e2e:camera-smoke`,
  `e2e:screen-smoke`, and `e2e:screen-audio-smoke` all pass — the last four (all real-WASAPI-
  hardware-dependent) were deferred earlier in this task specifically to avoid resource contention
  with the isolation E2E's own real-hardware debugging, and were re-run once that debugging
  concluded; `e2e:screen-audio-smoke` passing confirms T6's system-wide loopback path remains
  unaffected by T12's new process-scoped path sharing the same `screen-audio` semantic source.
- **Known gap flagged for the mandatory security review**: the pipe's SDDL/DACL construction
  (`pipe_security.cpp`) and the constant-time Hello-token compare (`util.cpp`) were built correctly
  per the documented threat model but could only be functionally verified for the current user — this
  machine has no second Windows user account to empirically confirm the ACL actually denies a
  different user's connection attempt. Flagged explicitly for `security-reviewer`; still an accepted,
  documented residual limitation after review (see "Security and QA review" below) — not something a
  single-user development machine can close without additional test infrastructure.

### Native toolchain

This development machine had no C++ compiler, Windows SDK, or CMake installed at the start of this
task. With explicit user approval, Visual Studio 2022 Build Tools (C++ workload, which includes a
Windows SDK) was installed via `winget`. Confirmed working end-to-end with a real compile/link/run
test of the exact `AUDIOCLIENT_ACTIVATION_PARAMS`/`PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE`
structures this task needs, against MSVC 19.44.35228. This machine's actual Windows build is **26200**
(`HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\CurrentBuild`) — comfortably above the documented
20348 minimum for process-loopback — despite its registry `ProductName` still reading "Windows 10
Pro," a real, firsthand confirmation of `references/WINDOWS_MEDIA.md`'s own warning to trust the
numeric build, never the product name string. Real physical audio hardware (USB audio devices, an
Astro A50 headset, NVIDIA HDMI/virtual audio) is present, so this task's live verification is against
genuine Windows audio rendering/capture, not a headless/simulated environment.

### Security and QA review

**Security review** found and this task fixed two issues, both verified against real Windows audio
hardware and the full `e2e:process-audio-smoke` re-run above:

- **PID-reuse TOCTOU gap**: the original design trusted a bare `pid` at `startCapture`-time with no
  check that the PID enumerated moments earlier still belongs to the same process the user actually
  selected — a real window given the OS is free to recycle a PID once its original process exits.
  Closed by threading the enumerated `exeName` through as a new `expectedExeName` field on the
  `Start` wire message (`packages/windows-media/src/protocol.ts`); the native helper now cross-checks
  it against the resolved PID's actual exe basename immediately after `OpenProcess` succeeds and
  before any `ActivateAudioInterfaceAsync` call, rejecting with `TargetNotFound` on any mismatch
  rather than silently capturing whatever process now holds that PID. `apps/desktop/src/main/
process-audio.ts`'s `startProcessAudioCapture` always sources this value from its own
  `lastEnumeratedCandidates` set, never from the Renderer. Regression-tested at three independent
  layers this QA pass confirmed: `tests/windows-media/protocol.test.ts`'s `Start` round-trip,
  `tests/windows-media/process-loopback-supervisor.test.ts`'s new
  `echo-start-exe`-mode test (proves `ProcessLoopbackSupervisor.startCapture(pid, exeName)` actually
  serializes and transmits the caller's `exeName` onto the wire, not merely that some `Start` frame
  triggers a response), and `tests/desktop/process-audio.test.ts`'s new
  `startProcessAudioCapture` test asserting the exact enumerated `exeName` (never an empty string,
  never anything Renderer-suppliable) reaches `supervisor.startCapture`.
- **`postMessage` targetOrigin hardening**: the Main-to-Renderer `MessagePort` relay
  (`preload/index.ts`) originally targeted `'*'`. Practical risk was already low (this app has no
  iframe/cross-origin content), but a security review flags `'*'` as a caution flag for
  `postMessage` in general — fixed to `window.location.origin`, free defense-in-depth against any
  future page ever embedding untrusted content. This QA pass found this specific relay listener had
  no test coverage at all (`tests/desktop/preload-bridge.test.ts` covered every other bridged
  channel but not this one, since it is the one channel that cannot go through
  `contextBridge.exposeInMainWorld`) and added a dedicated regression test asserting the real
  origin is used and `'*'` never is, plus a no-port no-op case.
- **Residual, accepted limitation**: the pipe's SDDL/DACL construction and the constant-time
  Hello-token compare could only be functionally verified for the current user — this development
  machine has no second Windows user account to empirically confirm the ACL denies a different
  user's connection attempt. Accepted as a documented residual risk (the design and code are correct
  per the documented threat model; only the empirical cross-user proof is unavailable on this single-
  user machine), not a release blocker.

**QA review** (this pass) found the following, all addressed except where noted:

- **Fixed — zero direct test coverage of `apps/desktop/src/main/process-audio.ts`.** Every other
  piece of the T12 stack had direct unit tests (`protocol.ts`, `capability.ts`,
  `process-loopback-supervisor.ts`, `process-audio-track.ts`), but this module — the Main-process
  integration point that actually enforces `capability.ts`'s fail-narrow contract, the
  single-supervisor exclusivity invariant, and the TOCTOU-fix exeName wiring — had none;
  `tests/desktop/ipc.test.ts` mocks it away entirely and only proves `main/ipc.ts` calls into it
  correctly for a trusted sender with a bounds-checked `pid`. Added
  `tests/desktop/process-audio.test.ts` (26 tests) covering: capability fail-narrow actually
  reaching this layer (an unsupported platform returns `supported:false` honestly and never spawns
  the native helper at all, not merely "spawns and then fails"); single-supervisor reuse/exclusivity
  across enumeration and capture; the TOCTOU-fix exeName cross-check assembly; port wiring for
  format/audioFrame/targetEnded/error/helperExit; `processAudioEnded` push semantics (sent on
  target-ended/error/unexpected-helper-exit, never on a caller-initiated `stop()`); and idempotent
  cleanup on `stop()`/`dispose()`/forced app-quit teardown, including that a late event from an
  already-detached supervisor cannot resurrect a stale session's notification.
- **Checked, no gap found — the IPC-layer `pid` bounds validation (`main/ipc.ts`) was already
  correctly implemented and already had a dedicated test** (`tests/desktop/ipc.test.ts`, covering
  `-1`, `0`, `1.5`, a non-number, and `Number.MAX_SAFE_INTEGER`) — confirmed sufficient on
  inspection; the real gap in this area was the module-level integration gap above, not this
  boundary layer.
- **Fixed — the mandatory E2E harness had no `package.json` script entry.** Unlike every other E2E
  scenario in this repository (`e2e:voice-smoke`, `e2e:screen-audio-smoke`, etc.),
  `apps/desktop/scripts/e2e-process-audio-smoke.mjs` was never wired into
  `apps/desktop/package.json`'s `scripts` block — `pnpm --filter @disco-voador/desktop run
e2e:process-audio-smoke`, the standard invocation pattern this repo's own `HANDOFF.md` documents
  for every prior task, would have failed with "missing script." Added `"e2e:process-audio-smoke"`.
- **Fixed — stale handoff notes.** This file's own "What is real and verified" section still
  described the WebRTC late-track delivery bug as unresolved and under active investigation, and this
  section was still the original unfilled placeholder, even though the bug had since been root-caused
  and fixed (see above) and both reviews had completed. Reconciled both.
- **Fixed — no unit coverage for T12's new `desktop-config.ts` E2E env vars.** Every other E2E-only
  env var this module parses (T5/T6/T10/T11) has dedicated parsing tests in
  `tests/desktop/desktop-config.test.ts`; T12's five new ones (`..._TARGET_PID`, `..._TARGET_EXE`,
  `..._EXPECTED_HZ`, `..._REJECTED_HZ`, `..._LIFECYCLE_SCENARIO`) had none. Added a matching
  `describe` block (11 tests).
- **Flagged, not fixed (would require a live-hardware E2E re-run, deliberately out of this pass's
  scope per its own instructions)**: `e2e-process-audio-smoke.mjs`'s four scenarios never assert
  "Application Audio never silently falls back to System Audio" as its own direct, explicit check —
  today it is only strong indirect evidence (`e2e-frequency-probe.ts`'s own doc comment explains why:
  a silent fallback would expose both simultaneously-playing tones at comparable levels, collapsing
  the isolation margin toward 0 dB instead of staying wide, so the existing proof would fail loudly if
  this ever regressed) rather than a scenario built specifically to prove it. A future strengthening
  could add a fifth scenario that forces `detectProcessAudioCapability()` to report unsupported (e.g.
  via a dedicated E2E-only override, mirroring how other scenarios already gate on `!app.isPackaged`)
  and asserts the picker never offers — and `enableScreenShare` never silently substitutes — System
  audio in that state. Recorded here rather than implemented, since it would require its own
  hardware-dependent E2E re-run this pass was explicitly told to avoid unless already touching that
  surface.
- **Flagged, not fixed (a product-behavior question, out of this pass's scope)**:
  `listProcessAudioCandidates()` converts a genuine enumeration-time helper failure (spawn error,
  crash, protocol violation, or a `start()`/enumerate timeout) into `{ supported: true, candidates:
[] }` — indistinguishable, from the Renderer's perspective, from "the platform supports process
  audio but no audio-producing process happens to be running right now." This is a different case
  from (and does not contradict) the documented "an unsupported system reports honestly empty, never
  fabricated" contract in `shared/ipc-contract.ts` (that one is about the capability check itself,
  which is correctly honest and now directly tested at this layer — see above). Whether a genuine
  runtime helper failure should instead surface as its own distinguishable error/reason is a product
  decision, not a test gap; pinned with a regression test
  (`tests/desktop/process-audio.test.ts`, "surfaces an enumeration helper error...") documenting the
  current contract precisely so a future change to it is deliberate rather than accidental.
- Test suite grew from 978 to 1019 Vitest tests (new tests added this pass: 26 in the new
  `tests/desktop/process-audio.test.ts`, 11 in `desktop-config.test.ts`'s new T12 `describe` block, 2
  in `preload-bridge.test.ts`'s new `processAudioPort` describe block, and 1 in
  `process-loopback-supervisor.test.ts`); `pnpm typecheck`, `pnpm lint`, and `pnpm exec vitest run`
  all pass clean on the result — never shrunk. The native C++ helper, wire protocol, and WebRTC
  integration themselves were not re-reviewed in this pass — they were implementation-complete and
  already proven by the E2E harness re-run above; this pass's scope was coverage/process gaps only.

### Privacy statement

- **Client-local, never sent anywhere:** selected process id, executable name, window title, process
  tree, PCM audio content, and every other piece of process-capture metadata.
- **Server-local / remote-peer-visible (unchanged from T6):** only the resulting `screen-audio`
  `MediaStreamTrack` — indistinguishable, on the wire, from T6's system-loopback audio.
- **Not centralized by anything OvniChat operates:** no game-activity history, no process telemetry,
  no Rich Presence, no central catalog of any kind.

### Next task

**T13 — Production Self-Hosting** (TURN, TLS/WSS, Docker, production configuration, health checks,
network/firewall documentation). Not implemented as part of T12.
