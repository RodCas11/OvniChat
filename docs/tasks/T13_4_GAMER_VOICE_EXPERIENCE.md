# T13.4 — Gamer Voice Experience

## Goal

Transform OvniChat's already-working P2P voice stack into a comfortable, gamer-oriented daily-use
experience: Push to Talk with a genuine global hotkey (usable while a game has focus), Voice
Activity mode, per-participant speaking indicators, local per-participant volume and "Mute for Me,"
subtle join/leave notification sounds, and a redesigned Voice & Video settings section — all as
client-local UX, never a server-authoritative "who may speak" control.

## Context

T3-T12 built the P2P voice/media stack; T13.1-T13.3 built the visual foundation, channel
administration, and profile/presence system. None of them touched voice _ergonomics_ — mute was a
single manual toggle, there was no speaking feedback, no per-participant volume, and no way to use
voice while a game had keyboard/mouse focus. A `software-architect` review was conducted before
implementation (see Handoff notes and
[`architecture/GAMER_VOICE_EXPERIENCE.md`](../architecture/GAMER_VOICE_EXPERIENCE.md)) resolving four
consequential decisions: the global-hotkey mechanism (Electron's `globalShortcut` cannot provide
real key-release semantics — verified, not assumed), the single microphone-transmit state machine,
the remote-audio-graph architecture for per-participant volume/speaking without breaking output-device
routing or doubling audio, and the settings/persistence schema. This task implements that design.

## In scope

- Voice Activity and Push to Talk input modes; PTT is genuine hold-to-talk via a real global hotkey
  usable while OvniChat is unfocused (a game has focus), never a toggle.
- A narrow, security-reviewed global-hotkey architecture: Main owns all privileged OS interaction;
  the Renderer only gets `setPttShortcut`/`clearPttShortcut`/a push-style PTT-state subscription.
- Fail-closed PTT: never stuck transmitting after a settings change, reload, disconnect, channel
  leave, device change, rebind, or app shutdown; a reconnect always requires a fresh key-press.
- Speaking indicators (self and remote), based on real audio-energy detection with hysteresis, never
  merely "microphone unmuted."
- Per-participant local playback volume (0-200%) and local "Mute for Me" — 100% client-local, never
  sent to the server, never visible to anyone but the local user.
- Subtle, disable-able join/leave notification sounds for the currently-joined voice channel only,
  using original project-owned audio assets.
- A redesigned Voice & Video settings section using gamer-facing product language, never WebRTC/audio
  engineering jargon.
- Local persistence (input mode, PTT binding, Voice Activity sensitivity, join/leave-sounds toggle;
  a full read/write path for per-(server, identity) volume/mute preferences — end to end, restoring
  automatically across leave/rejoin, reconnect, and application relaunch; see the targeted follow-up
  fix below).
- A permanent, repository-wide impact-based regression-testing policy (this task is also where it was
  introduced — see `CLAUDE.md`/`docs/DEVELOPMENT.md`).

## Out of scope (deferred to later T13.x tasks or explicitly not part of this task)

Streams/camera UX (T13.5). A server-authoritative "who may speak" control — **explicitly, permanently
out of scope**: this app's WebRTC transport is a P2P mesh with no media choke point capable of
authoritatively enforcing it (see `docs/architecture/CHANNELS_AND_SERVER_ADMINISTRATION.md`'s own
"Speak-permission" section, T13.2) — nothing in T13.4 changes that conclusion, and nothing here
introduces a channel Speak ACL, a fake server-mute, or any control that looks like server-enforced
speech suppression.

## Targeted follow-up fix: per-user volume/mute now persist by stable identity

