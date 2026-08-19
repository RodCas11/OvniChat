# T6 — Windows system audio for screen sharing

## Goal

A participant sharing their screen can optionally also share their computer's system audio, so
remote participants hear it alongside the shared video — never silently, only on an explicit
per-share opt-in. Screen-audio is a fourth, independent media source alongside microphone (T3),
camera (T4), and screen-video (T5).

## Context

T5 delivered screen/window video sharing with a hardened source-selection flow and a `mid`-based
semantic-identity mechanism distinguishing camera from screen-video. T6 extends that same identity
mechanism to a second audio source, and adds the actual Windows capture path: Electron's documented
`session.setDisplayMediaRequestHandler` system-audio-loopback mechanism (`Streams.audio:
'loopback'`), confirmed against this app's pinned Electron version's own type definitions and
distinct from the deprecated `chromeMediaSource` constraint form T5 already found and defended
against.

## In scope

- **Explicit consent UI**: a "Share audio" checkbox in the screen source picker, default unchecked.
- **Windows system-audio-loopback capture**: `session.setDisplayMediaRequestHandler` resolving with
  `audio: 'loopback'` only when the user's explicit choice, the platform's own confirmation the
  Renderer actually requested audio, and `process.platform === 'win32'` all agree.
- **Optional audio, mandatory video**: `packages/media-core`'s `acquireScreen()` gains a `shareAudio`
  parameter; the returned `Screen` carries an optional `audioTrack` — absence is never a failure of
  the share itself, video-only sharing remains fully supported.
- **Media identity extended to audio**: `packages/protocol`'s `TrackSource` grows to
  `'microphone' | 'camera' | 'screen-video' | 'screen-audio'`; microphone is now explicitly announced
  through the same `media:track-source` mechanism camera/screen-video already used, closing the
  absence-based-inference gap that would otherwise reappear once two audio sources exist.
- **RTC publication**: screen-audio flows through the exact same `MediaTransport.publishTrack`/
  `unpublishTrack` contract every other source uses — no parallel path.
- **Remote media model**: a fourth independent remote-stream map (`remoteScreenAudioStreams`),
  its own playback ownership (`RemoteAudio.tsx`, reused unmodified), never mixed with microphone
  even though both are `track.kind === 'audio'`.
- **Mute/deafen semantics**: microphone mute never touches screen-audio (structurally, by
  construction); deafen suppresses local playback of both.
- **Cleanup semantics**: stopping the share removes both screen-video and screen-audio; screen-video
  ending externally tears down screen-audio too; screen-audio can end independently without ending
  screen-video.
- **A dedicated E2E smoke test** (`e2e:screen-audio-smoke`) proving the whole path through real
  Windows system-audio-loopback capture, not an injected `MediaStreamTrack`.

## Out of scope

Accounts, authentication, a central identity service, cloud control plane, monetization, ads,
subscriptions, licensing, hosted Disco Voador infrastructure, text chat, process/game-specific
WASAPI capture (a future task — see "Future: process/game audio boundary" in
`docs/architecture/WEBRTC_SCREEN_AUDIO.md`), and an SFU.

## Architecture constraints

- Screen-audio flows through the same `MediaTransport.publishTrack`/`unpublishTrack` contract every
  other source uses — no parallel transport path, no `peerConnection.addTrack()` called from
  React/UI code.
- `packages/rtc-core`/`packages/media-core` stay free of Electron/React/Windows dependency; the
  actual `setDisplayMediaRequestHandler` audio-loopback decision stays in `apps/desktop`'s Main
  process, exactly where T5's video-source decision already lives.
- System-audio permission is part of the same explicit user action as video source selection — one
  armed selection carries both, never a separate/implicit audio grant.
- Screen-audio capture-only test automation is gated behind the same `!app.isPackaged` +
  explicit-env-var pattern every previous E2E-only flag uses; never global, never in a packaged
  build; the E2E's deterministic audio source (an oscillator tone) plays through the real OS audio
  output and is captured by the real production loopback path — never an injected
  `MediaStreamTrack` bypassing capture.
