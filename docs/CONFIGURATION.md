# Configuration philosophy

> T0 defines names and handling rules only. No runtime configuration loader exists yet.

Configuration must be explicit, typed, validated at process startup, and separated by trust
boundary. Missing production configuration should fail with a useful error; it must not silently
fall back to hosted services or embedded credentials.

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

## Future server-only values

Names are provisional until their owning task defines schemas:

```text
REALTIME_HOST
REALTIME_PORT
DATABASE_PATH
TURN_SHARED_SECRET
TURN_CREDENTIAL_TTL_SECONDS
TRUSTED_ORIGINS
LOG_LEVEL
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

T0 does not prescribe a final precedence system. T2/T10 should choose the minimum needed across
command-line arguments, environment, and operator files, then document it with tests. Desktop user
preferences such as device choice are application state, not environment configuration.

## Coturn templates

[`infrastructure/coturn/`](../infrastructure/coturn/) contains reviewed starting templates. Copy an
example to its ignored filename and replace placeholders outside source control. The production
template uses the full relay range and Linux host networking; the bridge template deliberately uses
a small range for local validation only. See [`references/COTURN.md`](references/COTURN.md).
