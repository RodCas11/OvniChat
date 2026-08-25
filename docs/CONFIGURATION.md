# Configuration philosophy

Configuration must be explicit, typed, validated at process startup, and separated by trust
boundary. Missing production configuration should fail with a useful error; it must not silently
fall back to hosted services or embedded credentials.

`packages/config` (implemented in T2) provides the shared, reusable pieces: `parseConfig(schema,
source)` validates a source once against a `zod` schema and throws a `ConfigValidationError`
listing every violation, plus small coercion factories (`envPort`, `envPositiveInt`,
`envNonEmptyString`) for values that always arrive as strings. Each service defines its own
concrete schema from these primitives — see `services/realtime/src/config.ts` for the first real
example — rather than `packages/config` prescribing one global shape.

## Client-visible values

The desktop client is configured via `DISCO_VOADOR_*` variables read by
`apps/desktop/src/main/desktop-config.ts` — `DISCO_VOADOR_REALTIME_URL` (the server address, normally
entered per-connection via the Add Server dialog rather than baked in) and `DISCO_VOADOR_STUN_URLS`
(comma-separated static STUN URIs). There is no client-visible TURN environment variable of any kind,
by design: TURN credentials are never a static client-side value — they are short-lived, minted
server-side, and pushed dynamically over the already-authenticated realtime connection
(`server:turn-credentials`, see "Dedicated Server values" below and
[`adr/0023-turn-rest-credential-minting-architecture.md`](adr/0023-turn-rest-credential-minting-architecture.md)).
An earlier draft of this document anticipated a static `TURN_URL`/`TURN_USERNAME`/`TURN_PASSWORD`
env-var model before that mechanism was designed; it did not match what was actually built and has
been removed here rather than left standing as a second, conflicting source of truth.

The root [`.env.example`](../.env.example) and
[`infrastructure/docker/.env.example`](../infrastructure/docker/.env.example) contain placeholders
for discoverability. A real `.env` is ignored and must not be committed.

## Realtime service values (implemented, T2)

Defined and validated in `services/realtime/src/config.ts`; see
[`docs/architecture/REALTIME_PROTOCOL.md`](architecture/REALTIME_PROTOCOL.md) for how each is
used. None of these are secrets.

| Variable                           |   Default | Purpose                                      |
| ---------------------------------- | --------: | -------------------------------------------- |
| `REALTIME_HOST`                    | 127.0.0.1 | Bind address                                 |
| `REALTIME_PORT`                    |      8090 | Bind port (`0` = ephemeral, used by tests)   |
| `REALTIME_MAX_CONNECTIONS`         |      1000 | Maximum concurrent connections               |
| `REALTIME_MAX_MESSAGE_BYTES`       |     16384 | Maximum inbound WebSocket frame size         |
| `REALTIME_HANDSHAKE_TIMEOUT_MS`    |      5000 | Time allowed to send `client:hello`          |
| `REALTIME_HEARTBEAT_INTERVAL_MS`   |     15000 | Interval between server-initiated pings      |
| `REALTIME_HEARTBEAT_TIMEOUT_MS`    |     10000 | Grace period for a pong before disconnecting |
| `REALTIME_RATE_LIMIT_MAX_MESSAGES` |        30 | Messages allowed per connection per window   |
| `REALTIME_RATE_LIMIT_WINDOW_MS`    |     10000 | Rate-limit window length                     |
| `LOG_LEVEL`                        |    `info` | `debug`\|`info`\|`warn`\|`error`             |

## Dedicated Server values (implemented, T14)

Defined and validated in `services/dedicated-server/src/config.ts`, layered on top of the realtime
values above per the same `defaults < config file < environment variables` precedence (T8 Section
9). None of these belong in the hand-edited config file except `publicHost` — see that file's own
doc comment on why secrets never do.

| Variable                                   | Secret? | Notes                                                                                      |
| ------------------------------------------ | ------- | ------------------------------------------------------------------------------------------ |
| `DISCO_VOADOR_SERVER_PUBLIC_HOST`          | No      | The Public Server Endpoint; display-only, never used for binding                           |
| `DISCO_VOADOR_DEPLOYMENT_SCOPE`            | No      | `public` or `local`; diagnostic only. Inferred from the public host when unset             |
| `DISCO_VOADOR_TURN_SHARED_SECRET`          | Secret  | Coturn `use-auth-secret` REST shared secret; must be set with the URLs below or not at all |
| `DISCO_VOADOR_TURN_URLS`                   | No      | Comma-separated `turn:`/`turns:` URIs, handed to remote clients verbatim                   |
| `DISCO_VOADOR_TURN_CREDENTIAL_TTL_SECONDS` | No      | Default `21600` (6 hours); only meaningful when TURN is configured                         |

