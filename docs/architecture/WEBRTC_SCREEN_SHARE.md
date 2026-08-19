# Screen sharing (T5)

Canonical contracts live in code at [`packages/media-core/src/screen.ts`](../../packages/media-core/src/screen.ts),
[`packages/rtc-core/src/peer.ts`](../../packages/rtc-core/src/peer.ts),
[`apps/desktop/src/main/screen-share.ts`](../../apps/desktop/src/main/screen-share.ts), and
[`apps/desktop/src/renderer/voice/`](../../apps/desktop/src/renderer/voice/); this document explains
the design and is not itself authoritative. See [`WEBRTC_VOICE.md`](WEBRTC_VOICE.md) for the T3
voice/signaling foundation and [`WEBRTC_CAMERA.md`](WEBRTC_CAMERA.md) for T4's camera work this
builds on, and [`../tasks/T5_SCREEN_SHARE.md`](../tasks/T5_SCREEN_SHARE.md) for the task record
including its verification status.

## Scope

Screen/window sharing is a third, independent media source published over the same P2P WebRTC
connections T3/T4 already established — no new transport, no new signaling channel, no new
peer-connection lifecycle.

```text
Participant
│
├── microphone
│     └── audio track   (T3)
│
├── camera
│     └── video track   (T4)
│
└── screen share
      └── video track   (T5)
```

System/game audio, text chat, SQLite, authentication, recording, remote control, annotation,
whiteboard, OBS integration, SFU, simulcast/SVC, and adaptive bitrate control all remain out of
scope — see [`../tasks/T5_SCREEN_SHARE.md`](../tasks/T5_SCREEN_SHARE.md)'s "Out of scope" section.

## Renegotiation offer atomicity (T5 prerequisite fix)

Before any of the rest of this document's design could safely depend on renegotiation, a T4
security-review finding had to be fixed: `Peer.createAndSendOffer()` used to call `createOffer()`
then `setLocalDescription(offer)` as two separate awaited steps, with a gap in which a remote
collision could land and cause a stale offer to be applied.

Fixed by switching to the atomic parameterless `setLocalDescription()`, which the WebRTC
specification defines as a single indivisible operation (it creates and applies an offer — or
answer, depending on `signalingState` — as one step, with no application-observable midpoint). The
actually-applied SDP is read back from `localDescription` afterward, rather than from a value
captured before applying it. See `Peer.createAndSendOffer()`'s doc comment in `peer.ts` for the
full explanation, and `tests/rtc-core/peer.test.ts`'s "the polite side handles a colliding remote
offer while its own offer synthesis is still pending" test for the regression coverage proving the
race class this closes — it reproduces the exact scenario the security review described (a polite
side mid-offer for its own renegotiation, with a colliding remote offer arriving before the local
offer settles) and asserts the pair converges correctly rather than corrupting state.

## Media source identity — the central T5 design problem

Once both camera and screen-video exist, `track.kind === 'video'` no longer identifies what a
video track actually shows. The task explicitly forbids inferring source from track-arrival order
("first video = camera" is race-prone) and forbids defaulting when unknown.

### The design that was tried and rejected: `MediaStreamTrack.id`

