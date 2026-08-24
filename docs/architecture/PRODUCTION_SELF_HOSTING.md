# Production self-hosting architecture (T14)

This document is the technical source of truth for how a Chantivo Dedicated Server deployment fits
together in production. For the practical operator-facing walkthrough, see
[`../SELF_HOSTING.md`](../SELF_HOSTING.md). For the design decisions and their alternatives, see
[ADR 0023](../adr/0023-turn-rest-credential-minting-architecture.md) (TURN) and
[ADR 0024](../adr/0024-tls-and-reverse-proxy-responsibility.md) (TLS/reverse proxy).

## Scope

T14 operationalizes decisions this repository had already made (Coturn as the TURN implementation,
short-lived server-minted credentials, no mandatory central service, SQLite-per-store persistence, P2P
mesh transport) into something a real operator can run: a production Docker image, a health endpoint,
a TURN credential-minting mechanism, a bounded/documented Coturn deployment, a first-class TLS
reverse-proxy example, a data-directory instance lock, and documentation. It does not redesign any of
those prior decisions, does not add an installer (T15), does not touch SFU (T17), and does not change
the desktop UI.

## The production deployment contract

**Listen address**: `REALTIME_HOST`/`REALTIME_PORT` (default `127.0.0.1:8090`, config-file `host`/
`port`, or environment). Never listens beyond localhost without an explicit operator choice.

**Public server address**: `DISCO_VOADOR_SERVER_PUBLIC_HOST` — display-only, never used for binding.
What a client actually types is documented in `SELF_HOSTING.md`'s "What a user types" section; it is
resolved by `parseServerAddress` (`apps/desktop/src/renderer/connection/parse-server-address.ts`),
independent of this config value.

**Realtime/WebSocket endpoint**: one port serves both the WebSocket protocol and the two HTTP health
routes (`services/realtime/src/server.ts`, an explicit `node:http` `Server` with `ws`'s
`WebSocketServer` attached via its `server` option).

