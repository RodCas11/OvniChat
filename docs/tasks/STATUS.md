# Task status

| Task                           | Status      | Outcome                                                            |
| ------------------------------ | ----------- | ------------------------------------------------------------------ |
| [T0](T0_REPOSITORY_HARNESS.md) | COMPLETE    | Repository and Claude development harness                          |
| [T1](T1_ELECTRON_SHELL.md)     | COMPLETE    | Electron desktop shell and application foundation                  |
| [T2](T2_REALTIME_PROTOCOL.md)  | COMPLETE    | Shared realtime protocol and realtime service foundation           |
| [T3](T3_VOICE_WEBRTC.md)       | COMPLETE    | Voice channels and microphone WebRTC vertical slice                |
| [T4](T4_CAMERA_STREAMING.md)   | COMPLETE    | Camera streaming over existing WebRTC voice sessions               |
| [T5](T5_SCREEN_SHARE.md)       | COMPLETE    | Screen/window streaming over existing WebRTC voice sessions        |
| [T6](T6_SCREEN_AUDIO.md)       | COMPLETE    | Windows system audio for screen sharing                            |
| [T7](T7_LOCAL_IDENTITY.md)     | COMPLETE    | Local cryptographic client identity                                |
| T8                             | NOT STARTED | Dedicated server product boundary                                  |
| T9                             | NOT STARTED | Server-local groups, permissions, invite/privilege tokens, bans    |
| T10                            | NOT STARTED | Minimal/ephemeral text chat                                        |
| T11                            | NOT STARTED | Devices, bookmarks, reconnect, and product UX                      |
| T12                            | NOT STARTED | Windows per-process/game audio                                     |
| T13                            | NOT STARTED | Self-hosting production package (TURN, TLS, Docker, configuration) |
| T14                            | NOT STARTED | Windows client installer and dedicated-server releases             |
| T15                            | NOT STARTED | UX polish / private beta                                           |
| T16                            | NOT STARTED | SFU evaluation/migration, only if measured scale requires it       |

Statuses are `NOT STARTED`, `IN PROGRESS`, `BLOCKED`, or `COMPLETE`. A status summarizes evidence;
it is not a substitute for the task handoff.

T0–T6 completed the media-engineering vertical: microphone, camera, screen-video, and screen-audio
all working, live-verified, self-hosted, with no accounts or central infrastructure required. T7
implemented the first piece of the actual TeamSpeak-style product architecture — every client now
has a local Ed25519 identity, proven to the realtime server via a challenge/response handshake, with
no central account, no email/password, and no global user database, per
[`../adr/0010-no-mandatory-central-control-plane.md`](../adr/0010-no-mandatory-central-control-plane.md)
and [`../adr/0011-local-cryptographic-identity-without-central-accounts.md`](../adr/0011-local-cryptographic-identity-without-central-accounts.md).
T8 onward continues that direction — a dedicated self-hosted server product, server-local
permissions. This reflects a roadmap decision for T8+; do not treat those as started until their own
task documents and STATUS.md rows say so.
