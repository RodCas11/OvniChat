# T11 — Devices, bookmarks, reconnect, and product UX

## Goal

Make OvniChat practical as a normal daily-use communication application: local device selection
(microphone/camera/output) with live switching and hot-plug handling, local server bookmarks, and
automatic reconnect with voice-channel restoration after an unexpected network/server loss — without
weakening any of T7-T10's identity, authorization, or persistence guarantees.

## Context

T0–T10 built the communication platform: voice/camera/screen/screen-audio (T3-T6), local cryptographic
identity (T7), the Dedicated Server product boundary (T8), server-local authorization (T9), and
persistent server-side text chat (T10). None of it remembered a device preference across launches,
remembered a server address, or recovered automatically from a dropped connection — every session
started from scratch, and an unexpected disconnect permanently ended it. T11 closes that gap.

## In scope

- A typed, versioned local client settings store (device preferences, screen-quality/mute/deafen
  defaults, `connectOnStartup`) and local server bookmarks — both entirely client-local.
- Device enumeration, hot-plug handling, and live microphone/camera switching without leaving voice.
- Local microphone level test, camera preview, and output-device test tone.
- Output-device (speaker) selection, honored by both remote-audio playback paths (microphone,
  screen-audio).
- Automatic reconnect with bounded backoff after an unexpected connection loss, including
  voice-channel restoration, fresh T7 re-authentication, and correct chat-history reload.
- A deliberate, mandatory policy that camera and screen sharing never auto-restart after a reconnect.
- Connection-status UI (connecting/authenticating/connected/reconnecting/disconnected) and a
  human-readable error for a non-retryable connection failure.

## Out of scope (explicitly deferred)

- Windows per-process/game audio (T12).
- Production TURN/TLS/Docker deployment (T13).
- Installer/release distribution, auto-update (T14).
- A public server directory, central accounts, or cloud bookmark sync.
- A full visual redesign — this task stays "functional, not polished," matching every prior task's own
  scope discipline.

## Architecture constraints

- Local client settings and bookmarks belong entirely to the Client — never sent to a Dedicated
  Server, never persisted alongside T7's cryptographic identity file. See
  [`adr/0015-local-client-settings-and-bookmarks.md`](../adr/0015-local-client-settings-and-bookmarks.md).
- Automatic reconnect never caches or replays a T7 identity proof, and never bypasses T9 admission —
  every reconnect is a fresh connection in every security-relevant sense. See
  [`adr/0016-automatic-reconnect-and-media-restoration-policy.md`](../adr/0016-automatic-reconnect-and-media-restoration-policy.md).
- Camera and screen sharing must never auto-restart after a reconnect — a mandatory, non-negotiable
  privacy constraint, not a default.
- No new telemetry, analytics, or central infrastructure of any kind.

## Relevant packages

`apps/desktop` (Main: `main/settings/`, `main/ipc.ts`; Renderer: `renderer/voice/use-voice-channel.ts`,
`renderer/voice/SettingsPanel.tsx`, `renderer/voice/device-enumeration.ts`,
`renderer/realtime/reconnect-controller.ts`, `renderer/realtime/reconnect-policy.ts`,
`renderer/connection/ConnectionScreen.tsx`), `packages/rtc-core` (`replaceTrack`),
`packages/media-core` (microphone `deviceId`).

## Relevant agents

`electron-desktop-engineer` (primary), `webrtc-media-engineer` (device switching, `replaceTrack`),
`realtime-backend-engineer` (consulted; no `services/realtime`/protocol changes were needed),
`software-architect` (settings-store placement, reconnect-controller placement, `replaceTrack`
addition — all three reviewed before implementation), `security-reviewer` and `qa-engineer` (final
gates).

## Relevant skills

`project-orientation`, `planning-feature`, `electron-development`, `webrtc-development`,
`testing-quality`, `security-review`.

## Acceptance criteria

See [`docs/DEFINITION_OF_DONE.md`](../DEFINITION_OF_DONE.md) and the exhaustive T11 checklist the task
brief itself specified — summarized in the Handoff notes below with each item's actual evidence.

## Definition of Done

Complete only when every applicable item in `docs/DEFINITION_OF_DONE.md` and the task's own checklist
is satisfied with real evidence (not "should work"), all E2E scripts pass their required consecutive
runs, security and QA review findings are addressed, and documentation reflects actual behavior.

## Handoff notes

### What is real and verified

**Client settings and bookmarks:**

- `apps/desktop/src/main/settings/settings-file.ts`/`settings-service.ts` — versioned,
  `.strict()`-zod-validated `settings.json`, atomic writes, section-by-section corruption salvage.
  12 dedicated unit tests.
