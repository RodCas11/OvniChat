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

T7 added local cryptographic client identity — the first piece of the actual TeamSpeak-style
product architecture ADR 0010 anticipated, replacing T2's unauthenticated `connectionId` with a
real, client-owned, server-verified identity while introducing **no** central account system:

- **Ed25519 keypair, generated and used only in the Electron Main process.** New Node-only
  `packages/identity` package (keygen/sign/verify/`identityId` derivation via `node:crypto`, no
  third-party crypto dependency), importable only by Main and `services/realtime` — never Renderer/
  Preload or the environment-neutral packages, enforced by a new `isIdentity()` check in
  `scripts/verify-architecture.mjs`. `packages/protocol` gained the wire schemas and a pure,
  crypto-free canonical-payload builder (`buildIdentityAuthPayload`) so it stays safe for the
  sandboxed Renderer to import directly.
- **A challenge/response handshake inserted into T2's existing connection handshake**:
  `client:hello` gained required `nickname`/`publicKey`; a new `awaiting_identity_proof` connection
  state and `server:identity-challenge`/`client:identity-proof` exchange must succeed before
  `server:hello` (now carrying a server-derived `identityId`) is ever sent. Protocol version bumped
  1 → 2 (breaking — v1 support dropped rather than kept as a parallel unauthenticated path). The
  challenge nonce uses real cryptographic randomness, is single-use, connection-bound, and expires;
  the existing handshake timeout now covers both handshake steps, not just the first.
- **Private key encrypted at rest via Electron's `safeStorage`** (Windows DPAPI-backed) at
  `%APPDATA%/DiscoVoador/identity/identity.json`, atomic write (temp file + `rename`), versioned/
  schema-validated on read. Fails closed (throws an actionable error) rather than falling back to
  plaintext if `safeStorage.isEncryptionAvailable()` is `false`. Corrupted identity (bad JSON,
  schema-invalid, unsupported version, or a public/private key mismatch caught by a sign-then-
  verify self-check) is never silently regenerated — it surfaces as an actionable error; the only
  way forward is the same explicit, confirmation-gated "Regenerate Identity" a user would use
  voluntarily. Two concurrent first-ever callers to the identity loader share one in-flight promise
  so only one identity ever becomes canonical (identity-creation race protection).
- **An anti-oracle IPC surface**: `signIdentityChallenge` accepts only structured, individually-
  bounded parameters (mirroring the wire protocol's own schemas exactly) — Main reconstructs the
  canonical payload itself from its own stored public key, never a value the Renderer supplies, so
  a compromised Renderer can never turn this into a generic "sign anything" oracle. All five new IPC
  channels (`getIdentity`, `signIdentityChallenge`, `regenerateIdentity`, `getNickname`,
  `setNickname`) go through the same `assertTrustedSender` check every other channel in this app
  uses.
- **Nickname is explicitly not identity**: a separate client-local preferences file, editable
  without ever touching the cryptographic identity — proven by a dedicated realtime integration test
  (same identity, two different nicknames across a reconnect, same `identityId` both times).
- **Renderer**: a narrow, IPC-shaped `IdentitySigner` dependency (unit-testable with a fake signer,
  no Electron involved) drives a fully reworked `RealtimeClient` (async hello → challenge → proof →
  ready); a minimal first-run nickname prompt and a settings Identity panel (nickname edit, Identity
  ID + Copy, confirmation-gated Regenerate) — no account/login/password language anywhere, matching
  the TeamSpeak-style UX goal.
- **Server**: `services/realtime` holds identity state only for a connection's lifetime — no
  users/accounts/profile database was introduced. The server always derives `identityId` itself from
  the verified public key, never trusting a client-supplied value.

**T7 is complete.** All four pre-existing media E2Es (`e2e:voice-smoke`, `e2e:camera-smoke`,
`e2e:screen-smoke`, `e2e:screen-audio-smoke`) were re-run against the final code and pass cleanly
under the now-mandatory identity gate — no regression. Two new dedicated E2E scripts each passed 3
consecutive clean runs with real evidence (not simulated): `e2e:identity-persistence` (a real
Electron instance launched twice against the same `--user-data-dir` reports the identical
`identityId` both times; a different `--user-data-dir` always reports a different one) and
`e2e:identity-auth` (two distinct local profiles' real, DPAPI-backed identities each match the
server-authenticated `identityId` they receive back, the two are always distinct, and real WebRTC
voice with genuinely non-silent decoded audio still works throughout). `security-reviewer` found no
release-blocking issues — the anti-oracle `signIdentityChallenge` design, fail-closed `safeStorage`
handling, canonical-payload domain separation/delimiter-injection safety, and single-use/expiring/
connection-bound challenge design were each independently confirmed correct by reading the actual
verification logic, not just its doc comments; one low-severity note (`regenerateIdentity` has no
_additional_ Main-side confirmation beyond the Renderer's UI gate — accepted, since a Renderer
compromise capable of triggering it unprompted already has equivalent access via
`signIdentityChallenge`) and one informational note (this document and `CLIENT_IDENTITY.md` were
still in progress at review time — both are now complete) were recorded, neither blocking. 612
total Vitest tests; full `corepack pnpm check` green (the same one pre-existing, already-accepted
high-severity dependency advisory; no new advisories). See
[`tasks/T7_LOCAL_IDENTITY.md`](tasks/T7_LOCAL_IDENTITY.md)'s handoff notes and
[`architecture/CLIENT_IDENTITY.md`](architecture/CLIENT_IDENTITY.md) for the full record, including
the canonical signing-payload design, the `packages/identity` boundary decision, and the
concurrency/race analysis.

Also recorded: [`adr/0010-no-mandatory-central-control-plane.md`](adr/0010-no-mandatory-central-control-plane.md),
the architectural guardrail T7 implements the first piece of, and
[`adr/0011-local-cryptographic-identity-without-central-accounts.md`](adr/0011-local-cryptographic-identity-without-central-accounts.md),
recording T7's own identity-design decision (Ed25519, challenge/response, no account, no hardware-
derived identity) — see [`tasks/STATUS.md`](tasks/STATUS.md) for the resulting T8+ roadmap toward a
Dedicated Server product boundary and server-local permissions.

T8 turned the previously-internal `services/realtime` into an explicitly independently-operated
**Disco Voador Dedicated Server** product — a client now connects directly to an operator-chosen
server address, with no Disco Voador–operated infrastructure required or assumed:

- **New `services/dedicated-server` workspace** (`@disco-voador/dedicated-server`) composes
  `services/realtime`'s reusable connection/session library rather than duplicating or renaming it —
  a `software-architect` review confirmed this boundary; see
  [`adr/0012-dedicated-server-product-boundary.md`](adr/0012-dedicated-server-product-boundary.md).
  `services/realtime` gained exactly one new, optional dependency-injection seam
  (`voiceChannels`/`serverMetadata`) so a composing caller can supply its own channel catalog and
  server identity — zero existing consumers needed to change. `services/realtime/src/index.ts` and
  `cli.ts` were split so importing the package as a library no longer has the side effect of starting
  a server.
- **Typed, strictly validated server configuration**: a JSON config file (server name, listen
  host/port, connection cap, voice-channel catalog) plus environment variables, precedence
  `defaults < file < environment`, reusing `services/realtime`'s already-tested
  `loadRealtimeConfig` rather than a second parallel implementation. Invalid configuration and port
  collisions fail loudly before the process ever binds a socket.
