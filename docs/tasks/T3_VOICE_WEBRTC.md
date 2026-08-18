# T3 — Voice channels and microphone WebRTC vertical slice

## Goal

Deliver the first complete voice-call vertical slice: predefined voice channels, microphone capture,
P2P WebRTC between channel participants, WebRTC signaling carried over the T2 realtime service, and
remote audio playback. Two real Electron desktop clients must be able to join the same voice channel
and hear each other's live microphone audio.

## Context

T1 delivered the secure Electron shell. T2 delivered the connection/handshake/heartbeat protocol
foundation with no voice/media semantics. ADR 0006 already accepted "P2P first with an SFU-ready
seam" as the transport direction; T3 is the first task to actually build against that seam.

## In scope

- `packages/protocol`: `voice:*` and `webrtc:*` message schemas, new non-fatal error codes
  (`CHANNEL_NOT_FOUND`, `NOT_IN_VOICE_CHANNEL`, `SIGNALING_TARGET_INVALID`).
- `services/realtime`: a hardcoded voice-channel catalog, an in-memory `VoiceRegistry`
  (membership, join/leave, signaling-target resolution), and protocol handlers wiring `voice:*`/
  `webrtc:*` into the existing connection/routing model.
- `packages/rtc-core`: environment-neutral `MediaTransport`/`SignalingPort`/`P2PMeshTransport`/
  `Peer`/ICE-candidate-queueing — no Electron/React/Windows dependency.
- `packages/media-core`: `acquireMicrophone()` and mute/stop semantics — no Electron/native
  dependency.
- `apps/desktop`: Renderer realtime-client WebSocket wrapper, voice-channel UI (channel list,
  join/leave, participant list, mute/deafen, remote audio playback), microphone permission gating,
  CSP `connect-src` allowlisting the configured realtime origin, an automated two-Electron-instance
  fake-media smoke test.

## Out of scope

Camera, screen sharing, system audio, text chat, SQLite, authentication/accounts, an SFU, speaking
indicators, device selection UI, per-participant volume, TURN credential minting, connection
recovery/ICE-restart (T8), production TLS/deployment topology (T10).

## Architecture constraints

- `packages/rtc-core`/`packages/media-core` stay free of Electron, React, Windows APIs, and
  mesh-specific UI assumptions (ADR 0006) — the Renderer talks to semantic participants and media
  publications, never peer connections.