- Five narrow IPC methods (`getClientSettings`, `updateClientSettings`, `addBookmark`,
  `updateBookmark`, `removeBookmark`), each validated at the IPC boundary, `assertTrustedSender`-gated.
- `ConnectionScreen.tsx` — bookmark list, add/edit/remove, `lastServerAddress` pre-fill,
  `connectOnStartup` opt-in checkbox. A bookmark never carries an invite/privilege/bootstrap token —
  verified both by the input type's own shape and a dedicated test asserting the on-disk shape of a
  persisted bookmark has exactly three keys.
- `App.tsx` — persists `lastServerAddress` on every connect attempt (bookmark or manual); a real,
  production `connectOnStartup` auto-connect path, structurally independent of the E2E-only
  `AutoConnect` component.

**Device management:**

- `device-enumeration.ts`'s `useMediaDevices()` — live, hot-plug-aware enumeration
  (`navigator.mediaDevices`/`ondevicechange`), fallback labeling before permission is granted, an
  explicit "System default" pseudo-entry.
- `packages/rtc-core`'s new `MediaTransport.replaceTrack(oldTrack, newTrack)` (transceiver-level, no
  renegotiation) and `packages/media-core`'s microphone `deviceId` support (mirroring camera's
  existing precedent, now also preserved across the `OverconstrainedError` fallback retry).
- `use-voice-channel.ts`'s `switchMicrophone`/`switchCamera` — acquire-then-`replaceTrack`-then-stop
  atomicity (a failed switch never disturbs the working device), generation-counter staleness guards
  mirroring `enableCamera`'s established pattern.
- Missing-preferred-device fallback detection (`resolveDeviceFallback`, comparing the preference
  against the resolved track's own `getSettings().deviceId`, since `deviceId` is an _ideal_ not
  _exact_ constraint and never itself causes a rejection) surfaced as `micUsingFallback`/
  `cameraUsingFallback`.
- A new microphone `'ended'` handler (previously absent) surfacing `micDisconnected` on unexpected
  device loss without ending the call — mirrors camera's existing T4 handling.
- `setSinkId()` output-device selection — supported on this app's pinned Electron 43.4.0; both remote
  microphone and screen-audio playback honor it.
- Local microphone level meter, camera preview, and output test tone — all local-only Web Audio, no
  recording, no network.
- Screen-share quality preference persists and pre-selects the picker; the per-share "Share audio"
  checkbox deliberately never persists as default-on (T6's explicit consent model preserved).

**Automatic reconnect:**

- `RealtimeClient` gained one additive `closed` event (real WebSocket close code/reason).
- `ReconnectController`/`reconnect-policy.ts` — bounded exponential backoff with jitter (1s-30s),
  close-code classification (never retry-loops a definitive rejection or a first-attempt failure),
  a generation counter closing the stale-timer race, `cancelReconnect`.
- `use-voice-channel.ts` — the P2P mesh is fully rebuilt per reconnect cycle (`recreateTransport`);
  voice-channel membership, microphone, and mute/deafen state are restored automatically; camera and
  screen are never auto-restored (released immediately on loss detection); chat threads open before
  the loss are re-requested fresh from the server after reconnecting.
- New E2E-only diagnostic markers (`disco-voador:connection-status:*`, `disco-voador:voice-joined:*`)
  and a relay-only E2E hook (`armE2EReconnectSmokeRelay`), following every existing convention exactly.

### E2E evidence

- **`e2e:reconnect-smoke`** (new): real Dedicated Server, real file-backed data directory, two real
  Electron instances with real peer audio; server killed (SIGTERM); both clients detect the loss and
  enter `reconnecting`; server restarts on the same port/data directory; both clients automatically
  reconnect (same `identityId`, fresh handshake), rejoin voice (fresh, server-issued
  `participantId`s), re-establish real peer audio, and correctly reload Server Chat history sent
  before the restart through the history API; camera/screen confirmed to never activate. **Passed 4
  consecutive clean runs** (3 before the final combined build, 1 more after).
- **`e2e:settings-persistence`** (new): a bookmark and a device preference written through the real
  IPC survive a restart of the same profile and do not leak to a different one. **Passed** (2 runs,
  including once against the final combined build).
- All eight pre-existing Electron E2E scripts (`e2e:voice-smoke`, `e2e:camera-smoke`,
  `e2e:screen-smoke`, `e2e:screen-audio-smoke`, `e2e:identity-auth`, `e2e:identity-persistence`,
  `e2e:connection-smoke`, `e2e:authorization`, `e2e:text-chat-persistence`) were re-verified passing
  against the final combined, repackaged build — no regression.
- One intermittent `e2e:camera-smoke` failure (`peerState=unknown` after a camera-off toggle) was
  observed once across this task's several runs, immediately followed by 3 consecutive clean runs.
  This matches a class of camera-smoke flakiness already documented as pre-existing and environmental
  in `docs/tasks/T6_SCREEN_AUDIO.md`'s handoff notes (observed under sustained multi-instance load,
  never root-caused to a specific fix, recurring independent of the change being tested) — recorded
  here honestly rather than silently treated as fully resolved, consistent with this repository's own
  evidence-reporting discipline.