- **Voice channels became server-owned configuration**, delivered via the existing `voice:catalog`
  message the client already rendered dynamically since T3 — the real gap was server-side (a
  hardcoded catalog every server shared), not client-side.
- **Server metadata added to `server:hello`**: `serverName`/`serverCapabilities`, bounded and
  schema-validated, sent only after T7's identity-proof step already succeeded. Protocol version
  bumped 2 → 3 (breaking — v2 support dropped, same reasoning T7's own bump already established).
- **`apps/desktop`'s Renderer stopped auto-connecting to one implicit development server**: a new
  `ConnectionScreen` (nickname context, manually entered server address via a real `URL`-parser-based
  `parseServerAddress`, Connect button — no login/password/email) and an explicit Disconnect action
  replace the previous always-on auto-connect. Connecting to a second, independent server within the
  same running app instance reuses T3–T7's already-correct effect-teardown lifecycle with **zero new
  teardown code** — verified by direct inspection of the cleanup path, not just by the E2E scripts
  continuing to pass.
- **All six pre-existing Electron E2E scripts** (`e2e:voice-smoke`, `e2e:camera-smoke`,
  `e2e:screen-smoke`, `e2e:screen-audio-smoke`, `e2e:identity-auth`, `e2e:identity-persistence`) now
  launch the real Dedicated Server product entrypoint (`services/dedicated-server/dist/cli.js`) via a
  new shared helper, rather than a second, bypassed "internal realtime-only" startup path — there is
  exactly one way this codebase starts a real server, in tests and product use alike. A new
  `e2e:connection-smoke` proves the full real-Electron connection flow end to end: start
  disconnected, connect to a real, distinctively-configured Dedicated Server, authenticate via T7
  identity, render its actual configured name.
- **A new Dedicated Server smoke test** (`pnpm --filter @disco-voador/dedicated-server run smoke`)
  and a real two-independent-server isolation integration suite
  (`tests/dedicated-server/integration.test.ts`, real sockets, real ephemeral ports, two full server
  instances in one Vitest process) prove sessions, channel state, and server metadata never cross
  between independently configured servers, and that the same local T7 identity authenticates
  independently to both with no cross-server correlation.

**T8 is complete.** `security-reviewer` found and this task fixed one release-blocking issue: a
stale Content-Security-Policy `connect-src` (fixed to one pre-declared origin since T2) that would
have silently blocked a real user from ever connecting to any server address other than the one
baked in via `DISCO_VOADOR_REALTIME_URL` at launch — the exact mechanism T8's own architecture
claimed to remove. Fixed by scoping `connect-src` to the `ws:`/`wss:` schemes generically; verified
with a genuine regression (`e2e:connection-smoke` now connects through a deliberately mismatched
default address). `qa-engineer` separately found and fixed a real config-validation gap (the
Dedicated Server's `name`/`DISCO_VOADOR_SERVER_NAME` fields did not enforce the same bounds the wire
protocol's `serverNameSchema` requires, so an invalid name would start the server successfully but
then be silently rejected by every connecting client's own strict message validation, hanging with
no visible error) and added regression coverage. See
[`tasks/T8_DEDICATED_SERVER.md`](tasks/T8_DEDICATED_SERVER.md)'s handoff notes and
[`architecture/DEDICATED_SERVER.md`](architecture/DEDICATED_SERVER.md) for the full record, including
the `services/realtime`-vs-Dedicated-Server composition decision, the server-local instance-id
deferral (T8 Section 12), and known limitations.

T9 gave the Dedicated Server its first authorization model -- server-local groups/permissions keyed
by T7's `identityId`, TeamSpeak-style bearer tokens, and identity-based bans -- and, with it, the
Dedicated Server's first persistent runtime state:

- **Storage**: `node:sqlite`'s built-in `DatabaseSync` -- zero new dependencies, and deliberately
  synchronous so token-redemption atomicity falls directly out of Node's own single-threaded event
  loop rather than needing manual locking (see
  [`adr/0013-server-authorization-storage-and-rbac.md`](adr/0013-server-authorization-storage-and-rbac.md)).
  The store lives entirely inside `services/dedicated-server`; `services/realtime` gained one more
  narrow injected seam (`AuthorizationPort`, defaulting to a permissive no-op) mirroring T8's own
  `voiceChannels`/`serverMetadata` pattern exactly.
- **Admission**: evaluated inside T7's existing `handleIdentityProof`, immediately after signature
  verification and before a connection can ever reach `ready`. `open` servers admit any non-banned
  identity as a non-persistent virtual Guest (no database row written); `invite-only` servers
  require either an existing persistent membership or a valid invite token presented at
  `client:hello`.
- **Bootstrap**: a fresh authorization store generates a one-time, cryptographically random Server
  Admin token, printed once to the operator's console, never persisted in raw form. Found and fixed
  a real gap while building this: a server started directly in `invite-only` mode would otherwise
  permanently lock out its own operator, since the bootstrap token's row is `kind: 'bootstrap'`, not
  `'invite'` -- fixed by having admission accept either kind.
- **Tokens**: privilege keys (admin-issued, any target group) and invite tokens (admission-time) are
  the same underlying mechanism -- opaque bearer secrets, digest-only in storage, atomically
  single-use by construction, no password-hashing KDF (deliberately unjustified for high-entropy
  random tokens).
- **Bans**: identity-based only (never IP/hardware), permanent or temporary, enforced at admission
  and live against an already-connected participant (a ban immediately force-closes that
  connection).
- **Last-admin protection**: structurally guaranteed -- the built-in `server-admin` group's
  permission set is a compile-time constant no mutation can edit, and revoking the group from the
  _last_ remaining admin is rejected inside the same transaction as the check.
- **Server-side enforcement**: every `client:authorization-*` mutation is permission-checked in
  `services/realtime/src/protocol-handlers.ts` against the caller's actual current permissions --
  the new `AuthorizationPanel.tsx` client UI hiding a section is a presentation courtesy, never the
  real boundary, proven by a real-socket test where a Guest hand-crafting an admin-only message is
  rejected regardless of what its own UI shows.
- **Cross-server isolation**: each Dedicated Server's `AuthorizationStore` is a private, unrelated
  SQLite connection -- proven with two real independent server instances in one Vitest process,
  including that a bootstrap/privilege/invite token created by Server A digests to something Server
  B's store has simply never seen.
- **New real-Electron E2E** (`e2e:authorization`, T9 Section 78): a full bootstrap -> Server Admin,
  invite redemption -> Member, live ban -> rejected reconnect, unban -> successful reconnect journey,
  the same local identity relaunched three times throughout. Found and fixed a real Windows-specific
  bug while building it: relaunching the same `--user-data-dir` immediately after externally
  `kill()`-ing the previous Electron instance produced a reproducible `safeStorage`/DPAPI decrypt
  failure reading the same, never-corrupted `identity.json` -- fixed by having each instance exit via
  Electron's own `app.exit()` instead (the same technique `e2e-identity-persistence.mjs` already
  relied on). Two consecutive clean runs.
- All six pre-existing E2E scripts re-verified passing against T9's default `open` access mode -- no
  regression from the new mandatory admission gate.

