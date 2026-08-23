# Client settings, bookmarks, device management, and automatic reconnect (T11)

Canonical contracts live in code at
[`apps/desktop/src/main/settings/`](../../apps/desktop/src/main/settings/),
[`apps/desktop/src/renderer/realtime/reconnect-controller.ts`](../../apps/desktop/src/renderer/realtime/reconnect-controller.ts),
[`apps/desktop/src/renderer/realtime/reconnect-policy.ts`](../../apps/desktop/src/renderer/realtime/reconnect-policy.ts),
and [`apps/desktop/src/renderer/voice/use-voice-channel.ts`](../../apps/desktop/src/renderer/voice/use-voice-channel.ts);
this document explains the design and is not itself authoritative. See
[`../adr/0015-local-client-settings-and-bookmarks.md`](../adr/0015-local-client-settings-and-bookmarks.md)
and [`../adr/0016-automatic-reconnect-and-media-restoration-policy.md`](../adr/0016-automatic-reconnect-and-media-restoration-policy.md)
for the two storage/architecture decisions this document elaborates, and
[`CLIENT_IDENTITY.md`](CLIENT_IDENTITY.md) for the identity/nickname persistence conventions the
settings store deliberately parallels but does not merge with.

## Core product rule

T11 makes OvniChat practical for daily use without changing anything about _what_ it is: local
identity, no central account, server-local authorization, and persistent server-owned chat all remain
exactly as T7–T10 established. What T11 adds is entirely **client-local**: device preferences,
bookmarks, and a reconnect policy. None of it is sent to any Dedicated Server, and none of it changes
the T7 authentication handshake or the T9 admission model — a reconnect is a fresh connection in every
security-relevant sense, never a replayed or cached credential.

## Client settings store

`apps/desktop/src/main/settings/settings-file.ts` owns a single versioned, `.strict()`-zod-validated
JSON file at `%APPDATA%/DiscoVoador/settings.json`, written atomically via the same
`identity/atomic-write.ts` primitive T7's identity file already uses. `settings-service.ts` is a thin
in-memory-cached wrapper (`getClientSettings`, `updateClientSettings`, `addBookmark`, `updateBookmark`,
`removeBookmark`), mirroring `identity-service.ts`'s own load-once/cache/write-through shape.

Schema (`StoredClientSettings`):

```text
version
audio:        { inputDeviceId, outputDeviceId }   -- string | null; null = system default
video:        { cameraDeviceId }                  -- string | null
screenShare:  { qualityPreset }                   -- 'standard' | 'high' | 'smooth' | 'smooth720'
voice:        { startMuted, startDeafened }
bookmarks:    [{ bookmarkId, displayName, serverAddress }]
lastServerAddress: string | null
connectOnStartup: boolean
```

See [ADR 0015](../adr/0015-local-client-settings-and-bookmarks.md) for why this lives here (not
`packages/config`, not a new package, not merged with `nickname-store.ts`) and for the
section-by-section corruption-salvage discipline (a malformed `screenShare` section does not also
discard the bookmark list).

### IPC surface

Five narrow methods on `DesktopApi`
(`apps/desktop/src/shared/ipc-contract.ts`/`main/ipc.ts`/`preload/index.ts`), each validated against a
`.strict()` zod schema at the IPC boundary before reaching the store — the same "never trust the
Renderer's shape" discipline `signIdentityChallenge` already established:

```text
getClientSettings()                     -> DesktopClientSettings
updateClientSettings(patch)             -> DesktopClientSettings
addBookmark({displayName, serverAddress}) -> DesktopServerBookmark
updateBookmark(bookmark)                -> boolean
removeBookmark(bookmarkId)              -> boolean
```

`updateClientSettings` merges field-by-field, not via object spread or `??` — see
`settings-service.ts`'s `resolve()` helper doc comment: an explicit `undefined` in a patch (reachable
via Electron's structured-clone IPC transport, unlike `JSON.stringify`) means "not provided, keep the
current value," while `null` is itself a meaningful, distinct value ("use the system default device"),
so `??` would be wrong.

## Server bookmarks