### Security and QA review

**Security review: clean, no release-blocking findings.** Independently verified by direct code
reading (not doc-trust) the single highest-priority claim in this task — that camera and
screen-video/audio genuinely never auto-restart after a reconnect (`onReconnecting`/`onReconnected`
in `use-voice-channel.ts`) — and confirmed it holds. Also independently confirmed: no path smuggles a
bearer token into a bookmark or settings patch (including via a _nested_ field, a real, non-obvious
zod `.strict().partial()` behavior); every new IPC handler is behind `assertTrustedSender`; the new
`getE2ESettingsPersistenceConfig` channel and the real `connectOnStartup` auto-connect path are both
correctly, structurally unreachable/never-bypassing-auth in a packaged build; every reconnect performs
a genuinely fresh T7 handshake and re-evaluates T9 admission with no shortcut; `replaceTrack` never
introduces a new signaling message or crosses between participants' connections; the reconnect
generation-counter race-guard is sound on direct reading, not merely tested. One non-blocking follow-up
(a test making the nested-strictness zod behavior explicit rather than only implicit) was suggested and
implemented (`tests/desktop/ipc.test.ts`, "rejects a settings patch with an unexpected _nested_
field").

**QA review: clean, no product-code defects found — closed three real test-coverage gaps.**

1. `tests/desktop/reconnect-controller.test.ts` — added a multi-cycle backoff-reset test (the existing
   test only proved backoff resets after _one_ loss/recovery cycle; a real regression class — an
   off-by-one in reset-before-vs-after-doubling — could have passed the old test).
2. `tests/desktop/reconnect-controller.test.ts` — added a Server-A-to-Server-B controller-switch race
   test, reproducing the actual production shape (a fresh `ReconnectController` per effect run, old
   one explicitly `disconnect()`-ed) one level above the existing same-controller race test.
3. `tests/desktop/ipc.test.ts` — added an `updateBookmark` token-smuggling rejection test (an
   equivalent test existed for `addBookmark` but not its sibling `updateBookmark`, despite both using
   the identical `.strict()` schema).

Two gaps were identified, evaluated, and explicitly **not** fabricated, with reasoning recorded rather
than silently left implicit:

- `switchMicrophone`/`switchCamera` have no live-hook or E2E test of their own — genuinely infeasible
  in this environment today (Chromium's `--use-fake-device-for-media-stream` provides one fake device
  per kind, not multiple distinct ones to switch between, and this repository has no React testing
  library for hook-level unit tests). Verified correct only by direct code reading. A future task
  adding a synthetic multi-device Chromium setup could close this.
- No E2E scenario proves "explicit `leave()` during an active voice channel, followed by an
  unexpected server loss/restart, does not restore the left channel" — the underlying
  `currentChannelRef` clearing logic is simple, has exactly one write site outside `join()`, and was
  verified correct by direct reading, but has no automated regression guard. Closing this would need a
  new E2E-only auto-leave hook, a genuine scope expansion beyond a QA pass, deferred as a documented
  limitation rather than built ad hoc during review.

Test count: 910 (pre-review) → **913** (post-review), 0 regressions, 0 skipped.

### Privacy statement

- **Client-local, never sent anywhere:** identity, nickname, local device preferences and ids, server
  bookmarks, `lastServerAddress`, `connectOnStartup`, screen-quality/mute/deafen defaults.
- **Server-local (unchanged by T11):** T9 authorization state, T10 persistent chat, server
  configuration.
- **Not centralized by anything OvniChat operates:** no OvniChat-operated service exists that could
  receive any of the above even if it wanted to. Automatic reconnect never caches, replays, or
  shortcuts T7 authentication or T9 admission.

### Next task

**T12 — Windows per-process/game audio** (sharing a specific process's audio, e.g. `game.exe`, instead
of the entire system output). Not implemented as part of T11.