See [`tasks/T9_SERVER_AUTHORIZATION.md`](tasks/T9_SERVER_AUTHORIZATION.md)'s handoff notes and
[`architecture/SERVER_AUTHORIZATION.md`](architecture/SERVER_AUTHORIZATION.md) for the full record.

T10 gave the Dedicated Server persistent server-side text chat -- two scopes (server-wide, and one
per existing voice channel), correcting an earlier roadmap assumption that chat would be ephemeral:

- **Storage**: a _second_, deliberately separate SQLite file (`chat.sqlite`), never merged into T9's
  `authorization.sqlite` -- retention-policy independence and an asymmetric acceptable-loss profile
  (chat is written far more often, and losing it is tolerable; losing authorization state is not)
  were the load-bearing reasons, per a `software-architect` review (see
  [`adr/0014-persistent-server-owned-chat-history.md`](adr/0014-persistent-server-owned-chat-history.md)).
  Both stores now share a small `withTransaction`/migration-runner _pattern_
  (`services/dedicated-server/src/storage/sqlite-store-utils.ts`), never a shared file or connection
  -- `AuthorizationStore` was refactored to use it too, with the full T9 test suite as the regression
  guard.
- **Ordering**: the message's own SQLite `AUTOINCREMENT` rowid is the ordering/pagination-cursor
  authority, never wall-clock `created_at` alone (two messages can share a millisecond).
- **Sending**: server-derived sender identity/nickname always, never client-supplied -- neither chat
  message type has a sender field to spoof. Server Chat requires `chat.server.send`; Channel Chat
  requires both `chat.channel.send` _and_ current voice-channel membership. Reading history requires
  no permission at all, a deliberate asymmetry with sending.
- **Live delivery**: Server Chat broadcasts to every `ready` connection (a new `'broadcast-ready'`
  action, since server-wide has no bounded membership set); Channel Chat reuses the existing
  per-channel `deliver` fan-out `voice:participant-joined` already used.
- **Client**: never the authoritative store -- `use-voice-channel.ts`'s `chatThreads` holds only
  threads the UI actually opened, deduplicated by message id, cleared on every disconnect/reconnect.
  `ChatPanel.tsx` never uses `dangerouslySetInnerHTML`, so a persisted `<script>` body always renders
  as inert literal text.
- **Guest data minimization, corrected**: T9's "a Guest creates no persistent server data" is no
  longer accurate without qualification -- a Guest's chat _send_ now persists a message row (this is
  the point of persistent chat), while still never creating a T9 authorization membership row. Both
  documents now state this precisely rather than leaving the old claim stale.
- **New real-Electron E2E** (`e2e:text-chat-persistence`): B connects and opens Server Chat; A sends
  a Server Chat message (observed live by B), joins a voice channel, and sends a Channel Chat
  message; A and B exit; the real Dedicated Server process is stopped and restarted against the same
  data directory; a third, genuinely fresh Electron profile (different `--user-data-dir`, different
  local identity, no relationship to A or B) connects and retrieves both messages purely through the
  history API, confirmed never received as a live event. Three consecutive clean runs.
- All eight pre-existing E2E scripts (including `e2e:authorization`) re-verified passing against the
  new chat surface -- no regression.
- Product-facing rename to **OvniChat** applied to client/server UI titles, startup banners, and new
  documentation; the internal `@disco-voador/*` package namespace deliberately left unchanged, per
  the task's own explicit instruction not to fold an uncontrolled rename migration into T10.

See [`tasks/T10_PERSISTENT_TEXT_CHAT.md`](tasks/T10_PERSISTENT_TEXT_CHAT.md)'s handoff notes and
[`architecture/PERSISTENT_TEXT_CHAT.md`](architecture/PERSISTENT_TEXT_CHAT.md) for the full record.

T11 made the Client practical for daily use -- local device management, server bookmarks, and
automatic reconnect, entirely client-local (never sent to any Dedicated Server):

- **Client settings and bookmarks**: a new versioned, `.strict()`-zod-validated `settings.json`
  (`apps/desktop/src/main/settings/`), atomic-write and corruption-recovery disciplined like T7's own
  identity/preferences files but with its own section-by-section salvage policy (a malformed
  `screenShare` section never discards the bookmark list) -- see
  [`adr/0015-local-client-settings-and-bookmarks.md`](adr/0015-local-client-settings-and-bookmarks.md).
  A bookmark is exactly `{bookmarkId, displayName, serverAddress}`; an invite/privilege/bootstrap
  token is never persisted through this or any other path.
- **Device management**: live device enumeration/hot-plug (`navigator.mediaDevices`), and -- the one
  genuinely new `rtc-core` primitive this task needed -- `MediaTransport.replaceTrack(oldTrack,
newTrack)`, a transceiver-level swap with no renegotiation, letting `switchMicrophone`/
  `switchCamera` change the active device without leaving voice. Atomicity is mandatory and verified:
  acquire the new device, `replaceTrack`, stop the old device only after success -- a failed switch
  never disturbs a working device. A missing/unavailable preferred device is detected after the fact
  (`deviceId` is an _ideal_, not _exact_, constraint, so acquisition never rejects for it) and
  surfaced, never silently mismatched with no explanation. `setSinkId()` output-device selection is
  supported on this app's pinned Electron build and honored by both remote-audio playback paths
  (microphone and T6 screen-audio).
- **Automatic reconnect**: `RealtimeClient` gained one additive `closed` event (real WebSocket close
  code/reason); a new wrapping `ReconnectController` (never inside `RealtimeClient` itself, so the
  existing E2E scripts that construct it directly are unaffected) owns one bounded
  exponential-backoff-with-jitter retry loop, applied only to an _already-established_ session --
  a first connection attempt that fails never silently retry-loops. Every reconnect performs a
  genuinely fresh T7 handshake and T9 admission re-evaluation; the P2P mesh is fully rebuilt each
  cycle (`P2PMeshTransport.closeAll()` permanently disables an instance); voice-channel membership,
  microphone, and mute/deafen state are restored automatically, while camera and screen-video/audio
  are **never** auto-restored -- a mandatory, independently security-reviewed privacy constraint, not
  a default. See
  [`adr/0016-automatic-reconnect-and-media-restoration-policy.md`](adr/0016-automatic-reconnect-and-media-restoration-policy.md).
- **New real-Electron E2E** (`e2e:reconnect-smoke`): a real Dedicated Server is killed (SIGTERM) mid
  voice-call and restarted on the same port/data directory; both clients are proven to detect the
  loss, automatically reconnect with the _same_ `identityId` via a fresh handshake, rejoin voice with
  _fresh_ server-issued participant ids and real peer audio, correctly reload Server Chat history sent
  before the restart through the history API, and never show any evidence of camera/screen activity.
  4 consecutive clean runs. A second new E2E (`e2e:settings-persistence`) proves a bookmark and device
  preference survive a same-profile restart and never leak to a different profile.
- All nine pre-existing E2E scripts (including `e2e:text-chat-persistence` and `e2e:authorization`)
  re-verified passing against the final combined, repackaged build -- no regression. One intermittent
  `e2e:camera-smoke` failure was observed once, matching the class of pre-existing, environmental
  flakiness already documented in T6's own handoff notes (not root-caused to a specific fix there
  either); 3 consecutive clean runs followed immediately.
