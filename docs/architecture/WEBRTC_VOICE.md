# Voice channels and WebRTC (T3)

Canonical contracts live in code at [`packages/protocol/src/messages/{voice,webrtc}.ts`](../../packages/protocol/src/messages/),
[`packages/rtc-core/src/`](../../packages/rtc-core/src/), and
[`packages/media-core/src/`](../../packages/media-core/src/); this document explains the design and
is not itself authoritative. See [`REALTIME_PROTOCOL.md`](REALTIME_PROTOCOL.md) for the T2
connection/handshake foundation this builds on, [`../ARCHITECTURE.md`](../ARCHITECTURE.md) for how
the pieces fit the wider system, [`../tasks/T3_VOICE_WEBRTC.md`](../tasks/T3_VOICE_WEBRTC.md) for
the task record including its verification status, and [`WEBRTC_CAMERA.md`](WEBRTC_CAMERA.md) for
T4's camera streaming, built on top of this same transport (including the renegotiation support T4
had to add to `packages/rtc-core`'s `Peer` — this document's [P2P mesh
topology](#p2p-mesh-topology) section predates that; `WEBRTC_CAMERA.md` documents it).

## Scope

T3 is the first voice vertical slice: predefined voice channels (a hardcoded catalog, no database),
microphone capture, P2P WebRTC between every pair of participants in a channel, and WebRTC signaling
carried over the T2 realtime service. Camera (added in T4, see `WEBRTC_CAMERA.md`), screen sharing,
system audio, text chat, SQLite, authentication, and an SFU are explicitly out of scope for T3 — see
ADR 0006 for the P2P-first decision this implements.

## Identity model

Three distinct identifiers exist, deliberately not conflated:

| Identifier      | Minted by                          | Lifetime                     | Meaning                                                          |
| --------------- | ---------------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `connectionId`  | Server (T2, `crypto.randomUUID()`) | One WebSocket connection     | Not an identity signal — see `REALTIME_PROTOCOL.md`              |
| `participantId` | Server (T3, `crypto.randomUUID()`) | One voice-channel membership | Who other participants in the channel see; never client-supplied |
| `userId`        | Not implemented                    | —                            | Future account/session task                                      |

A connection has zero or one active voice-channel membership at a time; joining a new channel while
already in one implicitly leaves the old one first (`VoiceRegistry.join` in
`services/realtime/src/voice/registry.ts`). Leaving a channel — explicitly, by switching channels, or
by abrupt disconnect — is always handled the same way: `notifyParticipantLeft` tells the _other_
remaining members, but the leaving/switching connection itself is not separately told "you left" when
it just joined somewhere else — it already knows, because it just received `voice:joined` for the new
channel.

## Message surface

Added to the T2 envelope (see `REALTIME_PROTOCOL.md` for the shared `type`/`id` fields, versioning,
and error-then-close-unless-non-fatal policy):

```text
client -> server   voice:join { channelId, displayName }
client -> server   voice:leave {}
server -> client   voice:joined { channelId, participantId, participants[] }
server -> client   voice:left { channelId }
server -> broadcast voice:participant-joined { channelId, participant }
server -> broadcast voice:participant-left { channelId, participantId }
server -> client   voice:catalog { channels[] }   (sent automatically right after server:hello)

client -> server   webrtc:offer/answer/ice-candidate { targetParticipantId, sdp | candidate }
server -> client   webrtc:offer/answer/ice-candidate { sourceParticipantId, sdp | candidate }
```

`webrtc:*` reuses the same `type` string in both directions deliberately — it is the same kind of
message, carrying `targetParticipantId` ("send this to...") one way and `sourceParticipantId` ("this
came from...") the other; the two directions are parsed by independent discriminated unions, so this
is unambiguous on the wire. SDP is a bounded opaque string (max 8192 bytes) and ICE candidates are a
bounded structured payload (`candidate` max 1024 bytes) — the server never parses their semantic
content, only bounds their size.

## Server-authoritative identity

`participantId` is always server-generated and a client can never state its own identity when
signaling: `webrtc:offer`/`answer`/`ice-candidate` carry a `targetParticipantId` chosen by the
sender, but the forwarded message's `sourceParticipantId` is derived server-side from the _sending
connection's own_ registry membership (`buildForwardedSignal` in `protocol-handlers.ts`), never from
anything the client wrote in the message body. `VoiceRegistry.resolveSignalingTarget` additionally
rejects: a sender not currently in any channel (`NOT_IN_VOICE_CHANNEL`), a target not in the _same_
channel as the sender (`SIGNALING_TARGET_INVALID`), and self-targeting. All three are non-fatal —
the connection stays open (see `errors.ts`'s deliberately-absent close-code mapping for these three
codes).

## Offer/answer ownership (no glare)

Exactly one deterministic rule decides who creates the offer for a given pair, applied identically by
every client — there is no negotiation-time coin flip and no perfect-negotiation rollback logic,
because the rule alone is enough to guarantee at most one offer per pair:

- When a client receives `voice:joined` (its own join confirmation) with a snapshot of participants
  already in the channel, it adds each of them to its transport with role **`'responder'`** — they
  were there first, so _they_ already learned about the newcomer via `voice:participant-joined` and
  will initiate.
- When a client receives `voice:participant-joined` (someone else joining its already-open channel),
  it adds them with role **`'initiator'`** — it was there first, so it owns the offer toward the
  newcomer.

This lives entirely in `packages/rtc-core`'s `MediaTransport.addParticipant(participantId, role)`
(see `P2PMeshTransport`/`Peer` in `packages/rtc-core/src/`) — the only place offer-vs-answer ownership
is decided. `apps/desktop/src/renderer/voice/use-voice-channel.ts` only ever calls `addParticipant`
with the role implied by which event it is reacting to; it never inspects or overrides role itself.

## Sequence: two participants joining the same channel

```mermaid
sequenceDiagram
    participant A as Client A (renderer)
    participant S as Realtime service
    participant B as Client B (renderer)

    A->>S: voice:join { channelId: "general", displayName: "A" }
    S-->>A: voice:joined { participantId: pA, participants: [] }
    Note over A: no existing members — nothing to add yet

    B->>S: voice:join { channelId: "general", displayName: "B" }
    S-->>B: voice:joined { participantId: pB, participants: [{pA, "A"}] }
    S-->>A: voice:participant-joined { participant: {pB, "B"} }

    Note over A: adds pB as 'initiator'
    Note over B: adds pA as 'responder'

    A->>S: webrtc:offer { targetParticipantId: pB, sdp }
    S-->>B: webrtc:offer { sourceParticipantId: pA, sdp }
    B->>S: webrtc:answer { targetParticipantId: pA, sdp }
    S-->>A: webrtc:answer { sourceParticipantId: pB, sdp }

    par ICE exchange (either direction, as candidates are gathered)
        A->>S: webrtc:ice-candidate { targetParticipantId: pB, candidate }
        S-->>B: webrtc:ice-candidate { sourceParticipantId: pA, candidate }
    and
        B->>S: webrtc:ice-candidate { targetParticipantId: pA, candidate }
        S-->>A: webrtc:ice-candidate { sourceParticipantId: pB, candidate }
    end

    Note over A,B: RTCPeerConnection reaches 'connected';<br/>each side's ontrack fires with the other's microphone
```

## ICE candidate queueing

A candidate can legitimately arrive before `setRemoteDescription` resolves (the remote peer may
gather and send candidates faster than this side processes the offer/answer). `IceCandidateQueue`
(`packages/rtc-core/src/ice-candidate-queue.ts`) queues any candidate — including a queued `null`,
the spec's end-of-candidates signal, treated as a legitimate value rather than an absence — until the
remote description is applied, then flushes them in arrival order before the local answer/offer is
created. This is a pure, environment-neutral queue, independently unit-tested.

## P2P mesh topology

One `RTCPeerConnection` (owned by one `Peer`) per remote participant — for a 3-person channel, each
client holds 2 peer connections. `P2PMeshTransport` (`packages/rtc-core/src/p2p-mesh-transport.ts`)
is the only place that knows this; it presents the environment-neutral `MediaTransport` interface
(`addParticipant`/`removeParticipant`/`handleRemote*`/`publishTrack`/`unpublishTrack`/`getStats`/
`on`/`off`/`closeAll`) to its caller, so the Renderer only ever deals with semantic participants and
remote media streams — never peer connections, transceivers, or per-connection negotiation state (per
ADR 0006's UI/transport seam). A future SFU-backed transport can implement the same `MediaTransport`
contract without any caller change.

`publishTrack`/`unpublishTrack` fan a local track out to (or back from) every current and future peer
in the transport; muting never calls either — see [Microphone lifecycle](#microphone-lifecycle)
below.

### Mid-session participant changes are not `closeAll()`

`removeParticipant(id)` tears down one peer connection and is safe to call any number of times, for
any reason (explicit leave, someone else leaving, a channel switch). `closeAll()` is different: it
permanently disables the transport (`addParticipant` becomes a no-op forever afterward) and exists
only for final teardown — when the transport itself is being discarded (component unmount,
disconnecting the realtime client entirely). `use-voice-channel.ts`'s effect cleanup is the only
caller of `closeAll()`; every other participant-list change (channel switch, a peer leaving) uses
`removeParticipant()` for each affected id instead, precisely so the transport keeps working for the
rest of the session.

## Microphone lifecycle

`packages/media-core`'s `acquireMicrophone()` requests audio-only capture (`getUserMedia({audio:
{...}, video: false})`) with `echoCancellation`/`noiseSuppression`/`autoGainControl` all defaulted to
`true` (spec `ideal`, not `exact` — a device that can't honor one just captures without it). It is
acquired lazily, once, the first time a user joins any voice channel in a session — not eagerly on
app launch — and released (`transport.unpublishTrack` + `microphone.stop()`) when the user leaves
voice entirely, to release the OS microphone indicator between sessions. Muting sets
`track.enabled = false` and never stops/reacquires the device — this is instant, has no
renegotiation cost, and matches ordinary voice-chat UX. Deafening is purely a local-playback concern
(`<audio>` element `.muted`, see `RemoteAudio.tsx`) — the peer connections and remote tracks are
untouched, so un-deafening is instant and the remote side is never told anything changed.

**T11 device switching**: `acquireMicrophone`/`acquireCamera` both accept an optional `deviceId` (see
`packages/media-core/src/microphone.ts`/`camera.ts`), and `rtc-core`'s `MediaTransport` gained a
`replaceTrack(oldTrack, newTrack)` primitive (`Peer`/`P2PMeshTransport`) so a caller can switch the
active microphone or camera device mid-session — acquire the new device's track first, call
`transport.replaceTrack(oldTrack, newTrack)`, then stop the old track only after that call succeeds —
without a full renegotiation cycle or disrupting other published sources (screen-video,
screen-audio). `replaceTrack` is a transceiver-level `RTCRtpSender.replaceTrack()` swap: no
`negotiationneeded` fires, no new offer/answer round-trip. This is a `rtc-core`/`media-core`
primitive only; the device-picker UI and `use-voice-channel.ts` wiring that calls it are separate T11
work.

## Permissions

`apps/desktop/src/main/permissions.ts` grants exactly one permission beyond T1's default-deny-all:
`media` requests that are audio-only (rejects any request that also asks for video, even mixed with
audio) **and** originate from an allowed origin (the app's own renderer origin — see
`main/origins.ts`). Both `setPermissionCheckHandler` and `setPermissionRequestHandler` enforce this
identically; Electron only fully enforces a policy when both are installed.

## Content-Security-Policy and the realtime origin

The realtime server URL (`DISCO_VOADOR_REALTIME_URL`, default `ws://127.0.0.1:8090`) was, through T7,
operator/deployment configuration only — parsed once in `main/desktop-config.ts` — never a
Renderer-editable text field, specifically so the CSP's `connect-src` could allowlist one exact
origin instead of a wildcard scheme/host. **T8 changed this**: the server address is now a real,
user-typed field (`ConnectionScreen`), which an exact pre-declared CSP origin cannot accommodate —
`content-security-policy.ts`'s `connect-src` now scopes to the `ws:`/`wss:` schemes generically
instead. See `docs/architecture/DEDICATED_SERVER.md`'s "Client connection UX" section for the full
T8 design and the CSP trade-off this required.

## ICE servers

`DISCO_VOADOR_STUN_URLS` (optional, comma-separated `stun:`/`stuns:` URLs) remains the desktop's own
static STUN configuration. STUN is best-effort NAT-traversal help, not required core communication —
two peers on the same LAN (T3's verification scenario) connect via host candidates with an empty
`iceServers` array. **T14 added real TURN/Coturn relay support**: when an operator configures `turn`
on their Dedicated Server, it mints short-lived Coturn `use-auth-secret` REST credentials
(`services/dedicated-server/src/turn/mint-turn-credentials.ts`) and pushes them to the client once,
right after identity-proof succeeds, via a new additive `server:turn-credentials` protocol message —
no protocol version bump. `packages/rtc-core`'s `P2PMeshTransport.setIceServers()` applies them to
every peer connection created after they arrive (REPLACE semantics — the caller merges STUN and TURN
itself).

**T15.1 corrected one wrong assumption here.** This originally also stated that already-created peer
connections could not be updated at all ("the platform does not support changing a live
`RTCPeerConnection`'s ICE servers in place"). That is not true: `RTCPeerConnection.setConfiguration()`
is standard WebRTC, and pairing it with `restartIce()` makes an existing connection genuinely
re-gather against the new list — verified directly on this project's own Electron/Chromium build (a
connection constructed with an empty `iceServers` array gathered host candidates only; after
`setConfiguration()` + `restartIce()` + renegotiation, the same connection gathered `srflx` and
`relay` candidates). `setIceServers()` therefore now also heals every existing peer that has not yet
established a working transport, and deliberately leaves already-working peers completely untouched
so a routine credential refresh can never disturb a call in progress. See
[`../adr/0023-turn-rest-credential-minting-architecture.md`](../adr/0023-turn-rest-credential-minting-architecture.md)
and [`../references/COTURN.md`](../references/COTURN.md) for the full design.

**T15.2 closed the mid-session credential-expiry gap.** T14's credential was minted exactly once per
connection and never again, so a peer connection created after `expiresAt` — a friend joining hours
into a call, or a connection rebuilt by ICE recovery — presented an expired `use-auth-secret`
username to Coturn and gathered no relay candidate at all. The Dedicated Server now re-mints and
re-pushes `server:turn-credentials` at **half the current credential's remaining lifetime** (three
hours at the 6-hour default), so a client is never holding a credential that is more than
half-expired. This needed **no protocol change at all**: the same message type, the same payload
shape, and the client's existing handler, which merges the new TURN servers with its own STUN list
and hands the result to `setIceServers()`. A replacement credential arriving for an already-healthy
peer is recorded and nothing else — no `setConfiguration`, no restart, no renegotiation on a live
call. The timer is per-connection, armed by the same identity-proof transition that sends the first
credential, and cancelled on every teardown path. Half the remaining lifetime, rather than a fixed
lead time before expiry, is what keeps the safety margin scale-free for any operator-configured TTL;
see `services/realtime/src/turn-credential-refresh.ts`.

## Automated end-to-end verification

`apps/desktop/scripts/e2e-voice-smoke.mjs` starts a real realtime service on an ephemeral port, then
launches two **unpackaged** Electron instances (the `electron` binary pointed directly at
`apps/desktop`, each with its own temporary `--user-data-dir`) — never the packaged `.exe`, since
`DISCO_VOADOR_E2E_FAKE_MEDIA`/`DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL` are only ever honored when
`!app.isPackaged`, by design (`main/window.ts`, `main/index.ts`) — a packaged/distributed build can
never auto-enable fake media devices or auto-join a channel, regardless of what environment variables
surround it. Both instances auto-join the `general` channel with Chromium's fake microphone device
(`--use-fake-device-for-media-stream`); each instance proves the connection is real — not merely that
a track object exists — by sampling RMS energy from the _remote_ track via a Web Audio `AnalyserNode`
(`renderer/voice/e2e-audio-probe.ts`) and logging `E2E_PEER_CONNECTED:<id>` /
`E2E_AUDIO_LEVEL_OK:<id>` markers that `main/index.ts`'s `armE2EVoiceSmokeExit` relays to its own
stdout and watches for.

**Status: implemented and passing.** `pnpm --filter @disco-voador/desktop run e2e:voice-smoke` has
passed three consecutive runs, each with both instances reaching `'connected'` and receiving
genuinely non-silent decoded audio (RMS one to two orders of magnitude above the silence threshold).
**T13.4 addendum**: `e2e:ptt-smoke` (new) reuses this same fake-media/`AnalyserNode`-probe pattern to
prove the global Push-to-Talk gate end to end — driving the actual `setPttShortcut`/`onPttState` IPC
surface (never real physical key injection) to simulate a press/release while the remote side samples
real audio energy. All three phases pass, including audio expected _during_ the PTT hold. An earlier
draft of this addendum attributed a during-hold silence to Chromium's own Opus DTX/VAD suppressing a
synthetic sine-tone test signal; that diagnosis was wrong. The real cause, found during this task, was
a genuine product defect: on this app's pinned Electron/Chromium build, a remote WebRTC audio track is
never decoded at all (`totalSamplesReceived`/`audioLevel` pinned at 0 despite healthy RTP delivery)
unless at least one real `HTMLMediaElement` is attached to the stream and playing — a pure Web Audio
consumption graph, which is exactly what `RemoteAudioGraphController` used once `<audio>` elements
were retired in favor of per-participant `GainNode`/`AnalyserNode` routing, never triggers decode on
its own. This would have broken microphone audio for every real voice session, not just the test.
Fixed via a hidden, muted, autoplaying "decode keep-alive" `HTMLAudioElement` attached per participant
(never part of the audible path). See [`GAMER_VOICE_EXPERIENCE.md`](GAMER_VOICE_EXPERIENCE.md) for the
full finding, evidence, and fix. `e2e:voice-smoke` itself was re-run against the final T13.4 code
(microphone playback/gating now routes through `TransmitGate` and `RemoteAudioGraphController`) with
no regression.

Getting here required fixing a real bug in the script: `ELECTRON_RUN_AS_NODE` must be genuinely
_absent_ from the spawned child's environment, not merely set to `''` — Electron's native bootstrap
checks presence, not truthiness, and a present-but-empty value crashed Electron 43 before any window
opened (`apps/desktop/scripts/lib/electron-e2e-env.mjs` now handles this correctly; see
[`../tasks/T3_VOICE_WEBRTC.md`](../tasks/T3_VOICE_WEBRTC.md) for the full root-cause record and
[`../references/VERSION_DECISIONS.md`](../references/VERSION_DECISIONS.md) for the version-level
note).

## Known gaps / deliberately deferred

- **T15.2 added real ICE-restart recovery for a peer connection that reaches `'failed'`**, which used
  to be an unrecoverable dead end (the peer was closed and removed, and the participant stayed in the
  roster with no media for the rest of the session). A failed peer now re-applies the freshest known
  ICE servers and restarts ICE up to three times with exponential backoff (1s, 3s, 9s, then a 27s
  window to judge the last attempt), renegotiating through the existing perfect-negotiation path;
  only when that budget is exhausted is the peer torn down, leaving the per-participant "Voice
  connection problem" indicator as the terminal state. A successful reconnection restores a full
  retry budget, and leaving/teardown cancels the chain. See `rtc-core/src/peer.ts`.
- Still **no** ICE-restart for a peer connection that reaches `'disconnected'` while the underlying
  realtime WebSocket stays up. That state is transient per the WebRTC specification and recovers on
  its own in the ordinary case, so T15.2 deliberately did not extend recovery to it — a restart there
  would disturb connections that were about to heal by themselves. A media path that stalls in
  `'disconnected'` indefinitely without ever reaching `'failed'` therefore still has no automatic
  recovery. This is narrower than the gap T11 closed: T11's automatic reconnect
  (`docs/architecture/CLIENT_SETTINGS_AND_RECONNECT.md`, ADR 0016) recovers from the _realtime
  connection itself_ being lost (the WebSocket closes — server restart, network drop, etc.), which
  necessarily rebuilds every peer connection from scratch as part of rejoining the voice channel, but
  does nothing for a single peer connection degrading while the WebSocket is still open.
- No SFU — see ADR 0006; the mesh does not scale past a small room.
- TURN credential minting is implemented (T14) and, since T15.2, proactively refreshed mid-session —
  see [ICE servers](#ice-servers) above. What remains open here is a boundary case rather than the
  main gap: Coturn's own behavior for a relay allocation whose _original_ minting credential has since
  expired has not been measured by this project (the reproduced failure — `401 Unauthorized`, zero
  relay candidates — was for a _new_ allocation, which is exactly what the refresh prevents).
  Separately, `P2PMeshTransport.setIceServers` still isn't part of the shared `MediaTransport`
  interface, so a future SFU-backed transport will need its own equivalent wiring at
  `use-voice-channel.ts`'s one call site rather than inheriting this for free — see ADR 0023.
- Speaking indicators and per-participant local volume were explicitly out of T3's scope; both are
  now implemented (T13.4), entirely as Renderer-side Web Audio processing over the same
  `MediaTransport`/`RemoteAudio`-supplied streams — no change to this document's own transport
  design, mesh topology, or offer/answer ownership rule was needed. See
  [`GAMER_VOICE_EXPERIENCE.md`](GAMER_VOICE_EXPERIENCE.md) for the full design: a
  `MediaStreamAudioSourceNode -> GainNode -> destination` path per remote participant (retiring
  `<audio>` for microphone-audio playback specifically; screen/system audio is unaffected) plus an
  analysis-only `AnalyserNode` tap for speaking detection, and a `TransmitGate` state machine
  (`packages/media-core`) that gates local transmission for Push-to-Talk/Voice-Activity purely via
  the same `track.enabled` mechanism this document's own "Microphone lifecycle" section already
  established for mute — no renegotiation, no new transport primitive. Device selection is no longer
  entirely absent: T11 added the `deviceId`/`replaceTrack` primitives described in
  [Microphone lifecycle](#microphone-lifecycle) above, and the device-picker UI/`use-voice-channel.ts`
  wiring living outside `rtc-core`/`media-core` is complete.
