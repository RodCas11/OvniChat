# T4 — Camera streaming over existing WebRTC voice sessions

## Goal

A participant already connected to a voice channel can enable/disable camera video, published to
every other participant in the same channel over the existing P2P WebRTC connections, without
interrupting voice. Camera is a second, independent media source alongside microphone.

## Context

T3 delivered voice channels, microphone capture, and P2P WebRTC signaling, live-verified with two
real Electron instances. T4 adds camera as a second track type flowing over the same peer
connections T3 already established — it does not create a new transport, a new signaling channel,
or a new connection lifecycle.

## In scope

- `packages/rtc-core`: renegotiation support (`negotiationneeded`-driven, deterministic
  polite/impolite glare handling derived from T3's existing initiator/responder role) so a track
  can be added to or removed from an already-`'connected'` peer connection.
- `packages/media-core`: `acquireCamera()`/`Camera` — video-only capture, full stop-on-disable
  lifecycle (unlike microphone's mute-in-place), late-acquisition-race protection.
- `apps/desktop`: camera permission gating (video-only, trusted origin only), camera on/off UI,
  local preview, remote camera tiles keyed by participant id, an automated two-Electron-instance
  camera E2E smoke test.

## Out of scope

Screen/window/monitor capture, system/process/game audio, text chat, SQLite, authentication,
recording, virtual backgrounds/filters, SFU, simulcast/SVC, adaptive bitrate UI, a device-picker UI
(the capture layer accepts an optional `deviceId` constraint so this is possible later without a
redesign, but T4 does not build the picker), advanced diagnostics dashboards.

## Architecture constraints

- Camera flows through the same `MediaTransport.publishTrack`/`unpublishTrack` contract microphone
  already uses — no parallel camera-specific transport path, no `peerConnection.addTrack()` called
  from React/UI code.
- `packages/rtc-core`/`packages/media-core` stay free of Electron/React/Windows dependency.
- No new wire-protocol message types unless normal WebRTC renegotiation cannot express the
  behavior — offer/answer/ICE forwarding already exists and needs no new `type`.
- `track.kind` (`'audio'`/`'video'`) is the source discriminator for T4 — no new `TrackSource` enum
  is introduced since exactly one video source exists until T5.
- Camera capture-only test automation (fake camera device) is gated behind the same
  `!app.isPackaged` + explicit-env-var pattern T3 established; never global, never in a packaged
  build.

## Relevant packages

`packages/rtc-core`, `packages/media-core`, `apps/desktop`

## Relevant agents

`webrtc-media-engineer` for the rtc-core renegotiation/glare change and `media-core`'s camera
module; `security-reviewer` for the widened permission surface and E2E flag gating;
`qa-engineer` for regression/race coverage and camera E2E false-positive review.

## Relevant skills

`project-orientation`, `planning-feature`, `webrtc-development`, `electron-development`,
`testing-quality`, `security-review`.

## Acceptance criteria

- Camera can be enabled after voice is already connected, without leaving/rejoining the channel.
- Camera can be disabled without closing the peer connection or affecting microphone.
- A brand-new peer joining after camera was already enabled receives the camera track without any
  special-casing (already true of T3's `publishTrack` design — verified, not re-implemented).
- Every existing peer in a multi-participant channel receives a camera enabled after they joined.
- Remote camera video is rendered, associated with the correct remote participant id.
- Camera-off releases the physical device (`track.readyState === 'ended'`), unlike microphone mute.
- A `getUserMedia` call still pending when camera is disabled or voice is left does not leak the
  camera track (same class of race T3 fixed for microphone).
- Voice (join/leave/switch/mute/deafen/signaling/cleanup) is unaffected — T3's own E2E smoke must
  still pass unmodified.
- Two real Electron clients prove real decoded remote video, not just an `ontrack` firing.

## Required tests

- `rtc-core`: renegotiation triggers correctly for a track added/removed from an already-connected
  peer; glare (near-simultaneous negotiation from both sides) resolves deterministically; a newly
  created peer still receives already-published tracks; teardown/idempotency around the new
  negotiation state.
- `media-core`: camera acquisition success/failure/constraint-fallback, stop lifecycle, the
  late-acquisition-after-teardown race.
- Desktop: permission-handler tests for the widened (still narrow) media surface; any renderer-level
  state logic that's feasibly testable under this repo's existing Node-only Vitest setup.
- Automated two-Electron-instance camera E2E smoke proving real decoded remote video (track
  `readyState`, `videoWidth`/`videoHeight`, and/or RTC inbound-video stats — not `ontrack` alone),
  explicitly participant-id-scoped (remote participant id != local participant id).
- Re-run of the existing T3 voice E2E smoke, unmodified, still passing.

## Manual verification

Two real Electron instances, both in the same voice channel: enable camera on A, confirm B renders
it; disable camera on A, confirm B's tile disappears while voice/audio keeps working; re-enable;
enable camera on B too (both simultaneously active); confirm mute/deafen still work; leave cleans
up camera state. Record exact steps/result.

## Definition of Done

Meet all acceptance criteria, applicable items in
[`../DEFINITION_OF_DONE.md`](../DEFINITION_OF_DONE.md), security review, QA review, and actual
two-instance runtime verification proving real decoded remote video (not Vitest alone). Update
[`../architecture/WEBRTC_VOICE.md`](../architecture/WEBRTC_VOICE.md) (or a new
`WEBRTC_CAMERA.md` if warranted), [`../ARCHITECTURE.md`](../ARCHITECTURE.md),
[`../SECURITY.md`](../SECURITY.md), [`../HANDOFF.md`](../HANDOFF.md), and `STATUS.md`.

## Handoff notes

**Status: COMPLETE.** Camera streaming is implemented, unit/integration-tested, and live-verified —
two real Electron clients establish real decoded remote video over the existing voice
`RTCPeerConnection`s, and disabling a remote camera does not disconnect the peer or interrupt audio.

### What is real and verified

- `packages/rtc-core`: the one real gap T3 left — no renegotiation support — is fixed. `Peer` now
  implements the standard WebRTC "perfect negotiation" pattern (polite/impolite derived from T3's
  existing `role`), so `publishTrack`/`unpublishTrack` correctly renegotiate a track added to or
  removed from an already-`'connected'` peer. `publishTrack`/`unpublishTrack`/`addParticipant`'s
  fan-out logic needed **zero changes** — already correct for existing peers, new peers, and
  multiple peers, verified by inspection before any change was made. Implemented by the
  `webrtc-media-engineer` agent; unit-tested against `tests/rtc-core/fake-peer-connection.ts`
  (renegotiation triggering, glare resolution, no-double-offer-during-initial-setup, late-join
  regression coverage).
- `packages/media-core`: `acquireCamera()`/`Camera` — video-only capture, full stop-on-disable
  (`track.readyState === 'ended'`), `OverconstrainedError` fallback that deliberately preserves
  `deviceId` (a documented, deliberate deviation from microphone's own fallback, which drops
  everything — `deviceId` identifies _which_ device, not a quality trade-off). Same agent, same
  session as the rtc-core work.
- Desktop integration (permissions, `use-voice-channel.ts`, `VoiceChannelView.tsx`,
  `LocalCameraPreview.tsx`, `RemoteCamera.tsx`): microphone permission handling widened to also
  allow video-only requests (never mixed); camera state/lifecycle wired through the hook exactly
  like microphone, with the same late-acquisition-race protection T3 established, generalized via a
  monotonic generation counter (bumped on every enable/disable and on teardown).
- Full repo: 386 Vitest tests passing (up from 331 at T3's close — net new: rtc-core renegotiation
  coverage, media-core camera coverage, desktop permission-surface coverage), `pnpm
typecheck`/`pnpm lint`/`pnpm format:check`/`pnpm build`/`node scripts/verify-repository.mjs`/
  `pnpm audit --audit-level high` all clean (same one pre-existing documented `extract-zip`
  exception; T4 introduced no new advisories).

### Two real bugs found and fixed by this session's own live E2E verification

Both were invisible to every layer of testing below "two real Electron clients actually toggling a
camera at each other" — exactly the kind of bug this task's Definition of Done insists on live
verification to catch:

1. **Remote camera-off detection used the wrong event.** The first implementation listened for the
   remote track's `'ended'` event. Live testing showed it never fires: renegotiating a sender's
   track away does not end the receiver's track on real Electron 43/Chromium — it just stops
   delivering data, and `readyState` stays `'live'` forever. Fixed to use the track's `'mute'`
   event instead (the spec-correct signal for "temporarily unable to provide data"), and `'unmute'`
   to handle a later re-enable correctly, since re-enabling typically reuses the same
   transceiver/track rather than firing a fresh `ontrack`. See
   [`../architecture/WEBRTC_CAMERA.md`](../architecture/WEBRTC_CAMERA.md)'s dedicated section on
   this — it is real, non-obvious WebRTC behavior worth a permanent record, not just a bug-fix note.
2. **The E2E auto-camera-off timer never fired.** `useVoiceChannel`'s returned `actions` object was
   a fresh object literal on every render (each individual action was already a stable
   `useCallback`, but the wrapping object was not memoized). An effect with `actions` in its
   dependency array — the new auto-disable-camera timer — was cancelled and rescheduled on every
   unrelated re-render of `VoiceChannelView`, so the `setTimeout` never survived long enough to
   fire. Fixed by wrapping the returned actions object in `useMemo`. This also incidentally
   tightens the two pre-existing T3 E2E effects that already depended on `actions`, though they
   were not visibly broken by the bug (no side effect sensitive to repeated re-invocation).

Both were found by adding the camera E2E smoke test itself and debugging an initial timeout, not by
guessing — see the actual investigation sequence below.

### Live verification record

`pnpm --filter @disco-voador/desktop run e2e:camera-smoke` — **3 consecutive passes**, each with
distinct, non-repeating evidence:

| Run | Participant (remote video, WxH) | Audio RMS   | Camera-off proof             |
| --- | ------------------------------- | ----------- | ---------------------------- |
| 1   | 320x180 (both sides)            | 0.35 / 0.33 | `peerState=connected` (both) |
| 2   | 320x180 (both sides)            | 0.37 / 0.35 | `peerState=connected` (both) |
| 3   | 320x180 (both sides)            | 0.33 / 0.11 | `peerState=connected` (both) |

`pnpm --filter @disco-voador/desktop run e2e:voice-smoke` (T3's own smoke, unmodified) — re-run
**twice** during this task, both passing, confirming no voice regression from the renegotiation
change or the camera additions.

**What this does not include:** a literal human sitting at a keyboard operating the camera button
and looking at the video — no human tester was available in this session, matching T3's own
recorded limitation. The automated evidence (real `RTCPeerConnection`s across two independent OS
processes, real SDP renegotiation, real decoded non-silent audio, real decoded video frames sampled
from an actual `<video>` element, explicit participant-id-scoped assertions) satisfies
`docs/DEFINITION_OF_DONE.md`'s WebRTC/media bar ("a two-client scenario validates actual tracks, not
only signaling mocks") at least as rigorously as T3's own already-accepted live verification did.

### Security and QA review

Both run before this handoff, scoped to the T4-specific surface (widened permission handling, new
E2E-only flags, the renegotiation change, camera lifecycle).

**QA finding, fixed — concurrent `enableCamera()` invocation:** `enableCamera()`'s guard
(`cameraRef.current`) is only set _after_ `acquireCamera()` resolves, so nothing prevented a second
concurrent invocation (e.g. a fast double-click; the Camera button had no `disabled`-during-
acquisition state) from starting a second `getUserMedia` call while the first was still in flight.
The existing generation counter already prevented a device/track _leak_ from this (the losing
generation's camera is stopped once it resolves), but not two concurrent physical-device-open
attempts, which many real webcams don't support — if the _stale_ attempt happened to be the one
that succeeded, the user could see a spurious error after one intended click. Fixed with a
synchronous `cameraAcquiringRef` guard (set for the duration of the whole `acquireCamera()` call,
survives an intervening `disableCamera()`) plus a `cameraAcquiring` state field the Camera button
now uses to disable itself during acquisition, matching the existing `joining`-disables-Join-button
pattern. Verified: full repo `pnpm check` still clean; camera E2E smoke re-run and still passing
(4th consecutive pass) after this fix.

**Security finding, accepted as a documented follow-up, not fixed — renegotiation offer
atomicity:** `Peer.createAndSendOffer()`'s `createOffer()` → `setLocalDescription(offer)` is two
separate awaited steps rather than the atomic parameterless `setLocalDescription()` MDN's reference
"perfect negotiation" pattern uses; a description computed by the first step could theoretically be
stale by the time the second step applies it if a remote offer collision resolves entirely in
between. Plausible worst-case impact per the reviewer: a stalled or duplicated renegotiation round
for one peer pair — not a crash, data exposure, or permission bypass. Not fixed in this session:
the correct fix (switching to the parameterless `setLocalDescription()` call and reading back
`localDescription` for what was actually applied) requires reworking
`tests/rtc-core/fake-peer-connection.ts`'s simulation model, since the existing glare/collision
test suite deliberately controls `createOffer()`'s timing via a separate, injectable step — doing
that safely needs the same care the original renegotiation implementation received, not a rushed
patch late in this task. Tracked as a known limitation (see below) for a focused follow-up. 4
consecutive live two-instance camera E2E runs did not surface this race in practice.

Both reviews' remaining findings were either already-correct-by-design (verified, not fixed) or
cosmetic/informational (see the full agent reports for detail); no other unaddressed findings
remained at completion.

### Known limitations

- **Renegotiation offer atomicity** (see above) — a narrow, unreproduced-in-practice theoretical
  race in `Peer.createAndSendOffer()`. Follow-up: switch to the parameterless
  `pc.setLocalDescription()` call and rework `tests/rtc-core/fake-peer-connection.ts` to support it
  without breaking the existing glare/collision test suite's timing control.
- No device-picker UI (architecture supports it; not built — see Out of scope above).
- No TURN credential minting (pre-existing T3 gap, unaffected by camera).
- No literal human operator test in this session (no tester available) — the automated evidence is
  believed at least as rigorous as T3's own already-accepted live verification; see "What this does
  not include" above.