- `security-reviewer` found no release-blocking issues, independently verifying by direct code reading
  (not doc-trust) that camera/screen genuinely never auto-restart after a reconnect -- the single
  highest-priority claim in this task. `qa-engineer` found no product-code defects and closed three
  real test-coverage gaps (a multi-cycle backoff-reset test, a Server-A-to-Server-B reconnect-race
  test, and an `updateBookmark` token-smuggling rejection test its `addBookmark` sibling already had)
  -- see [`tasks/T11_DAILY_USE_UX.md`](tasks/T11_DAILY_USE_UX.md)'s handoff notes for the full findings
  from both reviews, including two honestly-recorded, not-fabricated coverage gaps (live device
  switching has no automated regression test today, genuinely infeasible given this environment's
  single-fake-device-per-kind Chromium setup; no E2E proves an explicit channel `leave()` is never
  restored after a later reconnect).

See [`tasks/T11_DAILY_USE_UX.md`](tasks/T11_DAILY_USE_UX.md)'s handoff notes and
[`architecture/CLIENT_SETTINGS_AND_RECONNECT.md`](architecture/CLIENT_SETTINGS_AND_RECONNECT.md) for
the full record.

Read [`tasks/STATUS.md`](tasks/STATUS.md) for the authoritative status,
[`tasks/T1_ELECTRON_SHELL.md`](tasks/T1_ELECTRON_SHELL.md) /
[`tasks/T2_REALTIME_PROTOCOL.md`](tasks/T2_REALTIME_PROTOCOL.md) /
[`tasks/T3_VOICE_WEBRTC.md`](tasks/T3_VOICE_WEBRTC.md) /
[`tasks/T4_CAMERA_STREAMING.md`](tasks/T4_CAMERA_STREAMING.md) /
[`tasks/T5_SCREEN_SHARE.md`](tasks/T5_SCREEN_SHARE.md) /
[`tasks/T6_SCREEN_AUDIO.md`](tasks/T6_SCREEN_AUDIO.md) /
[`tasks/T7_LOCAL_IDENTITY.md`](tasks/T7_LOCAL_IDENTITY.md) for their full verification records,
and [`references/VERSION_DECISIONS.md`](references/VERSION_DECISIONS.md) before changing the
toolchain — it records a real Forge/`@electron/packager` incompatibility T1 found and worked around.
[`architecture/REALTIME_PROTOCOL.md`](architecture/REALTIME_PROTOCOL.md) documents the full T2
protocol design (now extended by T7's identity-proof step); [`architecture/WEBRTC_VOICE.md`](architecture/WEBRTC_VOICE.md)
documents T3's voice/WebRTC design; [`architecture/WEBRTC_CAMERA.md`](architecture/WEBRTC_CAMERA.md)
documents T4's camera design; [`architecture/WEBRTC_SCREEN_SHARE.md`](architecture/WEBRTC_SCREEN_SHARE.md)
documents T5's screen-share design including the `mid`-based identity redesign and SDP-bound
findings; [`architecture/WEBRTC_SCREEN_AUDIO.md`](architecture/WEBRTC_SCREEN_AUDIO.md) documents T6's
system-audio design including the Electron loopback platform finding and the `Peer.handleRemoteOffer`
fix; [`architecture/CLIENT_IDENTITY.md`](architecture/CLIENT_IDENTITY.md) documents T7's local
identity design including the canonical signing payload, private-key storage, and the
Renderer/Main trust boundary.

## What does not exist?

There is no running Coturn stack (templates exist but no TURN credential minting), installer/maker
artifact, or SFU. Production configuration/TLS termination and Docker packaging for the Dedicated
Server are also not yet implemented — this work is now **T14** (see the T13 redefinition below). Real
avatars/presence/status, voice-activity/push-to-talk UX, and Discord-like stream/camera layout are
also not yet implemented — this is **T13.3-T13.5**. Voice, camera, screen-video, and screen-audio
sharing (T3–T6, P2P-mesh, small-room, self-hosted scope), local cryptographic client identity (T7),
the Dedicated Server product boundary (T8), server-local groups/permissions/tokens/bans (T9),
persistent server-side text chat (T10 — server-wide and per-voice-channel, real restart persistence,
no message editing/deletion yet), local device management/bookmarks/automatic reconnect (T11),
Windows per-application audio capture (T12 — real native WASAPI process-loopback, this repository's
first native/compiled code), the Renderer's visual/interaction foundation (T13.1 — design tokens, CSS
Modules, `lucide-react` icons, server-home/rail/channel-sidebar/chat/member-panel/bottom-control-bar
layout, replacing the previous unstyled UI with no protocol/IPC/persistence change), its visual
polish/UX refinement (T13.1.1 — a substantial Settings information-architecture redesign, a Home with
real presence, quieter hover-revealed channel actions, a Member Panel duplicate-heading fix —
presentation only, no new capability), and dynamic channel/category hierarchy and server
administration (T13.2 — categories, voice channels, subchannels, TeamSpeak-style temporary channels,
group-based Visibility/Join/Manage access control with inheritance, optional user limits and scrypt
passwords, tombstone deletion, live per-connection-filtered catalog updates, and a full Renderer admin
UI reusing the T13.1/T13.1.1 design system — all administered live from the Client, no server restart,
no hand-edited config) are all implemented, mechanism-verified, and live-verified end to end. The
product is now marketed as **OvniChat** (see [`PRODUCT.md`](PRODUCT.md)); the internal
`@disco-voador/*` package namespace is unchanged.

## What should happen next?

T13 was redefined, by explicit product direction, from a single "self-hosting production package"
task into a five-part Product Experience series (T13.1-T13.5) — see
[`tasks/STATUS.md`](tasks/STATUS.md) for the full renumbering (production self-hosting is now T14,
installer/releases T15, private-beta polish T16, SFU T17, hardening/release-candidate T18).
**T13.3 — Profiles / Avatars / Members / Presence** is next, building on the channel administration
system T13.2 established. Do not implement it until its own task document exists.

Non-blocking follow-ups still open, cheap relative to the risk they guard against: (1) ~~a
frequency-domain (e.g. dominant-frequency-near-440Hz) check for `e2e:screen-audio-smoke`'s
`E2E_SCREEN_AUDIO_OK` proof, strengthening it beyond the current RMS-only non-silence check (recorded
since T6)~~ — T12 built exactly this capability (`apps/desktop/src/renderer/voice/e2e-frequency-probe.ts`,
built for its own mandatory process-audio isolation proof), but it was never wired into
`e2e-screen-audio-smoke.mjs`'s own existing RMS check, which is T6's own separate scenario — closing
this specific gap is now a small, low-risk follow-up (reuse the existing probe, one new assertion),
not a from-scratch build; (2) `e2e:camera-smoke`'s intermittent, environmental flakiness (recorded
since T6, observed
again during T11 — see T11's own handoff notes) remains un-root-caused; a targeted failing-vs-passing
stdout trace comparison across several deliberately-provoked failures would be the next diagnostic
step if it becomes disruptive rather than occasional. (3) T11-specific: no automated regression test
exists for live microphone/camera device switching (`switchMicrophone`/`switchCamera`) — genuinely
infeasible today given this environment's single-fake-device-per-kind Chromium setup and lack of a
React testing library; a future task adding a synthetic multi-device Chromium setup could close this.
(4) T11-specific: no E2E proves an explicit voice-channel `leave()` is never restored by a later
unexpected reconnect — the underlying logic is simple and verified correct by direct reading, but has
no automated regression guard; would need a new E2E-only auto-leave hook.

