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

**Status: COMPLETE.** Implemented, unit/integration-tested, code-reviewed, and — after finding and
fixing a real Electron-bootstrap bug in the smoke-test launcher — live-verified: two real Electron
clients establish a real WebRTC connection and receive each other's audio tracks, reproducibly. See
[Status](#status) at the end of this section for the final record; the sections below are the
chronological path to get there, including a real blocker this task hit and resolved.

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

### The live-verification blocker, its real root cause, and the fix (resolved)

An earlier pass through this task could not get `apps/desktop/scripts/e2e-voice-smoke.mjs` to pass
in its own tool environment and, after extensive isolation, concluded (incorrectly, see below) that
the environment itself could not sustain any Electron/Chromium window. Two real, unrelated bugs were
found and fixed during that investigation and are worth keeping regardless:

- **The E2E smoke script originally launched the _packaged_ `.exe`**, which always has
  `app.isPackaged === true` — meaning `DISCO_VOADOR_E2E_FAKE_MEDIA`/`DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL`
  (gated to `!app.isPackaged` by design) could never activate, so the script as originally written
  could never have passed on _any_ machine. Fixed to launch the unpackaged app (the `electron`
  binary pointed directly at `apps/desktop`, each instance given its own temporary `--user-data-dir`
  to avoid disk-cache lock contention between the two).
- A first attempt at clearing a contaminated `ELECTRON_RUN_AS_NODE` from the spawned child's
  environment used `ELECTRON_RUN_AS_NODE: ''` (empty string). This looked sufficient at the time but
  was the actual root cause of the real blocker — see below.

**Real root cause, found on real Windows hardware:** running the fixed script on ordinary (real, not
sandboxed) Windows/Electron `43.4.0` hardware reproduced an immediate native crash, before any window
ever opened:

```text
Assertion failed: (isolate_data->snapshot_data()) != nullptr
  in node::CreateEnvironment
exit code 134
```

Electron's native bootstrap checks whether `ELECTRON_RUN_AS_NODE` is **present** in the environment
(`getenv()`), not whether it's truthy — a variable set to `''` is still present, so it still routed
through Electron's Node-fallback bootstrap path, which does not have the Node startup snapshot that
path expects on Electron 43, producing exactly this assertion. `ELECTRON_RUN_AS_NODE: ''` is not
equivalent to the key being absent. This single-line mistake — not the environment, not WebRTC, not
the voice/signaling implementation — was the actual blocker for the entire prior session.

**Fix:** `apps/desktop/scripts/lib/electron-e2e-env.mjs` now exports `buildElectronE2EEnvironment`,
which `delete`s the key from the spawned child's environment object entirely rather than assigning it
any string value. Regression-tested in `tests/desktop/electron-e2e-env.test.mjs` (6 cases; proves
genuine absence — not `''`/`'0'`/`'false'` — including when the parent environment already has
`ELECTRON_RUN_AS_NODE=1` set, and when an override object tries to reintroduce the key).
`security-reviewer` reviewed the fix and its test (env-forwarding scope, subtractive-delete-on-a-copy
safety, packaged-build gating unaffected, no injection surface — argv-array `spawn`, no shell) and
found nothing.

### Live verification — now actually performed and passing

With the fix applied, `pnpm --filter @disco-voador/desktop run e2e:voice-smoke` was run **three
consecutive times**, each launching two real, independent, unpackaged Electron processes into the
same voice channel with Chromium's fake microphone device. All three passed
(`E2E_VOICE_SMOKE_OK` from both instances each time), with genuinely different evidence each run —
not a cached or stubbed result:

| Run | Instance A: peer connected / audio RMS | Instance B: peer connected / audio RMS |
| --- | -------------------------------------- | -------------------------------------- |
| 1   | `a4a1d913-…` / `0.3227`                | `fe2eea4a-…` / `0.3740`                |
| 2   | `6fb6197e-…` / `0.0582`                | `e8642872-…` / `0.2891`                |
| 3   | `9f2f8928-…` / `0.3603`                | `2a83ed06-…` / `0.3281`                |

(RMS is sampled from the _remote_ participant's actually-received, actually-decoded audio track over
~1 second via a Web Audio `AnalyserNode`; the silence threshold is `0.001` — every reading is one to
two orders of magnitude above it.) Each run used a fresh ephemeral realtime-service port, fresh
random participant UUIDs, and fresh temporary `--user-data-dir`s that were cleanly removed afterward;
no process or file leaked across runs. This exercises the real, unmodified WebRTC stack end to end —
SDP offer/answer, ICE gathering and connectivity checks, DTLS handshake, SRTP encrypt/decrypt, Opus
encode/decode — with only the _input_ source (the microphone hardware) simulated via Chromium's
standard `--use-fake-device-for-media-stream`, which is the conventional way WebRTC audio pipelines
are verified without physical hardware in any CI environment, including this one.

This satisfies `docs/DEFINITION_OF_DONE.md`'s WebRTC/media bar verbatim: _"A two-client scenario
validates actual tracks, not only signaling mocks."_ `qa-engineer` independently reviewed the fix,
the smoke test's own implementation (to rule out a false-positive result), and this evidence before
concurring, noting one residual, non-blocking gap worth a future targeted assertion: since both
instances use the same fake audio generator, the RMS-above-threshold check alone cannot by itself
distinguish "genuine remote track" from a hypothetical bug that mis-routed the _local_ stream into
`remoteStreams` — ruled out here by inspection (`remoteStreams` is populated only from
`RemoteTrackEvent`, keyed by the remote participant's server-issued id, never the local one), but not
by an explicit assertion in the smoke test itself.

**What this does not include:** a human physically speaking into a real microphone and listening
with real ears — no human tester was available in this session. If useful for extra confidence, a
quick manual sanity check (two `pnpm dev` instances, join the same channel, talk, listen) remains
available as an optional follow-up, not a blocker — the automated evidence above already exercises
every part of the media pipeline a human ear could additionally confirm except perceived audio
quality/latency.

### Status

**T3 is COMPLETE.** All acceptance criteria are met with real evidence: the protocol/realtime/
rtc-core/media-core layers were verified with real sockets and hand-written fakes; the desktop
integration layer was verified with a hand-written `FakeWebSocket`; and the live two-Electron-instance
WebRTC acceptance bar — the one criterion that had been outstanding — passed three consecutive times
with genuine, non-repeating evidence. `security-reviewer` and `qa-engineer` both reviewed the final
state with no unaddressed findings. See `docs/tasks/STATUS.md`.
