# Dedicated Server product boundary (T8, extended by T9, T10)

Canonical contracts live in code at
[`services/dedicated-server/src/`](../../services/dedicated-server/src/) and
[`services/realtime/src/`](../../services/realtime/src/); this document explains the design and is
not itself authoritative. See [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) for the wider system,
[`REALTIME_PROTOCOL.md`](REALTIME_PROTOCOL.md) for the connection/handshake envelope this server
composes, [`CLIENT_IDENTITY.md`](CLIENT_IDENTITY.md) for the T7 identity proof every connection
still requires, [`SERVER_AUTHORIZATION.md`](SERVER_AUTHORIZATION.md) for T9's server-local
groups/permissions/tokens/bans layered on top of this same composition root,
[`PERSISTENT_TEXT_CHAT.md`](PERSISTENT_TEXT_CHAT.md) for T10's persistent chat layered the same way,
and [`../adr/0012-dedicated-server-product-boundary.md`](../adr/0012-dedicated-server-product-boundary.md) /
[`../adr/0013-server-authorization-storage-and-rbac.md`](../adr/0013-server-authorization-storage-and-rbac.md) /
[`../adr/0014-persistent-server-owned-chat-history.md`](../adr/0014-persistent-server-owned-chat-history.md)
for the accepted decisions this document elaborates.

## Scope

T8 turned `services/realtime` — until then an internal service every E2E test bypassed into
directly — into something a **client explicitly connects to**: an independently-operated Chantivo
Dedicated Server. It did not add accounts, permissions, groups, invite tokens, bans, text chat,
production TURN/TLS deployment, Docker packaging, an installer, or a public server directory — those
were each added by their own later task (T9, T10, and T14 respectively; installer/directory remain
deferred to T15+).
**T9 added server-local permissions/groups/invite-and-privilege-tokens/bans** (see
[`SERVER_AUTHORIZATION.md`](SERVER_AUTHORIZATION.md)) — still no accounts, still no central
control plane, and connecting to a Dedicated Server means completing both T7's identity proof
_and_ T9's admission check before `ready` (see [`REALTIME_PROTOCOL.md`](REALTIME_PROTOCOL.md#handshake)).
**T10 added persistent text chat** (server-wide and per-voice-channel — see
[`PERSISTENT_TEXT_CHAT.md`](PERSISTENT_TEXT_CHAT.md)), correcting an earlier roadmap assumption
that chat would be ephemeral: chat history now survives client disconnect, client restart, and
server restart, stored entirely on the Dedicated Server that received it. **T14 added production
TURN/TLS deployment and Docker packaging** — see
[`PRODUCTION_SELF_HOSTING.md`](PRODUCTION_SELF_HOSTING.md). An installer and a public server
directory remain deferred to later tasks (T15+). See [`docs/tasks/T8_DEDICATED_SERVER.md`](../tasks/T8_DEDICATED_SERVER.md),
[`docs/tasks/T9_SERVER_AUTHORIZATION.md`](../tasks/T9_SERVER_AUTHORIZATION.md), and
[`docs/tasks/T10_PERSISTENT_TEXT_CHAT.md`](../tasks/T10_PERSISTENT_TEXT_CHAT.md) for the full task
scopes.

## Two products, no control plane

Disco Voador ships two independent, separately-operated products:

- **Disco Voador Client** (`apps/desktop`) — the Windows desktop app a participant runs.
- **Disco Voador Dedicated Server** (`services/dedicated-server`) — the process a self-hoster runs.

There is no `auth.discovoador.com`, `api.discovoador.com`, `directory.discovoador.com`,
`relay.discovoador.com`, or any other Disco Voador–operated infrastructure either product depends
on. A client connects directly to whichever server address its operator gives it; a server accepts
connections from any client that completes T7's identity handshake. This is the same guardrail ADR
0010 already recorded — T8 is the first task to make it a literal, runnable product boundary rather
than only a principle.

```text
Before T8:  Desktop Client -----> internal `services/realtime` (only ever launched by test/dev tooling)

After T8:   Disco Voador Client --(direct connection, operator-chosen address)--> Disco Voador Dedicated Server
                                                                                       |
                                                                          identity auth, channels, signaling
                                                                                       |
                                                                          WebRTC directly between clients

            Server A (voice.guild-a.example)   Server B (192.168.1.50:8090)   Server C (10.0.0.20:8090)
            each independently operated; none requires Disco Voador-operated infrastructure.
```

## `services/realtime` vs `services/dedicated-server`

