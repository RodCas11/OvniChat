# T5 — Screen/window streaming over existing WebRTC voice sessions

## Goal

A participant already connected to a voice channel can share a screen or a specific window,
published to every other participant in the same channel over the existing P2P WebRTC connections,
without interrupting voice or an active camera. Screen-video is a third, independent media source
alongside microphone (T3) and camera (T4).

## Context

T3 delivered voice channels, microphone capture, and P2P WebRTC signaling. T4 added camera as a
second independent track type over the same peer connections, plus WebRTC renegotiation support.
T5 adds screen-video as a third source over the same connections — no new transport, no new
signaling channel, no new peer-connection lifecycle — but requires two things T4 explicitly left
open: fixing a documented renegotiation-offer-atomicity race before adding more dynamic
renegotiation on top of it, and a real semantic source discriminator now that `track.kind ===
'video'` is ambiguous between camera and screen.

## In scope

- **Negotiation race fix (prerequisite)**: `Peer.createAndSendOffer()`'s two-step
  `createOffer()`/`setLocalDescription(offer)` replaced with the atomic parameterless
  `setLocalDescription()`, with a regression test reproducing the race class, before any of the
  rest of T5 depends on renegotiation further.
- **Media source identity**: a new `packages/protocol` message (`media:track-source`) broadcasting
  a published track's semantic source (`'camera'` | `'screen-video'`) by `MediaStreamTrack.id`,
  server-attributing the sender — so `track.kind === 'video'` is never the only signal once both
  camera and screen exist, and source is never inferred from track-arrival order.
- `packages/media-core`: `acquireScreen()`/`Screen` — video-only capture via `getDisplayMedia()`,
  quality presets, full stop-on-disable lifecycle, late-acquisition-race protection, double-click
  protection — mirroring camera's proven pattern.
- Electron Main: `desktopCapturer` source enumeration and `session.setDisplayMediaRequestHandler()`
  behind a narrow, validated IPC boundary; a custom Renderer source picker (screens/windows,
  thumbnails, quality presets) — never a browser-native picker, never an auto-selected source.
- `apps/desktop`: screen-share on/off lifecycle (idle/starting/sharing/stopping/error), local
  preview, remote screen tiles rendered separately from camera tiles with preserved aspect ratio,
  native/external capture-end handling, an automated two-Electron-instance screen-share E2E smoke
  test proving real decoded remote screen video with correct source/participant identity.

## Out of scope

System/game audio (WASAPI, process loopback — a future task), text chat, SQLite, authentication,
recording, remote control/mouse/keyboard, annotation, whiteboard, OBS integration, SFU,
simulcast/SVC, an adaptive bitrate controller.

## Architecture constraints

- Screen-video flows through the same `MediaTransport.publishTrack`/`unpublishTrack` contract
  microphone and camera already use — no parallel transport path, no `peerConnection.addTrack()`
  called from React/UI code.
- `packages/rtc-core`/`packages/media-core` stay free of Electron/React/Windows dependency; all
  `desktopCapturer`/`session` usage stays in `apps/desktop`'s Main process.
- Source IDs from `desktopCapturer` are privileged-ish: validated against a current
  server(Main)-enumerated set, never accepted as an arbitrary client-supplied string: a stale or
  previously-consumed selection must never satisfy a later, unrelated `getDisplayMedia()` call.
- Preload exposes only narrow, validated, typed functions returning sanitized plain data — never a
  raw `desktopCapturer`, `NativeImage`, or `DesktopCapturerSource` object.
- Screen-share capture-only test automation is gated behind the same `!app.isPackaged` +
  explicit-env-var pattern T3/T4 established; never global, never in a packaged build; never
  auto-selects a source in a way a real user's flow couldn't also produce.
- No SFU: screen-video is P2P mesh like everything else so far (publisher uploads separately to
  each peer) — this is documented, not hidden, and the transport abstraction stays SFU-ready.

## Relevant packages

`packages/protocol`, `packages/rtc-core`, `packages/media-core`, `apps/desktop`

## Relevant agents

