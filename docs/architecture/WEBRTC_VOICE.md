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

## Permissions

`apps/desktop/src/main/permissions.ts` grants exactly one permission beyond T1's default-deny-all:
`media` requests that are audio-only (rejects any request that also asks for video, even mixed with
audio) **and** originate from an allowed origin (the app's own renderer origin — see
`main/origins.ts`). Both `setPermissionCheckHandler` and `setPermissionRequestHandler` enforce this
identically; Electron only fully enforces a policy when both are installed.

## Content-Security-Policy and the realtime origin

The realtime server URL (`DISCO_VOADOR_REALTIME_URL`, default `ws://127.0.0.1:8090`) is
operator/deployment configuration — parsed once in `main/desktop-config.ts` — never a
Renderer-editable text field. This is specifically so the CSP's `connect-src` can allowlist one exact
origin (`new URL(url).origin`, computed in `main/index.ts`) instead of a wildcard scheme/host; an
arbitrary runtime-user-typed endpoint could never be safely pre-declared in a CSP set before the page
loads.

## ICE servers

`DISCO_VOADOR_STUN_URLS` (optional, comma-separated `stun:`/`stuns:` URLs) is the only ICE-server
configuration T3 supports. STUN is best-effort NAT-traversal help, not required core communication —
two peers on the same LAN (T3's verification scenario) connect via host candidates with an empty
`iceServers` array. TURN/coturn relay support needs short-lived credential minting that does not
exist yet (`infrastructure/coturn/` has reviewed templates but no runtime credential-issuing
endpoint) — that remains a later self-hosting-hardening task (see `docs/references/COTURN.md`).

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
Getting here required fixing a real bug in the script: `ELECTRON_RUN_AS_NODE` must be genuinely
_absent_ from the spawned child's environment, not merely set to `''` — Electron's native bootstrap
checks presence, not truthiness, and a present-but-empty value crashed Electron 43 before any window
opened (`apps/desktop/scripts/lib/electron-e2e-env.mjs` now handles this correctly; see
[`../tasks/T3_VOICE_WEBRTC.md`](../tasks/T3_VOICE_WEBRTC.md) for the full root-cause record and
[`../references/VERSION_DECISIONS.md`](../references/VERSION_DECISIONS.md) for the version-level
note).

## Known gaps / deliberately deferred

- No ICE-restart or reconnection recovery for a peer connection that reaches `'disconnected'` (only
  `'failed'`/`'closed'` are treated as terminal — see `rtc-core/src/connection-state.ts`); a flaky
  network can leave a pair "disconnected" with no automatic recovery attempt. Candidate for T8
  (connection recovery/diagnostics).
- No SFU — see ADR 0006; the mesh does not scale past a small room.
- No TURN credential minting — see [ICE servers](#ice-servers) above.
- No speaking indicators, device selection, or per-participant volume — explicitly out of T3's scope.