- Text/signaling only over the realtime service; media is WebRTC end-to-end, never relayed.
- `participantId` is always server-generated; a client's own signaling identity is never trusted
  from the wire (see `docs/architecture/WEBRTC_VOICE.md`'s server-authoritative identity section).
- Offer/answer ownership is decided by exactly one deterministic rule (existing member = initiator
  toward a newcomer); no glare-avoidance/rollback logic is needed because of it.
- The realtime server URL is operator/deployment configuration, never a Renderer-editable field, so
  CSP `connect-src` can allowlist one exact origin.
- Chromium's fake-media-device switches and any E2E auto-join config are gated behind both an
  explicit env var and `!app.isPackaged` — a packaged build can never activate either regardless of
  environment variables.

## Relevant packages

- `packages/protocol`, `services/realtime`, `packages/rtc-core`, `packages/media-core`,
  `apps/desktop`

## Relevant agents

- `realtime-backend-engineer` for `voice:*`/`webrtc:*` signaling and `VoiceRegistry`;
- `webrtc-media-engineer` for `packages/rtc-core`/`packages/media-core`;
- `electron-desktop-engineer`-scoped work (done directly by the orchestrator this task, per the
  tightly-coupled-to-existing-T1-code exception) for desktop wiring;
- `security-reviewer` for the new signaling surface, permission gating, and E2E-flag gating;
- `qa-engineer` for test-coverage evidence.

## Relevant skills

`project-orientation`, `planning-feature`, `webrtc-development`, `realtime-protocol`,
`testing-quality`, `security-review`.

## Acceptance criteria

- `packages/protocol` exports typed, `zod`-validated `voice:*`/`webrtc:*` schemas following T2's
  envelope/versioning/error conventions.
- `services/realtime` accepts `voice:join`/`voice:leave`, maintains channel membership, forwards
  `webrtc:offer`/`answer`/`ice-candidate` only within a shared channel with a server-verified
  source identity, and cleans up membership on abrupt disconnect.
- `packages/rtc-core` implements a P2P mesh `MediaTransport` with deterministic offer/answer
  ownership, ICE candidate queueing, and graceful teardown, independent of Electron/React/Windows.
- `packages/media-core` implements audio-only microphone acquisition with mute (never
  stop/reacquire) and stop semantics.
- The Electron desktop app: requests microphone permission only for audio and only from its own
  origin; joins a voice channel from the UI; establishes real `RTCPeerConnection`s to every other
  participant in the same channel; plays remote audio.
- **Two real Electron clients must establish a real WebRTC connection and receive each other's
  microphone audio tracks.** This is the actual completion bar — not that the protocol compiles or
  SDP moves through the WebSocket.
- Root `pnpm check` passes; T1/T2 remain green.

## Required tests

- Protocol: schema validation for every new message (valid/invalid/extra-field cases).
- Realtime: `VoiceRegistry` unit tests (join/leave/switch/signaling-target resolution); real-socket
  integration tests for the full join → notify → signal → leave/disconnect flow with two and three
  simultaneous clients.
- `rtc-core`/`media-core`: unit tests against hand-written fakes (`RtcPeerConnectionLike`, fake
  `getUserMedia`) covering offer/answer role assignment, ICE queueing, state-change forwarding,
  teardown idempotency, track publish/unpublish fan-out, and microphone constraint/error/mute
  semantics.
- Desktop: `RealtimeClient` tests against a hand-written `FakeWebSocket` (handshake, voice
  join/leave message shape, `SignalingPort` implementation, inbound signal dispatch, malformed-input
  containment); updated IPC/permission/CSP/protocol-handler tests for the new signatures.
- An automated two-Electron-instance fake-media smoke test proving a real, non-silent remote audio
  track arrives at each side (not merely that a track object exists).
- Mandatory manual two-Electron-instance verification on real hardware.

## Manual verification

Launch two real Electron instances (packaged or `electron-forge start`), each pointed at the same
running realtime service, join the same voice channel from each, and confirm each instance's
speakers/monitor genuinely carries the other instance's live microphone audio — "A must hear B, B
must hear A." Record the exact steps, environment, and result.

## Definition of Done

Meet all acceptance criteria, applicable items in
[`../DEFINITION_OF_DONE.md`](../DEFINITION_OF_DONE.md), security review, QA review, and actual
two-instance runtime verification (not Vitest alone). Update
[`../architecture/WEBRTC_VOICE.md`](../architecture/WEBRTC_VOICE.md),
[`../architecture/REALTIME_PROTOCOL.md`](../architecture/REALTIME_PROTOCOL.md),
[`../ARCHITECTURE.md`](../ARCHITECTURE.md), [`../SECURITY.md`](../SECURITY.md), and
[`../CONFIGURATION.md`](../CONFIGURATION.md).

## Handoff notes

**Status: implemented, unit/integration-tested, and code-reviewed — but the live two-instance
real-audio acceptance criterion above has NOT been verified in this session.** This is a real,
open gap, not a formality — see below.

### What is real and verified

- `packages/protocol`'s `voice:*`/`webrtc:*` schemas and `services/realtime`'s `VoiceRegistry`/
  protocol-handler wiring: verified with real (non-mocked) WebSocket integration tests — two and
  three simultaneous real clients, channel switching, abrupt disconnect cleanup, cross-channel
  signaling rejection, unknown-target rejection.
- `packages/rtc-core`/`packages/media-core`: implemented by the `webrtc-media-engineer` agent
  against a precise interface contract, with unit tests against hand-written fakes (a fake
  `RtcPeerConnectionLike` mirroring this repo's existing "minimal fake implementing only what's
  called" convention, and a fake `getUserMedia`) — 89 tests, covering offer/answer role assignment,
  ICE queueing (including a queued end-of-candidates `null`), race-safety (`close()` racing an
  in-flight negotiation step), teardown idempotency, and track fan-out. The agent's own report is
  explicit that real SDP generation/parsing, real ICE gathering, an actual two-peer connection
  reaching `'connected'`, and a real remote track arriving end-to-end are **not** verifiable under
  Vitest's Node environment (no native `RTCPeerConnection`) and require a real Electron runtime.
- Desktop integration (`apps/desktop/src/main/*`, `renderer/realtime/realtime-client.ts`,
  `renderer/voice/*`): unit-tested with a hand-written `FakeWebSocket` (17 tests) plus updated
  IPC/permission/CSP tests. A real bug was found and fixed this way: `RealtimeClient.disconnect()`
  double-emitted `'stateChange':'closed'` (once manually, once via the `'close'` listener it also
  triggers) — fixed by removing the manual emit and relying solely on the listener, so a
  client-initiated close and a server-initiated close now go through exactly one code path.
- Full repo: 331 Vitest tests passing, `pnpm typecheck`/`pnpm lint`/`pnpm format:check`/`pnpm build`/
  `node scripts/verify-repository.mjs`/`node scripts/verify-secrets.mjs`/`pnpm audit --audit-level
high` all clean (the one high-severity advisory is the pre-existing, already-documented
  `extract-zip` patch exception from T1 — see `references/VERSION_DECISIONS.md`; T3 introduced no
  new advisories).

### Security and QA review (both run before this handoff)

`security-reviewer` and `qa-engineer` independently reviewed the full T3 diff. Every actionable
finding was addressed:

- **Real bug, fixed — unbounded voice-channel membership:** `voice:joined`'s `participants` snapshot
  was always capped at 64 entries (`MAX_CHANNEL_PARTICIPANTS`, `packages/protocol/src/messages/voice.ts`),
  but `VoiceRegistry.join` enforced no membership cap at all — a 65th joiner to the same channel would
  get a `voice:joined` reply its own schema forbids, silently dropped client-side by
  `parseServerMessage`, leaving the server believing it joined while the client never learns its own
  `participantId`. Fixed: `VoiceRegistry.join` now rejects a join past `MAX_CHANNEL_PARTICIPANTS`
  with a new non-fatal `CHANNEL_FULL` error code (same one-source-of-truth constant, same
  non-fatal-by-omission pattern as the other T3 error codes) — checked _before_ leaving any previous
  channel, so a rejected switch never partially mutates state. New tests in
  `tests/realtime/voice-registry.test.ts` cover the boundary, a full channel still accepting a
  same-channel re-join, and a full channel correctly rejecting an outside switch-in.
- **Real bug, fixed — microphone leak on unmount-during-acquisition race:** `use-voice-channel.ts`'s
  `join()` captures the transport reference before `await acquireMicrophone()`; if the component
  unmounts (or `realtimeConfig` changes) while that await is pending, the effect cleanup's
  `microphoneRef.current?.stop()` runs while the ref is still empty — the microphone had not been
  assigned yet — so nothing is stopped, and when `getUserMedia` later resolves the code would have
  set `microphoneRef.current` and published a track to an already-torn-down transport, leaking the
  real hardware microphone (mic indicator stays lit) with no code path left that could ever stop it.
  Fixed: after the `await`, `join()` now checks whether `transportRef.current` still matches the
  transport it captured; if not, it stops the newly-acquired microphone immediately and returns
  instead of touching the stale transport or ref.
- **Real gap, fixed — the new E2E-smoke exit hook wasn't gated like its sibling flags:**
  `armE2EVoiceSmokeExit` (relays the app's own console output to stdout and can force `app.exit()`)
  was gated only by its env var, unlike `e2eFakeMediaRequested`/`e2eVoiceAutoJoin`, which both also
  require `!app.isPackaged`. Fixed by adding the same gate. Deliberately did **not** apply the same
  gate to the pre-existing T1 `armSmokeTestExit`/`isSmokeTest`, despite the reviewer's suggestion to
  do so for consistency: `apps/desktop/scripts/smoke.mjs` specifically exercises the _packaged_ `.exe`
  to prove packaging itself works, and gating it behind `!app.isPackaged` would have silently broken
  that already-working, already-documented T1 verification path — confirmed by checking what
  `smoke.mjs` actually launches before applying the suggestion.
- **False-negative-adjacent notes, not fixed:** the reviewer's Informational finding (live-audio
  verification outstanding) restates this document's own "What could not be verified" section, not a
  new gap. QA's coverage-gap note about `use-voice-channel.ts`/`VoiceChannelView.tsx` having no
  executable test coverage was investigated and confirmed genuinely infeasible without adding a new
  `jsdom`/React-testing-library devDependency this repo does not currently have (`vitest.config.ts`
  runs under Node, no DOM) — flagged as a follow-up decision rather than silently accepted, not
  addressed in this task.

### What could not be verified in this session, and why

Both the automated `apps/desktop/scripts/e2e-voice-smoke.mjs` and manual two-instance verification
require launching real Electron/Chromium windows and keeping them alive for more than a few seconds.
This session's tool environment cannot do that: **any** Electron window — packaged or unpackaged,
with or without WebRTC/fake-media involved — reliably crashes its GPU process and network service
(`content\browser\gpu\gpu_process_host.cc` exit code 143, `network_service_instance_impl.cc`
"crashed or was terminated") within roughly 1-3 seconds of launch. This was isolated methodically,
not assumed:

1. First suspected `app.isPackaged` gating (a real, separate bug — see below) and `ELECTRON_RUN_AS_NODE=1`
   being set in the shell (a real, separate bug — see below); both were found and fixed.
2. After fixing both, the crash persisted identically.
3. Isolated to specific command-line switches (`--use-fake-device-for-media-stream` +
   `--use-fake-ui-for-media-stream` together) — still crashed with only one switch removed.
4. Tried `--disable-gpu`, `--no-sandbox`, `--disable-gpu-sandbox`, `--in-process-gpu`, `--use-gl=swiftshader`,
   and combinations — the network-service crash persisted through every combination (the GPU-process
   crash specifically was avoidable with `--in-process-gpu`, but the network-service crash was not).
5. Conclusively isolated by running a **plain, idle, packaged build with zero smoke/E2E/fake-media
   flags at all**, kept alive 15 seconds: it crashed identically. This proves the instability is a
   property of this tool environment sustaining any long-lived Electron/Chromium process, unrelated
   to this implementation, fake media, WebRTC, or networking code.

Two real, unrelated bugs were found and fixed during this investigation and are worth keeping
regardless of the environment issue:

- **`ELECTRON_RUN_AS_NODE=1`** was set in this session's shell, which makes the `electron` binary run
  as a plain Node process (no window, no IPC, silently) instead of the real app. Not a code bug, but
  `apps/desktop/scripts/e2e-voice-smoke.mjs` now explicitly clears it in the spawned child's
  environment defensively, in case a future CI/dev shell has it set too.
- **The E2E smoke script originally launched the _packaged_ `.exe`**, which always has
  `app.isPackaged === true` — meaning `DISCO_VOADOR_E2E_FAKE_MEDIA`/`DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL`
  (gated to `!app.isPackaged` by design) could never activate, so the script as originally written
  could never have passed on _any_ machine, healthy environment or not. Fixed to launch the
  unpackaged app (the `electron` binary pointed directly at `apps/desktop`, each instance given its
  own temporary `--user-data-dir` to avoid disk-cache lock contention between the two).

### What is required before T3 can be marked COMPLETE

Run, on ordinary (non-sandboxed) Windows hardware with a real display/GPU:

1. `pnpm --filter @disco-voador/realtime run build`, then
   `pnpm --filter @disco-voador/desktop exec electron-forge package` (builds `.vite/build/`), then
   `pnpm --filter @disco-voador/desktop run e2e:voice-smoke`.
2. The manual two-instance verification described in [Manual verification](#manual-verification)
   above.

Both should be straightforward given everything else already passes; this is flagged as the one
concrete remaining step, not a redesign.