The initial T13.4 pass shipped per-participant volume/"Mute for Me" as session-only, since the
protocol surface (`voice:joined`/`voice:participant-joined`) exposed no stable correlation between a
voice-channel `participantId` and the remote user's actual identity, and nothing durable enough to
survive a reconnect/relaunch existed to persist by instead. A targeted fix closed this gap: see
[ADR 0022](../adr/0022-durable-per-server-identity-ref-for-local-voice-preferences.md) for the full
decision record and [`GAMER_VOICE_EXPERIENCE.md`](../architecture/GAMER_VOICE_EXPERIENCE.md)'s
"Persisted preferences: identityRef" section for the implementation. In short: `voiceParticipantSchema`
gained a new `identityRef` field — a durable, per-`(Dedicated Server, identity)` opaque token, distinct
from both the session-scoped `memberRef` (T13.3) and the cross-server-portable `identityId` (never sent
to another client, ADR 0011) — generated once server-side and reused forever, but _not_ comparable
across two different Dedicated Servers for the same real identity, so it cannot reopen the
cross-server correlation channel `identityId`'s own withholding exists to prevent. Local volume/mute
preferences are now genuinely keyed by `(serverScope, identityRef)`, restore automatically on
leave/rejoin, reconnect, and application relaunch, and remain fully local — no new protocol message
carries a preference value, and `packages/protocol`/`services/realtime` gained only the minimal,
reviewed `identityRef` correlation field itself (a deliberate, narrow, security-reviewed exception to
this task's original "protocol/realtime untouched" scope — see "Architecture constraints" below).

## Architecture constraints

- No renegotiation for any mute/PTT/Voice-Activity/local-mute/volume transition — only
  `track.enabled` toggling (via `TransmitGate`) and Web Audio gain/analysis nodes. Device switching
  remains the only legitimate `replaceTrack` use (pre-existing T11 behavior).
- No server-side mutation, message, or protocol change of any kind for PTT/Voice-Activity/local
  volume/local mute — 100% client-local. `packages/protocol`/`services/realtime` gained exactly one
  minimal, reviewed addition (the required `identityRef` correlation field on `voiceParticipantSchema`,
  `CURRENT_PROTOCOL_VERSION` bumped 4→5 — see
  [ADR 0022](../adr/0022-durable-per-server-identity-ref-for-local-voice-preferences.md)) to make
  local-only persistence possible without a stable identity handle any other existing field provided;
  no preference _value_ of any kind ever crosses into a protocol message.
- Never persist per-participant preferences by T13.3's session-scoped `memberRef`, and never by the
  cross-server-portable `identityId` (would reopen the correlation channel ADR 0011 closed) — only by
  the durable, per-server-only `identityRef` (ADR 0022).
- The global-hotkey native listener lives inside `packages/windows-media`, never directly in
  `apps/desktop/src/main` — an existing, binding `docs/SECURITY.md` rule, not new to this task.
- No microphone-activity/speaking/PTT-usage telemetry or history, anywhere, ever.
- Automated tests for join/leave sounds and Voice Activity must not require real audible speaker
  output or a real microphone.

## Relevant packages

`packages/windows-media` (new native PTT listener), `packages/media-core` (new `TransmitGate`),
`apps/desktop` (Main/Preload IPC, Renderer voice hook, settings, UI). `packages/protocol` and
`services/realtime`/`services/dedicated-server` gained the minimal `identityRef` correlation
mechanism described above (the targeted follow-up fix) — no other protocol/realtime surface was
touched.

## Relevant agents

`software-architect` (pre-implementation design review — complete, see Handoff notes),
`windows-media-engineer` (native PTT hotkey listener), `webrtc-media-engineer` (`TransmitGate`),
`electron-desktop-engineer` (Main/Preload IPC, Renderer integration, UI), `security-reviewer` and
`qa-engineer` (final gates).

## Relevant skills

`project-orientation`, `planning-feature`, `electron-development`, `webrtc-development`,
`testing-quality`, `security-review`.

## Acceptance criteria

See the task's own Definition of Done checklist below, summarized with real evidence in the Handoff
notes.

## Definition of Done

Complete only when: Voice Activity and Push to Talk both exist and are genuinely hold-to-talk (PTT)
or hysteresis-gated (Voice Activity); PTT works while unfocused via a narrow, security-reviewed
global-hotkey architecture; PTT can never get stuck transmitting across any disruptive event; explicit
mute always overrides PTT/Voice Activity; neither PTT nor Voice Activity ever renegotiates WebRTC;
speaking indicators reflect real audio activity with sane hysteresis; per-participant local volume and
"Mute for Me" exist, affect only local playback, and are never sent to the server; join/leave sounds
exist, are subtle, are disable-able, and their automated tests need no real audible output; no server
Speak ACL or telemetry of any kind was introduced; the new E2E scenarios and an impact-based (not
full-historical) regression pass; security and QA review findings are addressed; documentation
reflects the actual final system, including the new permanent regression-testing policy. Otherwise:
IN PROGRESS.

## Handoff notes

### What is real and verified

**Foundational packages** (built first, independently reviewed by the orchestrating session before
integration): `packages/windows-media/src/{ptt-binding,ptt-hotkey-listener}.ts` — a global PTT
listener built on `uiohook-napi` (see [ADR 0021](../adr/0021-global-ptt-in-process-keyboard-hook.md)),
with real repeat-suppression and a deliberate down/up modifier-matching asymmetry (exact match to
activate, code-only match to release) specifically preventing a `Ctrl+V`-style binding from getting
stuck "held" if the modifier is released before the main key. `packages/media-core/src/transmit-gate.ts`
— `TransmitGate`, the single microphone-transmit state machine (explicit mute always overrides a held
PTT key or detected voice activity; a fresh instance is constructed on every real join/reconnect,
which is what structurally guarantees a still-held key can never resume transmission after a
reconnect; `rebind()` preserves PTT/Voice-Activity state across a T11 device switch, since only the
capturing hardware changed, not the user's actual input state).

**Electron/Renderer integration**: the global-hotkey IPC surface (`setPttShortcut`/
`clearPttShortcut`/a push-style `onPttState` subscription, mirroring the existing
`onProcessAudioEnded` pattern, every handler `assertTrustedSender`-gated and zod-validated);
`TransmitGate` wired into `use-voice-channel.ts` for every join/reconnect/device-switch; a local
voice-activity detector analyzing a **cloned** `MediaStreamTrack` (a real deadlock — analyzing the
original, gate-muted track would starve the very detector meant to un-mute it — was found and fixed
via a live `e2e:voice-smoke` run, not merely reasoned about); `RemoteAudioGraphController`
(`apps/desktop/src/renderer/voice/remote-audio-graph.ts`) — one shared `AudioContext` per connection
session, `MediaStreamAudioSourceNode → GainNode → destination` as the _only_ audible path per remote
participant, with an analysis-only `AnalyserNode` tap for speaking detection, retiring `<audio>`
elements for microphone-audio playback specifically (screen/system audio is unaffected, still `<audio>`-
based) after confirming `AudioContext.setSinkId()` is genuinely supported on this app's pinned
Electron/Chromium build; join/leave notification sounds (tiny original synthesized tones, decoded via
`AudioContext.decodeAudioData` from inline bytes after a real CSP rejection of `new Audio('data:...')`
was found and fixed live); the settings schema additions (additive, no version bump, verified by a
dedicated pre-T13.4-fixture round-trip test); a redesigned Voice & Video settings section (Input Mode,
a live non-audible mic meter + sensitivity slider, a "Press a key…" PTT capture control with real
registered/conflict/failure state, a join/leave-sounds toggle); a speaking-indicator ring on
`ParticipantRow` (the in-voice-channel participant list); and a per-participant volume/"Mute for Me"
control (`ParticipantVoiceControlsModal.tsx`), now persisting by stable identity (see the targeted fix
below). 1576 Vitest tests pass repo-wide across 120 files; `tsc`/`eslint`/`prettier`/`tsc -b`/
`verify-repository.mjs`/the dependency audit are all clean via one `corepack pnpm check` run, and
`electron-forge package` succeeds.

**Live-verified via real Electron E2E**: `e2e:voice-smoke` (re-run against the final, gate-integrated
code — confirms no regression to the core P2P voice path now that microphone playback/gating routes
through the new mechanisms, real non-zero RMS values observed); `e2e:reconnect-smoke` (re-run — full
pass including audio flowing both before and after a real reconnect, and confirming a real fix to a
one-shot-guard bug in `VoiceChannelView.tsx` that had prevented the PTT-simulation marker from re-
firing after a post-reconnect rejoin); `e2e:ptt-smoke` (new) — **all three phases now pass**
(`E2E_PTT_DURING_HOLD_OK` included), proving no transmission before PTT is held, real transmission
throughout the hold, and none after release. An earlier pass of this task had two of three phases
passing with the during-hold phase attributed to Chromium's own Opus DTX/VAD suppressing a synthetic
tone; that diagnosis was wrong. The real cause was a genuine Chromium decode-pipeline defect, found and
fixed during QA follow-up — see "Security and QA review" below and
[`GAMER_VOICE_EXPERIENCE.md`](../architecture/GAMER_VOICE_EXPERIENCE.md) for the full record. A full
`corepack pnpm check` run on this final state is clean (120 files / 1576 tests, prettier/eslint/
typecheck/build/verify-repository all green, one pre-existing allowlisted dependency advisory, no new
ones from `uiohook-napi`).

### Security and QA review

**Security**: one real, release-blocking finding, fixed before completion — `armE2EPttSimulation`
(later generalized to `armE2EPttHoldOnJoin`) was missing the `!app.isPackaged` gate every sibling
`armE2E*` test-only hook has, meaning a real packaged build launched with the right environment
variables could have a fake PTT edge injected with no user interaction. Fixed by gating the config
value itself on `!app.isPackaged`. Every other explicitly-named invariant (no generic keylogger path,
Renderer cannot reach `uiohook-napi`/`globalShortcut` directly, PTT cannot get stuck transmitting,
explicit mute always overrides, no protocol/realtime changes, no speaking/PTT telemetry, no
hidden-channel/member-privacy leak, honest documentation of the weak-conflict-detection and
UIPI-elevation limitations, no new dependency-audit exposure) was independently checked against real
code paths and confirmed holding.

**QA**: found and this task fixed two real, severe defects via live, hands-on verification — (1) the
default Voice Activity sensitivity was materially too tight, breaking two pre-existing regression
tests; fixed with a reasoned default-threshold reduction plus decoupling those E2E scripts from
Voice-Activity calibration entirely (forced Push-to-Talk with a marker-driven simulated key). (2) the
real global PTT hotkey was completely non-functional in any real packaged build (Vite/Rollup was
inlining `uiohook-napi`, breaking its native-binary lookup, with a raw diagnostic leaked into
user-facing Settings copy); fixed with proper Rollup externalization plus an `asar.unpack`/packaging
hook, verified against the real packaged `.exe`. A third, deeper issue was found during this session's
own follow-up investigation: a genuine Chromium decode-pipeline requirement (see
"Remote audio: per-participant volume and speaking detection" in
[`GAMER_VOICE_EXPERIENCE.md`](../architecture/GAMER_VOICE_EXPERIENCE.md)) that had been silently
breaking all remote microphone audio the moment `<audio>` elements were retired for the Web Audio
graph — a real product defect, not a test artifact, confirmed via `getStats()` evidence and a
controlled differential test, and fixed with a hidden "decode keep-alive" element. QA's hands-on
findings on everything else (input-mode switching, mic-meter lifecycle, PTT registration/conflict UI,
volume/mute copy, speaking indicators, 1366×768 usability, jargon-free copy) were positive. See
[`GAMER_VOICE_EXPERIENCE.md`](../architecture/GAMER_VOICE_EXPERIENCE.md)'s "Security review outcome"
and "QA review outcome" sections for the full, detailed record.

### Screenshots

Seven real screenshots from actual packaged Electron instances were captured
(`docs/tasks/screenshots/t13-4/`): the redesigned Voice & Video settings in Voice Activity mode with
a live mic meter; Push to Talk unbound with honest "will never transmit until you pick one" copy; a
real shortcut conflict ("That shortcut is already in use — choose another key."); a real registered
F9 binding; the current-user control bar with PTT actively held (green mic icon); a second instance
observing the first's speaking-ring indicator and opening its "User Volume"/"Mute for Me" modal; and
Settings at 1366×768. Personally reviewed twice, one real issue found and fixed on the first pass:
the QA-authored capture script polled an **unscoped** `document.querySelector('[data-speaking="true"]')`
to detect the remote peer's speaking ring, which matched the viewer's own self-row instead (this
harness's fake microphone emits real audio energy, so a viewer left on the default Voice Activity
input mode genuinely speaks locally) — the captured screenshot showed the wrong participant speaking,
and the marker claiming success proved nothing about cross-peer detection. Fixed by scoping the
selector to the presenter's own `participantId` (`apps/desktop/src/main/index.ts`,
`armE2ET134ViewerScreenshotCapture`); recapturing after the fix shows the actual remote presenter's
speaking ring, genuinely proving the cross-peer/Chromium-decode-pipeline fix works end to end. This
was a screenshot-tooling gap only, not a product defect — the underlying speaking-detection code was
already unit-tested and the remote-audio-graph fix already had direct `getStats()` evidence.

### Cross-cutting fix found and fixed during closeout (not a T13.4-introduced defect)

While closing this task, a severe, repository-wide UX regression was reported: typing into any modal
form dialog (Add Server, Create/Edit Channel, Create Category, etc.) lost focus to the Close button
after every keystroke, making typing effectively impossible. Investigation traced this to `Modal.tsx`
(`apps/desktop/src/renderer/ui/`) — a shared primitive that has existed unchanged in this respect since
T13.1, not something T13.4 introduced. Its focus-management effect depended on `[open, onClose]`, and
every real consumer passes an `onClose` with a fresh identity on every render; a controlled form input
re-renders its owner on every keystroke, so the effect (which always resolves initial focus to the
first focusable element — the header Close button) reran on every keystroke. Fixed at the shared
primitive: the effect now depends on `[open]` alone (reading `onClose` via a ref), and a consumer's own
`autoFocus` field is now correctly respected instead of being overridden. See
[`PRODUCT_UI_FOUNDATION.md`](../architecture/PRODUCT_UI_FOUNDATION.md)'s new "Cross-cutting fix" section
for the full technical record. Regression tests added at the shared level
(`tests/desktop/components/modal.test.tsx`) and at the real-consumer level (`add-server-dialog.test.tsx`,
`channel-modal.test.tsx`). Full `corepack pnpm check` re-verified clean afterward (120 files / 1559
tests).

### Targeted fix: per-user volume/mute persistence by stable identity

Root cause: preferences were keyed by `participantId`, a fresh voice-channel session slot assigned on
every join — forgotten on leave/rejoin, reconnect, or relaunch by construction, not merely by
omission. Fixed by introducing `identityRef` (see [ADR 0022](../adr/0022-durable-per-server-identity-ref-for-local-voice-preferences.md)
for the full decision record): a durable, per-`(Dedicated Server, identity)` opaque token, added to
`voiceParticipantSchema` (`packages/protocol/src/messages/voice.ts`), generated once and persisted
forever by `SqliteProfileStore.getOrCreateIdentityRef` (a new column, `identity_profiles.identity_ref`,
migration v2), and consumed entirely locally by `use-voice-channel.ts` to key the pre-existing
`getVoicePreference`/`setVoicePreference` IPC calls (which the prior pass had built but never wired
end to end). Every internal variable in that persistence path previously named `identityId` (a stale
name from before this correlation problem was solved) is now consistently named `identityRef`.

Real-runtime evidence: a new `e2e:voice-preference-smoke` script proves the actual bug report fixed,
through four real Electron relaunches of the same profile — set a peer's volume to 55% via the real
"User Volume" UI, relaunch and confirm 55% restores automatically with no manual adjustment, toggle
"Mute for Me" only (volume slider untouched), relaunch again and confirm _both_ 55% and muted restore
together (proving mute never resets the stored volume). A real, unrelated infrastructure issue was
found and fixed while building this E2E: externally `child.kill()`-ing an Electron instance mid-session
corrupted that profile's `safeStorage`-encrypted identity file badly enough that the next relaunch of
the same profile failed to decrypt it — reproduced independent of this fix's own changes, and resolved
by having each instance self-exit gracefully (`app.exit()`, mirroring `armE2EIdentityPersistenceExit`'s
already-proven technique) before the orchestrating script relaunches the same `--user-data-dir`.
`tests/realtime/protocol-handlers.test.ts` separately, deterministically proves `identityRef` survives
a real leave+rejoin even though `participantId` changes (the server-side half of the same claim,
independent of any incidental reconnect). A focused `security-reviewer` pass (scoped to this diff only:
no raw `identityId` leak, cross-server correlation genuinely broken, no spoofing, no hidden-channel
leak, no new elevation, no preference value ever reaching the server, migration safety) found no
release-blocking issues.

### UI-consistency follow-up (closed before T13.5)

The gap disclosed below — `MemberRow.tsx` not showing the speaking ring — is now closed, along with a
second gap found alongside it: `ParticipantRow.tsx` was rendering only the generic initials/color
fallback, never a participant's real T13.3 server-local avatar. Both were fixed as one small
presentation/correlation-only pass, with no media-architecture change and no second avatar/speaking
subsystem: `voiceParticipantSchema` gained a `memberRef` field (the same, already-broadcast identifier
Member Panel already keys `VoiceChannelState.members` by — not `identityRef`, which stays scoped to
local voice-preference persistence only), letting `ParticipantRow` resolve each participant's live
`avatarRef` from `members` and letting `MemberRow` resolve its speaking state from the existing
`state.speakingParticipantIds` set. Both surfaces render the ring through the one shared `UserAvatar`
component. Full design, the privacy argument for why a hidden-channel member's speaking state
structurally cannot reach `MemberRow`, and the pre-gain volume/mute interaction are documented in
[`GAMER_VOICE_EXPERIENCE.md`](../architecture/GAMER_VOICE_EXPERIENCE.md)'s "UI consistency follow-up"
section.

### Known limitations (real T13.4 gaps, disclosed rather than hidden)

- **`e2e:voice-activity-smoke` and a dedicated local-volume/mute E2E were not built** — Voice Activity
  gating and per-participant volume/mute/deafen logic are covered instead by direct unit tests against
  a mocked `AudioContext`/`AnalyserNode` (19 and 18 tests respectively). Judged an adequate substitute
  for this task's own verification bar; recorded here for transparency rather than silently assumed
  equivalent.
- **The PTT key-capture control supports a bounded, realistic key/button set** (letters, digits,
  F-keys, arrows, common punctuation, mouse buttons 0-4) — a bare modifier key alone (Ctrl/Alt/Shift
  with nothing else) is not bindable in this pass.
- **Global-hotkey conflict detection is inherently weak** (see ADR 0021) — this is a documented,
  accepted mechanism limitation, not a bug: a passive OS hook has no concept of "already taken" the
  way `RegisterHotKey`'s real exclusivity does, so the best-effort probe only detects another
  application that itself used `RegisterHotKey` for the identical accelerator.
- **PTT while an elevated/anti-cheat-protected game has focus is a genuine, documented Windows UIPI
  limitation** (ADR 0021), not something this task attempts to work around.

### Privacy confirmation

- PTT bindings, Voice Activity sensitivity, and per-participant volume/mute never leave the client —
  no server message, no protocol field, carries any of it.
- No microphone-activity, speaking, or PTT-usage history/telemetry is stored anywhere.
- No server Speak ACL or server-enforceable mute exists or was implied by any new UI.
- No new keyboard logging: the native hotkey listener filters every event to the one configured
  binding in the same tick it arrives; nothing beyond that binding is ever observed, buffered, or
  logged.

### Next task

**T13.5 — Streams / Camera / Product Integration.** Not implemented as part of T13.4.