The key architectural question T8 had to answer: does `services/realtime` simply get renamed into
the product, or does something new sit on top of it? A `software-architect` review (see ADR 0012)
concluded **composition, not renaming**:

- **`services/realtime`** stays exactly what it already was — a reusable, product-agnostic
  transport/session **library**: WebSocket connections, the T2/T7 handshake, heartbeat, rate
  limiting, voice-channel signaling. It gained exactly one new seam
  (`RealtimeServerDependencies.voiceChannels` / `.serverMetadata`, both optional, both defaulting to
  the pre-T8 hardcoded values) so a composing caller can inject a server's own channel catalog and
  display identity instead of being stuck with the defaults every consumer previously shared. Zero
  existing consumers needed to change.
- **`services/dedicated-server`** (new workspace, `@disco-voador/dedicated-server`) is the actual
  product: it owns configuration loading, the composition root that turns a validated config into a
  running server, the CLI/process entrypoint, the startup banner, and signal handling. It depends on
  `@disco-voador/realtime` as an ordinary package dependency — it does not fork or duplicate any of
  its protocol/session logic.

This mirrors the existing `apps/desktop` pattern (a thin composition/product layer over reusable,
environment-neutral packages) rather than introducing a new shape. `apps/dedicated-server` was
considered and rejected: in this repository, `apps/*` specifically means "Electron Main/Preload/
Renderer GUI-shell composition" (see the ownership table in `docs/ARCHITECTURE.md`), not "any
operator-run deployable" — a headless Node server product belongs under `services/`, alongside its
own dependency, not under `apps/`.

### Why a CLI/library split inside `services/realtime`

Before T8, `services/realtime/src/index.ts` was both the package's import surface **and** a
self-executing CLI bootstrap (it called `bootstrap()` as an import side effect). Once
`services/dedicated-server` needed to import `createRealtimeServer`/`loadRealtimeConfig` etc. as a
real dependency, that side effect would have started a second, unwanted realtime server the moment
`@disco-voador/realtime` was imported. Fixed by splitting:

- `services/realtime/src/cli.ts` — the CLI bootstrap, unchanged logic, just renamed from the old
  `index.ts`. `services/realtime`'s own `dev`/`start` scripts now point at it.
- `services/realtime/src/index.ts` — a new, pure, side-effect-free barrel export
  (`createRealtimeServer`, `RealtimeServerAddress`, `RealtimeServerDependencies`,
  `RealtimeServerHandle`, `loadRealtimeConfig`, `RealtimeConfig`, `DEFAULT_VOICE_CHANNELS`,
  `createLogger`, `createNoopLogger`, `Logger`).

`services/realtime` remains independently runnable exactly as before (`pnpm --filter
@disco-voador/realtime run dev`) — this is a purely internal reorganization with no behavior change
for that package's own CLI.

## Composition root

`services/dedicated-server/src/create-dedicated-server.ts` exports the one function that turns a
validated `DedicatedServerConfig` into a runnable server:

```ts
function createDedicatedServer(
  config: DedicatedServerConfig,
  deps: DedicatedServerDependencies = {},
): DedicatedServerHandle; // { connectionCount, config, start(), stop() }
```

It composes `@disco-voador/realtime`'s `createRealtimeServer`, injecting the configured voice
channels and a fixed server-metadata capability set (`voice`, `camera`, `screen-video`,
`screen-audio` — the four media sources T3–T6 already implement). No protocol or session logic is
duplicated here — only product-identity wiring. `createDedicatedServer` itself never touches
`process.env`/`process.exit`, which is what makes it directly integration-testable
(`tests/dedicated-server/integration.test.ts` calls it with real ephemeral ports and real WebSocket
clients, no OS process spawn needed) as well as the same function both the CLI and future Docker/
service-wrapper packaging (T13/T14) would call.