### The Public Server Endpoint

`DISCO_VOADOR_SERVER_PUBLIC_HOST` and `DISCO_VOADOR_TURN_URLS` describe the same physical thing from
two angles: the address remote clients use. `install-chantivo.sh` derives both from one `--hostname`
(the **Public Server Endpoint**) precisely so they cannot disagree; an operator configuring by hand
must keep them consistent themselves.

**`DISCO_VOADOR_TURN_URLS` is handed to every remote client verbatim** as their `RTCIceServer.urls`.
A loopback (`turn:127.0.0.1:3478`), private-network, or Docker-internal value means every client
tries to reach _its own_ machine and relay fails silently — this happened in production. A
loopback/LAN value is legitimate for development, integration tests, and deliberate LAN-only
deployments; set `DISCO_VOADOR_DEPLOYMENT_SCOPE=local` there so diagnostics expect it.

`DISCO_VOADOR_DEPLOYMENT_SCOPE` changes no binding, routing, or authentication behavior. It exists
only so `chantivo-server doctor`'s `TURN advertised endpoint` check can distinguish a deliberate
local address from a broken public one. When unset it is inferred from
`DISCO_VOADOR_SERVER_PUBLIC_HOST` (public-looking host → `public`, unset or LAN-looking → `local`),
so no existing deployment has to set anything.

`DISCO_VOADOR_TURN_SHARED_SECRET` is never client-visible and never persisted — the realtime
service (`services/realtime/src/turn-credential-port.ts`, backed by
`services/dedicated-server/src/turn/mint-turn-credentials.ts`) uses it only to mint short-lived,
per-connection TURN credentials (`server:turn-credentials`) at the moment a connection reaches
`ready`. Production deployments should mount this secret from the operator's own secret mechanism
or a restricted file rather than placing it in Compose YAML, command lines, images, or source.

## Health endpoint (implemented, T14)

`services/realtime` exposes `GET /healthz` (liveness) and `GET /readyz` (readiness — 503 once
`connections.size >= REALTIME_MAX_CONNECTIONS`) on the same bound host/port as the WebSocket
server. Both return only a boolean-shaped status plus a connection count — never version strings,
config values, paths, or secrets; this is deliberately not an admin surface.

## Data-directory instance lock (implemented, T14)

`services/dedicated-server` acquires an exclusive `<dataDir>/.lock` file (via `data-dir-lock.ts`)
before opening any SQLite store, so two server processes accidentally pointed at the same data
directory fail fast with an actionable error instead of corrupting shared state. `:memory:` is a
documented no-op. The lock is released on graceful shutdown (`SIGINT`/`SIGTERM`) and on a failed
startup.

## Rules

1. Parse once at the process boundary and expose a typed, immutable result.
2. Validate URL schemes, hostnames, numeric ranges, file paths, and mutually dependent fields.
3. Distinguish public build-time values, runtime service values, and secrets.
4. Do not access environment variables ad hoc throughout application code.
5. Do not serialize server secrets or privileged paths through IPC.
6. Redact credentials and query tokens in errors, metrics, diagnostics, and crash reports.
7. Tests use explicit fixtures and obviously invalid/example domains—not production values.
8. Adding a required external SaaS endpoint for core communication violates the architecture.

## Precedence

`services/realtime` (T2) reads configuration from `process.env` only. `services/dedicated-server`
(T8, extended T14) layers an operator-authored config file underneath that:
`defaults < config file < environment variables` — see "Dedicated Server values" above and
[`architecture/DEDICATED_SERVER.md`](architecture/DEDICATED_SERVER.md). Neither service accepts
command-line arguments; that need can be added later if a real deployment requires it. Desktop user
preferences such as device choice are application state, not environment configuration.

## Coturn templates

[`infrastructure/coturn/`](../infrastructure/coturn/) contains reviewed starting templates. Copy an
example to its ignored filename and replace placeholders outside source control. The production
template uses Linux host networking and a bounded relay range sized for a small self-hosted
deployment (`49152-49351`, ~200 ports — see `infrastructure/coturn/README.md`'s "Sizing the relay
port range" section for the reasoning and how to enlarge it); the bridge template deliberately uses
an even smaller range for local validation only. See [`references/COTURN.md`](references/COTURN.md).