`webrtc-media-engineer` for the rtc-core negotiation fix and `media-core`'s screen module;
`electron-desktop-engineer` for `desktopCapturer`/IPC/picker UI;
`security-reviewer` for the widened capture surface, IPC boundary, and negotiation hardening;
`qa-engineer` for regression/race coverage and screen-share E2E false-positive review.

## Relevant skills

`project-orientation`, `planning-feature`, `webrtc-development`, `electron-development`,
`testing-quality`, `security-review`.

## Acceptance criteria

- The documented T4 negotiation race is fixed with a regression test reproducing its class, before
  screen sharing's renegotiation is considered trustworthy.
- Screen or window can be shared after voice (and optionally camera) is already connected, without
  leaving/rejoining the channel, and without interrupting either.
- A real second Electron client decodes the correct participant's screen-video (real dimensions,
  live `readyState`), not merely a fired `ontrack` event — proven via a dedicated E2E smoke run at
  least 3 consecutive times.
- Screen-video and camera are never confused with each other by any client, including a participant
  who joins after a screen share is already active.
- Stopping a screen share releases the capture device, removes the remote tile, and leaves
  microphone/camera/the peer connection itself unaffected; the same holds when the OS/user ends the
  capture externally (closed window, "Stop sharing" browser-style control).

## Definition of Done

See [`../DEFINITION_OF_DONE.md`](../DEFINITION_OF_DONE.md). T5 additionally requires: the
negotiation-race regression test (done); `e2e:screen-smoke` passing 3 consecutive times (done — 5
consecutive); `e2e:voice-smoke` and `e2e:camera-smoke` re-verified green after the negotiation fix
(done); security and QA review of the new capture/IPC surface (done, initial implementation) plus a
second security and QA review of the stabilization pass (done); `docs/architecture/
WEBRTC_SCREEN_SHARE.md` fully written (done). All satisfied — see "Status" in
`STATUS.md`.

## Handoff notes

### What is real and verified

- **Negotiation-race fix**: `Peer.createAndSendOffer()` now uses the atomic parameterless
  `setLocalDescription()`. Regression test
  (`tests/rtc-core/peer.test.ts`, "the polite side handles a colliding remote offer while its own
  offer synthesis is still pending") reproduces the exact collision class the T4 security review
  flagged and asserts it converges correctly. `e2e:voice-smoke` and multiple consecutive
  `e2e:camera-smoke` runs confirm no regression to the already-proven negotiation path.
- **Media source identity (`mid`-based, not `MediaStreamTrack.id`-based)**: live two-instance
  testing found `track.id` does not survive this application's connections unchanged (a genuine
  Electron/Chromium finding — see `docs/architecture/WEBRTC_SCREEN_SHARE.md`'s "Media source
  identity" section for the exact recorded mismatch). Redesigned around `mid`
  (`RTCRtpTransceiver.mid`), which was live-verified to survive correctly in both directions,
  every run. `packages/rtc-core` gained a `localTrackMid` transport event (`Peer.
reportLocalTrackMids`); `packages/protocol`'s `media:track-source` became peer-targeted (mirroring
  `webrtc:offer`/`answer`/`ice-candidate`) instead of a channel-wide broadcast, since `mid` is
  scoped to one peer connection, not global. Camera is announced through the same mechanism as
  screen, for the same reason absence-based inference is rejected for screen.
- **SDP size bound**: `packages/protocol`'s `SDP_MAX_LENGTH` (8 KiB, sized pre-T5 for at most 2
  m-lines) was live-found too small for a real 3-source offer (measured 10,859 characters) —
  genuinely rejected as `INVALID_MESSAGE`, which cascaded into breaking that connection's further
  signaling. Raised to 24 KiB with real headroom; `services/realtime`'s
  `REALTIME_MAX_MESSAGE_BYTES` transport-level default raised alongside it (16 KiB → 32 KiB).
- **rtc-core requires zero screen-specific changes** beyond the two prerequisites above:
  `tests/rtc-core/p2p-mesh-transport.test.ts`'s new regression tests prove three simultaneous
  tracks (mic + camera + screen) reach an existing peer and a newly-added peer, that unpublishing
  one video track leaves the other two intact, and that repeated publish/unpublish cycles do not
  accumulate stale sender bookkeeping.
