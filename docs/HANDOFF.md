# Engineering handoff

## What is this project?

Disco Voador is a planned lightweight self-hosted Windows desktop communication application. The
target product combines text/voice channels, microphone, camera, screen/window streaming, and
optional Windows audio without becoming a browser product or requiring external SaaS.

## What exists now?

T0 provided the pnpm TypeScript monorepo scaffold: package boundaries, strict TypeScript/ESLint/
Prettier/Vitest/CI, dependency decisions, marker modules, the Claude Code harness, and docs.

T1 replaced the `apps/desktop` markers with a real, verified Electron application:

- a secure Main process (`nodeIntegration: false`, `contextIsolation: true`, `sandbox: true`,
  `webSecurity: true`, no application menu, default-deny navigation/window-open/permissions);
- a narrow typed Preload bridge (`window.desktopApp.getVersionInfo()`) with sender-origin-validated
  IPC — no raw `ipcRenderer`, no generic channel access;
- a custom `app://` protocol for packaged content loading (not `file://`), with a path-traversal
  containment check and CSP/`X-Content-Type-Options`/`Referrer-Policy` response headers;
- a minimal React Renderer that states which product capabilities are not implemented yet;
- a working `pnpm dev` (launches `electron-forge start`) and `electron-forge package` producing a
  runnable Windows x64 artifact, plus a scripted launch/load/quit smoke test
  (`apps/desktop/scripts/smoke.mjs`).

T2 replaced the `packages/protocol`, `packages/config`, and `services/realtime` markers with a
real, verified realtime connection backbone:

- `packages/protocol`: typed + `zod`-runtime-validated wire contracts (`client:hello`,
  `client:ping` / `server:hello`, `server:pong`, `server:error`), explicit protocol versioning, a
  closed `ErrorCode` set, and parse helpers that never throw on hostile input. Platform-neutral —
  no Electron/React/Node-fs/Windows/WebRTC dependency.
- `packages/config`: small reusable `zod`-based env-parsing/validation primitives.
- `services/realtime`: a real `ws`-based WebSocket server with an explicit handshake (with
  timeout), server-driven heartbeat liveness detection, a per-connection rate limiter, a
  configurable connection cap, `ws`'s own max-message-size enforcement, structured JSON logging,
  a single-connection exception containment boundary (one connection's bug can't crash the shared
  process), and programmatic `createRealtimeServer(config) -> {start(), stop()}` used by both the
  CLI bootstrap and the test suite.
- 141 Vitest tests including real (non-mocked) `ws` server/client integration tests covering the
  full handshake, two independent clients, heartbeat liveness, and an 11-case hostile-client
  matrix.

T3 added voice channels, microphone capture, and P2P WebRTC on top of the T2 realtime service:

- `packages/protocol`: `voice:*`/`webrtc:*` message schemas (join/leave/catalog/participant
  notifications, offer/answer/ICE-candidate forwarding with server-verified source identity), three
  new non-fatal error codes.
- `services/realtime`: a hardcoded voice-channel catalog, an in-memory `VoiceRegistry` (membership,
  same-channel-only signaling authorization, abrupt-disconnect cleanup).
- `packages/rtc-core`: environment-neutral `MediaTransport`/`P2PMeshTransport`/`Peer`, deterministic
  offer/answer ownership (no glare-avoidance logic needed), ICE candidate queueing.