Two older follow-ups are now resolved by T11, recorded here for continuity rather than silently
dropped: `ConnectionScreen`'s own `connectionError` prop (recorded since T8/T9) remains always
`undefined` by design — T11 chose a different, more general mechanism instead
(`VoiceChannelState.connectionError`, surfaced by `VoiceChannelView` once the hook has mounted, which
covers both a first-connection failure and a post-reconnect non-retryable failure uniformly) rather
than routing back to `ConnectionScreen`; see
[`architecture/CLIENT_SETTINGS_AND_RECONNECT.md`](architecture/CLIENT_SETTINGS_AND_RECONNECT.md). The
T10-recorded gap ("`ChatPanel.tsx`'s channel tab only ever targets the currently-joined voice channel,
no picker for an arbitrary channel's history without joining it") was evaluated for T11 and explicitly
deferred rather than built — the task's own spec permitted deferring it if it created disproportionate
scope, and T11 already had a large surface; still open for a future task.

## Fixed foundation decisions

- Windows desktop, Electron, React, TypeScript, Vite, and Electron Forge.
- Main/Preload/sandboxed Renderer trust boundary.
- Self-hostable core services; no mandatory SaaS.
- One internally modular realtime service may initially own signaling and text.
- Signaling/text are WebSocket (`ws`); media is WebRTC and never relayed by that service.
- Runtime validation uses `zod`, shared by `packages/protocol` and `packages/config`.
- P2P first with an SFU-ready UI/transport seam.
- Independent microphone, camera, screen-video, and screen-audio sources.
- Windows-specific media isolated in `packages/windows-media` — including, since T12, real native
  Win32/WASAPI C++ code (this repository's first) for per-application process-loopback audio
  capture, run as an out-of-process helper rather than an in-process addon, primarily for crash
  isolation (see [`adr/0017-windows-process-loopback-native-boundary.md`](adr/0017-windows-process-loopback-native-boundary.md)).
- SQLite first behind a storage boundary — implemented for the Dedicated Server's authorization
  store (T9) and its chat store (T10), both via `node:sqlite`, in two deliberately separate physical
  files (`authorization.sqlite`, `chat.sqlite` — see
  [`adr/0014-persistent-server-owned-chat-history.md`](adr/0014-persistent-server-owned-chat-history.md)).
- Local client settings/bookmarks are entirely client-local, versioned JSON, never sent to a
  Dedicated Server — implemented for the Client's own settings store (T11, see
  [`adr/0015-local-client-settings-and-bookmarks.md`](adr/0015-local-client-settings-and-bookmarks.md)).
  Automatic reconnect is a wrapping controller around `RealtimeClient`, never new states inside it,
  always performing a fresh T7 handshake, and camera/screen never auto-restart after one (T11, see
  [`adr/0016-automatic-reconnect-and-media-restoration-policy.md`](adr/0016-automatic-reconnect-and-media-restoration-policy.md)).
- VDO.Ninja/reference code follows the conservative provenance/license policy.

See accepted ADRs in [`adr/`](adr/); supersede them explicitly if evidence changes a decision.

## Decisions still open

- Concrete application state, routing, and UI component choices.
- Message editing/deletion, retention-policy configuration, and full-text search for chat (T10
  deferred all three deliberately — message ids are already shaped so deletion can be added later
  without a schema migration). Text chat's own persistence model itself is implemented and not open;
  see [`adr/0013-server-authorization-storage-and-rbac.md`](adr/0013-server-authorization-storage-and-rbac.md)
  and [`adr/0014-persistent-server-owned-chat-history.md`](adr/0014-persistent-server-owned-chat-history.md).
- Whether/when the internal `@disco-voador/*` package namespace is migrated to match the OvniChat
  product name — deliberately deferred to its own, separately verified task (not part of T10).
- Exact RTC transport API, negotiation topology, diagnostics model, and room limits.
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

T7's clean-state evidence, 2026-08-19, is the same gate with 612 Vitest tests (the same one
pre-existing, already-allowlisted high-severity dependency advisory; no new advisories) —
formatting, lint, whole-repo typecheck, `vitest run`, composite build, `verify-repository.mjs`, and
the dependency audit all pass — plus its own required real-runtime evidence: 3 consecutive
`e2e:identity-persistence` runs and 3 consecutive `e2e:identity-auth` runs, both against real
Electron processes with real `safeStorage`/DPAPI-backed identities and (for the auth E2E) a real
realtime service and real WebRTC voice; `e2e:voice-smoke`, `e2e:camera-smoke`, `e2e:screen-smoke`,
and `e2e:screen-audio-smoke` were each re-run once against the final code and confirmed green under
the now-mandatory identity handshake. **T7 is marked COMPLETE in
[`tasks/STATUS.md`](tasks/STATUS.md)** — its mechanism is implemented, reviewed (`security-reviewer`
found no release-blocking issues; `qa-engineer` review recorded in
[`tasks/T7_LOCAL_IDENTITY.md`](tasks/T7_LOCAL_IDENTITY.md)), and unit/integration/live-verified
through real DPAPI-backed key storage and a real two-instance authenticated voice session, with all
Definition of Done items satisfied. See [`tasks/T7_LOCAL_IDENTITY.md`](tasks/T7_LOCAL_IDENTITY.md)'s
handoff notes for the full record, including the canonical signing-payload design, the
`packages/identity` package-boundary decision, the anti-oracle IPC design, and the corruption/race
handling.

T8's clean-state evidence, 2026-08-19, is the same gate with 667 Vitest tests (the same one
pre-existing, already-allowlisted high-severity dependency advisory; no new advisories) —
formatting, lint, whole-repo typecheck, `vitest run`, composite build, `verify-repository.mjs`, and
the dependency audit all pass — plus its own required real-runtime evidence:
`pnpm --filter @disco-voador/dedicated-server run smoke` passed (real process spawn, real `ws`
client, full T7 handshake, server metadata/channel-catalog assertions, clean disconnect);
`e2e:connection-smoke` passed, including after being strengthened to prove the CSP fix by
deliberately connecting through an address different from the one baked in at launch; all six
pre-existing Electron E2E scripts (`e2e:voice-smoke`, `e2e:camera-smoke`, `e2e:screen-smoke`,
`e2e:screen-audio-smoke`, `e2e:identity-auth`, `e2e:identity-persistence`) were re-verified passing
against the real Dedicated Server product entrypoint. **T8 is marked COMPLETE in
[`tasks/STATUS.md`](tasks/STATUS.md)** — its mechanism is implemented, reviewed (`security-reviewer`
and `qa-engineer` each found and this task fixed one real, actionable issue — see above), and
unit/integration/live-verified through real independently-configured server instances and a real
Electron connection flow, with all Definition of Done items satisfied. See
[`tasks/T8_DEDICATED_SERVER.md`](tasks/T8_DEDICATED_SERVER.md)'s handoff notes for the full record.