The first design correlated a locally-published track to its semantic source by broadcasting
`{trackId: track.id, source}` to the whole channel, keyed by the track's own `MediaStreamTrack.id`
(reasoning: per RFC 8830, a track's `msid` should preserve its id end-to-end over the wire).

**Live two-instance testing found this does not hold** on this application's actual Electron/
Chromium build when a track is added via `pc.addTrack(track)` with no explicit associated
`MediaStream` (which is how this package publishes every track — see `Peer.addTrack`). Diagnostic
instrumentation captured the exact mismatch: the sender's own local `track.id` and the SDP `msid`
line it offered both agreed with each other, but the _receiver's_ `RTCTrackEvent.track.id` for that
same track was a different, unrelated value — for both audio and video tracks, in both negotiation
directions. This is a genuine platform behavior on this build, not a mistake in the offer/answer
code (unit tests already thoroughly cover offer/answer sequencing and cannot catch this class of
finding, since they do not exercise real SDP/track machinery — this is exactly the category of bug
T3/T4 already established only a real two-instance run can surface).

### The design that was adopted: `mid`

`RTCRtpTransceiver.mid` — the SDP media identification (`a=mid:`) — was live-verified to survive
correctly on both ends, in both directions, across every test run. This is the standards-correct
correlation mechanism the WebRTC specification actually provides for this purpose.

Two consequences of using `mid` instead of `track.id`:

- **`mid` is scoped to one peer connection, not global.** In a P2P mesh, the same local track gets
  negotiated independently on every peer connection and can end up with a different `mid` on each
  one. A single "broadcast this track's source to the whole channel" design (the original plan,
  matching `trackId`'s broadcast shape) is therefore _wrong_ for `mid` — there is no single correct
  value to broadcast. `media:track-source` (`packages/protocol/src/messages/media.ts`) is instead
  **targeted per peer** (`targetParticipantId`/`sourceParticipantId`), structurally identical to
  `webrtc:offer`/`answer`/`ice-candidate` — see `midSchema`'s doc comment.
- **The sender only learns a track's `mid` once negotiation for that specific peer connection has
  actually assigned one** — not at publish time. `packages/rtc-core` exposes this as a new
  `MediaTransport` event, `localTrackMid: {participantId, track, mid}`, fired by `Peer` from a new
  `reportLocalTrackMids()` step at the end of every successful `createAndSendOffer()` (the offerer
  decides `mid` values when constructing an offer; they become authoritative as soon as
  `setLocalDescription()` succeeds, before the remote side even answers — see `Peer`'s
  `reportLocalTrackMids` doc comment). `use-voice-channel.ts`'s `onLocalTrackMid` handler checks
  whether the reported track is the currently-tracked camera or screen track and, if so, calls
  `RealtimeClient.announceTrackSource(participantId, mid, source)` — one message per peer, sent
  automatically whenever `rtc-core` reports a fresh `mid`, including for a peer that joins _after_
  the track was already published (their own `addParticipant`-seeded negotiation naturally produces
  their own `localTrackMid` event — no separate re-announce mechanism is needed, unlike the earlier
  broadcast design, which needed one specifically because a broadcast sent once at publish time
  could never reach a not-yet-present member).

### Reconciliation on the receiving side

`media:track-source` (learned via `mid`) and `ontrack` (the transport's `remoteTrack` event, itself
carrying `event.mid` read from `RTCTrackEvent.transceiver.mid`) arrive independently and in no
guaranteed order. `use-voice-channel.ts` buffers whichever arrives first, keyed by
`` `${participantId}:${mid}` `` (compound, since `mid` alone is only unique within one peer
connection), and reconciles once both sides are known — see the `pendingRemoteVideoTrackByKey` map
and `wireRemoteVideoTrack`. Neither side is ever inferred or defaulted; if an announcement never
arrives, a diagnostic is logged after 5 seconds instead of the track silently rendering nowhere with
no explanation, but no source is guessed.

Camera is announced through the exact same mechanism as screen — leaving it unannounced and letting
"no announcement" implicitly mean "camera" would itself be a form of the absence-based inference the
whole design set out to avoid.

#### A second real bug this design had to account for: `mid` reuse across _different_ sources

A QA review found that a `mid` is not only stable — it can be **reused for a different track**.
`RTCRtpTransceiver`/`addTrack` reuse (already relied on for the same-source camera-off/camera-on
case, see `wireRemoteVideoTrack`'s doc comment) is not restricted to reusing a transceiver for the
_same_ semantic source: unpublishing one video-shaped track and publishing a different one (e.g.
camera off, then screen share on) can land on the same freed transceiver and its already-negotiated
`mid`. Confirmed reachable through real product code, not just theorized: a dedicated
`tests/rtc-core/p2p-mesh-transport.test.ts` regression test drives exactly this sequence
(publish camera → unpublish camera → publish screen, each through real renegotiation) and asserts
the reported `mid` for the new (screen) track is the same as the freed camera track's `mid`.

When this happens, the platform does **not** fire a fresh `ontrack` for the reused transceiver —
only `'unmute'` on the pre-existing remote track object. The first version of
`wireRemoteVideoTrack` captured the track's source in a closure once, at first reconciliation, so a
later `'unmute'` on a mid-reused track would misroute the new content into the _previous_ source's
map. Fixed by making the source lookup dynamic: `sourceByKey` holds the _current_ known source per
key, updated on every `media:track-source` message (not just the first), and `wireRemoteVideoTrack`'s
mute/unmute/ended handlers read it at event-fire time rather than closing over a fixed value.
`onMediaTrackSource` additionally moves an already-wired stream to its new map immediately when a
later announcement changes an already-known key's source, rather than only self-correcting on that
track's next mute/unmute — closing the timing gap between the announcement and that event. See
`moveRemoteVideoStream`/`wiredEventByKey` in `use-voice-channel.ts`.

## SDP size bound (a real, live-found T5 finding)

`packages/protocol`'s `SDP_MAX_LENGTH` was `8192` (8 KiB), sized when this project's only SDPs ever
carried microphone, or microphone+camera (at most 2 m-lines). Live two-instance testing with all
three sources negotiated at once measured a real offer's SDP at **10,859 characters** (3 m-lines,
each video m-line carrying Chromium's full modern codec/RTX/extension set) — genuinely rejected by
the old bound as `INVALID_MESSAGE`, which in turn silently broke that connection's further
signaling (observed as a cascading "audio also went silent" symptom, since the closed/errored
signaling channel could no longer carry anything). Raised to `24576` with real headroom (see that
file's doc comment for the exact reasoning), together with `services/realtime`'s
`REALTIME_MAX_MESSAGE_BYTES` transport-level default (`16 KiB` → `32 KiB`, kept above the SDP bound
with margin for JSON envelope overhead and `\r\n` → `\\r\\n` escaping, not sized identically to it).

## Screen capture (`packages/media-core/src/screen.ts`)

`acquireScreen(constraints?)` calls `navigator.mediaDevices.getDisplayMedia({ video, audio: false })`
— the standard Web API for screen capture, distinct from `getUserMedia()`. `audio: false` is
unconditional; system/game audio is out of scope until a future task and this function must never
be the accidental source of unexpected audio. Unlike `acquireCamera`, there is no `deviceId`-
equivalent parameter — source selection is not a capture-layer concern at all (see the IPC section
below); this function only supplies quality constraints and returns whatever stream Electron's
Main-process handler resolves the call with.

Named quality presets (`SCREEN_QUALITY_PRESETS`): `standard` (1280×720@30), `high` (1920×1080@30,
the default), `smooth` (1920×1080@60), `smooth720` (1280×720@60) — all `ideal`, not `exact`,
constraints, matching camera/microphone's existing rationale. `track.contentHint = 'detail'` is set
on the acquired track, the platform-recommended hint for screen/desktop content (sharp edges,
consistent color) as opposed to camera's implicit `'motion'`-appropriate default.

Like `Camera`, not `Microphone`: `stop()` always fully releases capture — there is no screen-share
"mute," only acquire/stop, mirroring T4's camera-off product decision.

Errors are classified into a closed `ScreenErrorReason` set
(`'permission-denied' | 'no-source-available' | 'capture-failed' | 'unknown'`) distinct from
camera's — `getDisplayMedia()` has a materially different exception surface (see
`screen-errors.ts`'s doc comment, sourced against the Screen Capture specification, MDN, and
Electron's own `setDisplayMediaRequestHandler` test suite).

## Electron Main: source enumeration and the `getDisplayMedia()` fulfillment boundary

`apps/desktop/src/main/screen-share.ts` is the only place a native `DesktopCapturerSource` or
`NativeImage` ever exists:

- `listScreenShareSources()` calls `desktopCapturer.getSources({ types: ['screen','window'],
thumbnailSize: 320×180, fetchWindowIcons: true })`, caches the native result, and returns only
  sanitized plain data (`DesktopScreenSource` — id, name, `'screen'|'window'`, thumbnail/app-icon
  as bounded `data:` URLs, display id) to the Renderer.
- `selectScreenShareSource(sourceId)` arms a **single-use** pending selection, only for an id
  present in the _most recent_ enumeration from this same trusted sender. Returns `false` (never
  throws) for an unknown/stale/invalid id. A second, distinct enumeration invalidates every id from
  the previous one, even if never selected.
- `installScreenShareHandlers()` installs `session.setDisplayMediaRequestHandler()` — the real
  security decision point. It fires for _every_ `getDisplayMedia()` call, consumes (clears) the
  pending selection synchronously as the first thing it does (so a second concurrent call can never
  observe or reuse it), re-resolves the id against Main's own cached native source list (never
  reconstructing a `DesktopCapturerSource`-shaped object from the sanitized IPC data the Renderer
  holds), checks the request's origin, and denies (resolves with no source) unless everything
  matches. `audio` is never passed to the callback — screen-video only.

Both new IPC channels (`app:list-screen-share-sources`, `app:select-screen-share-source`) go
through the existing `assertTrustedSender` sender/origin-validation pattern
(`apps/desktop/src/main/ipc.ts`), exactly like every other channel. The Preload bridge
(`apps/desktop/src/preload/index.ts`) exposes only these two narrow, typed functions — never
`desktopCapturer`, `ipcRenderer`, `NativeImage`, or a raw `DesktopCapturerSource`.

### A researched, documented residual finding (not a T5 bug, flagged for follow-up)

`apps/desktop/src/main/permissions.ts`'s `isDisplayCaptureRequest` documents a real, researched
finding: Electron's `'media'` permission-request handler receives an _empty_ `mediaTypes` array
both for a genuine `getDisplayMedia()` call and for the legacy, undocumented
`getUserMedia({ video: { mandatory: { chromeMediaSource: 'screen' } } })` constraint form, which
does **not** route through `setDisplayMediaRequestHandler` at all and (per Electron/Chromium's own
C++ implementation) defaults to capturing the entire primary screen with no further app-level
check if granted. Granting empty-`mediaTypes` requests (required for real `getDisplayMedia()` to
work) therefore also re-enables that legacy path for a Renderer that already has arbitrary script
execution — a scenario this app is defended in depth against (`sandbox: true`, `contextIsolation:
true`, a `script-src 'self'` CSP, no Node/filesystem exposure through Preload), but not something
this permission layer alone can distinguish. See that file's doc comment for the full research
trail; flagged for `security-reviewer` follow-up.

## RTC integration: publish/unpublish, no parallel path

Screen-video flows through exactly the same `MediaTransport.publishTrack`/`unpublishTrack` contract
microphone and camera already use — no screen-specific transport path, no UI/hook code calling
`peerConnection.addTrack()` directly. Verified with **zero `rtc-core` changes** beyond the
negotiation-atomicity fix and the `mid`-reporting addition (both prerequisites, not screen-specific
redesigns): a dedicated regression test
(`tests/rtc-core/p2p-mesh-transport.test.ts`, "a participant publishing mic + camera + a second
independent video track (screen)...") proves three simultaneous tracks (one audio, two video) reach
both an already-connected peer and a newly-added peer, and that unpublishing just one video track
leaves the other two untouched. A second regression test proves repeated publish/unpublish/publish
cycles on the same track do not accumulate stale sender bookkeeping (T5's "repeated ON/OFF/ON/OFF/
ON" requirement).

## Renderer: state, lifecycle, and UI

`use-voice-channel.ts`'s `screenSharingState: 'idle' | 'starting' | 'sharing' | 'error'` is an
explicit multi-state value, not a boolean — there is deliberately no separate transitional
"stopping" state, since `disableScreenShare()`'s own work (`unpublishTrack` + `screen.stop()`) is
synchronous from this hook's point of view, exactly like `disableCamera()`'s already-proven pattern;
a "stopping" state would have no observable duration to occupy.

`enableScreenShare(quality)`/`disableScreenShare()` mirror `enableCamera`/`disableCamera` exactly,
including the same late-acquisition-race protection (a monotonic generation counter, bumped on
every enable/disable/teardown; a `getDisplayMedia()` that resolves after the user already moved on
stops the device immediately instead of leaking it or publishing a track nobody wants) and the same
double-click/concurrent-acquisition protection (`screenAcquiringRef`) T4's QA review found necessary
for camera. `enableScreenShare` does not itself select a source — it assumes
`desktopApp.selectScreenShareSource(id)` was already called (by `ScreenSourcePicker`'s
`onSourceSelected`, or by the E2E auto-share flow using the exact same production IPC) immediately
before.

Native/external capture end (the OS "Stop sharing" control, or the captured window closing) is
handled via the screen track's own `'ended'` event, mirroring camera's device-unplugged handling: it
fully unpublishes and resets local state without requiring `disableScreenShare()` to have been
called explicitly.

Remote screen shares render via `RemoteScreen.tsx`, a deliberately separate component from
`RemoteCamera.tsx` (not a shared component behind a `source` prop) — larger, with `object-fit:
contain` to preserve aspect ratio without stretching or unwanted cropping, in their own section of
`VoiceChannelView.tsx`, never mixed into the camera tile grid even though both are
`track.kind === 'video'`. `ScreenSourcePicker.tsx` is a self-contained picker (screens/windows tabs,
thumbnails, quality selector, Cancel/Share) that never auto-selects a source and never calls
`selectScreenShareSource` speculatively — the IPC selection call only happens inside the Share
button's handler, so Cancel has no side effect on an already-active voice/camera session by
construction.

## No SFU: P2P mesh, documented not hidden

Screen-video is currently P2P mesh like every other T3–T5 source: the publisher's local screen
capture is uploaded separately to each peer. The `MediaTransport` abstraction stays SFU-ready (no
peer-count assumptions leak into the UI or into `rtc-core`'s public surface); a future SFU-backed
transport could implement the same contract without changing any caller.

## Automated end-to-end verification

`apps/desktop/scripts/e2e-screen-smoke.mjs`'s primary scenario (default, no flag) is **one
publisher + one pure viewer**, not two simultaneous local capturers:

- The **publisher** auto-joins, auto-enables camera, then auto-shares its own screen (real
  `desktopCapturer` capture through the exact same production
  `listScreenShareSources`/`selectScreenShareSource` IPC a real picker uses), auto-stops, then
  auto-re-shares — proving a full share → stop → re-share lifecycle on the sending side.
- The **viewer** auto-joins only and never captures anything of its own. It proves it received and
  decoded the publisher's camera **and** screen-video (on deliberately separate marker families —
  `E2E_REMOTE_VIDEO_OK`/`_SILENT` for camera, `e2e-screen-probe.ts`'s
  `E2E_REMOTE_SCREEN_OK`/`_SILENT` for screen, never sharing a `markerPrefix` — proving the two are
  never confused with each other, not merely that "a second video track" exists), that the
  publisher's screen stopping did not disconnect the peer or disrupt voice/camera (proven with
  _fresh_ evidence taken specifically after the stop —
  `E2E_AUDIO_LEVEL_POST_SCREEN_OK`/`E2E_REMOTE_VIDEO_POST_SCREEN_OK`, not a reused earlier proof),
  and that the re-share produced real decoded frames again (`E2E_REMOTE_SCREEN_OK` is required to
  fire a **second** time — the re-share proof, guarding against stale mid/transceiver/sender state
  left over from the first cycle).

Both directions of proof use frame-**delta** evidence, not a one-shot check:
`HTMLVideoElement.requestVideoFrameCallback`'s `presentedFrames` counter must advance by at least 2
while `track.readyState` stays `'live'` — a frozen/stalled `<video>` element still reports its last
decoded frame's dimensions forever, so a one-shot `videoWidth > 0` check (the original bar) cannot
distinguish "decoding" from "decoded once, then stalled."

The original symmetric scenario (both instances performing real screen capture simultaneously) is
preserved as an explicit, non-gating stress test (`--dual-capture`) — see "Capture contention
matrix" below for why it is not the primary scenario.

### Status: COMPLETE — 3 consecutive clean runs, three real root causes found and fixed

A follow-up stabilization pass found and fixed three distinct, real defects that were producing the
flakiness originally reported here (this section previously described that flakiness as
unresolved, attributed to a DXGI-capture-contention hypothesis — that hypothesis is **not** what
was actually causing the primary scenario's flakiness; see the contention matrix below for what it
_does_ explain):

1. **`backgroundThrottling` was not disabled on the `BrowserWindow`.** Chromium throttles
   `requestVideoFrameCallback`/timer scheduling for a window that is not the OS-focused window —
   normal, correct behavior for an ordinary background tab, but wrong for an active real-time call,
   where remote video must keep decoding at full rate regardless of OS focus. Running two Electron
   instances side by side, whichever instance did not currently have OS focus could miss the
   frame-delta probe's window entirely even though frames were genuinely still arriving. Fixed by
   setting `backgroundThrottling: false` in `apps/desktop/src/main/window-options.ts` (all windows,
   not just E2E — this is a real call-quality fix, not a test-only workaround; see
   `tests/desktop/window-options.test.ts`'s regression test).
2. **A fast-finishing E2E instance disconnected before the slower instance could finish its own
   proof.** Each instance exited ~250ms after satisfying its own local success criteria. Since
   several of this scenario's proofs are asymmetric (the viewer's post-screen-off continuity proof
   depends on the publisher's connection staying alive a little longer), a publisher that finished
   its own phases quickly could close its WebSocket before the viewer had time to complete its
   proof — which the realtime server correctly reports to the still-running side as a genuine
   `voice:participant-left`, surfacing as a misleading `peerState=unknown` on a connection that was
   never actually unhealthy. Fixed by raising the post-success exit delay from 250ms to 5000ms in
   `apps/desktop/src/main/index.ts`'s `armE2ECameraSmokeExit`/`armE2EScreenSmokePublisherExit`.
3. **A real product bug in remote-stream reconciliation** (found via this same investigation, not
   previously known): `use-voice-channel.ts`'s `moveRemoteVideoStream` unconditionally deleted a
   participant's entry from the _other_ video-source map (camera vs. screen) as a side effect of
   wiring _any_ video key — correct for the mid-reuse-reclassification case it was designed for
   (see the previous section), but also incorrectly triggered on a video key's **first-ever wire**.
   The moment a screen-share transceiver's first track was wired in for a participant who already
   had a live camera stream, this unconditionally deleted that live camera entry — a real, previously
   undiscovered bug: any user enabling screen share while their camera was on would cause the
   _remote_ viewer to silently lose that camera video. Fixed by splitting the function into
   `setRemoteVideoStream` (touches only its own map — used for a key's initial wire and for an
   `'unmute'` re-add) and `reclassifyRemoteVideoStream` (touches exactly the previous and new maps
   for one specific key — used only by `onMediaTrackSource`'s genuine same-mid reclassification).
   See "Media source identity" above for the two functions' full rationale.

Additionally, `packages/rtc-core/src/peer.ts`'s `onnegotiationneeded` handler gained a re-entrancy
guard (`|| this.makingOffer` added to the early-return condition) — a second `negotiationneeded`
firing while this side's own offer is still in flight is now dropped rather than starting a second,
overlapping `setLocalDescription()` call; per the WebRTC "update the negotiation-needed flag"
algorithm, nothing is lost, since the flag stays set and the event re-fires once signaling returns
to `stable` if changes are still pending. See `tests/rtc-core/peer.test.ts`'s "a second
negotiationneeded firing while an offer is already in flight does not start a second overlapping
offer" regression test. This was investigated as a plausible contributor and is a correct,
defensive fix in its own right, but was not the actual cause of the observed flakiness (the three
items above were).

With all three fixes applied, `e2e:screen-smoke` (primary scenario) passed **5 consecutive clean
runs**, `e2e:camera-smoke` passed 4 consecutive runs, and `e2e:voice-smoke` passed — all against the
same final code, all with `pnpm check` green. (The independent QA review of this stabilization pass
noted that 3 consecutive passes starting immediately after the last fix, with no visibility into how
many attempts preceded that fix, is weaker evidence than 3 consecutive passes with headroom; 5 was
run for that reason.)

### Capture contention matrix

The original DXGI-capture-contention hypothesis was tested directly by running
`e2e-screen-smoke.mjs --dual-capture` (both instances performing real simultaneous screen capture)
multiple times after all three fixes above:

| Scenario                                                                                  | Runs | Result                                                                                                                                              |
| ----------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| B: one publisher captures, one pure viewer (primary)                                      | 3    | 3/3 clean                                                                                                                                           |
| C: both instances capture their own screen simultaneously (`--dual-capture`, stress-only) | 3    | 1 failure (`E2E_AUDIO_LEVEL_SILENT`/`E2E_AUDIO_LEVEL_POST_SCREEN_SILENT` on both sides, with video/screen frames still decoding correctly), 2 clean |

This confirms the original hypothesis was directionally right about _where_ contention shows up
(two simultaneous real captures on one machine), but the failure mode measured is audio starvation
under load, not the video/frame-delivery timing that was actually causing the _primary_ scenario's
flakiness (that was root-caused to the three fixes above, none of which are about capture
contention). These `--dual-capture` runs were taken with the `backgroundThrottling: false` fix
already applied — an independent QA review of this stabilization pass pointed out that the
_original_, pre-stabilization dual-capture flakiness record (which attributed the failures purely to
DXGI contention) was measured before that fix existed, and in a two-Electron-instance-on-one-machine
run only one instance is ever OS-focused at a time — so every earlier dual-capture run was also
subject to the very throttling penalty item 1 above fixed, a confound never isolated from the DXGI-
contention hypothesis at the time. This matrix's numbers are the first measurement taken with that
confound already removed, and still show real (if less severe, and differently-shaped — audio
rather than video) degradation under two simultaneous real captures. Scenario C remains a non-gating
stress test, not part of T5's completion bar — it exists to characterize dual-capture behavior, and
two real users in production each have their own separate machine, so this specific contention mode
does not occur between them.

**Documented gap, not yet covered by any gating test**: two _real_ participants each sharing their
own screen with the other **at the same time** (both directions of screen-video flowing
concurrently between two live participants, each also receiving the other's) is exercised only by
this non-gating stress test — the gating suite's one-publisher/one-viewer topology by construction
only ever has screen-video flowing in one direction at a time. The product itself is not restricted
to one sharer (see `docs/tasks/T5_SCREEN_SHARE.md`'s "In scope"), so this is a real, accepted
narrowing of _test_ coverage, not a product limitation — flagged by QA review, recorded here rather
than left implicit.

## Security and QA review outcomes

Both reviews found T5's own new surface sound overall, with no release-blocking defects, but each
found one real, actionable issue — both were fixed in this task, not merely noted:

- **Security (fixed)**: granting the `getDisplayMedia()`-shaped empty-`mediaTypes` permission
  request (necessary for real screen sharing to work at all) also incidentally re-enabled a legacy,
  undocumented `getUserMedia({ video: { mandatory: { chromeMediaSource: 'screen' } } })` constraint
  form that bypasses `screen-share.ts`'s entire source-selection/consent flow, defaulting to the
  primary screen with no further check (already documented as a residual risk before review, since
  exploiting it requires a pre-existing XSS). The review's suggested mitigation was implemented:
  `permissions.ts`'s request handler now also requires `screen-share.ts`'s
  `hasPendingScreenShareSelection()` (a read-only check, never itself consuming the pending
  selection) before granting — this app's own sanctioned flow always arms a selection immediately
  before calling `getDisplayMedia()`, so the legitimate path is unaffected, while the legacy bypass
  (which never arms one) is now denied outside a narrow race window. Not a full close (Electron does
  not expose a way to disable the legacy constraint independently), but a meaningful, low-cost
  narrowing.
- **QA (fixed)**: `mid` reuse is not limited to the same semantic source (see "A second real bug
  this design had to account for" above) — a mid freed by unpublishing one video-shaped track and
  reused by publishing a _different_ one could misroute the new track's content into the old
  source's remote-stream map, because `wireRemoteVideoTrack`'s mute/unmute handlers originally
  captured the source once in a closure rather than looking it up dynamically. Fixed; see that
  section for the mechanism and the regression test that proves the underlying platform behavior is
  real and reachable through actual product code.

Both reviews also identified open, non-blocking follow-ups, recorded honestly rather than treated
as resolved:

- **No renderer-level test harness exists for `use-voice-channel.ts`** (a pre-existing gap from T4
  — camera's own `enableCamera`/`disableCamera`/generation-counter/double-click-guard logic has the
  same gap, not something T5 introduced) — this repository has no React testing library installed.
  T5's mid-reconciliation logic (the piece both the original QA-found bug and the stabilization
  pass's `moveRemoteVideoStream` bug lived in) is exactly the kind of logic such a harness would
  directly protect; its correctness currently rests entirely on the live two-instance E2E smoke
  test rather than a fast, deterministic unit test — and that E2E does not even exercise the
  hardest case (`reclassifyRemoteVideoStream`'s cross-source mid-reuse path never fires live, since
  the primary scenario's camera stays on for the whole run; only the isolated
  `p2p-mesh-transport.test.ts` rtc-core test proves cross-source mid reuse is reachable at all, and
  it does not assert anything about the renderer's own reconciliation). A follow-up QA review of
  this stabilization pass noted these functions do **not** strictly require installing a React
  testing library to cover — `setRemoteVideoStream`/`reclassifyRemoteVideoStream`/
  `wireRemoteVideoTrack` are plain functions closed over local state, not JSX — so a minimal,
  targeted unit test extracting/exercising just the reconciliation state machine is a smaller lift
  than a full hook-testing harness. Recommended as the single highest-value next gate before further
  screen-share (or camera) renderer-hook changes; deliberately not attempted in this stabilization
  pass to avoid open-ended scope growth once the live E2E evidence (5 consecutive clean runs) was
  in hand.
- The re-entrancy question below was resolved during the stabilization pass (see "Automated
  end-to-end verification" above): `Peer.createAndSendOffer()`'s `onnegotiationneeded` handler now
  guards against a second self-triggered offer starting while one is already in flight, with a
  dedicated regression test. It was investigated as a plausible contributor to the E2E flakiness
  and is a correct, defensive fix in its own right, but was not the actual root cause.
- **`backgroundThrottling: false`** (added during the stabilization pass to fix real
  video-decode-starvation on an unfocused window during a call) applies to all windows, not only
  E2E runs — a real user's build now keeps Renderer timers/media pipelines running at full rate
  while backgrounded/minimized, a legitimate but real background-CPU/battery cost, and removes one
  incidental resource-throttling limit an attacker's script would be subject to in the event of an
  unrelated Renderer-compromise vector. Recorded as an accepted trade-off, not a release blocker.

## Future: screen/system audio boundary

Not built in T5. When added, it must remain a _fourth_ independent source (its own
`getDisplayMedia({audio:true})`-style or WASAPI-loopback-style acquisition, its own publish/
announce cycle) — never silently folded into the existing screen-video track's constraints, and
never conflated with microphone audio.