- No SFU: screen-audio is P2P mesh like everything else so far — documented, not hidden.

## Relevant packages

`packages/protocol`, `packages/rtc-core`, `packages/media-core`, `apps/desktop`,
`services/realtime` (no changes needed beyond the message-size bound — the forwarding logic is
already source-agnostic).

## Relevant agents

`windows-media-engineer` and `webrtc-media-engineer` for the capture/identity design;
`electron-desktop-engineer` for the Electron/Chromium loopback mechanism and IPC surface;
`security-reviewer` for the widened capture surface and consent flow; `qa-engineer` for
regression/false-positive review of the new E2E scenario.

## Relevant skills

`project-orientation`, `planning-feature`, `webrtc-development`, `windows-media-capture`,
`electron-development`, `testing-quality`, `security-review`.

## Acceptance criteria

- Screen sharing without audio continues to work exactly as in T5.
- A user can explicitly opt into sharing system audio per share; it is never shared silently.
- A remote participant identifies screen-audio distinctly from microphone, camera, and screen-video
  — no absence-based or arrival-order-based inference.
- Microphone mute does not affect screen-audio; deafen suppresses both.
- Stopping a share cleans up both screen-video and screen-audio without affecting microphone,
  camera, or the peer connection.
- A dedicated E2E smoke run proves the real Windows system-audio-loopback path end to end, at least
  3 consecutive clean runs on final code.

## Definition of Done

See [`../DEFINITION_OF_DONE.md`](../DEFINITION_OF_DONE.md). T6 additionally requires:
`e2e:screen-audio-smoke` passing 3 consecutive times (done — 12 total across four rounds, the last
round after the final lifecycle-audit fixes); `e2e:voice-smoke`/`e2e:camera-smoke`/
`e2e:screen-smoke` re-verified green after this change (done); security and QA review of the new
capture/IPC/protocol surface (done — see `docs/architecture/WEBRTC_SCREEN_AUDIO.md`'s "Security and
QA review outcomes"); measured (not guessed) SDP/message-size bounds (done — a live 4-source SDP
measured 25,235 characters, bound raised to 65536 with headroom); `docs/architecture/
WEBRTC_SCREEN_AUDIO.md` written (done).

## Handoff notes

### What is real and verified

- **Windows system-audio-loopback capture**: confirmed via Electron 43.4.0's own type definitions
  (`node_modules/electron/electron.d.ts`) — `Streams.audio` accepts `'loopback' | 'loopbackWithMute'`,
  Windows-only, and `DisplayMediaRequestHandlerHandlerRequest.audioRequested` reflects whether the
  Renderer's own `getDisplayMedia()` call requested audio. Live-verified working end to end via
  `e2e:screen-audio-smoke` — real system-audio loopback capture, real WebRTC transport, real remote
  decode, all through the production path.
- **`acquireScreen(constraints, shareAudio)`** (`packages/media-core`): optional `audioTrack`,
  never a failure when audio is requested but unavailable; `stop()` releases both tracks.
- **`main/screen-share.ts`**: `pendingSelection` now carries `{sourceId, shareAudio}`; the grant
  requires the armed selection, the platform's own `audioRequested` confirmation, and
  `process.platform === 'win32'` to all agree before ever passing `audio: 'loopback'`.