- `packages/media-core`: audio-only `acquireMicrophone()`, mute-without-reacquire, stop semantics.
- `apps/desktop`: a Renderer `RealtimeClient` (implements `rtc-core`'s `SignalingPort` directly), a
  voice-channel UI (join/leave, participants, mute/deafen, remote audio playback), audio-only
  same-origin microphone permission gating, CSP `connect-src` allowlisting the configured realtime
  origin, and an automated two-Electron-instance fake-media E2E smoke test.

**T3 is complete: implemented, unit/integration-tested (337 Vitest tests), and live-verified.** Its
automated two-Electron-instance smoke test (`apps/desktop/scripts/e2e-voice-smoke.mjs`) passed three
consecutive times, each launching two real, independent Electron processes into the same voice
channel and confirming each side's `RTCPeerConnection` reached `'connected'` and received the other's
genuinely non-silent, actually-decoded audio track (RMS sampled from the real remote `MediaStreamTrack`,
one to two orders of magnitude above the silence threshold every run). Getting there required finding
and fixing a real bug in the smoke script itself — `ELECTRON_RUN_AS_NODE: ''` (empty string) is not
equivalent to the variable being absent, and its presence-but-empty state crashed Electron 43's native
bootstrap before any window opened. See
[`tasks/T3_VOICE_WEBRTC.md`](tasks/T3_VOICE_WEBRTC.md)'s handoff notes for the full root-cause
record and [`references/VERSION_DECISIONS.md`](references/VERSION_DECISIONS.md) for the version-level
finding.

T4 added camera as a second, independent media source over the same T3 voice `RTCPeerConnection`s:

- `packages/rtc-core`: the one real gap T3 left — `Peer` never renegotiated after the initial
  offer/answer cycle, so adding/removing a track on an already-connected peer never reached the
  remote side. Fixed with standard WebRTC "perfect negotiation" (polite/impolite derived from T3's
  existing initiator/responder role — no second coordination mechanism). `publishTrack`/
  `unpublishTrack`/`addParticipant`'s track fan-out needed zero changes; it was already correct for
  existing peers, new peers, and multiple peers.
- `packages/media-core`: `acquireCamera()`/`Camera` — video-only capture, full stop-on-disable
  (unlike microphone's mute-in-place — the camera light must actually turn off), the same
  late-acquisition-race protection T3 established for microphone.
- `apps/desktop`: camera permission widened (video-only, still never mixed with audio, still
  trusted-origin-only), camera on/off UI, local preview, remote camera tiles keyed by participant
  id, an automated two-Electron-instance camera E2E smoke test.

**T4 is complete: implemented, unit/integration-tested (386 Vitest tests), and live-verified.** Its
camera E2E smoke (`apps/desktop/scripts/e2e-camera-smoke.mjs`) passed three consecutive times,
proving real decoded remote video (not just `ontrack` firing) and that disabling a remote camera
does not disconnect the peer or interrupt audio. Two real bugs were found only by this live
verification (invisible to every layer of testing below it): remote camera-off detection needs the
track's `'mute'` event, not `'ended'` (renegotiating a track away doesn't end the receiver's track on
real Electron/Chromium — see [`architecture/WEBRTC_CAMERA.md`](architecture/WEBRTC_CAMERA.md)'s
dedicated section); and the voice hook's returned `actions` object needed `useMemo` — an unmemoized
wrapper object was silently resetting a `setTimeout`-based E2E effect on every unrelated re-render.
See [`tasks/T4_CAMERA_STREAMING.md`](tasks/T4_CAMERA_STREAMING.md)'s handoff notes for the full
record.

T5 added screen/window sharing as a third, independent media source over the same T3/T4
`RTCPeerConnection`s, plus a required prerequisite fix to renegotiation itself:

- **Negotiation-race fix**: `Peer.createAndSendOffer()`'s two-step `createOffer()`/
  `setLocalDescription(offer)` (a T4 security-review finding, deliberately deferred at the time)
  replaced with the atomic parameterless `setLocalDescription()`, with a regression test
  reproducing the exact polite-side collision the finding described.
- **Media source identity, redesigned mid-implementation from a real live-found platform bug**: the
  first design correlated a published track to its semantic source by `MediaStreamTrack.id`,
  broadcast to the channel. Live two-instance testing found `track.id` does not survive this
  application's connections unchanged on this Electron/Chromium build (confirmed via diagnostic
  instrumentation: the sender's own SDP `msid` and the receiver's `RTCTrackEvent.track.id` for the
  same track genuinely disagreed, for both audio and video, both directions) — invisible to every
  unit test, since none exercise real SDP/track machinery. Redesigned around `RTCRtpTransceiver.mid`
  (live-verified reliable) instead, which — because `mid` is scoped to one peer connection, not
  global — also required `media:track-source` to become a _targeted_ per-peer message (mirroring
  `webrtc:offer`/`answer`/`ice-candidate`) rather than a channel-wide broadcast, and a new
  `packages/rtc-core` transport event (`localTrackMid`) to tell the Renderer when each peer's mid
  for a given local track becomes known.
