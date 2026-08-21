# Screen/system audio (T6)

Canonical contracts live in code at
[`packages/media-core/src/screen.ts`](../../packages/media-core/src/screen.ts),
[`apps/desktop/src/main/screen-share.ts`](../../apps/desktop/src/main/screen-share.ts), and
[`apps/desktop/src/renderer/voice/`](../../apps/desktop/src/renderer/voice/); this document explains
the design and is not itself authoritative. See [`WEBRTC_SCREEN_SHARE.md`](WEBRTC_SCREEN_SHARE.md)
for the T5 screen-video foundation this builds on directly, and
[`../tasks/T6_SCREEN_AUDIO.md`](../tasks/T6_SCREEN_AUDIO.md) for the task record.

## Scope

Screen/system audio is a fourth, independent media source published over the same P2P WebRTC
connections T3–T5 already established:

```text
Participant
│
├── microphone     (T3)
├── camera         (T4)
├── screen-video    (T5)
└── screen-audio    (T6)
```

Optional, per-share, never silent: a user explicitly checks "Share audio" for a specific screen
share; nothing shares system audio by default. Process/game-specific audio (Windows native
process-loopback), text chat, accounts, and every other T6-out-of-scope item are listed in
[`../tasks/T6_SCREEN_AUDIO.md`](../tasks/T6_SCREEN_AUDIO.md)'s "Out of scope" section.

## Platform finding: Electron's real Windows system-audio-loopback mechanism

T6 needed to determine the actual, current Electron 43 mechanism for system-audio capture on
Windows before implementing anything — not copy an old example using the deprecated
`chromeMediaSource`/`chromeMediaSourceId` constraint form T5 already researched and defended
against (see `WEBRTC_SCREEN_SHARE.md`'s "A researched, documented residual finding").

Confirmed directly against this app's pinned Electron version's own type definitions
(`node_modules/electron/electron.d.ts`, Electron 43.4.0):

```ts
interface Streams {
  video?: Video | WebFrameMain;
  /**
   * If a string is specified, can be `loopback` or `loopbackWithMute`. Specifying a
   * loopback device will capture system audio, and is currently only supported on
   * Windows. If a WebFrameMain is specified, will capture audio from that frame.
   */
  audio?: ('loopback' | 'loopbackWithMute') | WebFrameMain;
  enableLocalEcho?: boolean;
}

interface DisplayMediaRequestHandlerHandlerRequest {
  frame: WebFrameMain | null;
  securityOrigin: string;
  videoRequested: boolean;
  audioRequested: boolean;
  userGesture: boolean;
}
```

This is exactly the mechanism T6 uses: the Renderer's `getDisplayMedia({ video, audio: shareAudio })`
call reaches Main's existing `session.setDisplayMediaRequestHandler` (the same handler T5 already
installs for video source selection); when granting, the callback's `Streams.audio` field is set to
`'loopback'` — real WASAPI loopback capture of the system's default audio output — never the legacy
`chromeMediaSource` constraint form, and never a fake/injected source. `WASAPI` loopback capture
(`IAudioClient` with `AUDCLNT_STREAMFLAGS_LOOPBACK`) has existed since Windows Vista, so unlike
process-loopback audio (`docs/references/WINDOWS_MEDIA.md`'s later stage, requiring Windows build
20348+), this path needs no runtime capability detection beyond `process.platform === 'win32'` —
this app's whole target is Windows 10/11 x64 anyway.

**`'loopback'` chosen over `'loopbackWithMute'`, deliberately**: Electron's own documentation does
not clearly specify what `'loopbackWithMute'` mutes (community discussion confirms this ambiguity —
developers have asked "what does loopbackWithMute mute exactly?" with no definitive public answer).
The safe, conservative choice — and the one consistent with never changing the sharer's own local
audio experience as a side effect of sharing it, since nothing in this task's requirements calls for
that — is plain `'loopback'`: it captures and forwards system audio without muting anything locally.