T9's clean-state evidence, 2026-08-19, is the same gate with 740 Vitest tests (the same one
pre-existing, already-allowlisted high-severity dependency advisory; no new advisories — T9 added
zero new npm dependencies, since `node:sqlite` is built into the pinned Node runtime) — formatting,
lint, whole-repo typecheck, `vitest run`, composite build, `verify-repository.mjs`, and the
dependency audit all pass via one canonical `corepack pnpm check` run — plus its own required
real-runtime evidence: `pnpm --filter @disco-voador/dedicated-server run smoke` passed, now also
capturing and redeeming the real one-time bootstrap token over a real socket; `e2e:authorization`
(new, T9 Section 78) passed three consecutive clean runs (two before the post-review fixes below,
one more after, against a freshly repackaged build), proving a real Electron client's full
bootstrap/redeem/ban/reject/unban/reconnect journey with its local identity unchanged throughout;
all six pre-existing Electron E2E scripts were re-verified passing against T9's default `open`
access mode. **T9 is marked COMPLETE in [`tasks/STATUS.md`](tasks/STATUS.md)** — its mechanism is
implemented, reviewed (`security-reviewer` and `qa-engineer` each found and this task fixed one
real, non-blocking issue: a `deleteGroup`/`revokeGroup` force-disconnect symmetry gap, and a
misleading fallback WebSocket close code on a force-closed connection — see
[`tasks/T9_SERVER_AUTHORIZATION.md`](tasks/T9_SERVER_AUTHORIZATION.md)'s handoff notes for the full
findings), and unit/integration/live-verified through a real SQLite-backed authorization store, real
sockets, and a real Electron flow, with all Definition of Done items satisfied. See
[`tasks/T9_SERVER_AUTHORIZATION.md`](tasks/T9_SERVER_AUTHORIZATION.md)'s handoff notes for the full
record, including the SQLite/synchronous-atomicity storage decision, the bootstrap-on-invite-only
fix, and the Windows DPAPI relaunch bug found and fixed while building the new E2E script.

T10's clean-state evidence, 2026-08-20, is the same gate with 823 Vitest tests (the same one
pre-existing, already-allowlisted high-severity dependency advisory; no new advisories — T10 added
zero new npm dependencies) — formatting, lint, whole-repo typecheck, `vitest run`, composite build,
`verify-repository.mjs`, and the dependency audit all pass via one canonical `corepack pnpm check`
run — plus its own required real-runtime evidence: `e2e:text-chat-persistence` (new) passed **five**
consecutive clean runs across this task (two before the OvniChat naming changes, three more after,
the last two against the final, review-driven build), proving live cross-client Server Chat
delivery, a real Dedicated Server process restart against the same data directory, and a genuinely
fresh client (different profile/local identity) retrieving both Server Chat and Channel Chat
messages purely through the history API, never as a live event. All eight pre-existing Electron E2E
scripts were re-verified passing against the new chat surface — no regression. **T10 is marked
COMPLETE in [`tasks/STATUS.md`](tasks/STATUS.md)** — its mechanism is implemented, reviewed
(`security-reviewer` found one real, non-blocking issue — an overly absolute "message bodies are
never logged" doc claim, corrected to precisely scope it to server-side logs and name the one
documented client-side E2E-diagnostic exception; `qa-engineer` closed several real, pre-existing test
coverage gaps with new regression tests rather than finding product defects — see
[`tasks/T10_PERSISTENT_TEXT_CHAT.md`](tasks/T10_PERSISTENT_TEXT_CHAT.md)'s handoff notes for the full
findings), and unit/integration/live-verified through two real, deliberately separate SQLite stores,
real sockets, and a real multi-instance Electron flow, with all Definition of Done items satisfied.
See [`tasks/T10_PERSISTENT_TEXT_CHAT.md`](tasks/T10_PERSISTENT_TEXT_CHAT.md)'s handoff notes for the
full record, including the storage-topology decision (ADR 0014) and the OvniChat product-naming
correction.