**Data directory**: `DISCO_VOADOR_SERVER_DATA_DIR` (default a relative path for bare-metal/dev use;
`/data` inside the production Docker image, pinned by the `Dockerfile`, never by changing the library
default). See [Persistent data](#persistent-data).

**TURN endpoint**: `DISCO_VOADOR_TURN_URLS` (operator-supplied, only meaningful alongside
`DISCO_VOADOR_TURN_SHARED_SECRET`) — see [TURN](#turn-credential-minting).

**STUN endpoint**: the desktop client's own `DISCO_VOADOR_STUN_URLS` (pre-existing, unchanged by T14).
A self-hosted Coturn instance doubles as STUN at the same address.

**TLS expectation**: `services/realtime` never terminates TLS itself. Production internet-facing
deployments are expected to run a reverse proxy in front of it (Caddy is the documented first-class
example) or accept a plain-`ws://` LAN/private posture. See
[ADR 0024](../adr/0024-tls-and-reverse-proxy-responsibility.md).

**Health endpoints**: `GET /healthz` (liveness), `GET /readyz` (readiness — 503 once
`connections.size >= REALTIME_MAX_CONNECTIONS`). Both return only `{"status": ..., ...}` — never
version, config, or secret data.

**Required ports**: the one WebSocket/health port (8090 by default). **Optional ports**: 80/443
(reverse-proxy TLS), 3478 TCP+UDP and the configured relay range (TURN), 5349 TCP (TURN over TLS, only
if configured). See `SELF_HOSTING.md`'s port matrix for the full table.

**Database ownership**: four independent SQLite files (`authorization.sqlite`, `chat.sqlite`,
`channels.sqlite`, `profiles.sqlite`), each with its own migration history, all under one data
directory. T14 did not merge or restructure this model (ADR 0009).

**Backup unit**: the entire data directory, offline (server stopped). See
[Backup and restore](#backup-and-restore).

**Shutdown semantics**: `SIGTERM`/`SIGINT` → stop accepting new connections → close every open
connection → close the WebSocket/health listener → close all four SQLite stores → release the
data-directory lock → exit. Already implemented since T2/T8; T14 added the lock-release step and
closed two gaps in it (see [Data-directory instance lock](#data-directory-instance-lock)).

## Configuration model

**Decision: extend the existing flat model, do not restructure into nested blocks.**
`DedicatedServerConfig` (`services/dedicated-server/src/config.ts`) gained two additive fields —
`publicHost` (display-only) and `turn: TurnConfig | undefined` — on top of its existing shape. The
existing precedence (`defaults < config file < environment variables`), the `.strict()`-validated
config-file schema, and every existing field's behavior are all unchanged.

This was a deliberate choice against the alternative the original brief sketched (nested `server:`/
`public:`/`data:`/`turn:` YAML blocks): that config precedence/merge logic is tested, load-bearing (
`services/realtime`'s own config depends on the file→env translation it provides), and a shape change
had no product justification — T14 is operationalization, not a storage/config redesign (ADR 0009,
ADR 0012).

`turn` is environment-variable-only, **never** part of the hand-edited, versionable config file — that
file's own rule (and `docs/SECURITY.md`'s pre-existing "[the config file] never contains
credentials... only display/network/channel configuration") already drew this line for other cases.
`DISCO_VOADOR_TURN_SHARED_SECRET` and `DISCO_VOADOR_TURN_URLS` are validated together — both present
or both absent, enforced by a `zod` `superRefine`, never a silently-partial TURN configuration. See
`docs/CONFIGURATION.md` for the complete field reference.

## Health endpoint

`services/realtime/src/server.ts`'s `start()` now creates an explicit `http.Server`, attaches `ws`'s
`WebSocketServer` to it via `{server: httpServer}` (no new dependency — `ws@8.21.3` already supported
this), and handles `GET /healthz`/`GET /readyz` before any WebSocket upgrade. `stop()` closes both the
WebSocket server and the HTTP server. This is deliberately minimal: two read-only routes, no admin
surface, no version/config/secret exposure — matching this service's existing dependency-free posture
(no Express/Fastify, ~15 lines of `node:http`).

## TURN credential minting

See [ADR 0023](../adr/0023-turn-rest-credential-minting-architecture.md) for the full decision record.
Summary: `services/dedicated-server/src/turn/mint-turn-credentials.ts` implements Coturn's standard
`use-auth-secret` REST convention (HMAC-SHA1 over an epoch-seconds expiry, from an operator-supplied
shared secret). Minted credentials are pushed once, unconditionally, to an already-authenticated
connection as part of the same message burst `handleIdentityProof` already sends after a successful
identity proof (`server:hello`, catalog, presence snapshot, etc.) — a new, additive
`server:turn-credentials` protocol message, no version bump (protocol stays v5).

The desktop client applies them via `packages/rtc-core`'s `P2PMeshTransport.setIceServers()` (REPLACE
semantics — the caller merges STUN and TURN itself), which only affects peer connections created
_after_ the call; already-established connections are unaffected. **Accepted limitation**: no
mid-session credential refresh — a connection open past its credential's TTL (default 6 hours) that
then needs a _new_ peer connection receives a stale credential for that one peer. Documented, not
silently gapped.

## Docker image

`services/dedicated-server/Dockerfile` — multi-stage:

- **Build stage** (`node:24.18.1-slim`): `pnpm --filter @disco-voador/dedicated-server... build`,
  then `pnpm --filter @disco-voador/dedicated-server deploy --prod --config.inject-workspace-packages=true /deploy`
  — pnpm's own workspace-pruning `deploy` command, which resolves and copies only
  `@disco-voador/dedicated-server`'s real runtime dependency closure (`@disco-voador/{config,identity,
protocol,realtime,shared}` + `ws` + `zod`). This is what keeps Electron, the desktop Renderer, and
  `packages/windows-media` entirely out of the image — not manual file selection.
- **Runtime stage** (same pinned base): non-root user (`chantivo`, fixed uid 10001), `/data` as the
  sole writable volume, `ENV DISCO_VOADOR_SERVER_DATA_DIR=/data`, `HEALTHCHECK` using Node's built-in
  `fetch` against `/healthz` (no `curl`/`wget` assumed — this is a `-slim` image), `EXPOSE 8090`,
  `CMD ["node", "dist/cli.js"]`.

No secret is ever baked into either stage — every `DISCO_VOADOR_*`/`REALTIME_*` value, including the
TURN shared secret, is supplied only at `docker run`/Compose time via environment variables.
`node:sqlite` is a Node built-in, so no native-module rebuild step is needed for the container's
architecture.

`.dockerignore` (repo root) keeps the build context reasonable and ensures `.env`/local dev artifacts
never enter the image build context.

## Docker Compose

`infrastructure/docker/`:

- `compose.server.example.yaml` — the `chantivo-server` service alone. Builds the Dockerfile from the
  repo root, publishes only `8090:8090`, mounts a named volume (`chantivo-server-data`) at `/data`,
  `restart: unless-stopped`. Sets `REALTIME_HOST=0.0.0.0` explicitly in the service definition (not
  `.env`) — required because the app's own safe bare-metal default (`127.0.0.1`) would otherwise be
  unreachable through Docker's published-port NAT; this is the deliberate "explicit operator choice"
  the security posture already requires, not a relaxation of it.
- `compose.self-hosted.example.yaml` — the combined stack an operator actually runs, composed via
  Compose's `include:` mechanism over `compose.server.example.yaml` and the pre-existing
  `compose.turn.example.yaml`, so neither service definition is duplicated anywhere. Coturn stays
  behind the existing `profiles: ['turn']` gate — `up -d` alone starts only the server (a fully
  supported STUN/P2P-only deployment); `--profile turn` also starts Coturn.
- `.env.example` — every relevant `DISCO_VOADOR_*`/`REALTIME_*` value with safe placeholders, never a
  real secret.

## Coturn

Pre-existing scaffolding (`infrastructure/coturn/`) was extended, not redesigned: the production
template's relay range was narrowed from the full ephemeral range (`49152-65535`, ~16,384 ports) to a
bounded, sized default (`49152-49351`, ~200 ports), with documented reasoning
(`infrastructure/coturn/README.md#sizing-the-relay-port-range`) and an explicit path to enlarge it.
Anonymous relay, CLI/web administration, and loopback-peer allowance all remain rejected by default,
unchanged from the pre-T14 templates. The dev/bridge template's already-narrow range (`49160-49200`)
was left untouched.

## Reverse proxy

See [ADR 0024](../adr/0024-tls-and-reverse-proxy-responsibility.md). Caddy
(`infrastructure/reverse-proxy/Caddyfile.example`) is the one first-class documented example: two
lines, automatic HTTPS, WebSocket upgrade support by default with no extra directive. TURN is never
routed through it — Coturn is exposed directly, per its own network requirements.

## Data-directory instance lock

`services/dedicated-server/src/storage/data-dir-lock.ts` — an `O_CREAT|O_EXCL` exclusive-create lock
file (`<dataDir>/.lock`, containing the holding process's PID), acquired at `cli.ts` startup before any
SQLite store opens, released on graceful shutdown. A second process pointed at the same data directory
fails immediately with an actionable `DataDirLockError`, rather than operating unpredictably against
shared SQLite files. `:memory:` is a documented no-op (used only by tests).

During the T14 architecture review, a gap was found and closed: the lock was released on the graceful
shutdown and startup-failure paths, but not on `uncaughtException`/`unhandledRejection` or a
mid-`start()` failure — all three now release it too, so a handled crash (not just a hard `SIGKILL`)
doesn't leave a stale lock file. A stale lock from an actual unclean kill still requires manual
deletion — documented as an accepted, narrow limitation (cross-platform PID-liveness probing was
judged not worth the complexity for this).

## Persistent data

```
<dataDir>/
  authorization.sqlite   # groups, permissions, tokens, bans (T9)
  chat.sqlite             # server-wide + per-channel chat history (T10)
  channels.sqlite         # channel/category hierarchy and ACL (T13.2)
  profiles.sqlite         # avatars, status, presence (T13.3)
  .lock                   # T14 instance lock
```

Unchanged from pre-T14: four independent SQLite files (`node:sqlite`'s `DatabaseSync`), each with its
own hand-rolled, transactional, ordered migration history (`schema_migrations` table per store), WAL
journal mode, foreign keys enforced. T14 did not add, remove, or merge any store, and did not change
SQLite pragma tuning.

## Backup and restore

**Decision: documented offline procedure only — no new CLI subcommand.** `cli.ts` parses zero
arguments today; a `backup` subcommand would only wrap a plain, already-correct filesystem operation
(stop → copy → restart is consistent because WAL mode plus a stopped process leaves an ordinary,
self-consistent file copy) for no correctness benefit over documenting that operation directly. See
`SELF_HOSTING.md`'s "Backup and restore" section for the operator-facing procedure.

## Logging

Unchanged mechanism (`services/realtime/src/logging.ts`'s dependency-free structured JSON-line
logger), extended with new event fields for T14's own concerns (server listening address including
the health-endpoint port, TURN configured/not). No log rotation is implemented or attempted — this is
explicitly left to Docker/systemd/the operator's own log collector.

## What was not changed

The P2P mesh transport and its offer/answer ownership rules (ADR 0006), the four-SQLite-file storage
model (ADR 0009), the server-local authorization/permission model (T9), the realtime protocol's
handshake and message-routing structure beyond the one additive TURN message, and every piece of the
desktop UI outside the one `parseServerAddress` scheme-detection change. No new central,
Chantivo-operated service was introduced anywhere (ADR 0004, ADR 0010).

## Verification record

This section records exactly what has and has not been proven, with evidence, rather than asserting a
blanket pass. See [`../tasks/T14_PRODUCTION_SELF_HOSTING.md`](../tasks/T14_PRODUCTION_SELF_HOSTING.md)
for the full final report.

**Proven with real evidence** (all run against the actual built server, not a description of expected
behavior):

- Full repository gate (`corepack pnpm check`): prettier, eslint, whole-repo typecheck, the full
  Vitest suite, composite build, repository verification, and dependency audit all pass.
- The pruned `pnpm deploy --prod` artifact (the exact output the Docker build stage produces) was
  built and run standalone outside a container, and its `GET /healthz`/`GET /readyz` responded
  correctly over real HTTP.
- **Restart/persistence**: a real built server created genuine state (a category, a voice channel, a
  channel chat message, a profile status) through a real WebSocket client speaking the actual
  protocol, was stopped, and a fresh process against the same data directory correctly reconnected the
  same identity and confirmed every piece of that state survived — verified through the real protocol
  (`client:chat-history-request`, catalog/authorization-state on admission), not by inspecting
  `.sqlite` files directly.
- **Data-directory lock**: a third process started against a data directory already held by a running
  second process failed immediately with the documented `DataDirLockError` message — no hang, no
  silent corruption.
- **Backup/restore**: the checkpoint-clean data directory (all four `.sqlite` files, no `-wal`/`-shm`
  remaining after a clean close) was copied to a separate location, the original was destroyed, and a
  server started directly against the restored copy correctly recovered every piece of the same state
  via the real protocol.
- **WAL checkpoint behavior**: directly invoking the same four store `.close()` calls
  `DedicatedServerHandle.stop()` performs was shown to fully checkpoint WAL content into each main
  `.sqlite` file and remove the `-wal`/`-shm` sidecars — real evidence supporting the documented
  "stop first, then copy" offline-backup model.
- **One genuine, honestly-documented environment limitation**: a real OS-level `SIGTERM`/`SIGINT`
  delivered from _outside_ the process could not be verified to reach the running server in this
  specific sandboxed Windows environment — `GenerateConsoleCtrlEvent`-based console-control signals
  did not propagate to spawned child processes here even though the Win32 API reported success at
  every step (confirmed via an isolated minimal repro, not just the dedicated-server process itself).
  `cli.ts`'s registered `SIGINT`/`SIGTERM` handlers route to the identical `shutdown()` function
  either way, and the store-close behavior they call was verified directly (see WAL checkpoint
  behavior above) — what remains unverified is OS-level signal _delivery_ in this sandbox
  specifically, not the shutdown logic itself. A non-sandboxed Windows host or a Linux container
  (where `SIGTERM` delivery is unambiguous) would close this gap.

**Proven on a real Ubuntu 24.04 VPS** (all four remaining Docker-dependent items above were closed by
switching the verification environment from the Windows workstation — where Docker/WSL2 could not be
installed without administrator privileges the session lacked — to a real remote Linux VPS reachable
over SSH, per explicit operator instruction; the Windows workstation itself was never modified):

- **Native systemd deployment**: a real production runtime artifact (the same `pnpm deploy --prod`
  output the Docker image uses) running under a dedicated `chantivo` service user, `systemctl
start`/`restart`/`stop` all real and correct, `/healthz`/`/readyz` responding correctly, and — the
  one gap the Windows environment genuinely could not close — a real, externally-delivered `SIGTERM`
  (`kill -TERM <pid>`, unambiguous on real Linux) triggering the documented clean shutdown sequence
  within milliseconds. This closes the "OS-level signal delivery" gap noted above: the shutdown
  _logic_ was already verified on Windows; real Linux now also verifies real signal _delivery_.
- **Data-directory lock**, re-verified natively: a manually-started second process against the
  systemd-held data directory failed immediately with the documented error; the lock was confirmed
  released (file gone) after a clean stop and NOT released after a forced `SIGKILL`-equivalent
  (`docker rm -f` in the separate Docker phase) — exactly the documented, accepted behavior.
- **Backup/restore**, re-verified natively: stop → `tar` the real data directory (confirmed no
  `-wal`/`-shm` sidecars survive a clean stop, on real Linux this time) → restore into a fresh
  directory → real protocol client confirms every piece of state intact.
- **Native Coturn** (Ubuntu 24.04's own `apt install coturn`, not just the pinned Docker image):
  installed, configured from this repo's own reviewed template, running non-root, a real manually-
  computed TURN REST credential got a real allocation via `turnutils_uclient`, an invalid credential
  was correctly rejected (`check_stun_auth` HMAC mismatch, confirmed in Coturn's own logs).
- **Real TURN credential pipeline, end to end**: a real WebSocket client completing the actual
  Chantivo identity-proof handshake received `server:turn-credentials` only after authentication
  (confirmed: nothing arrives pre-auth), containing only the derived `username`/`credential` pair
  (never the raw shared secret), and that exact minted credential was independently confirmed to work
  against the real Coturn instance.
- **The decisive forced-relay WebRTC proof**: two independent `RTCPeerConnection`-equivalent peers
  (`werift`, a real RFC-compliant WebRTC stack), both configured with `iceTransportPolicy: 'relay'`
  and the same real Chantivo-minted credential, established a real data-channel connection through
  Coturn. Concrete evidence, not inference: both peers' **selected/nominated candidate pairs** show
  `candidateType: "relay"` on **both** the local and remote candidate — and no host/srflx candidate
  was ever gathered on either side (confirming the relay-only policy was enforced at gather time, not
  just at selection time). The relay ports used (`49186`/`:49333`, on the VPS's real public IP) fall
  inside the documented bounded range (`49152-49351`). A second run with a deliberately corrupted credential
  correctly failed to gather any relay candidate at all, independently corroborated by Coturn's own
  rejection log for the same timestamp.
- **Native Caddy**: installed from Caddy's official apt repository, real TLS handshake (internal CA —
  no public DNS exists for the validation host, honestly distinguished from a public Let's Encrypt
  certificate, which was not tested), a real `wss://` connection through the proxy completed a full
  identity handshake and stayed open 38 seconds across two heartbeat intervals with no drop.
- **Docker**: Docker Engine + Compose plugin installed via the official method, the production image
  built clean (345MB, `node:24.18.1-slim` base, confirmed free of Electron/desktop/windows-media
  content), the container confirmed running as real non-root uid 10001, graceful `docker stop`
  completing in under a second with exit code 0 (not the `137` a forced kill would show), persistence
  confirmed across both container restart and full container recreation with the same named volume.
- **Docker Compose Coturn, actually started (not just config-validated)**: the combined
  `compose.self-hosted.example.yaml` stack (`--profile turn up`) was run for real, with the native
  Coturn/Chantivo services temporarily and safely stopped to free the shared ports, then restored
  afterward. Both `chantivo-server` and `coturn` reached a real running state inside Compose (Coturn's
  own real listener-bound log lines confirmed, not inferred from "container running"). A real
  TURN credential minted by the _Compose-deployed_ Chantivo server (not reused from the native run)
  was proven to work against the _Compose-deployed_ Coturn via the same forced-relay proof described
  below, entirely within the Docker deployment. Persistence (restart), graceful shutdown
  (`docker compose stop`, exit code 0), and a full stop/restart cycle were all re-verified against
  this Compose-specific deployment. One real defect was found and fixed at the deployment-config
  level (not source code): the pinned Coturn image runs as a fixed numeric `uid=65534 gid=65534`
  (`nobody`/`nogroup`, confirmed via `docker run --rm coturn/coturn:4.17.2-r0 id`, not assumed), so a
  config file permissioned the native/systemd way (`640`, group-restricted) is silently unreadable to
  it, causing Coturn to fall back to an unauthenticated default rather than fail loudly. **An initial
  fix (`chmod 644`) was itself caught and corrected before this task was considered closed**: that
  runtime config file contains the real `static-auth-secret` in plaintext (the committed templates
  deliberately omit it; the runtime copy has it appended, same as the native path), so making it
  world-readable would have been a real secret exposure, not an acceptable production fix. The correct
  fix — `chown 65534:65534` + `chmod 400`, restricting the file to exactly the one process that needs
  it — was verified to both keep the secret non-world-readable and let Coturn read its real config
  (confirmed via startup logs showing the real `realm`/deny-ranges, no fallback), and the full mint →
  allocate → forced-relay chain was re-proven against the corrected permissions before final cleanup.
  See `infrastructure/docker/README.md` for the documented fix. A second, unrelated finding —
  `compose.server.example.yaml` and `compose.self-hosted.example.yaml` use different Compose project
  names and therefore different data-volume namespaces — is also documented there.

Real, honest findings from this pass — none release-blocking, all fixed in the docs above — included
a systemd `WorkingDirectory=` gotcha for the relative default config path, a version-compatibility
note for older distro-packaged Coturn silently ignoring two rate-limit directives, and a warning that
`docker rm -f` (unlike `docker stop`) skips the graceful shutdown path and can leave a stale instance
lock. See [`../SELF_HOSTING.md`](../SELF_HOSTING.md) and `infrastructure/coturn/README.md` for where
each was folded into the operator-facing docs.

Per `docs/DEFINITION_OF_DONE.md`'s explicit "TURN is verified through real allocations/forced relay,
not process liveness alone" requirement, T14 is marked COMPLETE in `docs/tasks/STATUS.md` on the
strength of the real evidence above — not code review alone.