- **`acquireScreen()`/`Screen`** (`packages/media-core`): video-only `getDisplayMedia()` capture,
  quality presets, full stop-on-disable, late-acquisition-race and double-click protection
  mirroring camera's proven pattern, `contentHint = 'detail'`. Closed `ScreenErrorReason` set
  researched against the Screen Capture spec, MDN, and Electron's own test suite (see
  `screen-errors.ts`).
- **Electron Main source enumeration and `getDisplayMedia()` fulfillment**
  (`apps/desktop/src/main/screen-share.ts`): sanitized `desktopCapturer` enumeration, single-use
  validated source selection, `session.setDisplayMediaRequestHandler()` re-resolving against Main's
  own cached native list (never trusting Renderer-supplied data for the actual grant), origin
  checked, never grants audio. A researched, documented residual finding about a legacy
  `chromeMediaSource` constraint path is flagged for `security-reviewer` follow-up (see
  `permissions.ts`'s `isDisplayCaptureRequest` doc comment and
  `docs/architecture/WEBRTC_SCREEN_SHARE.md`).
- **Renderer**: `screenSharingState` (`'idle'|'starting'|'sharing'|'error'`) as an explicit state,
  not a boolean; `enableScreenShare`/`disableScreenShare` mirroring camera's proven pattern;
  `ScreenSourcePicker.tsx` never auto-selects and never calls the selection IPC speculatively;
  `RemoteScreen.tsx` rendered separately from `RemoteCamera.tsx`, preserving aspect ratio; native
  capture-end handled via the track's own `'ended'` event.
- **Live camera+screen semantic-identity proof**: multiple two-instance runs during this task's own
  verification correctly routed one client's camera and screen-video to their own distinct remote
  streams simultaneously, with correct, differing real dimensions logged for each
  (`E2E_REMOTE_VIDEO_OK`/`E2E_REMOTE_SCREEN_OK`) — this is the core architectural risk T5 exists to
  retire, and it is retired.
- Full `corepack pnpm check` (prettier + lint + typecheck + `vitest run`, 473 tests + build +
  repository verification + dependency audit) green throughout; `pnpm build` and
  `electron-forge package` both succeed.

### Resolved: `e2e:screen-smoke` now reaches 3 consecutive clean passes