**System-audio loopback is source-type-independent** — a real, researched finding, not an oversight:
capturing `audio: 'loopback'` captures the whole system's mixed audio output regardless of whether
the `video` source selected is a specific monitor or a specific window. Windows offers no per-window
audio isolation without process-tree loopback capture (a distinct, future capability — see "Future:
process/game audio boundary" below). `ScreenSourcePicker.tsx` states this plainly ("Shares all system
sound currently playing, not audio from a specific window") rather than implying window-scoped
audio the mechanism cannot actually provide — the Share Audio checkbox is therefore never disabled
per source type, since the capability genuinely does not differ by source type on this mechanism.

## Share Audio UX: explicit, per-share, default off

`ScreenSourcePicker.tsx` gained a "Share audio" checkbox, `shareAudio` state defaulting to `false` —
nothing shares system audio unless a user actively checks it for that specific share. The choice is
armed alongside the video source selection in one atomic IPC call
(`selectScreenShareSource(sourceId, shareAudio)`) and consumed together by
`main/screen-share.ts`'s `setDisplayMediaRequestHandler` callback — there is no separate,
independently-timed "audio permission" step a Renderer could race or forget.

## Capture model: `ScreenCaptureSession`, video mandatory, audio optional

`getDisplayMedia()` can resolve with a `MediaStream` carrying both a video and an audio track, but
this package never treats that as one opaque combined stream. `acquireScreen(constraints,
shareAudio)`'s returned `Screen` models the two tracks independently from the moment they're
acquired:

```ts
interface Screen {
  readonly track: MediaStreamTrack; // video — always present, or acquireScreen() throws
  readonly audioTrack: MediaStreamTrack | undefined; // present only if requested AND supplied
  readonly stream: MediaStream;
  readonly stopped: boolean;
  stop(): void; // stops both tracks
}
```

`shareAudio` defaults to `false` and is always traced back to the picker's own checkbox — this
function never defaults it to `true` on its own. Requesting audio never turns a failure to supply it
into a rejection of the whole call: `stream.getAudioTracks()[0]` is read back _after_ the platform
resolves the call, `undefined` if absent — a normal, expected outcome (audio unchecked, the source
type or platform declined it, Main denied the loopback grant) never a fatal error. Video-only screen
sharing remains fully supported and is the common case whenever `shareAudio` is `false`.

## Media identity: extending T5's `mid`-based mechanism to audio

T5 solved camera-vs-screen-video with a `mid`-based semantic-source announcement
(`media:track-source`) because `track.kind === 'video'` stopped identifying content once two video
sources existed, and neither arrival order nor absence-based defaulting were acceptable. T6 needed
the identical fix for audio, for the identical reason: once both microphone and screen-audio exist,
`track.kind === 'audio'` no longer identifies what an audio track carries either.

**`packages/protocol`'s `trackSourceSchema`** grows from `['camera', 'screen-video']` to
`['microphone', 'camera', 'screen-video', 'screen-audio']`. Microphone becomes an explicit member —
not a special unannounced default — and is now announced through the exact same `media:track-source`
mechanism camera/screen-video already used. Leaving microphone unannounced and treating "no
announcement" as implicitly meaning "microphone" would itself be exactly the absence-based inference
this whole design exists to reject.

**`onLocalTrackMid`** (`use-voice-channel.ts`) resolves a locally-published track's source by
identity against every currently-tracked local device handle:

```ts
const source: TrackSource | undefined =
  event.track === microphoneRef.current?.track
    ? 'microphone'
    : event.track === cameraRef.current?.track
      ? 'camera'
      : event.track === screenRef.current?.track
        ? 'screen-video'
        : event.track === screenRef.current?.audioTrack
          ? 'screen-audio'
          : undefined;
```

Reference-identity comparison against the single currently-tracked handle for each source, never
inferred from track kind or order — the same soundness argument T5 established for camera vs.
screen-video applies identically here for microphone vs. screen-audio.

## Reconciliation, generalized: `RemoteMediaReconciler`

T5's receiving-side reconciliation (`pendingRemoteVideoTrackByKey`/`wiredEventByKey`/`sourceByKey`,
keyed by `` `${participantId}:${mid}` ``) was originally written video-specific, with audio (then
unambiguous — only microphone existed) handled by a separate, simpler fast path: add to state
immediately on `ontrack`, remove on `'ended'`, no announcement dependency at all.