A bookmark is exactly `{ bookmarkId, displayName, serverAddress }` — never a bearer token. An
invite/privilege/bootstrap token presented at `ConnectionScreen` remains exactly as ephemeral as it was
before T11 (cleared immediately after one connect attempt, per T9 Section 72); no bookmark flow ever
threads a token into persistent storage. Bookmarks, `lastServerAddress`, and `connectOnStartup` are
pure client-local convenience — no Dedicated Server, and no other OvniChat Client, ever learns what
servers a user has bookmarked (see [Privacy](#privacy) below).

`connectOnStartup` is explicit opt-in, off by default — enabling it still goes through the full T7
identity handshake and T9 admission normally on every launch; there is no shortcut or cached
authentication.

## Automatic reconnect

### Why a separate controller

`apps/desktop/src/renderer/realtime/realtime-client.ts`'s `RealtimeClient` gained exactly one
additive change for T11: a `closed` event carrying the real WebSocket close `code`/`reason` (fired
just before the existing `stateChange('closed')`). Everything else lives in a new wrapping class,
`ReconnectController` (`reconnect-controller.ts`), which owns **one** `RealtimeClient` instance for an
entire connection sequence, including every reconnect attempt, and only ever calls `.connect()`/
`.disconnect()` on it — `RealtimeClient.connect()` already tolerates being called again after a close.
See [ADR 0016](../adr/0016-automatic-reconnect-and-media-restoration-policy.md) for the full reasoning
(why not inside `RealtimeClient`, why not inline in the hook).

### State machine

```text
ReconnectingConnectionState = 'connecting' | 'authenticating' | 'open' | 'reconnecting' | 'closed'
```

`connect()` starts a fresh sequence (resets backoff/attempt counters). An unexpected close (not an
explicit `disconnect()`/`cancelReconnect()`) is classified by `reconnect-policy.ts`'s
`classifyCloseCode(code)`:

- **Non-retryable** (`BANNED`, `KICKED`, `INVITE_REQUIRED`, a protocol/identity error, ...) _or_ the
  connection never reached `'open'` even once during this sequence → `connectionFailed` fires with a
  human-readable reason (`describeNonRetryableClose`); the sequence ends at `'closed'`, no retry.
- **Retryable**, and the session had been genuinely established at least once → `reconnecting` fires
  with the current attempt number and computed delay; a bounded exponential backoff timer
  (1s initial, doubling, capped at 30s, "equal jitter") schedules the next `client.connect()` call.
  Backoff resets to the initial value the moment `'open'` is reached again.

A **generation counter**, bumped by every explicit `connect()`/`disconnect()`, invalidates any
in-flight reconnect timer from a stale sequence — a user manually connecting to a different server (or
clicking Cancel) while a retry is pending can never have the old timer fire a `connect()` call
afterward (T11's race requirement).

### Voice-channel and media restoration

`use-voice-channel.ts`'s main effect wires three controller events:

- **`reconnecting`** — the dead session is torn down immediately, not lazily: every current
  participant is removed from the (now-dead) transport, the reconciler resets, camera and screen are
  fully released (never held "on" with nothing to publish to), microphone is released too, and a
  **fresh `P2PMeshTransport`** replaces the old one (`recreateTransport()` — the old instance is
  permanently disabled by `closeAll()`, so a fresh mesh is required regardless of whether the
  underlying `RealtimeClient` survives). Currently-open chat threads are remembered
  (`openChatThreadsBeforeLossRef`) and cleared from state, matching T10's "the client is never the
  authoritative store" rule.
- **`reconnected`** (fires once `'open'` is reached again _after_ a genuine loss, never on a first
  connect) — replays the previously-joined channel via the same production `join()` action a user
  would invoke manually (which itself re-applies the current mute state to the freshly-acquired
  microphone), and re-requests history for whichever chat threads were open before the loss.
- **`connectionFailed`** — sets a human-readable `state.connectionError`, shown by `VoiceChannelView`.

| Source                   | Restored after reconnect?                                                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Voice-channel membership | Yes — via `join()`                                                                                                                                                                    |
| Microphone               | Yes — reacquired fresh by `join()`, current mute state re-applied                                                                                                                     |
| Mute / deafen            | Yes — never reset by the reconnect cycle in the first place                                                                                                                           |
| Camera                   | **No** — released the instant a loss is detected, never auto-restarted                                                                                                                |
| Screen video/audio       | **No** — same treatment as camera                                                                                                                                                     |
| Chat threads             | Reloaded from the server (fresh history request), never from client memory                                                                                                            |
| Profile/presence (T13.3) | Yes, accurately — the server proactively pushes the identity's real persisted avatar/status/presence as part of every connection's initial burst, never left as a stale/default guess |
| Member list (T13.3)      | Reloaded from the server (`server:presence-snapshot`), never carried over from before the loss                                                                                        |

Camera and screen non-restoration is a mandatory, non-negotiable product/privacy constraint, not a
convenience trade-off — see ADR 0016.

**T13.3 — per-Dedicated-Server profile/presence state isolation.** `VoiceChannelState`'s
`members`/`avatarCache`/`selfPresence`/`selfCustomStatus`/`selfAvatarRef` fields must never survive
past their own connection's terminal close — a security review found the in-hook reset meant to
guarantee this was wired to a `stateChange` listener detached _before_ `controller.disconnect()`
could ever fire it, so it was silently dead code on every real teardown path. The actual isolation
guarantee in practice came entirely from `AppShell`'s pre-existing per-connection remount `key`
(`App.tsx`), which discards the whole hook instance on every real server switch — not from the
in-hook reset that claimed to provide it. Fixed by reordering cleanup so `disconnect()` fires while
the listener is still attached, so the documented reset is now genuinely delivered by the code that
claims it, independent of the remount mechanism. See
[`SERVER_LOCAL_PROFILES_AND_PRESENCE.md`](SERVER_LOCAL_PROFILES_AND_PRESENCE.md)'s "Security review
outcome" section.

**T13.2 — restoring into a channel that changed while offline.** "Voice-channel membership: Yes — via
`join()`" above assumes the previously-joined channel is still restorable; T13.2 added three specific
outcomes for when it is not, all resolved via the same `join()` call's own rejection rather than a
special-cased restore path:

| While disconnected, the channel was...  | `join()`'s rejection code                           | Client behavior                                                                                                                                           |
| --------------------------------------- | --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deleted, or hidden by a live ACL change | `CHANNEL_NOT_FOUND` (both cases, indistinguishable) | Silently gives up — no error toast, since this is a background reconciliation, not a user action                                                          |
| Still visible but no longer joinable    | `CHANNEL_ACCESS_DENIED`                             | Same silent give-up                                                                                                                                       |
| Made password-protected                 | `CHANNEL_PASSWORD_REQUIRED`                         | The connection itself still succeeds; `state.channelPasswordPrompt` opens so the user can manually re-enter a password and complete the rejoin themselves |

In every case **the connection itself reconnects successfully** — a channel-restore failure never
fails the whole reconnect, matching this codebase's existing "a non-fatal error code never appears in
`CLOSE_CODE_BY_ERROR`" precedent. `use-voice-channel.ts` distinguishes a restore-triggered join
attempt from a user-initiated one via a `lastJoinRequestRef.isRestore` flag, purely to decide _how_ to
present a failure (silent vs. a password prompt vs, for a genuinely user-initiated join, an ordinary
error toast) — never to change what the server actually allows. See
[`CHANNELS_AND_SERVER_ADMINISTRATION.md`](CHANNELS_AND_SERVER_ADMINISTRATION.md)'s "Reconnect
interaction" section and `e2e:reconnect-channel-smoke` for the real-socket proof of all three cases.

### Fresh authentication, every time

Every reconnect goes through the _exact same_ T7 handshake (`client:hello` →
`server:identity-challenge` → `client:identity-proof` → `server:hello`) as any other connection — the
signature is never cached or replayed, and the server always issues a new challenge nonce. The same
local `identityId` is used every time (proven directly by `e2e:reconnect-smoke`, below), but the
cryptographic proof itself is always fresh. T9 admission (ban check, invite-only membership) is
re-evaluated identically on every reconnect too — a persistent Member does not need to re-present an
invite token (their T9 membership already persists server-side), but a ban applied while disconnected
is enforced on the very next reconnect attempt exactly as it would be for a first-time connection.

## Device management

### Enumeration and hot-plug

`apps/desktop/src/renderer/voice/device-enumeration.ts`'s `useMediaDevices()` hook calls
`navigator.mediaDevices.enumerateDevices()` — a standard Web API, no IPC involved — and listens for
`ondevicechange`, with the listener removed on unmount. Device _labels_ are empty until
microphone/camera permission has been granted at least once (a platform privacy protection, not a
bug); `fallbackDeviceLabel` produces a stable, numbered placeholder ("Microphone 1") per kind rather
than showing a blank dropdown entry or guessing a real name. Every dropdown is prepended with an
explicit "System default" pseudo-entry (`deviceId: null`), matching `settings-file.ts`'s own
device-preference model exactly.

### Live switching without leaving voice

`use-voice-channel.ts`'s `switchMicrophone(deviceId)`/`switchCamera(deviceId)` reuse the
`replaceTrack` primitive added to `packages/rtc-core`'s `MediaTransport` for this purpose (see
`docs/architecture/WEBRTC_VOICE.md`): acquire the new device first, `transport.replaceTrack(oldTrack,
newTrack)` only once the new device is confirmed live, then stop the old device — never the reverse
order. If acquisition of the new device fails, the old device is left completely untouched and still
working (T11 Section 27, mandatory atomicity). Both actions share the exact same
generation-counter/acquiring-ref staleness-guard pattern `enableCamera`/`join()` already established,
so a stale in-flight acquisition (transport torn down, or a newer switch/join superseding this one)
is detected and its result discarded rather than corrupting state. Switching a device preference while
nothing is currently live (no active call, or camera currently off) only updates the stored preference
for the _next_ acquisition — it never itself starts a call or turns the camera on.

### Missing/unavailable preferred device

A bare `deviceId` constraint is an _ideal_, not _exact_, constraint per the Media Capture and Streams
specification — `getUserMedia`/`getDisplayMedia` never reject for a missing device, they silently
substitute another one. `resolveDeviceFallback` detects this after the fact by comparing the preferred
`deviceId` against the actually-resolved track's own `getSettings().deviceId`, setting
`state.micUsingFallback`/`cameraUsingFallback` so the UI can show "Preferred device unavailable — using
Default" rather than silently behaving as if the preference were honored.

### Active device loss during a call

Camera already had an `'ended'` handler (T4) treating unexpected device loss as "stop cleanly, do not
disconnect the call." T11 adds the equivalent for microphone (previously absent — only an explicit
release ever stopped it before T11): surfaces `state.micDisconnected` without ending the voice session
or silently auto-reacquiring a different device on the user's behalf — per the Media Capture and
Streams specification, an `ended` track cannot be revived, and auto-substituting a device the user
never chose would route their voice through hardware they did not select. The user resolves it from
Settings (or by plugging the original device back in and switching to it again).

### Output-device (speaker) selection

`HTMLMediaElement.setSinkId()` is supported on this app's pinned Electron 43.4.0 build. Both remote
`<audio>` playback paths — microphone (`RemoteAudio.tsx`'s main use) and T6 screen-audio (the same
component, reused for the `remoteScreenAudioStreams` map) — honor the selected output device, not only
one of the two. Deafen safety (`audio.muted`) is independent of `setSinkId` by specification — changing
the output device while deafened cannot cause audible playback, since muting and sink selection are
orthogonal operations on the element.

### Local testing tools — no server involvement, nothing recorded

The Settings panel's microphone level meter and output test tone are both local-only Web Audio
(`AnalyserNode` / `OscillatorNode`) — no network call, no recording, no upload. The level meter reuses
the live call's own microphone stream when one is active rather than opening a second concurrent
capture; camera preview reuses `LocalCameraPreview.tsx`'s existing pattern of attaching the _same_
captured stream, never a second acquisition.

### Screen-share quality and "Share audio" persistence

The screen-share quality preset pre-selects `ScreenSourcePicker.tsx`'s dropdown default and never
itself starts a capture. The per-share "Share audio" checkbox is deliberately **not** persisted as a
default-on preference (T11 Section 36) — it always defaults to unchecked, regardless of what was
chosen for a previous share, preserving T6's explicit per-share consent model.

## Known limitations

- No ICE-restart for a single peer connection that alone reaches `'disconnected'` while the realtime
  WebSocket stays healthy — T11 only recovers from the WebSocket itself being lost. See
  `docs/architecture/WEBRTC_VOICE.md`'s "Known gaps" section.
- No bounded _attempt count_ — only a bounded _delay_. A permanently unreachable server (not a
  protocol-classified rejection, just genuinely gone) retries forever at the 30s-capped interval until
  the user explicitly cancels or disconnects. This matches the task's own framing ("bounded state
  machine" refers to the backoff delay, not a give-up-after-N-tries policy) and avoids inventing a
  second, arbitrary "give up" threshold with no clear right answer.
- `ReconnectController`'s own reconnect/backoff behavior has direct, deterministic fake-timer unit
  coverage (`tests/desktop/reconnect-controller.test.ts`) independent of the live E2E's own pass/fail
  history, following the same "don't rely solely on a live E2E for a stateful, closure-heavy concern"
  precedent `RemoteMediaReconciler` established in T6.
- Bookmark add/edit/remove and the `connectOnStartup` checkbox were exercised through typecheck/lint/
  the settings-persistence E2E (which drives the same production IPC calls programmatically) but not
  through actual DOM clicks — this repository has no DOM-automation E2E harness (console-marker-driven
  only, matching every other UI surface's own testing limitation, e.g. `CLIENT_IDENTITY.md`'s "no
  component-level Renderer test harness").
- Switching a device preference while an acquisition using the _previous_ preference is still in
  flight completes with the old device; the user can switch again once it finishes. A minor, accepted
  timing edge case, not a correctness bug (the atomicity guarantee is about not corrupting a _working_
  device, not about instantaneously canceling an in-flight one).
- `switchMicrophone`/`switchCamera` have no live-hook or E2E regression test of their own — flagged by
  `qa-engineer`'s T11 review and genuinely infeasible today: Chromium's
  `--use-fake-device-for-media-stream` (this codebase's only fake-media mechanism) provides one fake
  device per kind, not multiple distinct ones to switch between, and this repository has no React
  testing library for hook-level unit tests. Verified correct only by direct code reading (acquire →
  `replaceTrack` → stop-old ordering, generation-counter staleness guards mirroring `enableCamera`'s
  already-proven pattern). A future task adding a synthetic multi-device Chromium setup could close
  this.
- No E2E scenario proves an explicit `leave()` during an active voice channel, followed by an
  unexpected server loss/restart, does not restore the left channel — also flagged by QA review. The
  underlying `currentChannelRef` clearing has exactly one write site outside `join()` and was verified
  correct by direct reading; closing this properly would need a new E2E-only auto-leave hook, deferred
  as a documented limitation rather than added ad hoc during review.
- Output-device honoring was verified against the Web Audio/`HTMLMediaElement` specification's own
  documented `setSinkId`/`muted` independence and against this app's pinned Electron build's actual
  API surface, not by physically swapping a second real output device on the development machine
  (only one was available) — stated honestly rather than claimed as physically verified.

## Automated end-to-end verification: settings and bookmarks

`apps/desktop/scripts/e2e-settings-persistence.mjs`: a real Electron instance writes a device
preference and a bookmark through the real `updateClientSettings`/`addBookmark` IPC (no server
involved, mirroring `e2e-identity-persistence.mjs`'s zero-server design); a second launch against the
_same_ `--user-data-dir` confirms both survived; a third launch against a _different_ profile confirms
neither leaked. **Passed.**

## Privacy

**Client-local, never sent to any Dedicated Server or any other OvniChat Client:** identity, nickname,
bookmarks, selected device ids, screen-quality/mute/deafen preferences, `connectOnStartup`,
`lastServerAddress`. **Server-local (unchanged by T11):** authorization state (T9), persistent chat
(T10), server configuration. **Not centralized by anything OvniChat operates:** none of the above —
there is no OvniChat-operated service that could receive it even if it wanted to; see
`docs/PRODUCT.md`'s product principles and `docs/adr/0010-no-mandatory-central-control-plane.md`.

## Automated end-to-end verification

`apps/desktop/scripts/e2e-reconnect-smoke.mjs`: a real Dedicated Server (file-backed data directory),
two real Electron instances joined to the same voice channel with real, non-silent peer audio; the
server process is killed (`SIGTERM`) to simulate an unexpected loss; both clients are proven to detect
it (`disco-voador:connection-status:reconnecting`); the server restarts on the _same_ port and data
directory; both clients are proven to automatically reconnect (a second
`disco-voador:connection-status:connected`, with the _same_ `identityId` as before), rejoin the voice
channel (a second `disco-voador:voice-joined:<channelId>`), and re-establish real peer audio with
_fresh_ server-issued participant ids (`E2E_PEER_CONNECTED`/`E2E_AUDIO_LEVEL_OK` firing a second time
with different ids — the server mints a new `participantId` per join,
`services/realtime/src/voice/registry.ts`); Server Chat history sent before the restart is proven to
reload correctly after reconnect (via the history API, not a stale live event); camera/screen are
proven to have never activated. **Passed 3 consecutive clean runs.**

All eight pre-existing Electron E2E scripts (`e2e:voice-smoke`, `e2e:camera-smoke`, `e2e:screen-smoke`,
`e2e:screen-audio-smoke`, `e2e:identity-auth`, `e2e:identity-persistence`, `e2e:connection-smoke`,
`e2e:authorization`, `e2e:text-chat-persistence`) were re-verified passing against the final T11 code —
no regression from the reconnect architecture change.
