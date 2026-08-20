# Task status

| Task                                | Status      | Outcome                                                            |
| ----------------------------------- | ----------- | ------------------------------------------------------------------ |
| [T0](T0_REPOSITORY_HARNESS.md)      | COMPLETE    | Repository and Claude development harness                          |
| [T1](T1_ELECTRON_SHELL.md)          | COMPLETE    | Electron desktop shell and application foundation                  |
| [T2](T2_REALTIME_PROTOCOL.md)       | COMPLETE    | Shared realtime protocol and realtime service foundation           |
| [T3](T3_VOICE_WEBRTC.md)            | COMPLETE    | Voice channels and microphone WebRTC vertical slice                |
| [T4](T4_CAMERA_STREAMING.md)        | COMPLETE    | Camera streaming over existing WebRTC voice sessions               |
| [T5](T5_SCREEN_SHARE.md)            | COMPLETE    | Screen/window streaming over existing WebRTC voice sessions        |
| [T6](T6_SCREEN_AUDIO.md)            | COMPLETE    | Windows system audio for screen sharing                            |
| [T7](T7_LOCAL_IDENTITY.md)          | COMPLETE    | Local cryptographic client identity                                |
| [T8](T8_DEDICATED_SERVER.md)        | COMPLETE    | Dedicated server product boundary                                  |
| [T9](T9_SERVER_AUTHORIZATION.md)    | COMPLETE    | Server-local groups, permissions, invite/privilege tokens, bans    |
| [T10](T10_PERSISTENT_TEXT_CHAT.md)  | COMPLETE    | Persistent server-side text chat (server + per-channel)            |
| [T11](T11_DAILY_USE_UX.md)          | COMPLETE    | Devices, bookmarks, reconnect, and product UX                      |
| [T12](T12_WINDOWS_PROCESS_AUDIO.md) | IN PROGRESS | Windows per-process/game audio                                     |
| T13                                 | NOT STARTED | Self-hosting production package (TURN, TLS, Docker, configuration) |
| T14                                 | NOT STARTED | Windows client installer and dedicated-server releases             |
| T15                                 | NOT STARTED | UX polish / private beta                                           |
| T16                                 | NOT STARTED | SFU evaluation/migration, only if measured scale requires it       |

Statuses are `NOT STARTED`, `IN PROGRESS`, `BLOCKED`, or `COMPLETE`. A status summarizes evidence;
it is not a substitute for the task handoff.

T0–T6 completed the media-engineering vertical: microphone, camera, screen-video, and screen-audio
all working, live-verified, self-hosted, with no accounts or central infrastructure required. T7
implemented the first piece of the actual TeamSpeak-style product architecture — every client now
has a local Ed25519 identity, proven to the realtime server via a challenge/response handshake, with
no central account, no email/password, and no global user database, per
[`../adr/0010-no-mandatory-central-control-plane.md`](../adr/0010-no-mandatory-central-control-plane.md)
and [`../adr/0011-local-cryptographic-identity-without-central-accounts.md`](../adr/0011-local-cryptographic-identity-without-central-accounts.md).
T8 turned the previously-internal `services/realtime` into an explicit, independently-operable
Disco Voador Dedicated Server product (`services/dedicated-server`) that a client connects to
directly, with no Disco Voador–operated infrastructure required — see
[`T8_DEDICATED_SERVER.md`](T8_DEDICATED_SERVER.md) and
[`../architecture/DEDICATED_SERVER.md`](../architecture/DEDICATED_SERVER.md) for the full design,
including a security-review finding (a stale Content-Security-Policy that would have blocked
connecting to any address other than the one baked in at launch) found and fixed during this task.
T9 gave that Dedicated Server its first authorization model — server-local groups/permissions keyed
by T7's `identityId`, bearer tokens (bootstrap/privilege/invite), and identity-based bans, backed by
the Dedicated Server's first persistent runtime state (SQLite via `node:sqlite`, zero new
dependencies) — see [`T9_SERVER_AUTHORIZATION.md`](T9_SERVER_AUTHORIZATION.md) and
[`../architecture/SERVER_AUTHORIZATION.md`](../architecture/SERVER_AUTHORIZATION.md) for the full
design, including two non-blocking security/QA findings (a `deleteGroup` force-disconnect symmetry
gap, and a misleading fallback WebSocket close code) found and fixed during this task.

The product is now marketed as **OvniChat** (see [`../PRODUCT.md`](../PRODUCT.md) for the naming
note; the internal `@disco-voador/*` package namespace is unchanged for now). T10 gave the
Dedicated Server its second persistent concern — server-wide and per-voice-channel chat, in its own
SQLite file (`chat.sqlite`, deliberately separate from T9's `authorization.sqlite` — see
[`../adr/0014-persistent-server-owned-chat-history.md`](../adr/0014-persistent-server-owned-chat-history.md)),
correcting an earlier roadmap assumption that chat would be ephemeral: history now survives client
disconnect, client restart, and server restart, owned entirely by the Dedicated Server that received
it. See [`T10_PERSISTENT_TEXT_CHAT.md`](T10_PERSISTENT_TEXT_CHAT.md) and
[`../architecture/PERSISTENT_TEXT_CHAT.md`](../architecture/PERSISTENT_TEXT_CHAT.md).

T11 made the Client practical for daily use: a local typed/versioned settings store and server
bookmarks (`apps/desktop/src/main/settings/`, entirely client-local — see
[`../adr/0015-local-client-settings-and-bookmarks.md`](../adr/0015-local-client-settings-and-bookmarks.md)),
device enumeration/hot-plug/live-switching (a new `MediaTransport.replaceTrack` primitive in
`packages/rtc-core`), and automatic reconnect with a bounded backoff, voice-channel restoration, fresh
T7 re-authentication, and a mandatory rule that camera/screen never auto-restart after a reconnect
(see
[`../adr/0016-automatic-reconnect-and-media-restoration-policy.md`](../adr/0016-automatic-reconnect-and-media-restoration-policy.md)).
See [`T11_DAILY_USE_UX.md`](T11_DAILY_USE_UX.md) and
[`../architecture/CLIENT_SETTINGS_AND_RECONNECT.md`](../architecture/CLIENT_SETTINGS_AND_RECONNECT.md).
Do not treat T12+ as started until their own task documents and STATUS.md rows say so.