T6 removed that special case. Every track, audio or video, now goes through the identical
reconciliation the video-only design already proved: buffer whichever of `ontrack` /
`media:track-source` arrives first for a given key, wire once both are known, and — the mid-reuse
case — reclassify a key whose announced source changes later (a transceiver freed by one source and
reused by a different one, not just the same one turning back on). `'ended'`, `'mute'`, and
`'unmute'` are all wired for every track kind now, not only video: `'ended'` remains the operative
signal for microphone (an application-level mute sends silence via `track.enabled = false` rather
than muting the track at the WebRTC level, so `'mute'`/`'unmute'` were never expected to fire for it
and still don't — this is a superset of the old behavior, not a change to it); `'mute'`/`'unmute'`
remain necessary for any track that can be renegotiated away and reused (T4's live finding, unchanged
by T6).

This logic — the site of two real, live-found bugs across T5's stabilization pass and T5's own
review round — is now extracted into a standalone, React-free class,
[`remote-media-reconciliation.ts`](../../apps/desktop/src/renderer/voice/remote-media-reconciliation.ts)
(`RemoteMediaReconciler`), taking an injected `updateStreams` callback instead of calling `setState`
directly. `use-voice-channel.ts` owns exactly one instance per connection lifetime and calls
`reset()` on reconnect/rejoin. This closes a gap flagged in two prior review rounds (T5's initial QA
review and its stabilization pass both called out that this exact reconciliation logic had zero
direct unit coverage, resting entirely on the live two-instance E2E) — `tests/desktop/
remote-media-reconciliation.test.ts` (14 tests) now covers it directly: initial wiring in both
arrival orders, four sources concurrently live for one participant without cross-contamination,
mid reuse across sources (including the exact scenario the T5-stabilization `moveRemoteVideoStream`
bug produced — wiring in a new source must never delete an unrelated, still-live source's entry),
the missing-announcement diagnostic, and `reset()`.

## Remote media model: four independent maps, four independent playback owners

`VoiceChannelState` carries `remoteAudioStreams` (microphone), `remoteCameraStreams`,
`remoteScreenStreams`, and a new `remoteScreenAudioStreams` — four separate
`ReadonlyMap<string, MediaStream>` fields, never a kind-based union. `RemoteAudio.tsx` — already a
generic `{participantId, stream, muted}` component with no microphone-specific logic — is reused
unmodified for screen-audio, rendered from the new map alongside the existing microphone instance;
each participant with both microphone and screen-audio active gets two independent `<audio>`
elements, each with its own playback lifecycle.

## RTC publication: zero transport changes, again

Screen-audio publishes through the exact same `MediaTransport.publishTrack`/`unpublishTrack`
contract every other source uses. `enableScreenShare` calls `transport.publishTrack(screen.track)`
then, if `audioTrack` is present, `transport.publishTrack(audioTrack)` — both synchronously in the
same task, so the platform's own `negotiationneeded` batching (see "Renegotiation batching" below)
coalesces them into one renegotiation cycle for a combined share-start, not two. A dedicated
`p2p-mesh-transport.test.ts` regression test (mirroring T5's three-source test exactly) proves all
four sources reach both an already-connected peer and a newly-added peer, and that unpublishing just
screen-audio leaves microphone, camera, and screen-video untouched.

### Renegotiation batching

Two back-to-back synchronous `addTrack()` calls (video then audio, in `enableScreenShare`) are
expected to coalesce into a single `negotiationneeded` event per the WebRTC "update the
negotiation-needed flag" algorithm — the platform's own task-queued check-and-fire semantics mean
multiple synchronous changes before that task runs simply leave the flag already `true`, firing the
event once. `packages/rtc-core/src/peer.ts`'s existing re-entrancy guard (`|| this.makingOffer`,
added during T5's stabilization pass) additionally protects the case where a second
`negotiationneeded` fires while an offer for the first is still asynchronously in flight. Live
`e2e:screen-audio-smoke` runs are consistent with this: no renegotiation-storm symptoms were
observed across six consecutive clean runs.

## A real, previously-latent `rtc-core` bug this session found and fixed

`Peer.createAndSendOffer()` has always called `reportLocalTrackMids()` after its own
`setLocalDescription()` succeeds — reporting each locally-attached sender's now-known `mid` to the
callback. `Peer.handleRemoteOffer()` (the _responder_'s path for the initial handshake — it only
ever answers, never offers, for that cycle) never did the equivalent after _its own_
`setLocalDescription(answer)`.

This was harmless through T5: every track needing a `media:track-source` announcement (camera,
screen-video) was always added by explicit user action _after_ the initial join, so its mid was
always reported via a later `createAndSendOffer()` renegotiation — regardless of which side of the
pair happened to answer the very first offer. T6 changed the precondition: microphone now requires
the identical announcement mechanism, and microphone is _seeded before the peer connection is even
created_ (`P2PMeshTransport.addParticipant` adds already-published tracks before the first offer is
sent), landing it in the very first offer/answer cycle. Live-found via `e2e:camera-smoke`: a
responder-role instance's remote peer would see `E2E_PEER_CONNECTED` but never `E2E_AUDIO_LEVEL_OK`
— the announcement genuinely never arrived, because the answering side never sent one.

Fixed with one added call, `this.reportLocalTrackMids()`, right after `handleRemoteOffer()` sets
`this.negotiated = true` — mirroring `createAndSendOffer()`'s identical call. Per the WebRTC
specification, `mid` values are decided by the offerer and carried in the offer's SDP, so an
answerer's own transceivers already have their `mid` populated as soon as
`setRemoteDescription({type: 'offer', ...})` resolves (earlier in the same function) — this is a
genuinely correct fix, not a workaround. `tests/rtc-core/fake-peer-connection.ts` was corrected to
model this real platform behavior (it previously assigned mids only on the offerer's own
`setLocalDescription()` call, never on receiving an inbound offer, so it could not have caught this
class of bug before now) and `tests/rtc-core/peer.test.ts` gained a dedicated regression test
("T6 regression: a track published before the initial handshake... has its mid reported even on the
_responder_ side").

## Microphone mute independence

`setMuted` is structurally scoped to microphone alone — `mutedRef.current = muted;
microphoneRef.current?.setMuted(muted); setState(...)` — it never references `screenRef` or any
screen-audio state, by construction, not by an added guard. `e2e:screen-audio-smoke` proves this
live: the publisher mutes its microphone mid-scenario, and the viewer's screen-audio probe
(re-triggered with a distinct `E2E_SCREEN_AUDIO_POST_MUTE` marker family, timed to land during the
mute window) confirms screen-audio stays non-silent throughout.

## Deafen

`state.deafened` is passed identically to both the microphone and the screen-audio `RemoteAudio`
instances — `muted={state.deafened}` at both call sites in `VoiceChannelView.tsx`. `RemoteAudio.tsx`
only mutes the `<audio>` element's local playback; it never touches the underlying track,
unpublishes anything, or notifies the sender (unchanged from T3's original deafen design). This is
also how `e2e:screen-audio-smoke`'s same-machine-feedback avoidance works (see "Same-machine
feedback" below) without weakening any proof: the E2E's audio-level probes tap the raw `MediaStream`
directly via `AudioContext.createMediaStreamSource`, entirely independent of whether the `<audio>`
element rendering that same stream is muted — deafening a participant during the E2E silences its
real speaker output but never affects what the probe can observe.

## Cleanup semantics

- **Stop sharing**: unpublishes and stops both `screen.track` and (if present) `screen.audioTrack`;
  microphone, camera, and the peer connection are untouched.
- **Screen-video ends externally** (native "Stop sharing" control, captured window closed): the
  video track's own `'ended'` handler unpublishes and stops _both_ tracks — screen-audio must never
  keep broadcasting after the visual share ended.
- **Screen-audio ends independently** (source app closed, platform revoked it) while video keeps
  sharing: the audio track's own, separate `'ended'` handler unpublishes and stops only the audio
  track, sets `screenShareAudioActive` to `false`, and leaves `screenSharingState`/the video track
  untouched — optional media failing degrades explicitly rather than ending unrelated media
  (`docs/PRODUCT.md`'s product principle 5).
- **Re-share**: `screenShareAudioActive` accurately reflects whether the _current_ share actually
  has a live audio track, distinct from "the user requested audio" — requested-but-unavailable and
  requested-and-active are both real, observably different states.

## Automated end-to-end verification

`apps/desktop/scripts/e2e-screen-audio-smoke.mjs` mirrors T5 stabilization's proven one-publisher/
one-viewer topology exactly (see `WEBRTC_SCREEN_SHARE.md`'s own "Automated end-to-end verification"
section for why that topology, not two simultaneous local capturers, is the right primary scenario).

### Deterministic audio source, through the real production path

The E2E cannot depend on ambient desktop noise, and must not inject an artificial
`MediaStreamTrack` directly into `rtc-core` — that would bypass the very feature being tested.
Required proof path: **a known audio signal actually plays through the real system audio output,
gets captured by the real production system-audio-loopback path, becomes a real `screen-audio`
`MediaStreamTrack`, travels over real WebRTC, and is decoded by a real remote Electron instance.**

The publisher instance, gated behind a new E2E-only flag (`autoScreenShareAudio`), creates a plain
`AudioContext` with an `OscillatorNode` (440 Hz) connected to `audioContext.destination` — the
platform's actual default audio output device, not a fake device and not an injected track. Windows'
WASAPI loopback capture (via `audio: 'loopback'`, see above) picks this up through the exact same
path a real user's shared system sound would take.

The remote-side proof itself (`e2e-audio-probe.ts`) is RMS-based: it proves _some_ non-silent audio
arrived, not _which_ audio — a real, documented gap this doc doesn't hide. T12 (Windows
per-application audio capture) needed a stronger, frequency-domain proof for its own mandatory
process-isolation acceptance criterion (two independent processes, known different tones, prove the
remote side received the selected one and not the other) and built exactly that:
`apps/desktop/src/renderer/voice/e2e-frequency-probe.ts`, an FFT-based probe with a documented
threshold/margin design — see `docs/tasks/T12_WINDOWS_PROCESS_AUDIO.md`. It was never wired into
_this_ scenario's own `E2E_SCREEN_AUDIO_OK` check; doing so would close this section's own RMS-only
gap with a small, low-risk reuse rather than a new build, and remains open as a follow-up (see
`docs/HANDOFF.md`'s "What should happen next?").

### Same-machine feedback

Publisher and viewer run on the same Windows machine during this E2E, which creates a real risk: the
viewer's own remote-audio playback (microphone passthrough, and once screen-audio arrives, that too)
would otherwise reach the same machine's real speaker output, which the publisher's own loopback
capture could then re-capture — contaminating the signal or causing audible feedback. Rather than
changing production semantics to solve this, both roles simply **auto-deafen immediately once voice
is stable** (`actions.setDeafened(true)`, gated on the same `autoScreenShareAudio` flag) — an
entirely existing product feature, not a new test-only override. As "Deafen" above establishes,
deafening only mutes local `<audio>` playback; it never affects what the E2E's Web-Audio-API-based
probes can observe, so every proof below is unaffected by both instances being deafened throughout.

### Scenario and evidence

Publisher role (gated on `autoScreenShareAudio && autoScreenShare`): a sequential, explicitly-phased
async orchestration (not a chain of independent timer effects — this scenario has too many ordered
steps for that pattern to stay readable) — share (audio off) → stop → share (audio on) → mute
microphone → unmute microphone → stop → re-share (audio on). Each phase transition is logged
(`E2E_LOCAL_SCREEN_ON:<n>`/`E2E_LOCAL_SCREEN_AUDIO_ON:<n>`/`E2E_LOCAL_MIC_MUTED`/etc.), so a timeout
reports exactly which phase was reached, matching T5 stabilization's "explicit numbered phases, not
one giant timer race" principle.

Viewer role proves, all from its own observation of real decoded/received evidence:

- screen-video decodes (`E2E_REMOTE_SCREEN_OK`, frame-delta based, from T5 stabilization);
- screen-audio is genuinely **absent** during the audio-off cycle (`E2E_SCREEN_AUDIO_ABSENT`,
  checked at the moment screen-video is first confirmed present for that cycle);
- screen-audio decodes as real, non-silent, correctly-identified audio once requested
  (`E2E_SCREEN_AUDIO_OK` — a deliberately separate marker family from microphone's
  `E2E_AUDIO_LEVEL_OK`, via `probeRemoteAudioLevel`'s existing `markerPrefix` parameter, so a
  microphone-path success can never be mistaken for screen-audio proof);
- screen-audio survives the publisher's microphone mute unaffected (`E2E_SCREEN_AUDIO_POST_MUTE_OK`
  — a second, later re-probe of the same still-active stream, timed to land during the mute window);
- stopping removes both screen-video and screen-audio without disconnecting the peer
  (`E2E_SCREEN_SHARE_ENDED`/`E2E_SCREEN_AUDIO_ENDED`, both requiring `peerState=connected`) and
  without breaking microphone continuity (`E2E_AUDIO_LEVEL_POST_SCREEN_OK`, fresh evidence taken
  after the stop, from T5 stabilization's pattern);
- a re-share produces real decoded screen-video _and_ screen-audio again (`screenOkCount >= 3`,
  `screenAudioOkCount >= 2` — the re-share proof, guarding against stale mid/transceiver/sender
  state left over from earlier cycles).

### Status: 12 consecutive clean runs across four rounds

`e2e:screen-audio-smoke` passed 3 times before the SDP-bound fix below using a temporarily-widened
diagnostic scenario, 3 after on the actual gating scenario, 3 after the QA evidentiary-precision
fix, and 3 more after the final pre-publish lifecycle fixes — well past the 3-consecutive-run bar.

## SDP/message-size bound, live-measured (not guessed)

T5 found a genuine 3-source SDP measured 10,859 characters against an 8192 bound and raised it to 24576. T6 adds a fourth source. Rather than guessing at a new number, this session measured a real
offer: mic + camera + screen-video + screen-audio, negotiated together with a stop/re-share cycle
(each renegotiation restates every current m-line plus accumulated trickle-ICE candidates) — **the
SDP reached 25,235 characters**, genuinely exceeding the 24576 bound in a live run (the run's viewer
instance failed because of it, not a theoretical concern). `packages/protocol`'s `SDP_MAX_LENGTH`
was raised to 65536 with real headroom above that measurement; `services/realtime`'s
`REALTIME_MAX_MESSAGE_BYTES` default was raised alongside it, 32 KiB → 80 KiB, kept with headroom
above the new SDP bound once JSON envelope overhead and `\r\n` → `\\r\\n` escaping are accounted for
— not sized identically to it, matching the established T5 pattern.

## Camera-smoke intermittent flakiness (honest record, not a T6 regression)

During this session's live verification, `e2e:camera-smoke` (T4's 2-instance camera scenario,
unrelated to screen-audio) showed intermittent failures interspersed with clean runs — roughly half
of ~10 total attempts, with no consistent symptom (sometimes audio silent, sometimes video missing,
sometimes a participant appearing to leave). A live diagnostic run with additional console tracing
confirmed the underlying mechanism (microphone's mid announcement, now required after the
`rtc-core` fix above) works correctly when it fires — every traced message arrived in the expected
order. The final 3 consecutive runs against final code were clean, satisfying T4/T5's own
regression bar, but this pattern (mechanism proven correct, intermittent under this session's
sustained load of dozens of consecutive Electron launches, resolving on retry without a code change)
is recorded honestly rather than silently smoothed over — it was not root-caused to a specific fix
the way T5 stabilization's own flakiness was, and remains a candidate for further investigation if
it recurs more persistently in a future session.

## Security and QA review outcomes

The initial security and QA reviews found T6's new surface sound overall, with no release-blocking
defects in the surfaces they examined.

**Security review**: confirmed the consent flow is genuinely single-sourced (the picker's checkbox
is the only place `shareAudio` can become `true`, traced through every layer to the Main-process
grant decision with no silent-default path), confirmed the three-way grant condition
(`selection.shareAudio && request.audioRequested && process.platform === 'win32'`) is real
defense-in-depth rather than redundant, confirmed the IPC boundary validates the new `shareAudio`
argument, confirmed no new logging of audio content or capture metadata, confirmed the E2E-only
automation (oscillator tone, auto-deafen, scripted phase sequence) is gated behind the same
double-gate (env var + unspoofable `!app.isPackaged`) pattern with no observed gap, and confirmed
the widened `trackSourceSchema` doesn't change server-side identity derivation. One informational,
non-blocking note (addressed — see `docs/SECURITY.md`'s T6 paragraph): the pre-existing T5 residual
race over `pendingSelection` (a second concurrent `getDisplayMedia()` call, itself already requiring
Renderer script execution, racing to consume an armed selection) can now also yield the audio grant
when the legitimately-armed selection requested one, not only video — the underlying precondition
and mitigation are unchanged from T5, only the scope of what a successful race could obtain widened
alongside the feature, so the existing documented risk was extended to say so rather than treated as
new.

**QA review**: confirmed the four-way source-identity resolution (`onLocalTrackMid`'s
object-identity comparison against `microphoneRef`/`cameraRef`/`screenRef.track`/
`screenRef.audioTrack`) cannot misclassify any track, confirmed `setMuted` is structurally
incapable of touching screen-audio by direct code reading, and confirmed `RemoteMediaReconciler`'s
14 tests cover the highest-risk scenarios (four-source coexistence, mid reuse including
audio-to-audio, cross-map isolation). Three real, actionable findings were made and addressed:

1. **`E2E_SCREEN_AUDIO_ABSENT` was not phase-tagged** — it could fire during a later audio-_on_
   cycle too (video settling one render tick before audio), which would not have produced a false
   _pass_ of the overall suite (the separate `screenAudioOkCount >= 2` requirement is unaffected)
   but weakened the evidentiary precision of the absence proof specifically. Fixed: the viewer now
   tracks its own observed screen-share cycle count (`viewerScreenCycleCount`, independent of the
   publisher's local count) and tags the marker with it
   (`E2E_SCREEN_AUDIO_ABSENT:<id>:cycle=<n>`); `armE2EScreenAudioSmokeViewerExit` now requires
   `cycle=1` specifically. Re-verified live after the fix — `cycle=1` fires exactly once per run, at
   the correct (audio-off) cycle, across three additional consecutive clean runs.
2. **`onParticipantLeft`'s four-map cleanup had no dedicated test** — flagged as exactly the kind of
   "obviously correct" code this codebase's own history (the T5 stabilization `moveRemoteVideoStream`
   bug, and this session's own `Peer.handleRemoteOffer` gap) shows is worth verifying directly rather
   than trusting by inspection. Addressed by centralizing the cleanup into a new
   `RemoteMediaReconciler.removeParticipant()` method (replacing the inline four-map diff previously
   duplicated in `use-voice-channel.ts`), with three new dedicated tests (all four maps cleared at
   once, a different participant's entries left untouched, a harmless no-op for a participant with no
   live streams).
3. **The screen-audio non-silence probe cannot independently corroborate audio _content_** (screen-
   audio vs. microphone) beyond the structural object-identity routing guarantee — `probeRemoteAudioLevel`
   is a pure RMS-silence check with no frequency-domain verification against the publisher's known
   440 Hz oscillator tone, so if a routing bug ever did exist, a fake-microphone's own non-silent
   synthetic waveform could in principle also satisfy an RMS-only check. Not fixed in this task —
   recorded as a follow-up (an FFT/dominant-frequency assertion would be a stronger, still-cheap
   differentiator) since the routing guarantee itself is structural and independently verified by
   code reading and by `RemoteMediaReconciler`'s direct unit tests, not solely by this E2E probe.

QA additionally examined the session's camera-smoke intermittent-failure pattern (documented below)
and assessed it as consistent with environmental flakiness rather than a proven remaining defect,
given the specific bug the session found and fixed (`Peer.handleRemoteOffer`) has direct,
deterministic unit regression coverage independent of the live E2E's own pass/fail history —
while noting the margin (roughly half of ~10 attempts failed before the final 3 consecutive clean
runs) is thin enough to warrant a closer failing-vs-passing trace comparison if it recurs in a future
session, which was not attempted here given time budget.

**Final pre-publish lifecycle audit**: a later independent pass found two release blockers in local
screen cleanup. First, the native screen-video `'ended'` handler unpublished screen-audio but did
not call `Screen.stop()`, so the Windows loopback track could remain locally active after the user
ended visual sharing through the native control. Second, the channel-leave cleanup stopped the
capture but did not unpublish `screen.audioTrack`, leaving that ended track in
`P2PMeshTransport.publishedTracks` for a later join. Both are fixed by the shared
`releasePublishedScreen()` operation, now used by native capture-end, channel leave/effect cleanup,
and explicit disable. It always unpublishes screen-video and optional screen-audio before stopping
the capture session. Two direct regressions cover audio+video cleanup ordering and the video-only
case; the final full gate contains 508 tests.
The dedicated real-loopback E2E also passed 3 consecutive times after these fixes.

## Process/game audio boundary — resolved as T12, matching this section's own prediction

Not built in T6; this section originally described it as a future task's constraint. **Built in T12**
exactly as anticipated below: process-scoped audio is not a fifth independent semantic source — it
publishes through the very same `screen-audio` source T6 established, via a native Windows helper in
`packages/windows-media` (see `docs/tasks/T12_WINDOWS_PROCESS_AUDIO.md` and
[`adr/0017-windows-process-loopback-native-boundary.md`](../adr/0017-windows-process-loopback-native-boundary.md)
for the real implementation, including why an out-of-process helper — not an in-process addon — was
chosen). `rtc-core`/the remote-side reconciliation genuinely never had to change: a `screen-audio`
track's origin (system-wide loopback vs. one selected process) is invisible past the local capture
layer, exactly as designed here:

```text
T6:                                  T12:
Windows/system audio                 Game.exe/process-specific audio
    |                                     |
Electron/Chromium loopback           Windows native helper
                                          |
                                      WASAPI process loopback
    \                                    /
     \                                  /
      -----> semantic RTC source: screen-audio <-----
```