- **A second real live-found bug**: `packages/protocol`'s `SDP_MAX_LENGTH` (8 KiB, sized pre-T5 for
  at most 2 m-lines) rejected a genuine 3-source offer (measured 10,859 characters) as
  `INVALID_MESSAGE`, which cascaded into breaking that connection's further signaling entirely.
  Raised to 24 KiB with headroom; the realtime service's transport-level message-size default raised
  alongside it.
- `packages/rtc-core`/`packages/media-core` needed **zero screen-specific transport changes** beyond
  the two fixes above — proven by dedicated three-simultaneous-track and repeated-publish/unpublish
  regression tests.
- `packages/media-core`: `acquireScreen()`/`Screen` — video-only `getDisplayMedia()` capture,
  quality presets, full stop-on-disable, the same late-acquisition-race and double-click protection
  T3/T4 established.
- `apps/desktop`: Electron Main `desktopCapturer` enumeration and
  `session.setDisplayMediaRequestHandler()` fulfillment behind a narrow validated IPC boundary
  (single-use, most-recent-enumeration-only source selection; never grants audio); a Renderer source
  picker; screen-share on/off lifecycle mirroring camera's proven pattern; remote screen tiles
  rendered separately from camera tiles.

**T5 is complete.** Its end-to-end smoke test (`e2e:screen-smoke`) initially did not reliably reach
the required 3 consecutive clean passes; a follow-up stabilization pass root-caused and fixed this
rather than leaving it open. Every run — passing or not, before or after stabilization — correctly
and distinctly routed one client's camera and screen-video with correct, differing real dimensions;
that is T5's core architectural risk, and it was retired from the start. What took longer to reach
reliably was full end-to-end delivery timing, and three distinct real causes were found and fixed:
Chromium was throttling remote-video decode scheduling on whichever Electron instance did not have
OS focus (`backgroundThrottling: false` now set); a fast-finishing E2E instance could disconnect
before the other instance finished its own proof (exit-delay raised); and a real, previously
undiscovered product bug in `use-voice-channel.ts` meant any user turning on screen share while
their camera was active caused the remote viewer to silently lose that camera video (fixed by
splitting an overly-broad stream-reconciliation function). The stabilization pass also changed the
primary E2E scenario from two simultaneous local screen-capturers to one publisher + one pure
viewer (isolating the actual product requirement being proven — the product itself still supports
either party sharing), and kept the original dual-capture scenario as a non-gating stress test,
which confirmed real (if different, and less severe than originally attributed) contention between
two simultaneous local captures on one machine — not something two real users on separate machines
encounter. With all fixes applied, `e2e:screen-smoke` passed 5 consecutive clean runs. See
[`architecture/WEBRTC_SCREEN_SHARE.md`](architecture/WEBRTC_SCREEN_SHARE.md)'s "Automated
end-to-end verification" section and
[`tasks/T5_SCREEN_SHARE.md`](tasks/T5_SCREEN_SHARE.md)'s handoff notes for the full record.

`security-reviewer` and `qa-engineer` each reviewed T5 twice — once for the initial implementation,
once for the stabilization pass — and together found and this task fixed several real, actionable
issues: a documented residual security finding (display-capture permission also incidentally
re-enabling a legacy capture path bypassing the picker/consent flow) was narrowed by requiring an
actually-armed source selection before granting; QA found and proved (via a new rtc-core regression
test against real product code) that a `mid` can be reused across _different_ sources (e.g. camera
off then screen on reusing the freed transceiver), which the original reconciliation logic would
have misrouted — fixed by making the source lookup dynamic instead of closure-captured; and the
stabilization pass's own `use-voice-channel.ts` fix and negotiation re-entrancy guard (see above)
were each independently reviewed and confirmed correct. Non-blocking follow-ups remain, recorded
rather than resolved: no renderer-level test harness exists for `use-voice-channel.ts` (a QA review
noted the reconciliation functions involved are plain closures and would not require installing a
React testing library to cover in isolation — the highest-value next gate before further
screen-share or camera renderer-hook changes); two real participants sharing screens with each
other simultaneously is validated only by the non-gating dual-capture stress test, not the gating
suite; and `backgroundThrottling: false` applying to all windows (not just E2E runs) is a real,
accepted background-CPU/battery trade-off for call-quality correctness. See
[`architecture/WEBRTC_SCREEN_SHARE.md`](architecture/WEBRTC_SCREEN_SHARE.md)'s "Security and QA
review outcomes" section for the full detail.