`services/dedicated-server/src/cli.ts` is the only place that reads `process.env`, prints the
startup banner, and installs signal handlers — see [Startup and shutdown](#startup-and-shutdown)
below.

## Canonical entrypoint

```text
pnpm --filter @disco-voador/dedicated-server run dev     # tsx watch, development
pnpm --filter @disco-voador/dedicated-server run build   # tsc -b, produces dist/
pnpm --filter @disco-voador/dedicated-server run start   # node dist/cli.js, the packaged/product path
pnpm --filter @disco-voador/dedicated-server run smoke   # scripts/smoke.mjs, see "Server smoke" below
```

The server never depends on Electron, the Renderer, desktop app state, or a browser UI — it is a
standalone Node process, runnable on a headless machine with no display. All six of this project's
Electron E2E scripts (`e2e:voice-smoke`, `e2e:camera-smoke`, `e2e:screen-smoke`,
`e2e:screen-audio-smoke`, `e2e:identity-auth`, `e2e:connection-smoke`) now launch this exact
entrypoint (`services/dedicated-server/dist/cli.js`) via a shared helper
(`apps/desktop/scripts/lib/start-dedicated-server.mjs`), rather than a second, test-only "internal
realtime startup" path — there is exactly one way this codebase starts a real server, in tests and
in product use alike.

## Configuration

Precedence: **defaults < config file < environment variables.** A plain, strictly-validated JSON
file — not YAML/TOML — deliberately: zero new third-party dependency, and every value already needs
the same `zod`-strict-validation discipline the rest of this codebase uses for everything else. The
config file path defaults to `disco-voador-server.config.json` (relative to the process's working
directory) and is itself overridable via `DISCO_VOADOR_SERVER_CONFIG_PATH`.

```jsonc
{
  "name": "My Guild's Server", // optional, 1-100 chars, control characters rejected
  "host": "127.0.0.1", // optional, forwarded to REALTIME_HOST
  "port": 8090, // optional, forwarded to REALTIME_PORT
  "maxConnections": 1000, // optional, forwarded to REALTIME_MAX_CONNECTIONS
  "voiceChannels": [
    // optional, up to 64 entries, duplicate channelId rejected
    { "channelId": "general", "name": "General" },
    { "channelId": "gaming", "name": "Gaming" },
  ],
}
```

The file is `.strict()`-validated: an unknown top-level key fails config loading rather than being
silently ignored (T8 Section 9's "do not silently ignore misspelled security-sensitive settings").
A missing file is valid — it just means "run entirely on defaults/environment"
(`readServerConfigFile` returns `undefined` for `ENOENT` only; every other read/parse/validation
failure throws `ServerConfigFileError` and the process refuses to start).

`host`/`port`/`maxConnections` are implemented by converting the config file's values into the
exact env-var-shaped keys `@disco-voador/realtime`'s own `loadRealtimeConfig` already validates
(`REALTIME_HOST`/`REALTIME_PORT`/`REALTIME_MAX_CONNECTIONS`), then merging that object _underneath_
the real `process.env` (`{ ...fileAsEnv, ...process.env }`, real env spread last so it always wins)
before calling that already-tested function — this reuses 100% of the existing, already-tested
realtime config validation instead of a second, parallel implementation, and keeps exactly one
source of truth for what those three fields mean and how they are bounded. `name` has no realtime
env-var equivalent; `DISCO_VOADOR_SERVER_NAME` is the one additional override this package defines
itself, taking precedence over the config file's `name` per the same defaults-file-env precedence.
`voiceChannels` is config-file-only (a structured list has no natural flat-env-var form) — omitted
entirely, it defaults to the same catalog `services/realtime` always shipped
(`DEFAULT_VOICE_CHANNELS`).

Every `RealtimeConfig` field (`REALTIME_HANDSHAKE_TIMEOUT_MS`, `REALTIME_HEARTBEAT_*`,
`REALTIME_RATE_LIMIT_*`, `REALTIME_MAX_MESSAGE_BYTES`, `LOG_LEVEL`, ...) remains configurable the
same way it always was — env-var only, no config-file equivalent added, since T8's spec explicitly
warns against overbuilding a full administrative config system. See
[`REALTIME_PROTOCOL.md`](REALTIME_PROTOCOL.md#size-rate-and-connection-limits) for their defaults.

Invalid configuration (malformed JSON, schema violation, duplicate channel id, out-of-range port,
`REALTIME_PORT=banana`, ...) fails loudly and the process exits non-zero before ever binding a
socket — never a silent fallback to defaults.

## Network defaults

`REALTIME_HOST` defaults to `127.0.0.1` — a fresh Dedicated Server never listens beyond localhost by
accident. Exposing it to a LAN or the internet is an explicit operator choice (`host: "0.0.0.0"` or
a specific interface address in the config file, or `REALTIME_HOST` in the environment), not a
hidden default. `REALTIME_PORT` defaults to `8090`. `services/realtime` itself still does not
terminate TLS in-process — a plain `ws://127.0.0.1:8090` remains the accepted development/
self-hosted-LAN posture. For a public production deployment, T14 added a first-class Caddy
reverse-proxy example that terminates `wss://` in front of this same plain-`ws://` listener — see
[`PRODUCTION_SELF_HOSTING.md`](PRODUCTION_SELF_HOSTING.md) and
[`../adr/0024-tls-and-reverse-proxy-responsibility.md`](../adr/0024-tls-and-reverse-proxy-responsibility.md).

## Server-owned channels

Voice channels are no longer a client-side constant. Before T8, `apps/desktop`'s Renderer already
rendered whatever channel catalog `voice:catalog` (sent right after `server:hello`) contained — that
mechanism dates to T3 and needed no client change. The actual gap was server-side: the catalog it
sent was always `DEFAULT_VOICE_CHANNELS`, a hardcoded module constant every server (real or test)
shared. T8 makes the catalog part of `DedicatedServerConfig.voiceChannels`, sourced from the
operator's config file, and passed into `createRealtimeServer`'s new `voiceChannels` dependency —
so two Dedicated Servers with different config files genuinely offer different channels to a
connecting client with zero source-code change on either side. Joining a channel id the connected
server does not have (stale client state, a misconfigured invite, ...) is rejected cleanly with the
existing `CHANNEL_NOT_FOUND` non-fatal error code — the connection is not torn down.

Channel identity/passwords remain out of scope. The channel model is exactly what it was in T3: a
stable `channelId` plus a display `name`, still bound by `packages/protocol`'s existing
`voiceChannelSummarySchema` limits — T9 did not add per-channel permissions or channel-scoped
groups. What T9 did add is a single, server-wide `voice.channel.join` permission (part of its
small RBAC registry, not a channel property): a connecting identity that does not hold it is
rejected at `voice:join` time with the same non-fatal `AUTHORIZATION_DENIED` code any other
server-side permission denial uses (see
[`SERVER_AUTHORIZATION.md`](SERVER_AUTHORIZATION.md#server-side-enforcement)) — it governs whether
an identity may join _any_ channel this server offers, not which specific channel.

## Server metadata handshake

A client needs to know which server it just connected to — its display name and which product
capabilities it offers — without a second, parallel HTTP API. T8 adds this to the existing,
already-authenticated `server:hello` message (see [`REALTIME_PROTOCOL.md`](REALTIME_PROTOCOL.md)
for the full handshake): two new required fields, `serverName` (`packages/protocol`'s
`serverNameSchema`, 1-100 chars, control characters rejected) and `serverCapabilities` (a bounded
array of a closed `ServerCapability` enum: `voice` | `camera` | `screen-video` | `screen-audio` |
`text-chat` (the last added by T10 — see [`PERSISTENT_TEXT_CHAT.md`](PERSISTENT_TEXT_CHAT.md)).
Adding these fields to an existing `.strict()`-validated message is a breaking wire change, so the
protocol version bumped 2 → 3 (see `REALTIME_PROTOCOL.md`'s own versioning section) — consistent
with how T7 treated its own `client:hello` field additions. Adding `text-chat` to the enum afterward
was purely additive (no version bump needed, matching `version.ts`'s evolution policy).

`ServerCapability` is deliberately a **separate** schema from the existing `TrackSource` enum
(`microphone` | `camera` | `screen-video` | `screen-audio`) even though they overlap heavily —
`ServerCapability` describes what a _server_ offers as a product feature, `TrackSource` describes
what kind of media _track_ a peer published; `text-chat` is the first real proof they diverge, since
persistent chat is not a media track source at all. The Renderer's `RealtimeClient` surfaces this as
a new `serverInfo` event, stored in `VoiceChannelState` and rendered directly in `VoiceChannelView`
once connected.

Capability negotiation is deliberately not a general protocol: adding a new capability is additive
(no version bump — matches `version.ts`'s existing evolution policy) as long as a client treats an
unrecognized capability value as simply absent, never fatal.

## Client connection UX

Before T8, `apps/desktop`'s Renderer always auto-connected to one IPC-loaded, env-var-baked
development URL as soon as it mounted — there was no concept of "not yet connected to a server."
T8 replaces this with an explicit state machine in `App.tsx`:

```text
disconnected --(user types address, clicks Connect)--> connected
connected --(user clicks Disconnect)--> disconnected
connected --(user connects to a different address)--> disconnected --> connected (new server)
```

- **`ConnectionScreen`** (`apps/desktop/src/renderer/connection/ConnectionScreen.tsx`): the nickname
  (read-only context — edited from the existing settings Identity panel once connected, not
  duplicated here), an editable Server Address field, and a Connect button. No Login, Password, or
  Email field exists anywhere in this screen or this task — identity remains T7's automatic local
  cryptographic identity.
- **`parseServerAddress`** (`apps/desktop/src/renderer/connection/parse-server-address.ts`): parses
  hostname / IPv4 / bracketed IPv6 / `localhost`, with an optional `:port` (default `8090`), into a
  `ws://` URL. Built on the platform's own `URL` parser (`new URL('ws://' + input)`) rather than
  hand-rolled string splitting specifically because naive splitting breaks on IPv6 literals, which
  contain colons throughout the address, not only before a port. Bounds the raw input length (300
  chars) and rejects any extra URL component (path, query, fragment, credentials) so a pasted invite
  URL or malformed string can never silently connect somewhere the user didn't intend. A bare
  `host[:port]` input still defaults to `ws://` (unchanged); T14 added support for an explicit
  `ws://`/`wss://` scheme prefix, with `wss://` defaulting its port to `443` (matching a TLS
  reverse proxy) rather than `8090` — see
  [`../adr/0024-tls-and-reverse-proxy-responsibility.md`](../adr/0024-tls-and-reverse-proxy-responsibility.md).
- **Disconnect**: an explicit button, visible once connected. Clicking it sets `App.tsx`'s
  connection state back to `disconnected`, which unmounts `VoiceChannelView` — the pre-existing
  `useVoiceChannel(realtimeConfig)` hook's own `useEffect` (keyed on `[realtimeConfig]`, present
  since T3) already performs full teardown on unmount: WebSocket close, voice-channel-membership
  clear, peer connections closed, microphone/camera/screen capture stopped, remote media cleared.
  T8 added **no new teardown logic** — Disconnect and "connect to a different server" both reuse
  this same, already-correct T3–T7 lifecycle path, verified by the E2E scripts continuing to pass
  and by direct code inspection of the effect's cleanup function.
- **Connecting to a second server without restarting the app**: setting a new `realtimeConfig`
  object (a different server address) changes that same effect's dependency identity, which
  triggers the identical teardown-then-rebuild sequence React already runs on every dependency
  change — no server-specific state can leak from Server A into a subsequent connection to Server B,
  because the entire voice/media/session subtree unmounts and remounts between them. `connectionId`
  and voice-channel membership are always freshly issued by whichever server the client connects to
  next; the local T7 identity (and its `identityId`) is unaffected, since it lives entirely outside
  this component tree (`useIdentity()`, loaded once at app start from `%APPDATA%/DiscoVoador/`).

**CSP note**: through T7, the Renderer's Content-Security-Policy `connect-src` allowlisted exactly
one pre-declared realtime origin, since the address was fixed deployment configuration. T8's
`ConnectionScreen` makes the address a genuine runtime value the CSP cannot know in advance — a
security review during this task found the CSP had not been updated to match, which would have
silently blocked a real user from ever reaching any address other than the one baked in at launch.
Fixed by scoping `connect-src` to the `ws:`/`wss:` schemes generically rather than one exact origin
(`apps/desktop/src/main/content-security-policy.ts`) — see `docs/SECURITY.md`'s T8 section for the
full finding and fix.

A packaged build ships with **no server address baked in and no auto-connect** — `ConnectionScreen`
is always the real first screen a genuine user sees after the (also T7-existing) first-run nickname
prompt. The one exception, `AutoConnect`, is reachable only when `e2eVoiceConfig` is present, which
Main only ever supplies when `!app.isPackaged` (see `main/window.ts`) — the same unspoofable
production kill-switch pattern `docs/SECURITY.md` already documents for every other E2E automation
hook in this app.

## Identity across independent servers

T7's local cryptographic identity is portable, by design, across any number of independently
operated servers — and T8 is the first task where that portability is actually exercised end to
end. The same local `identityId` independently authenticates to Server A and Server B; each
authentication is a fresh, from-scratch challenge/response with that server, using the exact
mechanism `CLIENT_IDENTITY.md` already documents — T8 changes nothing about the identity handshake
itself. No central service learns about either connection, and **Server A never automatically
learns anything about Server B** — there is no global role, global ban, global profile, or global
nickname registry, and no cross-server correlation infrastructure exists or is introduced.

**T9's server-local permission/group/token/ban model is exactly this guarantee, now implemented.**
The same `identityId` can be Server Admin on Server A and an ordinary Guest on Server B, with
zero relationship between the two: each server owns its own `AuthorizationStore` (its own SQLite
file, its own groups/memberships/tokens/bans), Server A's bootstrap or privilege tokens are
meaningless on Server B, and a ban issued by Server A never applies on Server B. See
[`SERVER_AUTHORIZATION.md`](SERVER_AUTHORIZATION.md#cross-server-isolation) for the isolation
design and its integration-test evidence.

## Data model — what a Dedicated Server does and does not store

**Client-local** (`%APPDATA%/DiscoVoador/`, per T1/T7 — unchanged by T8/T9): identity keypair,
nickname, preferences.

**Dedicated Server runtime (in-memory, connection-lifetime only):** active connections, verified
public keys / derived `identityId`s during authentication, nicknames, voice-channel memberships,
in-flight signaling state. All of this already existed pre-T8 in `services/realtime`; T8 changed
only who operates the process holding it, not what it holds.

**Dedicated Server config (file, operator-authored, versionable):** server display name, network
bind/port/connection-cap settings, the voice-channel catalog, and (T9) `accessMode`/`dataDir`.
Never: email database, user accounts, passwords, client identity private keys, social accounts,
hardware fingerprints.

**Dedicated Server persistent authorization storage (T9, new — see
[`SERVER_AUTHORIZATION.md`](SERVER_AUTHORIZATION.md#data-split) for the complete list):** its own
SQLite file under `config.dataDir`, holding groups, group-permission assignments, identity-to-group
memberships, token digests/metadata (never raw tokens), and bans — all keyed by `identityId`, all
server-local, no cross-server relationship. This is the first Dedicated Server runtime state T9
persists to disk at all; before it, "Dedicated Server runtime" above (connections, sessions) was
exhaustively in-memory-only.

**Dedicated Server persistent chat storage (T10, new — see
[`PERSISTENT_TEXT_CHAT.md`](PERSISTENT_TEXT_CHAT.md#data-split) for the complete list):** its own,
_separate_ SQLite file under `config.dataDir` (`chat.sqlite`, never merged into T9's
`authorization.sqlite` — see [ADR 0014](../adr/0014-persistent-server-owned-chat-history.md)),
holding persisted chat messages (body, scope, channelId, sender identityId, nickname-at-send,
timestamp) for both Server Chat and per-voice-channel chat. This is the Dedicated Server's second
persistent runtime state, and the first that is expected to grow without bound under ordinary use —
a real, documented difference from T9's small, low-growth authorization store.

**Dedicated Server persistent channel storage (T13.2, new — see
[`CHANNELS_AND_SERVER_ADMINISTRATION.md`](CHANNELS_AND_SERVER_ADMINISTRATION.md) for the complete
design):** a third, separate SQLite file under `config.dataDir` (`channels.sqlite`, never merged into
T9's or T10's stores), holding the dynamic category/voice-channel hierarchy, per-node access-control
policy (referencing T9 groups by plain string ID, never a foreign key), and scrypt password verifiers.
This is the Dedicated Server's third persistent runtime state, and the first whose structure itself —
not just its rows — is administered live from the Client rather than fixed at startup by a config
file.

**Dedicated Server persistent profile/presence storage (T13.3, new — see
[`SERVER_LOCAL_PROFILES_AND_PRESENCE.md`](SERVER_LOCAL_PROFILES_AND_PRESENCE.md) for the complete
design):** a fourth, separate SQLite file under `config.dataDir` (`profiles.sqlite`, never merged
into T9's/T10's/T13.2's stores), holding per-identity avatar/custom-status/presence-preference rows
and a singleton server-avatar row. This is the first store to hold binary data (avatar image bytes,
as a `BLOB` column) and the first genuinely personal visual/social state this product persists —
still not an account: no nickname, email, real name, phone, IP, or device fingerprint is stored, and
`identity_id` remains a bare string with no foreign key into any other store.

**Not introduced by T8, T9, T10, T13.2, or T13.3:** a central account database,
`server-users.json`/`users.db`/`accounts.sqlite`-as-a-_profile_-store or any equivalent, cross-server
tracking, a global server directory, central message history (each server's `chat.sqlite` is its
own, unrelated to any other server's), central analytics/telemetry, email, password, phone number,
real name, or any concept of "this human owns a Disco Voador account." T9's SQLite file stores
authorization _subjects_ (which cryptographic identities hold which of this server's own groups),
never user profiles; T10's SQLite file stores messages and their minimal authorship metadata, never
a message-history service any party other than that one server's own operator can reach; T13.3's
SQLite file stores exactly one avatar image, one status string, and one presence preference per
identity, per server, with zero cross-server relationship for the same identity — see
[`SERVER_AUTHORIZATION.md`](SERVER_AUTHORIZATION.md), [`PERSISTENT_TEXT_CHAT.md`](PERSISTENT_TEXT_CHAT.md),
and [`SERVER_LOCAL_PROFILES_AND_PRESENCE.md`](SERVER_LOCAL_PROFILES_AND_PRESENCE.md) for the full
designs and ADR 0013/0014/0020 for why SQLite, and why one file per domain, specifically.

## Server-local instance identifier (T8 Section 12) — evaluated, deferred

T8's spec asked for an explicit evaluation of whether a Dedicated Server should have a
locally-generated, stable instance identifier, for anticipated future use: client-side server
bookmarks (T11), a possible privilege-token binding, trust-on-first-use address-reuse detection,
and diagnostics. **Decision: not implemented in T8, deliberately deferred rather than added
speculatively.** T8 introduces no concrete consumer of such an id — no bookmark list, no
trust-on-first-use check, no token binding exists yet to bind it to — and adding server-local state
with no real caller would be exactly the premature abstraction this repository's workflow guidance
warns against.

**T9 update: this deferral turned out to be correct — T9 needed no such identifier.** Token
validity is inherently server-local already, because each Dedicated Server owns its own SQLite
authorization file (`config.dataDir`) and a token digest is only ever looked up against that one
file; there was never a need to _label_ a server with an id for a token to be "bound" to. The
remaining anticipated uses (T11 bookmarks, trust-on-first-use) are still unimplemented and still a
fair candidate for this identifier when that task actually needs it — this section remains a
documented deferral, not a silent gap, for that future task to read first.

## Startup and shutdown

`services/dedicated-server/src/cli.ts` prints a startup banner once the server is actually
listening:

```text
Disco Voador Dedicated Server
Server name:   My Guild's Server
Listening:     127.0.0.1:8090
Protocol:      v3
Identity auth: enabled
Voice channels: 2
Access mode:   open
Config file:   disco-voador-server.config.json

Ready.
```

**T9's one deliberate exception**: on a genuinely fresh authorization store (first-ever start
against an empty `dataDir`), the _same_ banner write additionally includes the one-time Server
Admin bootstrap privilege key, exactly once:

```text
Initial Server Admin privilege key:

  DV-ADMIN-<43-char base64url secret>

This key is shown once and cannot be recovered later. Use it (or "Use Privilege Key" once
connected as a Guest) to become this server's Server Admin.
```

This is folded into the same `console.info` call as the rest of the banner (never a second,
separately-timed write, and never repeated on a later restart — the server only ever generates a
bootstrap token once, on the database's first-ever initialization; see
[`SERVER_AUTHORIZATION.md`](SERVER_AUTHORIZATION.md#server-admin-bootstrap)). Every other startup
value remains non-sensitive: no client private keys, no other invite/privilege secrets, no
environment values beyond the display fields above. Signal handling: `SIGINT` (Ctrl+C) and
`SIGTERM` both trigger the same
graceful-shutdown path (`server.stop()` — stop accepting new connections, close existing sessions,
release resources, then `process.exit(0)`); a shutdown failure exits non-zero. This is the same
pattern `services/realtime`'s own CLI already used since T2, reused rather than reinvented.
`services/dedicated-server` does not attempt full Windows Service/systemd integration — a documented
systemd example for advanced direct-runtime operators remains a possible future addition, not
blocking Docker-first self-hosting. An HTTP health endpoint was evaluated and deliberately not added
in T8, per the task's own explicit guidance to defer it if it would substantially complicate the
server; **T14 added it** — `GET /healthz`/`GET /readyz`, sharing the same port as the WebSocket
listener (see [`PRODUCTION_SELF_HOSTING.md`](PRODUCTION_SELF_HOSTING.md)) — so process-level health
is no longer the only liveness signal available to an operator or a container orchestrator.

**Known Windows testing limitation** (already documented for T2, reapplies unchanged here):
`child.kill('SIGTERM')` from a _different_ Node process does not deliver a catchable POSIX signal on
Windows — it forcibly terminates the child, bypassing `process.on('SIGTERM', ...)` entirely. This is
Node's own documented behavior, not a Dedicated Server defect. `services/dedicated-server/scripts/
smoke.mjs` accounts for this: it exercises the real cross-process SIGTERM path but only logs the
resulting `(exitCode, signal)` rather than asserting `exitCode === 0` on Windows; the actual
graceful-shutdown _logic_ (`stop()` correctly closing every open connection and releasing resources)
is verified separately, in-process, by `tests/dedicated-server/integration.test.ts`'s direct
`stop()` test.

## Server smoke test

```text
pnpm --filter @disco-voador/dedicated-server run smoke
```

Real end-to-end, no Electron involved: spawns the actual built CLI (`dist/cli.js`) as a child
process, waits for it to report listening, captures the one-time bootstrap Server Admin token
straight from the real stdout banner (T9), connects a real `ws` client, completes the full T7
handshake, receives `server:hello` (asserting the `serverName`/`serverCapabilities` fields) and the
voice-channel catalog, redeems the bootstrap token over the real socket and asserts it grants
`server-admin` (T9), disconnects cleanly, then sends `SIGTERM` and observes the exit (subject to
the Windows caveat above).

## Isolation guarantee — two independent servers

`tests/dedicated-server/integration.test.ts` starts two real, independently configured Dedicated
Server instances (different names, different channel catalogs, different ephemeral ports) inside
the same Vitest process and proves, against real sockets (no mocked transport, matching the
real-network testing philosophy `REALTIME_PROTOCOL.md` already established for T2):

- Sessions do not cross — a connection to Server A never appears in Server B's connection count.
- Channel state does not cross — each server's `voice:catalog` reflects only its own configured
  channels.
- Server metadata differs correctly — each server's `server:hello` carries its own configured name.
- The same local `identityId` independently authenticates to both servers in the same test run, and
  both servers accept it, with neither server needing to know about the other.
- A second server bound to an already-occupied port fails clearly at startup (no silent
  port-hunting, no hang).
- Graceful shutdown (`stop()`) actually closes open connections.
- A server at its configured `maxConnections` cap rejects a new connection deterministically
  (`SERVER_AT_CAPACITY`), reusing the existing T2 error/close-code path unchanged.
- (T9) Authorization state does not cross either: a bootstrap token minted by Server A is
  `TOKEN_INVALID` on Server B, and a ban issued by Server A does not apply on Server B — see
  [`SERVER_AUTHORIZATION.md`](SERVER_AUTHORIZATION.md#cross-server-isolation) for the dedicated
  T9 isolation tests (run in the same two-real-server-instances style this section describes).

## Known limitations

- The Section 50-style full real-Electron "connect to Server A, disconnect, connect to Server B,
  same identity, fresh session state" proof is covered at the Vitest integration level (two
  real independent server instances, one local identity authenticating to both) plus a real-Electron
  single-server connection smoke (`e2e:connection-smoke`), rather than as one combined real-Electron
  two-server-switch script. The task's own spec explicitly allowed this ("a focused real Electron
  test if practical") — building the additional two-phase auto-connect/auto-disconnect/
  auto-reconnect Renderer automation and matching Main-process exit-watcher this would require was
  judged not to add proportional confidence beyond what the integration test plus the identity- and
  connection-smoke E2Es already establish, since the App.tsx state-machine change that makes
  server-switching possible reuses T3–T7's already-proven effect-teardown lifecycle with zero new
  teardown code (see [Client connection UX](#client-connection-ux) above).
- No installer — that remains T15.
- No admin API (a normal web dashboard/remote management plane) — deliberately out of scope for
  self-hosting per T14's own brief; the existing desktop server-admin UX remains the only admin
  surface. Production TLS (via reverse proxy), TURN deployment, Docker packaging, and an HTTP health
  endpoint were all added by T14 — see [`PRODUCTION_SELF_HOSTING.md`](PRODUCTION_SELF_HOSTING.md).
- Server-local instance identifier — evaluated and deliberately deferred, not implemented (see
  above).
- `ConnectionScreen`'s `connectionError` prop is still always `undefined` as of T9 — there is no
  user-visible error message on that specific screen for a failed connection attempt (wrong
  address, server unreachable, protocol mismatch before the optimistic `connected` transition).
  Found by `qa-engineer` during T8's own review; still not fixed, and still not a violation of any
  T8 or T9 acceptance criterion, since `App.tsx` moves to `VoiceChannelView` optimistically on
  Connect rather than waiting on the socket. **T9's own admission errors (`BANNED`,
  `INVITE_REQUIRED`, and the post-connection `TOKEN_*` codes) are not affected by this specific
  gap** — they occur after that optimistic transition, so `VoiceChannelView` is already mounted and
  its `state.lastError` (set by `use-voice-channel.ts`'s `onServerError`) renders them as a plain
  user-visible alert (see [`SERVER_AUTHORIZATION.md`](SERVER_AUTHORIZATION.md#client-ux)). The
  original `ConnectionScreen` gap remains a real, worthwhile follow-up for a later task (T11).
