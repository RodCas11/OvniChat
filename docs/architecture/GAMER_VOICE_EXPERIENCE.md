# Gamer voice experience (T13.4)

> This document describes the Push-to-Talk/Voice-Activity/speaking-indicator/per-user-volume/
> local-mute/join-leave-sound system T13.4 implemented. See
> [`tasks/T13_4_GAMER_VOICE_EXPERIENCE.md`](../tasks/T13_4_GAMER_VOICE_EXPERIENCE.md) for the task
> record and [`adr/0021-global-ptt-in-process-keyboard-hook.md`](../adr/0021-global-ptt-in-process-keyboard-hook.md)
> for the accepted global-hotkey decision. A `software-architect` review preceded implementation;
> this document reflects what was actually built and verified, not just what was designed.

## Why this exists

Through T13.3, voice had exactly one manual mute toggle and no speaking feedback, per-participant
control, or ergonomic accommodation for daily gaming use (a global PTT key, a Voice-Activity mode
that doesn't require constantly touching a button). T13.4 adds all of this as pure client-side UX —
no change to the underlying P2P WebRTC transport, protocol, or server.

## Microphone transmit ownership: `TransmitGate`

`packages/media-core/src/transmit-gate.ts` owns the single derivation of "should the microphone
actually be transmitting right now":

```text
shouldTransmit =
  !userMuted
  AND (
    (inputMode === 'voice-activity' AND voiceActivityDetected)
    OR
    (inputMode === 'push-to-talk' AND pttHeld)
  )
```

Explicit mute always wins — a muted user holding PTT still does not transmit. The only effect on the
outside world is `Microphone.setMuted()` (`track.enabled` toggling — instant, no renegotiation,
matching the pre-existing mute precedent from T3). `TransmitGate` never adds/removes tracks, never
calls `replaceTrack`, and never touches an `RTCRtpSender`/transceiver.

**Edge-triggered PTT is what makes reconnect/rejoin safe, structurally, not by a special reset call.**
`pttHeld` always starts `false` on construction — the type system excludes it from the constructor's
initial-state parameter entirely, so there is no code path (test convenience or otherwise) that can
construct an already-"held" gate. A fresh `TransmitGate` is constructed on every real microphone
acquisition (initial channel join, a reconnect's fresh reacquire) — never reused across those — so a
key still physically held across a reconnect cannot silently resume transmission; a fresh press is
always required. `rebind(newMicrophone)` is the one exception: for a T11 device switch (the same
logical session, just a different capturing device), it swaps the underlying `Microphone` reference
while _preserving_ `pttHeld`/`voiceActivityDetected` — the user's finger/mouse-button state and their
actual voice activity haven't changed, only which physical device is capturing them.

## Global Push-to-Talk

See [ADR 0021](../adr/0021-global-ptt-in-process-keyboard-hook.md) for the full decision record
(Electron's `globalShortcut` cannot provide real key-release semantics — verified, not assumed — so
an in-process native listener, `uiohook-napi`, lives inside `packages/windows-media` behind a narrow
interface).

### Binding shape and matching (`packages/windows-media/src/ptt-binding.ts`)

```ts
type PttBinding =
  | { kind: 'keyboard'; keycode: number; modifiers: { ctrl; alt; shift; meta } }
  | { kind: 'mouseButton'; button: number; modifiers: { ctrl; alt; shift; meta } };
```

`PttBindingMatcher` is pure, injectable edge-detection logic, unit-tested with zero dependency on the
real native module. Every event not matching the configured binding is discarded in the same tick it
arrives — never buffered, logged, or forwarded. OS key-repeat is suppressed structurally: a `'down'`
edge only fires on the genuine 0→1 transition; repeated `'down'` events for an already-held binding
are silently absorbed.

**A deliberate, load-bearing asymmetry**: the _down_ transition requires an exact modifier match; the
_up_ transition matches on key/button code alone, ignoring modifier state, once the binding is
active. Reasoning: binding `Ctrl+V` and releasing Ctrl before V produces a `'keyup'` for V whose
`ctrlKey` flag is now `false` — requiring an exact match on release too would make that keyup never
match, leaving the binding "held" forever with no way to observe its release. Matching release on
code alone is the safe direction to err toward for a transmit-_stop_ signal.

### Native boundary (`ptt-hotkey-listener.ts`)

A thin wrapper around `uiohook-napi`'s process-wide `uIOhook` singleton, narrowed to exactly one
caller-configured binding's `'down'`/`'up'` edges. Deliberately uses a **lazy, dynamic**
`import('uiohook-napi')` inside the start function — never a static top-level import — because a
static import eagerly loads the native addon at module-evaluation time, which would make every
consumer of `@disco-voador/windows-media` (including unrelated T12 code) pay that cost/risk merely by
importing the package barrel. `uIOhook.start()`'s real, verified failure mode
(`UIOHOOK_ERROR_SET_WINDOWS_HOOK_EX` etc.) is caught and surfaced as a typed result, never an
uncaught throw. `stop()` is idempotent and always detaches this call's own listeners even if the
native `uIOhook.stop()` itself throws, so a caller can always safely restart afterward.

### Main-process lifecycle (`apps/desktop/src/main/ptt-hotkey.ts`)

Owns exactly one listener at a time. On `setPttShortcut`: a best-effort conflict probe (momentarily
`globalShortcut.register()`/checking the boolean return/immediately `unregister()` — this only
detects another app that itself used `RegisterHotKey` for the identical accelerator, an honestly weak
but real signal, per ADR 0021), then starts the real listener, and only stops the previous one _after_
the new one is confirmed running — never zero listeners active because a rebind failed, never two
active at once. The listener's own lifecycle is **independent of window reload, disconnect, channel
leave, and device changes** — global capture while unfocused is the entire point; only the
Renderer-side `TransmitGate` (via fresh-construction-per-session) is what guarantees stale "held"
state can never resume transmission. Stopped unconditionally on `before-quit`.

### IPC surface

`setPttShortcut(binding)`, `clearPttShortcut()`, and a push-style `onPttState(listener)` subscription
mirroring the existing `onProcessAudioEnded` pattern exactly. Every handler is `assertTrustedSender`-
gated and validates the binding shape against a local zod schema before acting on it — the Renderer
can never reach `uiohook-napi`/`globalShortcut` directly, and `@disco-voador/windows-media` is never
imported (even type-only) from Preload/Renderer code (enforced by `scripts/verify-architecture.mjs`;
`PttBinding` is re-exported through `shared/ipc-contract.ts` instead).

### A real deadlock found and fixed: analyzing the gate-muted track

`TransmitGate` mutes by disabling `microphone.track` (`track.enabled = false`). Per the Media Capture
and Streams specification, a disabled track emits _silence_ to **every** consumer, not merely the
`RTCPeerConnection` sender that publishes it — including a local `MediaStreamAudioSourceNode` used
for Voice-Activity analysis. Analyzing the original track directly created a permanent deadlock in
Voice Activity mode: muted-for-not-speaking → the very energy analysis meant to un-mute it reads
silence forever → it can never un-mute. Found live via `e2e:voice-smoke`, fixed by analyzing a
`MediaStreamTrack.clone()` instead — an independent track sharing the same hardware source but with
its own, independently-controlled `enabled` flag, forced to `true` immediately after cloning (a
clone inherits the _current_ `enabled` value at clone time, which is often already `false`). The
clone is stopped explicitly on teardown (a clone's lifecycle is independent of the original's).

## Remote audio: per-participant volume and speaking detection

`apps/desktop/src/renderer/voice/remote-audio-graph.ts`'s `RemoteAudioGraphController` retires
`<audio>` elements as the playback mechanism for **microphone** audio specifically (screen/system
audio is unaffected, still `<audio>`-based via `RemoteAudio.tsx`) — after confirming
`AudioContext.setSinkId()` is genuinely supported on this app's pinned Electron 43.4.0/Chromium 150
build (shipped since Chromium 110).

One shared `AudioContext` per connection session (constructed once per `use-voice-channel.ts` hook
instance, closed only in `disposeAll()` on full session teardown — never recreated on ordinary
participant churn). Per participant: `MediaStreamAudioSourceNode → GainNode (0-2.0, default 1.0) →
AudioContext.destination` is the **only** connection that ever reaches `destination` — the one and
only audible path. A second `AnalyserNode` is tapped off the same source node for speaking detection
and is never connected onward to anything. `audioContext.setSinkId()` is called once at the context
level for T11 output-device selection, replacing every per-element `setSinkId()` call for this class
of audio.

### A real Chromium decode-pipeline requirement found and fixed: the silent "decode keep-alive" element

A genuine regression, found live via `e2e:voice-smoke` and confirmed with direct `RTCPeerConnection.
getStats()` evidence (not a guess): on this app's pinned Electron 43.4.0/Chromium 150 build, a remote
`RTCRtpReceiver`'s audio track is **never actually decoded** unless at least one real
`HTMLMediaElement` (`<audio>`/`<video>`) is attached to the stream and playing — `bytesReceived`/
`packetsReceived` climbed in lockstep with the sender's own `bytesSent`/`packetsSent` (full, healthy
RTP delivery confirmed), yet `totalSamplesReceived`/`audioLevel`/`totalAudioEnergy` stayed pinned at
exactly `0` forever. A pure Web Audio consumption graph (`MediaStreamAudioSourceNode → ... →
AudioContext.destination`) does not trigger decode on its own, even with a genuinely `'running'`
`AudioContext` whose `currentTime` is advancing at real wall-clock rate (checked directly before
concluding this — an `AudioContext`-suspended-by-autoplay-policy theory was raised and disproven).
Confirmed via a differential test: attaching a second, muted, autoplaying `<audio>` element to the
exact same stream immediately and reliably unblocked decode for every consumer, with no other change,
and reproduced independently of any mute/Push-to-Talk timing.

Fixed by having `RemoteAudioGraphController.attachParticipant` also create one hidden, `muted = true`,
never-inserted-into-the-DOM `HTMLAudioElement` per participant purely to keep Chromium's decode
pipeline active — never an audible path (muted before `srcObject` is ever assigned; the class's own
"exactly one audible path" invariant above is unchanged). This is a universal fix, not a mute/PTT-
specific one: it applies to every remote microphone stream in every session, since the underlying
requirement has nothing to do with whether or when a track was ever disabled — it is a baseline
property of this Chromium build's own WebRTC audio pipeline once `<audio>` elements are no longer the
playback mechanism.

**This same fix also resolved what was previously, incorrectly, attributed to "Opus DTX/VAD
suppressing a synthetic tone."** `e2e:ptt-smoke`'s own "during PTT hold" phase — the one previously
recorded as an honestly-unresolved gap — passes cleanly once this fix is in place
(`E2E_PTT_DURING_HOLD_OK`, all three phases green). The earlier DTX/VAD theory was a reasonable
inference from the _symptom_ (real bytes delivered, zero decoded energy) but not the actual mechanism;
the decode-keep-alive element is the real, verified fix, not a coincidental one.

`setDeafened(bool)` is a top-level override applied across every attached participant's effective
gain, without mutating any participant's own `volumePercent`/`muted` — un-deafening restores each
participant's individually-configured state exactly, never a reset to 100%/unmuted.

### Detection: one shared technique, local and remote

`voice-activity-detector.ts` provides `SchmittHangoverDetector` (two thresholds — an open threshold
above a close threshold — plus a hangover delay before flipping back to "not speaking") over a small
FFT (`fftSize: 256`) RMS/average-magnitude sample, driven by `AnalyserActivitySampler` at a throttled
rate (not audio-rate, not per-React-render). The same technique is reused for the local microphone's
Voice-Activity gate input and for every remote participant's speaking indicator — one detection
algorithm, two attachment points. Self speaking indicator reflects _effective transmitted_ speech
(`effectiveTransmitting && selfVoiceActivityDetected`) — holding PTT while silent never shows
"speaking."

**Pre-gain, by design.** The `AnalyserNode` above taps `MediaStreamAudioSourceNode` directly
(`source.connect(analyser)`), never the post-volume `GainNode` a participant's local volume/"Mute for
Me" setting controls. Consequence: if the local user lowers a participant's volume to 60% or applies
"Mute for Me," the speaking ring still reflects that participant's _real, transmitted_ speech,
unaffected by the local listener's own playback adjustment. This is intentional, not an oversight —
seeing "they're talking" even while locally muted is useful, and moving the tap point post-gain would
only make the indicator disappear exactly when a user might most want to glance over and confirm
someone is still there.

### UI consistency follow-up (T13.4): the same avatar and speaking indicator everywhere

Through the rest of T13.4, `ParticipantRow` (voice channel roster) rendered only the generic
initials/color `Avatar` fallback, never a member's real T13.3 server-local avatar, while `MemberPanel`
already showed it — and `MemberRow` (server-wide Member Panel) had no speaking indicator at all, even
though `ParticipantRow` already had a real one. Both gaps were closed as a presentation/correlation-only
fix, with no new detector and no new avatar subsystem:

- **Avatar correlation.** `voiceParticipantSchema` gained a `memberRef` field (see
  [`REALTIME_PROTOCOL.md`](REALTIME_PROTOCOL.md)'s "Still v5" entry) — the same `memberRef` Member
  Panel already keys `VoiceChannelState.members` by. `member-presentation.ts`'s
  `resolveParticipantAvatars(participants, members)` is a pure function, re-run on every render, that
  looks each participant's `memberRef` up in `members` and attaches that member's current `avatarRef`
  — never baked in once at join time, so a live profile-avatar change (or removal) reaches
  `ParticipantRow` exactly the same render cycle Member Panel already updates on, with no reconnect,
  rejoin, or new `participantId` required. The synthesized local-self participant entry instead reads
  `state.selfAvatarRef` directly (it has no `memberRef` of its own to look up). Rendering itself reuses
  the one shared `UserAvatar` component (`ParticipantRow`'s avatar cell is a `<UserAvatar avatarRef={
participant.avatarRef} avatarCache={state.avatarCache} onRequestAvatar={...} />`, the exact same
  component and cache Member Panel/the profile popover use) — there is no second, voice-specific
  avatar/cache/fetch system anywhere in this path.
- **Speaking correlation for `MemberRow`.** `member-presentation.ts`'s `isMemberCurrentlySpeaking(
memberRef, participants, speakingParticipantIds)` is likewise pure and re-run every render: `true`
  only if some currently-known voice participant both belongs to that `memberRef` and is present in
  `state.speakingParticipantIds` — the one existing `AnalyserNode`-driven set described above. No
  second detector is created anywhere in `MemberRow`/`MemberPanel`. Privacy falls out structurally, not
  from a filter: `state.participants`/`state.speakingParticipantIds` only ever describe the _one_ voice
  channel this connection is itself currently joined to (a connection belongs to zero or one voice
  channel at a time), so a member speaking in a channel this client cannot see structurally never
  appears in `participants` at all — there is nothing for `isMemberCurrentlySpeaking` to leak, because
  the data it reads never contains it. Both `ParticipantRow` and `MemberRow` render the speaking ring
  through the same shared `UserAvatar` `speaking` prop, so the two surfaces cannot visually drift.

## Settings and persistence

`apps/desktop/src/main/settings/settings-file.ts` — additive, **no `SETTINGS_FILE_VERSION` bump**.
`voiceSchema` gained `inputMode`/`pttBinding`/`voiceActivitySensitivity`/`joinLeaveSoundsEnabled`,
each with a zod `.default(...)` — under `.strict()`, a _missing_ key with a default parses cleanly
(only an _unrecognized_ key is rejected), so a pre-T13.4 file missing these fields still parses
successfully, picking up the defaults. Verified by a dedicated round-trip test reading a byte-for-byte
pre-T13.4 fixture and confirming it parses as a genuine schema success (not the corrupted-file
salvage path).

A new top-level section, `voicePreferences: Record<serverScopeKey, Record<identityRef,
{volumePercent, locallyMuted}>>`, with its own independent `salvageSections` entry (a malformed blob
here never takes down bookmarks or vice versa) and a single flat `MAX_VOICE_PREFERENCE_ENTRIES = 500`
bound (mirroring `MAX_BOOKMARKS`'s own simplicity) enforced via a zod `.refine()`.
`deriveServerScopeKey(serverAddress)` (moved to `apps/desktop/src/shared/voice-preference-scope.ts` —
a single source of truth reused by both Main, which persists by this key, and the Renderer, which
must derive the _same_ key for whatever server it is currently connected to) normalizes host case and
makes the port explicit so the same server typed two ways never splits into separate entries — never
keyed by `bookmarkId` (a manually typed connection has none). The inner key is always `identityRef`
(see "Persisted preferences: identityRef" below) — never T13.3's session-scoped `memberRef` (reassigned
every reconnect) and never the raw, cross-server-portable `identityId` (would reopen a correlation
privacy hole — see [ADR 0022](../adr/0022-durable-per-server-identity-ref-for-local-voice-preferences.md)).

### Persisted preferences: `identityRef`, wired end to end (targeted fix)

The initial T13.4 pass built this backend but could not wire it to the live UI: the protocol surface
(`voice:joined`/`voice:participant-joined`) exposed no stable correlation between a voice-channel
`participantId` (session-scoped, reassigned every join) and the remote user's actual identity, and
nothing durable enough to survive a reconnect/relaunch existed to persist by instead — reusing
`identityId` directly was never an option (it is the _same_ value on every independently-operated
Dedicated Server the same keypair connects to; broadcasting it would reopen the cross-server
correlation channel ADR 0011 closed), and `memberRef` is deliberately retired the moment an identity's
last live connection closes.

A targeted follow-up fix closed this gap by adding `identityRef` — a durable, per-`(server, identity)`
opaque token — to `voiceParticipantSchema` (`packages/protocol/src/messages/voice.ts`). Generated once
server-side (`ProfilePort.getOrCreateIdentityRef`, backed by a new nullable `identity_profiles.
identity_ref` column, migration v2) and reused forever after; a fresh `randomUUID()`, never derived
from `identityId`, so two different Dedicated Servers mint two _unrelated_ values for the very same
real identity — the same anti-correlation property `memberRef` already has, extended to survive a full
disconnect. See [ADR 0022](../adr/0022-durable-per-server-identity-ref-for-local-voice-preferences.md)
for the full decision record, including why this was scoped to `voiceParticipantSchema` only (not
`memberPresenceSchema` as well — a larger, separate decision left for a future task).

`use-voice-channel.ts` maintains a `participantId -> identityRef` map from these two messages
(`identityRefByParticipantIdRef`), used only to key `getVoicePreference`/`setVoicePreference` IPC
calls — never sent anywhere, never round-tripped back to the server. On attach, the stored preference
is resolved and applied _before_ `RemoteAudioGraphController.attachParticipant` ever runs (a short
silence during the local IPC round trip, never a 100%-then-correct blast). Multiple simultaneous
sessions of the same identity (T13.3 supports this) share one preference:
`participantIdsForIdentityRef` applies a change to every `participantId` currently mapped to the same
`identityRef`, and persists exactly one entry regardless of how many sessions exist. Volume writes are
debounced (400ms per `identityRef`, coalescing a dragged slider's many updates into one IPC call);
"Mute for Me" persists immediately (a discrete click) and always re-sends the current volume unchanged,
so unmuting later restores exactly what was configured, never a reset to 100%. Every pending debounced
write is flushed synchronously on genuine session teardown (disconnect, server switch, unmount), not
left to a timer that might never fire.

Live-verified end to end by a new `e2e:voice-preference-smoke` script: set a peer's volume to 55% via
the real "User Volume" UI, relaunch the same profile and confirm 55% restores automatically, toggle
"Mute for Me" only, relaunch again and confirm both 55% and muted restore together. A real, unrelated
infrastructure issue surfaced while building this: externally killing an Electron instance mid-session
corrupted that profile's `safeStorage`-encrypted identity file badly enough that the next relaunch
could not decrypt it — fixed by having each instance self-exit gracefully (`app.exit()`) before the
orchestrating script relaunches the same `--user-data-dir`, mirroring `armE2EIdentityPersistenceExit`'s
already-proven technique. `tests/realtime/protocol-handlers.test.ts` separately, deterministically
proves `identityRef` survives a real leave+rejoin even though `participantId` changes.

## Join/leave notification sounds

`apps/desktop/src/renderer/voice/join-leave-sounds.ts`. `diffParticipantsForSound` is pure,
side-effect-free dedup logic: the very first participant snapshot after _any_ fresh join or
reconnect-restore establishes a silent baseline (zero sounds for people already present) — only
transitions observed strictly _after_ that baseline produce a sound. The baseline resets at every
genuine "a fresh roster begins" point (`onJoined`, `onLeft`, entering `'reconnecting'`, a
policy-forced removal), never merely inferred from the list becoming empty. Self-join/leave never
sound at all — `state.participants` structurally excludes the local user, so this module cannot even
observe a self-transition.

Two tiny (~1-1.2 KB), original, synthesized sine tones (660 Hz join / 300 Hz leave, ~130-150 ms,
linear fade in/out, conservative gain) are embedded as inline base64 WAV bytes. **A real CSP
rejection was found and fixed live**: the first version played them via `new Audio('data:audio/wav;
base64,...')`, which a real Electron instance's `default-src 'self'` policy rejected outright
(silently, no crash — just never played). Fixed by decoding the bytes directly with
`AudioContext.decodeAudioData` and playing through `AudioBufferSourceNode → GainNode → destination`
— this operates entirely on already-in-memory bytes with no resource-fetch step, so it is not subject
to CSP at all, and the policy was not loosened.

## Settings/UI language

The redesigned Voice & Video settings section, the current-user bottom bar, and every new context
menu use gamer-facing product language throughout ("Push to Talk," "Voice Activity," "Input
Sensitivity," "User Volume," "Mute for Me," "Join/Leave Sounds") — never WebRTC/audio-engineering
terms ("track enabled," "gain node," "analyser," "RTP," "global shortcut registration") in
user-facing copy.

## Security review outcome

One real, concrete, release-blocking finding, fixed before completion: `armE2EPttSimulation` (later
generalized to `armE2EPttHoldOnJoin`) — the Main-process test-only hook that simulates a PTT edge over
IPC for `e2e:ptt-smoke`/`e2e:voice-smoke`/`e2e:reconnect-smoke` — was missing the `!app.isPackaged`
gate every sibling `armE2E*` hook in `apps/desktop/src/main/index.ts` has, meaning a real packaged
build launched with the right two environment variables set (a malicious shortcut, a compromised
launcher, a persistent machine-level env var) could have a fake PTT down-then-up edge injected with no
user interaction. Fixed by gating the config value itself on `!app.isPackaged`, matching this
repository's own non-negotiable "test-only automation must be structurally inert in a packaged build"
rule. Every other explicitly-named invariant (no generic keylogger path, Renderer cannot reach
`uiohook-napi`/`globalShortcut` directly, PTT cannot get stuck transmitting, explicit mute always
overrides, no protocol/realtime changes, no speaking/PTT telemetry, no hidden-channel/member-privacy
leak, honest documentation of the weak-conflict-detection and UIPI-elevation limitations, no phantom
`globalShortcut` registration, no new dependency-audit exposure) was independently checked against
real code paths — not doc comments — and confirmed holding. See
[`SECURITY.md`](../SECURITY.md)'s T13.4 section for the full record.

**Targeted fix addendum (`identityRef`, see "Persisted preferences" above):** a second, focused
security review — scoped specifically to this diff, not a general re-review — found no
release-blocking issues. Verified independently against real code: no raw `identityId` ever reaches
another client (`identityRef` only); `getOrCreateIdentityRef` mints a genuinely unrelated `randomUUID()`
per `(Dedicated Server, identity)` pair, confirmed not derivable/comparable across two independent
`SqliteProfileStore` instances for the same `identityId`; `identityRef` is always resolved from a
server-verified `identityId` (the Ed25519 identity-proof handshake), never client-supplied, so it
cannot be spoofed or predicted; the field is scoped to `voiceParticipantSchema` only, introducing no
new hidden-channel or server-wide-presence leak; `setVoicePreference`/`getVoicePreference` remain
genuinely local-only (no protocol message, no network call); the SQLite migration (`identity_ref TEXT`,
nullable, lazily backfilled with an `ON CONFLICT ... WHERE identity_ref IS NULL` guard) is safe under
`services/realtime`'s actual single-threaded/synchronous handler model, not just its own doc comment's
claim. One informational note (not a defect): the local-settings IPC surface's own internal parameter
naming still said `identityId` in a few places even though it always carried `identityRef` values — a
leftover from before this correlation problem was solved — renamed throughout
(`settings-file.ts`/`settings-service.ts`/`ipc.ts`/`preload/index.ts`/`ipc-contract.ts`) for clarity.

## QA review outcome

QA found and this task fixed two real, severe defects via live, hands-on verification of the actual
running product — not merely unit tests:

1. **The default Voice Activity sensitivity was materially too tight**, breaking two pre-existing
   regression tests (`e2e:voice-smoke`, `e2e:reconnect-smoke`) that had passed for years — QA measured
   Chromium's fake-microphone signal, after this app's real default noise-suppression/AGC processing,
   at roughly 10x below the default energy threshold. Fixed with a genuine, reasoned safety-margin
   reduction to the default (documented in `voice-activity-detector.ts`'s own doc comment, including
   why the fix does _not_ chase the fake-device's own measured floor, which risked overfitting to a
   synthetic-signal artifact). The two regressed E2E scripts were separately decoupled from Voice-
   Activity calibration entirely (forced into Push-to-Talk with a simulated held key, reacting to a
   real join/rejoin marker rather than a fixed timer — see `armE2EPttHoldOnJoin`'s own doc comment for
   why a marker-driven approach was needed over a fixed delay).
2. **The real global PTT hotkey was completely non-functional in any real build** — Vite/Rollup was
   inlining the lazy `import('uiohook-napi')` into the app's own compiled bundle, breaking
   `node-gyp-build`'s `__dirname`-relative native-binary lookup, and the resulting raw diagnostic
   string was shown directly to the user in Settings. `e2e:ptt-smoke` never caught this because it
   deliberately bypasses the real native listener by design (IPC-simulated edges only). Fixed with a
   proper Rollup externalization (`apps/desktop/native-main-dependencies.ts` — a single source of
   truth for any Main-process-only native dependency) plus `asar.unpack`/a packaging hook to actually
   get the real package files into the built artifact, verified with a genuine end-to-end proof against
   the real packaged `.exe` (a CDP-driven script calling the real `setPttShortcut` IPC method,
   confirming `uIOhook.start()` genuinely succeeds from inside `app.asar`/`app.asar.unpacked`) — not
   merely "no longer throws an obvious error." The raw-diagnostics leak was fixed separately with
   curated, honest failure copy (the raw native message still reaches `console.error`, never the
   rendered UI).

A third, deeper issue was found during the orchestrating session's own follow-up investigation into
why QA's threshold fix alone didn't fully explain the E2E failures: a genuine Chromium decode-pipeline
requirement (see "Remote audio" above) that also, as a side effect, resolved the `e2e:ptt-smoke`
"during hold" phase previously recorded as an unresolved, environment-attributed gap — it was a real
product defect, not a test-tooling artifact, confirmed via direct `getStats()` evidence and a
controlled differential test.

QA's hands-on findings on everything else (input-mode switching, mic-level-meter lifecycle
correctness, PTT registration/conflict UI honesty, per-user volume/mute copy clarity, speaking
indicator correctness, 1366×768 usability, jargon-free copy elsewhere) were all positive — the one
jargon violation found was the raw-diagnostics leak above, now fixed.

A fourth issue, found during the orchestrating session's own personal screenshot review (not by a
formal agent pass): the QA screenshot-capture script's remote-speaking-ring proof
(`armE2ET134ViewerScreenshotCapture`) polled an unscoped `document.querySelector('[data-speaking=
"true"]')`, which matched the viewer's own self-row (the fake microphone device emits real audio
energy, so a viewer left on the default Voice Activity mode genuinely speaks locally) well before the
presenter's remotely transmitted audio could register — the captured screenshot showed the wrong
participant "speaking," so the marker proved nothing about cross-peer detection despite claiming
success. Fixed by scoping the selector to the presenter's own `participantId`; the recaptured
screenshot now shows the actual remote presenter's ring. This was a screenshot-tooling gap only, not
a defect in the shipped speaking-detection code, which already had direct unit coverage.