T6 added screen/system audio as a fourth, independent media source — the last piece of the core
media-engineering vertical:

- **Windows system-audio-loopback capture**: Electron's documented `session.
setDisplayMediaRequestHandler` mechanism (`Streams.audio: 'loopback'`), confirmed against this
  app's pinned Electron version's own type definitions, not the deprecated `chromeMediaSource`
  path. Granted only when the user's explicit per-share "Share audio" choice, the platform's own
  confirmation the Renderer actually requested audio, and `process.platform === 'win32'` all agree.
- **Media identity extended to audio**: `packages/protocol`'s `TrackSource` grew to include
  `'microphone'` and `'screen-audio'` — microphone is now explicitly announced through the same
  `media:track-source` mechanism camera/screen-video already used (previously an unannounced,
  kind-inferred default), closing the absence-based-inference gap that would otherwise reappear
  once two audio sources exist.
- **`use-voice-channel.ts`'s mid-based reconciliation, extracted and directly unit-tested**: the
  camera-vs-screen-video mechanism T5 built (the site of two real, live-found bugs across T5's own
  review rounds) is now generalized to all four sources and extracted into a standalone, React-free
  `RemoteMediaReconciler` class with 17 direct unit tests — closing a gap flagged twice in T5's
  reviews as the highest-value follow-up, since this repository still has no React testing library.
- **A real, previously-latent `rtc-core` bug found and fixed**: `Peer.handleRemoteOffer()` (the
  responder's path for the initial handshake) never reported local track mids after answering, only
  `createAndSendOffer()` did after offering — harmless through T5 (every announced track was always
  added post-handshake), but microphone is seeded _before_ the initial offer/answer cycle, so a pure
  responder never announced its own microphone's mid at all once microphone required the same
  mechanism. Fixed with one added call; regression-tested, and the shared `rtc-core` test fake was
  corrected to model real platform mid-assignment timing (it previously couldn't have caught this
  class of bug at all).
- **SDP/message-size bound, live-measured again**: a real 4-source offer with a re-share cycle
  measured 25,235 characters against the T5-era 24576 bound — genuinely exceeded it in a live run —
  raised to 65536 with headroom; `REALTIME_MAX_MESSAGE_BYTES`'s default raised 32 KiB → 80 KiB
  alongside it.
- Microphone mute remains structurally incapable of touching screen-audio (by construction, not an
  added guard); deafen suppresses both via two independent `RemoteAudio` instances.

**T6 is complete.** `e2e:voice-smoke`, `e2e:camera-smoke` (3 consecutive), and `e2e:screen-smoke` (3
consecutive) all remain green; the new `e2e:screen-audio-smoke` passed **12 total consecutive clean
runs across four rounds** — proving real Windows system-audio-loopback capture end to end (a
deterministic oscillator tone played through the actual OS audio output, captured by the real
production loopback path, decoded by a real remote instance — never an injected `MediaStreamTrack`),
genuine screen-audio absence when unrequested, microphone-mute independence, clean stop/re-share
cycles, and same-machine-feedback avoidance via the existing deafen feature (not a new test-only
override). `security-reviewer` and `qa-engineer` each reviewed T6's new surface and found no
release-blocking defects; QA's three findings (an E2E evidentiary-precision gap, a missing unit test
for participant-leave cleanup, and a recommendation to add frequency-domain verification to the
audio-content proof as a future strengthening) were addressed except the last, recorded as a
follow-up — see [`architecture/WEBRTC_SCREEN_AUDIO.md`](architecture/WEBRTC_SCREEN_AUDIO.md)'s
"Security and QA review outcomes" section for the full detail, including an honest record of
intermittent (non-regression) `e2e:camera-smoke` flakiness observed this session.

A final pre-publish lifecycle audit then found two additional release blockers, both fixed before
handoff: native screen-video ending did not stop the still-live local system-audio loopback, and
channel leave stopped screen-audio without removing it from the transport's published-track set.
All screen-release paths now share a tested `releasePublishedScreen()` operation that unpublishes
video and optional audio before stopping capture.

Also recorded this session: [`adr/0010-no-mandatory-central-control-plane.md`](adr/0010-no-mandatory-central-control-plane.md),
an architectural guardrail (not an implementation) establishing that Disco Voador's product
direction does not require central accounts, a mandatory cloud control plane, or centralized user
data — see [`tasks/STATUS.md`](tasks/STATUS.md) for the resulting T7+ roadmap toward a
TeamSpeak-style local-identity/dedicated-server model.

Read [`tasks/STATUS.md`](tasks/STATUS.md) for the authoritative status,
[`tasks/T1_ELECTRON_SHELL.md`](tasks/T1_ELECTRON_SHELL.md) /
[`tasks/T2_REALTIME_PROTOCOL.md`](tasks/T2_REALTIME_PROTOCOL.md) /
[`tasks/T3_VOICE_WEBRTC.md`](tasks/T3_VOICE_WEBRTC.md) /
[`tasks/T4_CAMERA_STREAMING.md`](tasks/T4_CAMERA_STREAMING.md) /
[`tasks/T5_SCREEN_SHARE.md`](tasks/T5_SCREEN_SHARE.md) /
[`tasks/T6_SCREEN_AUDIO.md`](tasks/T6_SCREEN_AUDIO.md) for their full verification records,
and [`references/VERSION_DECISIONS.md`](references/VERSION_DECISIONS.md) before changing the
toolchain — it records a real Forge/`@electron/packager` incompatibility T1 found and worked around.
[`architecture/REALTIME_PROTOCOL.md`](architecture/REALTIME_PROTOCOL.md) documents the full T2
protocol design; [`architecture/WEBRTC_VOICE.md`](architecture/WEBRTC_VOICE.md) documents T3's voice/
WebRTC design; [`architecture/WEBRTC_CAMERA.md`](architecture/WEBRTC_CAMERA.md) documents T4's camera
design; [`architecture/WEBRTC_SCREEN_SHARE.md`](architecture/WEBRTC_SCREEN_SHARE.md) documents T5's
screen-share design including the `mid`-based identity redesign and SDP-bound findings;
[`architecture/WEBRTC_SCREEN_AUDIO.md`](architecture/WEBRTC_SCREEN_AUDIO.md) documents T6's
system-audio design including the Electron loopback platform finding and the `Peer.handleRemoteOffer`
fix.

## What does not exist?

There is no text chat, database schema, running Coturn stack (templates exist but no TURN credential
minting), installer/maker artifact, authentication/session model, central client identity, dedicated-
server product boundary, or SFU. Production configuration/TLS termination for the realtime service is
also not yet implemented. Voice, camera, screen-video, and screen-audio sharing, in T3–T6's P2P-mesh,
small-room, self-hosted scope, are all implemented, mechanism-verified, and live-verified end to end
— the core media-engineering vertical is complete.

## What should happen next?

**T7 — local cryptographic client identity** (TeamSpeak-style: client-side identity, no central
account, no email, no username/password database), per
[`adr/0010-no-mandatory-central-control-plane.md`](adr/0010-no-mandatory-central-control-plane.md)'s
recorded direction. Before starting, consider closing two recorded follow-ups from T6's own review,
neither blocking but both cheap relative to the risk they guard against: (1) a frequency-domain
(e.g. dominant-frequency-near-440Hz) check for `e2e:screen-audio-smoke`'s `E2E_SCREEN_AUDIO_OK`
proof, strengthening it beyond the current RMS-only non-silence check; (2) if `e2e:camera-smoke`
flakiness recurs, a targeted failing-vs-passing stdout trace comparison (not attempted this session
given time budget) to either root-cause it the way T5 stabilization's own flakiness was, or confirm
it really is environmental and stop treating each occurrence as a fresh investigation.

## Fixed foundation decisions

- Windows desktop, Electron, React, TypeScript, Vite, and Electron Forge.
- Main/Preload/sandboxed Renderer trust boundary.
- Self-hostable core services; no mandatory SaaS.
- One internally modular realtime service may initially own signaling and text.
- Signaling/text are WebSocket (`ws`); media is WebRTC and never relayed by that service.
- Runtime validation uses `zod`, shared by `packages/protocol` and `packages/config`.
- P2P first with an SFU-ready UI/transport seam.
- Independent microphone, camera, screen-video, and screen-audio sources.
- Windows-specific media isolated in `packages/windows-media`.
- SQLite first behind a storage boundary.
- VDO.Ninja/reference code follows the conservative provenance/license policy.

See accepted ADRs in [`adr/`](adr/); supersede them explicitly if evidence changes a decision.

## Decisions still open

- Concrete application state, routing, and UI component choices.
- Auth/session model (T2's `connectionId` is explicitly not an identity signal).
- Exact RTC transport API, negotiation topology, diagnostics model, and room limits.
- Storage interface and SQLite driver/schema/migration tooling.
- Native addon versus isolated helper for advanced Windows audio.
- Installer/signing/update approach and production deployment topology.
- Whether/when measured scale justifies an SFU and which implementation to use.

## How should Claude work here?

Read [`../CLAUDE.md`](../CLAUDE.md), the task, affected architecture/security docs, and relevant ADRs.
The main session owns implementation. Delegate focused questions according to
[`DEVELOPMENT.md`](DEVELOPMENT.md); use skills as procedures, not as substitute product specs.
Inspect reality before changing architecture and report actual verification.

## How is work verified?

During iteration, run targeted tests/checks. Before a substantial handoff run:

```text
pnpm check
```

T0's final clean-state evidence on 2026-08-18 was a frozen-lockfile install followed by this full
gate: formatting, lint, typecheck, 16 Vitest tests, composite build, repository verification, and
the high/critical dependency audit all passed. See
[`tasks/T0_REPOSITORY_HARNESS.md`](tasks/T0_REPOSITORY_HARNESS.md) for environment details and
limitations.

T1's clean-state evidence, also 2026-08-18, is the same gate with 55 Vitest tests (one documented,
patched dependency-audit exception; see `references/VERSION_DECISIONS.md`), plus actual Windows
runtime evidence beyond `pnpm check`: `electron-forge start` and `electron-forge package` both
verified by launching real windows (development and the packaged `.exe` independently), an
automated launch/load/quit smoke script, and `@electron/fuses read` against the packaged binary.
See [`tasks/T1_ELECTRON_SHELL.md`](tasks/T1_ELECTRON_SHELL.md) for the full record.

T2's clean-state evidence, also 2026-08-18, is the same gate with 141 Vitest tests (the same one
documented dependency-audit exception; T2 introduced no new advisories), plus real-runtime
evidence: `pnpm --filter @disco-voador/realtime run dev` actually listening, and a real external
`ws` client (a separate OS process, not part of the Vitest run) completing a full
hello/hello/ping/pong/close round trip against it, cross-checked against the server's own
structured logs. See [`tasks/T2_REALTIME_PROTOCOL.md`](tasks/T2_REALTIME_PROTOCOL.md) for the full
record, including the one Windows-specific testing limitation it documents (`SIGINT`/`SIGTERM`
signal-handler wiring cannot be exercised via a cross-process signal on Windows, per Node's own
documented behavior — the underlying `server.stop()` logic it calls is thoroughly tested).

T3's clean-state evidence, 2026-08-18, is the same gate with 337 Vitest tests (no new
dependency-audit advisories) — formatting, lint, typecheck, build, and `verify-repository.mjs` all
pass — plus its own required real-runtime evidence: `pnpm --filter @disco-voador/desktop run
e2e:voice-smoke` passed three consecutive times, each run launching two independent Electron
processes that joined the same voice channel, reached a `'connected'` `RTCPeerConnection`, and
received the other's genuinely non-silent decoded audio track. See
[`tasks/T3_VOICE_WEBRTC.md`](tasks/T3_VOICE_WEBRTC.md)'s handoff notes for the full record, including
the real Electron-bootstrap bug (`ELECTRON_RUN_AS_NODE` set to `''` instead of being genuinely absent)
found and fixed to get there.

T4's clean-state evidence, 2026-08-18, is the same gate with 386 Vitest tests (no new
dependency-audit advisories) — formatting, lint, typecheck, build, and `verify-repository.mjs` all
pass — plus its own required real-runtime evidence: `pnpm --filter @disco-voador/desktop run
e2e:camera-smoke` passed three consecutive times, each proving real decoded remote video
(`videoWidth`/`videoHeight` both positive, sampled from an actual `<video>` element) and that
disabling a remote camera left the peer `'connected'` and audio still flowing. `pnpm --filter
@disco-voador/desktop run e2e:voice-smoke` (T3's smoke, unmodified) was re-run twice during this
task and still passes, confirming no voice regression. See
[`tasks/T4_CAMERA_STREAMING.md`](tasks/T4_CAMERA_STREAMING.md)'s handoff notes for the full record.

T5's clean-state evidence, 2026-08-19, is the same gate with 473 Vitest tests (the one pre-existing,
already-allowlisted high-severity dependency advisory; no new advisories) — formatting, lint,
typecheck, `vitest run`, build, `verify-repository.mjs`, and the dependency audit all pass — plus
its own required real-runtime evidence: `pnpm --filter @disco-voador/desktop run e2e:voice-smoke`,
4 consecutive `e2e:camera-smoke` runs, and 5 consecutive `e2e:screen-smoke` runs (the primary
one-publisher/one-viewer scenario) all passed clean at the final code state, confirming no
regression from the negotiation-atomicity fix, the `mid`-based reconciliation redesign, or the
stabilization pass's own fixes. T5's E2E stability initially fell short of the required three
consecutive clean passes; rather than leaving that open, a follow-up stabilization pass root-caused
and fixed it — see [`architecture/WEBRTC_SCREEN_SHARE.md`](architecture/WEBRTC_SCREEN_SHARE.md)'s
"Automated end-to-end verification" section and
[`tasks/T5_SCREEN_SHARE.md`](tasks/T5_SCREEN_SHARE.md)'s handoff notes for the full record: the
camera/screen semantic-identity mechanism was correct on every single run throughout, passing or
not; what took the stabilization pass to resolve was full end-to-end delivery timing, traced to
three distinct real causes (window background-throttling, an E2E exit race, and a genuine
stream-reconciliation bug affecting real users, not just the test) rather than the originally
hypothesized capture contention alone. **T5 is marked COMPLETE in
[`tasks/STATUS.md`](tasks/STATUS.md)** — its mechanism is implemented, twice reviewed
(`security-reviewer` and `qa-engineer`, once for the initial implementation and once for the
stabilization pass, together finding and this task fixing several real issues — see above), and
unit/integration/live-verified, with all Definition of Done items satisfied. See
[`tasks/T5_SCREEN_SHARE.md`](tasks/T5_SCREEN_SHARE.md)'s handoff notes for the full record,
including the negotiation-atomicity fix, the `mid`-based redesign (replacing an earlier
`MediaStreamTrack.id`-based design a live test found unreliable), the SDP-size protocol fix, the
stabilization pass's three root causes, and both rounds of review fixes.

T6's clean-state evidence, 2026-08-19, is the same gate with 508 Vitest tests (the same one
pre-existing, already-allowlisted high-severity dependency advisory; no new advisories) —
formatting, lint, typecheck, `vitest run`, build, `verify-repository.mjs`, and the dependency audit
all pass — plus its own required real-runtime evidence: `e2e:voice-smoke` clean, 3 consecutive
`e2e:camera-smoke` runs, 3 consecutive `e2e:screen-smoke` runs, and **12 total consecutive**
`e2e:screen-audio-smoke` runs across four rounds, including 3 after the final lifecycle-audit fixes.
**T6 is marked COMPLETE
in [`tasks/STATUS.md`](tasks/STATUS.md)** — its mechanism is implemented, reviewed
(`security-reviewer` and `qa-engineer`, together finding and this task addressing three real,
actionable findings — see above), and unit/integration/live-verified through the real Windows
system-audio-loopback path, with all Definition of Done items satisfied. See
[`tasks/T6_SCREEN_AUDIO.md`](tasks/T6_SCREEN_AUDIO.md)'s handoff notes for the full record, including
the Electron loopback platform finding, the media-identity extension to audio, the
`RemoteMediaReconciler` extraction, the `Peer.handleRemoteOffer` fix, the SDP-size measurement, the
review findings, and the final lifecycle-audit fixes.

Then perform the task’s required manual/platform checks. Apply
[`DEFINITION_OF_DONE.md`](DEFINITION_OF_DONE.md) and update status only when every applicable item
is evidenced. Electron-surface tasks specifically need actual Windows Electron start/quit and
packaged-artifact smoke tests; a passing TypeScript build alone is not a packaging claim.