T11's clean-state evidence, 2026-08-20, is the same gate with 913 Vitest tests (the same one
pre-existing, already-allowlisted high-severity dependency advisory; no new advisories — T11 added
zero new npm dependencies) — formatting, lint, whole-repo typecheck, `vitest run`, composite build,
`verify-repository.mjs`, and the dependency audit all pass via one canonical `corepack pnpm check`
run — plus its own required real-runtime evidence: `e2e:reconnect-smoke` (new) passed **4** consecutive
clean runs (3 before the final combined build, 1 more against it), proving a real Dedicated Server
process killed and restarted on the same port/data directory is automatically recovered from by both
clients with a fresh T7 handshake (same `identityId`), voice-channel restoration with fresh
server-issued participant ids and real peer audio, correct Server Chat history reload through the
history API, and confirmed camera/screen never auto-restarting; `e2e:settings-persistence` (new)
passed, proving a bookmark and device preference survive a same-profile restart and never leak to a
different one; the Dedicated Server's own smoke test and all eight pre-existing Electron E2E scripts
(`e2e:voice-smoke`, `e2e:camera-smoke`, `e2e:screen-smoke`, `e2e:screen-audio-smoke`,
`e2e:identity-auth`, `e2e:identity-persistence`, `e2e:connection-smoke`, `e2e:authorization`,
`e2e:text-chat-persistence`) were re-verified passing against the final, combined, repackaged build —
no regression. One intermittent `e2e:camera-smoke` failure was observed once, matching the
already-documented pre-existing environmental flakiness class from T6's own handoff notes (not
root-caused there either); 3 consecutive clean runs followed immediately. **T11 is marked COMPLETE in
[`tasks/STATUS.md`](tasks/STATUS.md)** — its mechanism is implemented, reviewed (`security-reviewer`
found no release-blocking issues, independently verifying by direct code reading that camera/screen
genuinely never auto-restart after a reconnect — the single highest-priority claim in this task;
`qa-engineer` found no product-code defects and closed three real test-coverage gaps, honestly
recording two further gaps as not fabricated rather than built ad hoc — see
[`tasks/T11_DAILY_USE_UX.md`](tasks/T11_DAILY_USE_UX.md)'s handoff notes for the full findings), and
unit/integration/live-verified through a real Dedicated Server restart, real sockets, and a real
multi-instance Electron flow, with all Definition of Done items satisfied. See
[`tasks/T11_DAILY_USE_UX.md`](tasks/T11_DAILY_USE_UX.md)’s handoff notes for the full record, including
the settings-store and reconnect-controller placement decisions (ADR 0015/0016) and the two
honestly-documented, not-yet-closed test-coverage gaps.

T12’s clean-state evidence is the same gate with 1019 Vitest tests (up from T11’s 913; the same one
pre-existing, already-allowlisted high-severity dependency advisory; no new npm dependencies — T12’s
only new dependency is a compiled native `.exe`, gitignored and never committed, built reproducibly
from source via its own `build.ps1`) — formatting, lint, whole-repo typecheck, `vitest run`, composite
build, `verify-repository.mjs`, and the dependency audit all pass via one canonical `corepack pnpm
check` run — plus its own required real-runtime evidence: `e2e:process-audio-smoke` (new), the
mandatory non-negotiable acceptance proof, passed **3 consecutive clean runs on the final,
security-fixed code** (a 4th followed immediately after a fully clean from-scratch native rebuild and
repackage, for good measure), each run measuring 68-78 dB of real frequency-domain isolation margin
(against a 20 dB minimum threshold) between two genuinely independent real Windows processes, in
both selection directions, across all four scenarios (dual-direction isolation, mid-share mic-mute/
clean-stop lifecycle, target-process-exit cleanup with a real orphan-helper-process check); all ten
pre-existing Electron E2E scripts (`e2e:voice-smoke`, `e2e:camera-smoke`, `e2e:screen-smoke`,
`e2e:screen-audio-smoke`, `e2e:identity-persistence`, `e2e:settings-persistence`,
`e2e:connection-smoke`, `e2e:authorization`, `e2e:text-chat-persistence`, `e2e:reconnect-smoke`) were
re-verified passing against the final, combined, repackaged build — no regression, including
`e2e:screen-audio-smoke` confirming T6’s system-wide loopback path is unaffected by T12’s new
process-scoped path sharing the same `screen-audio` semantic source. **T12 is marked COMPLETE in
[`tasks/STATUS.md`](tasks/STATUS.md)** — its mechanism is implemented, reviewed (`security-reviewer`
found and this task fixed a real PID-reuse TOCTOU gap — a bare `pid` was trusted at capture-start time
with no check it still named the process the user actually selected, closed by cross-checking the
enumerated exe name against the resolved PID’s real exe name inside the native helper itself, before
any activation call — plus a low-priority `postMessage` targetOrigin hardening; `qa-engineer` found
and closed a real, load-bearing test-coverage gap — the Main-process integration module
(`main/process-audio.ts`) enforcing capability fail-narrow behavior, single-supervisor exclusivity,
and the TOCTOU fix itself had _zero_ direct tests before this pass — plus a missing E2E
`package.json` script entry and stale handoff notes; see
[`tasks/T12_WINDOWS_PROCESS_AUDIO.md`](tasks/T12_WINDOWS_PROCESS_AUDIO.md)’s handoff notes for the
full findings from both reviews), and unit/integration/live-verified through a real out-of-process
native Win32/WASAPI helper (this repository’s first native/compiled code), real named-pipe IPC, real
WebRTC, and a real multi-instance Electron flow, with all Definition of Done items satisfied. See
[`tasks/T12_WINDOWS_PROCESS_AUDIO.md`](tasks/T12_WINDOWS_PROCESS_AUDIO.md)’s handoff notes for the
full record, including the native-helper-vs-addon decision (ADR 0017) and one honestly-documented,
not-yet-closed follow-up (the E2E harness proves "no silent fallback to System Audio" only indirectly
via the isolation-margin proof, not as its own direct assertion — recorded as a future strengthening,
not implemented this pass).

T13.1’s clean-state evidence is the same gate with 1085 Vitest tests (up from T12’s 1019; the same
one pre-existing, already-allowlisted high-severity dependency advisory — T13.1’s new dependencies
(`lucide-react`, and root-level `@testing-library/react`/`@testing-library/dom`/
`@testing-library/jest-dom`/`jsdom`) introduced zero new advisories) — formatting, lint, whole-repo
typecheck, `vitest run`, composite build, `verify-repository.mjs`/`verify-architecture.mjs`, and the
dependency audit all pass via one canonical `corepack pnpm check` run — plus its own required
real-runtime evidence: a new `e2e:product-shell-smoke` passed, proving the full journey (fresh
profile, nickname, two bookmarks, Home showing both, connect, select-without-joining a channel’s
chat, real explicit Join, Settings open/close, a real `disconnect()`→`connectTo()` switch to a second
server with a verified fresh `AppShell`/`VoiceChannelView` mount — the remount-key fix’s own proof —
and a clean return toward Home with both bookmarks intact) through a real Electron instance and two
real Dedicated Servers; all twelve pre-existing Electron E2E scripts (`e2e:voice-smoke`,
`e2e:camera-smoke`, `e2e:screen-smoke`, `e2e:screen-audio-smoke`, `e2e:process-audio-smoke`,
`e2e:identity-auth`, `e2e:identity-persistence`, `e2e:connection-smoke`, `e2e:authorization`,
`e2e:text-chat-persistence`, `e2e:settings-persistence`, `e2e:reconnect-smoke`) were re-verified
passing against the final, security-fixed, repackaged build — no regression, confirming the visual
redesign changed presentation only. Five real screenshots from an actual packaged Electron instance
(Home at 1920×1080, connected workspace at 1920×1080 and 1366×768, Settings, and a
collapsed-member-panel state) were captured and personally visually reviewed twice — once before and
once after the post-review fixes below, since the first pass surfaced two real defects a screenshot
alone made visible (see below). **T13.1 is marked COMPLETE in [`tasks/STATUS.md`](tasks/STATUS.md)**
— its foundation is implemented, reviewed (`security-reviewer` found four real, low-severity,
non-blocking issues, all fixed in this task: a stale-form-state bug in the Add/Edit Server dialog, a
quadratic unmemoized chat-message-grouping DoS risk, a redundant chat-history-refetch-on-thread-switch
rate-limit amplifier, and one unpinned dependency range; `qa-engineer` found and fixed one further
real bug — `MainContent` mounting `ChatView` without a per-thread key, letting an unsent composer
draft leak across a chat-target switch — and wrote this repository’s first Renderer component-test
suite, 62 tests across 12 files, plus the new E2E script), and the task’s own visual review
independently found and fixed two further real defects visible only in an actual screenshot: the
local user never appearing in their own member/participant lists (a real, already-built `isSelf`/
"(you)" rendering path with nothing to render against, since `state.participants` only ever held
_other_ participants — fixed by synthesizing a self entry from data already owned for real, not
fabricated), and the cryptographic Identity ID/"Regenerate Identity" action being prominent in the
main Settings flow rather than tucked into Advanced as the task explicitly required — fixed by
relocating the existing `IdentityPanel` into the Advanced section. All Definition of Done items are
satisfied. See [`tasks/T13_1_VISUAL_FOUNDATION.md`](tasks/T13_1_VISUAL_FOUNDATION.md)’s handoff notes,
[`architecture/PRODUCT_UI_FOUNDATION.md`](architecture/PRODUCT_UI_FOUNDATION.md) for the full design
record, and [`adr/0018-renderer-ui-foundation-css-modules-and-component-layering.md`](adr/0018-renderer-ui-foundation-css-modules-and-component-layering.md)
for the styling/component-architecture decision, including the real `TS2882`/pattern-ambient-module
diagnostic trail and the React-19-batching remount-key fix.

T13.1.1’s clean-state evidence is the same gate with 1122 Vitest tests (up from T13.1’s 1085; the
same one pre-existing, already-allowlisted high-severity dependency advisory — T13.1.1 introduced
zero new npm dependencies, pure CSS/JSX/data) — formatting, lint, whole-repo typecheck, `vitest run`,
composite build, `verify-repository.mjs`, and the dependency audit all pass via one canonical
`corepack pnpm check` run — plus its own required real-runtime evidence: `e2e:product-shell-smoke`,
`e2e:settings-persistence`, and `e2e:text-chat-persistence` re-run against the final, fully-fixed
build all pass; `e2e:voice-smoke`, `e2e:camera-smoke`, `e2e:screen-smoke`, `e2e:screen-audio-smoke`,
`e2e:connection-smoke`, `e2e:identity-auth`, `e2e:identity-persistence`, `e2e:authorization`, and
`e2e:reconnect-smoke` all passed against a T13.1.1 build differing from the final one only in
`SettingsPanel.tsx`/`IdentityPanel.tsx`/`ServerHome.tsx` (none of those nine scripts’ own code paths
touch those files). `e2e:process-audio-smoke` failed identically on five consecutive attempts during
this task’s final regression sweep; `git log` confirms neither T13.1 nor T13.1.1 touched
`packages/windows-media`, `main/process-audio.ts`, or the script itself since T12’s own completion —
recorded as a pre-existing, machine-specific limitation of this session’s environment, the same
non-blocking-flakiness class T6/T11 already documented for `e2e:camera-smoke`, not a T13.1.1
regression. Ten real screenshots from an actual packaged Electron instance (Home; connected workspace
at 1920×1080, 1366×768, and the required intermediate 1600×900; Settings’ three redesigned sections;
the collapsed Member Panel; the Add Server dialog; and a real multi-sender chat with grouping/
wrapping/emoji) were captured and personally visually reviewed twice — once before and once after two
real defects the first review pass surfaced. **T13.1.1 is marked COMPLETE in
[`tasks/STATUS.md`](tasks/STATUS.md)** — its polish pass is implemented, reviewed (`security-reviewer`
found two real, low-severity, non-blocking issues, both fixed: a mic-test capture left running with no
visible stop control after switching Settings sections, and the cryptographic Identity ID/"Regenerate
Identity" being reachable from Home with no Advanced-equivalent framing, unlike the same content
inside Settings — fixed by giving `IdentityPanel` a closed-by-default disclosure for exactly this
case; `qa-engineer` found and fixed one further real bug — two Settings fields nesting their hint text
inside the same `<label>` as the control, polluting the accessible name announced to screen readers),
and the task’s own visual-review pass independently found and fixed the same two security-review
defects via real screenshot inspection before the formal review even ran. All Definition of Done items
are satisfied except the one honestly-recorded, diff-unrelated `e2e:process-audio-smoke` limitation
above. See [`tasks/T13_1_1_VISUAL_POLISH.md`](tasks/T13_1_1_VISUAL_POLISH.md)’s handoff notes and
[`architecture/PRODUCT_UI_FOUNDATION.md`](architecture/PRODUCT_UI_FOUNDATION.md)’s own T13.1.1 section
for the full record.

T13.2’s clean-state evidence is the same gate with 1258 Vitest tests (up from T13.1.1’s 1122; the
same one pre-existing, already-allowlisted high-severity dependency advisory — T13.2 introduced zero
new npm dependencies) — formatting, lint, whole-repo typecheck, `vitest run`, composite build,
`verify-repository.mjs`, and the dependency audit all pass via one canonical `corepack pnpm check`
run — plus its own required real-runtime evidence: four new E2E scripts (`e2e:channel-admin-smoke`,
`e2e:channel-hidden-smoke`, `e2e:channel-temporary-smoke`, `e2e:reconnect-channel-smoke`) each passed
against the final, security-fixed, repackaged build, proving (respectively) a full nested
category/channel/subchannel administration journey including a live ACL grant and a live
rename/reparent observed with no reconnect, wrong-then-right password join, and the password never
persisted to disk; a fully hidden category+channel never appearing in a Guest’s raw incoming messages,
with joining/reading-admin-details/reading-chat-history for the real (guessed) hidden ID all
byte-identical in rejection shape to a genuinely nonexistent ID; a temporary channel’s full lifecycle
(appears on creation, survives while occupied, destroyed with a real chat-history purge the instant it
empties, never returns after a restart); and the three new offline-mutation reconnect cases
(deleted/ACL-denied/password-added) each reconnecting the whole connection successfully while
correctly declining to silently restore voice. `e2e:reconnect-smoke` (T11, unmodified) re-confirmed
the fourth, still-allowed-restore case. All twelve pre-existing Electron E2E scripts
(`e2e:product-shell-smoke`, `e2e:text-chat-persistence`, `e2e:authorization`, `e2e:connection-smoke`,
`e2e:identity-auth`, `e2e:identity-persistence`, `e2e:settings-persistence`, `e2e:voice-smoke`,
`e2e:camera-smoke`, `e2e:screen-smoke`, `e2e:screen-audio-smoke`, `e2e:process-audio-smoke`) were
re-verified passing against the final code — no regression, including `e2e:process-audio-smoke`
passing cleanly across all four of its scenarios on this run (the class of environmental flakiness
recorded since T6/observed again in T13.1.1 did not reproduce this time). Thirteen real screenshots
from an actual packaged Electron instance (the full admin hierarchy at 1920×1080; the admin context
menu; Create/Edit Channel; Create Category; Move Channel; the ACL editor with a real Selected-Groups
checkbox list and inheritance note; the password-join prompt; a temporary channel; Server Settings’
Channels and Groups & Permissions pages; a genuine no-permission Guest’s sidebar; and the admin
workspace at 1366×768) were captured and personally visually reviewed, surfacing and fixing two real,
minor defects (channel/category names truncating with no way to see the full name — fixed with
`title` tooltips and matching CSS ellipsis handling on the category header) and honestly recording one
pre-existing, out-of-scope rough edge left unfixed (the reused T9 Groups & Permissions panel shows raw
permission-key strings rather than human labels — predates T13.2, and rewriting it would cross this
task’s own “do not rewrite working T9 behavior” boundary). **T13.2 is marked COMPLETE in
[`tasks/STATUS.md`](tasks/STATUS.md)** — its mechanism is implemented, reviewed (`security-reviewer`
found and this task fixed one real, high-severity issue — four Manage-gated channel-administration
handlers authorized a caller without first checking Visibility, letting a node-local delegated-Manage
grant leak a Visibility-hidden node’s existence/admin-detail content; fixed to check visibility first,
matching the pattern the Move/Delete handlers already used correctly, with a dedicated regression test
covering all six node-addressing actions; three lower-severity findings — parent-Manage delete/move
semantics, per-connection password rate limiting, temporary-channel idle-pruning cadence — were
reviewed and accepted as already-deliberate, documented tradeoffs rather than gaps. `qa-engineer`
exercised every admin scenario through real component tests against actual rendered UI, found and
fixed one narrow CSS overflow defect for long group names, and added 19 new tests, including a new
`voice-channel-view-wiring.test.tsx` proving the selected-channel-removed fallback and Server Settings
gating are genuine UI wiring, not just isolated pure functions. A separate UI-authorization defect —
“Move Channel” gated on Manage-over-the-node-itself instead of Manage-over-the-parent, exactly
backwards from `handleChannelMove`’s real requirement — was found during this task’s own final
code review and fixed, with both affected component tests corrected and two new ones added
distinguishing the two Manage scopes), and unit/integration/live-verified through a real third SQLite
store, real sockets, and a real multi-instance Electron flow, with all Definition of Done items
satisfied. See [`tasks/T13_2_CHANNEL_ADMINISTRATION.md`](tasks/T13_2_CHANNEL_ADMINISTRATION.md)’s
handoff notes and
[`architecture/CHANNELS_AND_SERVER_ADMINISTRATION.md`](architecture/CHANNELS_AND_SERVER_ADMINISTRATION.md)
for the full record, including the storage/ACL/password/temporary-channel/tombstone design (ADR 0019),
the security-fix detail, and the Renderer admin-UI summary.

Then perform the task’s required manual/platform checks. Apply
[`DEFINITION_OF_DONE.md`](DEFINITION_OF_DONE.md) and update status only when every applicable item
is evidenced. Electron-surface tasks specifically need actual Windows Electron start/quit and
packaged-artifact smoke tests; a passing TypeScript build alone is not a packaging claim.
