# Task status

| Task                                        | Status      | Outcome                                                         |
| ------------------------------------------- | ----------- | --------------------------------------------------------------- |
| [T0](T0_REPOSITORY_HARNESS.md)              | COMPLETE    | Repository and Claude development harness                       |
| [T1](T1_ELECTRON_SHELL.md)                  | COMPLETE    | Electron desktop shell and application foundation               |
| [T2](T2_REALTIME_PROTOCOL.md)               | COMPLETE    | Shared realtime protocol and realtime service foundation        |
| [T3](T3_VOICE_WEBRTC.md)                    | COMPLETE    | Voice channels and microphone WebRTC vertical slice             |
| [T4](T4_CAMERA_STREAMING.md)                | COMPLETE    | Camera streaming over existing WebRTC voice sessions            |
| [T5](T5_SCREEN_SHARE.md)                    | COMPLETE    | Screen/window streaming over existing WebRTC voice sessions     |
| [T6](T6_SCREEN_AUDIO.md)                    | COMPLETE    | Windows system audio for screen sharing                         |
| [T7](T7_LOCAL_IDENTITY.md)                  | COMPLETE    | Local cryptographic client identity                             |
| [T8](T8_DEDICATED_SERVER.md)                | COMPLETE    | Dedicated server product boundary                               |
| [T9](T9_SERVER_AUTHORIZATION.md)            | COMPLETE    | Server-local groups, permissions, invite/privilege tokens, bans |
| [T10](T10_PERSISTENT_TEXT_CHAT.md)          | COMPLETE    | Persistent server-side text chat (server + per-channel)         |
| [T11](T11_DAILY_USE_UX.md)                  | COMPLETE    | Devices, bookmarks, reconnect, and product UX                   |
| [T12](T12_WINDOWS_PROCESS_AUDIO.md)         | COMPLETE    | Windows per-process/game audio                                  |
| [T13.1](T13_1_VISUAL_FOUNDATION.md)         | COMPLETE    | Visual foundation & main application layout                     |
| [T13.1.1](T13_1_1_VISUAL_POLISH.md)         | COMPLETE    | Visual polish & UX refinement                                   |
| [T13.2](T13_2_CHANNEL_ADMINISTRATION.md)    | COMPLETE    | Channels & server administration                                |
| [T13.2.1](T13_2_1_ADMIN_UX_POLISH.md)       | COMPLETE    | Administration UX polish (permission labels, category ACL copy) |
| [T13.3](T13_3_PROFILES_AVATARS_PRESENCE.md) | COMPLETE    | Profiles / avatars / members / presence                         |
| [T13.4](T13_4_GAMER_VOICE_EXPERIENCE.md)    | COMPLETE    | Gamer voice experience                                          |
| T13.5                                       | NOT STARTED | Streams / camera / product integration                          |
| T14                                         | NOT STARTED | Production self-hosting (TURN, TLS, Docker, configuration)      |
| T15                                         | NOT STARTED | Windows client installer and dedicated-server releases          |
| T16                                         | NOT STARTED | Private beta / usage polish                                     |
| T17                                         | NOT STARTED | SFU evaluation/migration, only if measured scale requires it    |
| T18                                         | NOT STARTED | Hardening / release candidate                                   |

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

T12 gave the Client real per-application ("game") audio capture — this repository's first native/
compiled code, an out-of-process Win32/WASAPI C++ helper in `packages/windows-media/native/`
(chosen over an in-process addon for crash isolation, see
[`../adr/0017-windows-process-loopback-native-boundary.md`](../adr/0017-windows-process-loopback-native-boundary.md)),
speaking a framed local-pipe protocol to a TypeScript supervisor, bridged to a real `MediaStreamTrack`
via `MediaStreamTrackGenerator`, and published through the exact same `screen-audio` semantic source
T6 already established — no new remote signaling. Met with real evidence, not simulation: a mandatory
frequency-domain isolation proof between two genuinely independent Windows processes passed 3
consecutive clean runs on the final, security-reviewed code (68-78 dB margin against a 20 dB
threshold), and a security review found and this task closed a real PID-reuse TOCTOU gap (the native
helper now cross-checks the enumerated exe name against the resolved PID's real exe name before ever
activating capture). See [`T12_WINDOWS_PROCESS_AUDIO.md`](T12_WINDOWS_PROCESS_AUDIO.md) for the full
record.

**T13 was redefined, by explicit product direction, from a single "self-hosting production package"
task into a five-part Product Experience series (T13.1-T13.5)** covering the visual/UX foundation,
channel/server administration, profiles/avatars/presence, the gamer voice experience, and streams/
camera integration, in that order — before self-hosting/installer/beta work. Every task originally
numbered T13-T16 shifted down: production self-hosting is now **T14**, the installer/release task is
now **T15**, private beta/UX polish is now **T16**, SFU evaluation is now **T17**, and a new **T18**
(hardening/release candidate) was added to close out the roadmap. `docs/ROADMAP.md` predates this
renumbering (and, independently, predates the real T7-T12 history) — this file (`STATUS.md`) is the
authoritative source per `CLAUDE.md`; treat `ROADMAP.md` as superseded until it is rewritten to match.
Do not treat T13.2+ or T14+ as started until their own task documents and STATUS.md rows say so.