A follow-up stabilization pass root-caused and fixed this task's previously-open E2E flakiness.
The original hypothesis recorded here (DXGI screen-capture contention between two simultaneous
local captures) was tested directly and found to explain a _different, non-gating_ scenario's
occasional flakiness (the optional `--dual-capture` stress test — see
`docs/architecture/WEBRTC_SCREEN_SHARE.md`'s "Capture contention matrix"), not the primary
scenario's failures. The primary E2E scenario was also changed from two simultaneous local
capturers to one publisher + one pure viewer (the product itself is not restricted to one sharer —
see "In scope" above — this changes only the E2E's own topology, isolating the actual product
requirement being proven: a viewer decoding a publisher's screen).

Three distinct real root causes were found and fixed:

1. `backgroundThrottling` was not disabled on the `BrowserWindow`, so Chromium throttled remote
   video decode/frame-callback scheduling on whichever instance did not have OS focus — a genuine
   call-quality bug, not merely a test artifact. Fixed in `window-options.ts` (all windows).
2. A fast-finishing E2E instance's process exit (250ms after its own local success) could close its
   connection before the other, slower instance finished its own proof, producing a misleading
   `peerState=unknown`. Fixed by raising the exit delay to 5000ms.
3. A real product bug: `use-voice-channel.ts`'s stream-reconciliation logic unconditionally deleted
   a participant's camera stream entry as a side effect of wiring in a new screen-share track —
   meaning any user turning on screen share while their camera was active would cause the remote
   viewer to silently lose that camera video. Fixed by splitting the reconciliation function so
   only a genuine same-mid reclassification touches the other source's map.

Full detail, the contention matrix, and the exact fixes are in
`docs/architecture/WEBRTC_SCREEN_SHARE.md`'s "Automated end-to-end verification" section. With all
three fixes applied: `e2e:voice-smoke` passed, `e2e:camera-smoke` passed 4 consecutive runs, and
`e2e:screen-smoke` (primary scenario) passed 5 consecutive clean runs, all against the same final
code, with `pnpm check` green throughout.

An independent QA review of this stabilization pass identified one accepted, documented gap this
work does not close: two _real_ participants sharing screens with each other simultaneously (both
directions of screen-video flowing concurrently) is exercised only by the non-gating `--dual-capture`
stress test, not the gating suite — see `WEBRTC_SCREEN_SHARE.md`'s "Capture contention matrix" for
detail. The product itself is not restricted to one sharer; this is a test-coverage gap, not a
product limitation.

### Security and QA review

Both reviews found T5's own new surface sound overall, no release-blocking defects — each also
found one real, actionable issue, and both were fixed (not just noted):

- **Security**: the display-capture permission grant was, per an already-documented residual risk,
  also incidentally re-enabling a legacy capture path that bypasses the picker/consent flow
  entirely. Fixed by additionally requiring an actually-armed `screen-share.ts` selection before
  granting (`hasPendingScreenShareSelection()`) — narrows, does not fully close, the documented
  residual window (Electron exposes no way to disable the legacy path directly).
- **QA**: found and proved (via a new rtc-core regression test driving real product code) that a
  `mid` can be reused across _different_ sources, not just the same one — e.g. camera off then
  screen on reusing the freed transceiver's mid — and that the original reconciliation logic in
  `use-voice-channel.ts` would misroute the reused track's content into the stale source's map,
  because it captured the source in a closure once instead of looking it up dynamically. Fixed;
  see `docs/architecture/WEBRTC_SCREEN_SHARE.md`'s "A second real bug this design had to account
  for" section.

Two non-blocking follow-ups were also identified and are recorded, not resolved, in this task:
no renderer-level test harness exists for `use-voice-channel.ts` (pre-existing gap from T4, not
T5-specific, but T5's own reconciliation logic — where the QA-found bug lived — is exactly what
such a harness would protect); and `Peer.createAndSendOffer()` has no explicit re-entrancy guard
against two self-triggered renegotiation offers overlapping (e.g. toggling camera and screen
quickly) — likely mitigated in practice by the browser's own operations-chain serialization, but
not proven safe by a test, and deliberately not asserted as correct without a chosen fix direction
first. See `docs/architecture/WEBRTC_SCREEN_SHARE.md`'s "Security and QA review outcomes" section
for the full detail, and [`../HANDOFF.md`](../HANDOFF.md) for the cross-task summary.

**A second security and QA review, of the later stabilization pass** (topology change,
`backgroundThrottling`, the exit-race fix, the `moveRemoteVideoStream` bug fix, and the negotiation
re-entrancy guard) found no release-blocking defects. Security confirmed the negotiation
re-entrancy guard resolves the follow-up above (now has a regression test) and flagged
`backgroundThrottling: false`'s all-windows background-CPU/battery trade-off as worth recording
(done, in `WEBRTC_SCREEN_SHARE.md`). QA independently traced the fix's correctness and the E2E's
proof mechanisms (frame-delta evidence, re-share double-counting, post-screen-off freshness) and
found them sound, but recommended more than 3 consecutive runs given the last fix was found _by_ a
failure in this exact topology (5 were run — see "Automated end-to-end verification" in
`WEBRTC_SCREEN_SHARE.md`) and flagged that the renderer reconciliation fix still has zero unit-test
coverage (folded into the existing test-harness follow-up above) and that two real participants
sharing screens with each other simultaneously is validated only by the non-gating stress test (new
follow-up, recorded in `WEBRTC_SCREEN_SHARE.md`'s "Capture contention matrix").

### Next task

T5 is COMPLETE. T6 — Windows system audio sharing (see [`STATUS.md`](STATUS.md)).