- **Media identity extended uniformly to audio**: `use-voice-channel.ts`'s mid-based reconciliation
  (originally T5's camera-vs-screen-video mechanism) now covers all four sources. Extracted into a
  standalone, React-free `RemoteMediaReconciler` class (`remote-media-reconciliation.ts`) with direct
  unit test coverage (`tests/desktop/remote-media-reconciliation.test.ts`, 14 tests) — closing a gap
  flagged by two prior review rounds (T5's initial QA review and its stabilization pass) that this
  exact reconciliation logic had zero unit coverage.
- **A real, previously-latent `rtc-core` bug found and fixed**: `Peer.handleRemoteOffer()` never
  reported local track mids after answering (only `createAndSendOffer()` did after offering) —
  harmless while every announced track was added post-handshake (camera/screen, always
  user-enabled after join), but microphone is seeded _before_ the initial offer/answer cycle, so the
  side of a pair that only ever answers for that cycle never announced its own microphone's mid at
  all once microphone required the same mechanism. Fixed with one added call, mirroring
  `createAndSendOffer()`'s existing one; regression-tested (`tests/rtc-core/peer.test.ts`'s "T6
  regression" test), and the shared test fake (`fake-peer-connection.ts`) was corrected to model
  real platform behavior (mids become known at `setRemoteDescription(offer)` time for the answerer,
  not at `setLocalDescription(answer)` time — it previously modeled neither).
- **SDP/message-size bound, live-measured**: a real offer negotiating all four sources plus a
  re-share cycle measured **25,235 characters**, exceeding the old 24576 bound from a real run (the
  run's viewer instance failed because of it) — raised to 65536 with headroom;
  `REALTIME_MAX_MESSAGE_BYTES`'s default raised 32 KiB → 80 KiB alongside it.
- **`RemoteMediaReconciler.removeParticipant()`**: a QA-flagged gap (the four-map leaving-participant
  cleanup, previously an inline diff in `use-voice-channel.ts` with no direct test) closed by
  centralizing it into the reconciler with three dedicated tests.
- Full `corepack pnpm check` green throughout (508 tests, including 17 in
  `remote-media-reconciliation.test.ts` and 2 local screen-release lifecycle regressions in
  `screen-share-lifecycle.test.ts`). `pnpm build`, realtime build, and `electron-forge package` all
  succeed.

### E2E evidence

- `e2e:voice-smoke`: clean.
- `e2e:camera-smoke`: 3 consecutive clean runs against final code (see
  `docs/architecture/WEBRTC_SCREEN_AUDIO.md`'s "Camera-smoke intermittent flakiness" note for the
  honest record of intermittent failures interspersed with passes this session, and why they were
  not treated as a T6 regression).
- `e2e:screen-smoke`: 3 consecutive clean runs against final code (re-verified twice, most recently
  after the `E2E_SCREEN_AUDIO_ABSENT` cycle-tagging fix below).
- `e2e:screen-audio-smoke`: **12 total consecutive clean runs across four rounds** — 3 before the SDP
  bound fix (using a temporarily-widened diagnostic scenario to also measure the 4-source SDP), 3
  after on the actual gating scenario, and 3 more after a QA-flagged fix tagging
  `E2E_SCREEN_AUDIO_ABSENT` with the viewer's own observed cycle number (closing an evidentiary-
  precision gap — see "Security and QA review" below), plus 3 against the final lifecycle-audit
  fixes. Proves: video-only sharing with genuine screen-audio absence, tied to the correct cycle;
  audio-on sharing with real non-silent decoded screen-audio; microphone-mute independence
  (screen-audio stays non-silent while muted); clean stop removing both tracks without disconnecting
  the peer; a re-share producing fresh decoded screen-video and screen-audio again.

### Security and QA review

See `docs/architecture/WEBRTC_SCREEN_AUDIO.md`'s "Security and QA review outcomes" section for the
full detail. A final pre-publish lifecycle audit additionally found and fixed two release blockers:
native video capture ending did not stop the still-live system-audio loopback, and channel leave
did not remove screen-audio from the transport's published-track set. Both paths now use one tested
`releasePublishedScreen()` operation that unpublishes video and audio before stopping the capture.

### Next task

T6 is COMPLETE. See [`STATUS.md`](STATUS.md) for the roadmap: T7 — local cryptographic client
identity is next.
