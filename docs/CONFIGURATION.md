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

## Expected client-visible values

| Variable        | Purpose                                       | Secret?   | Notes                                                      |
| --------------- | --------------------------------------------- | --------- | ---------------------------------------------------------- |
| `SIGNALING_URL` | HTTPS/WSS endpoint used by the desktop client | No        | Require an allowed secure scheme outside local development |
| `STUN_URL`      | STUN URI used for ICE                         | No        | May contain multiple values after T3 defines parsing       |
| `TURN_URL`      | TURN/TURNS URI used for relay fallback        | No        | Must point to the operator's service by default            |
| `TURN_USERNAME` | Short-lived TURN REST username                | Sensitive | Obtain at session time; do not bake into a desktop bundle  |
| `TURN_PASSWORD` | Short-lived TURN REST credential              | Secret    | Keep in memory only as long as necessary; never log        |

The root [`.env.example`](../.env.example) contains blank placeholders for discoverability. A real
`.env` is ignored and must not be committed.

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

## Future server-only values

Names are provisional until their owning task defines schemas:

```text
DATABASE_PATH
TURN_SHARED_SECRET
TURN_CREDENTIAL_TTL_SECONDS
TRUSTED_ORIGINS
```

`TURN_SHARED_SECRET` is never client-visible. The realtime service should use it to mint expiring
credentials. Production deployments should mount secrets from the operator's secret mechanism or
restricted files rather than placing them in Compose YAML, command lines, images, or source.

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

`services/realtime` (T2) reads configuration from `process.env` only — no command-line arguments
or operator config files yet; that need can be added later if a real deployment requires it.
Desktop user preferences such as device choice are application state, not environment
configuration.

## Coturn templates

[`infrastructure/coturn/`](../infrastructure/coturn/) contains reviewed starting templates. Copy an
example to its ignored filename and replace placeholders outside source control. The production
template uses the full relay range and Linux host networking; the bridge template deliberately uses
a small range for local validation only. See [`references/COTURN.md`](references/COTURN.md).
