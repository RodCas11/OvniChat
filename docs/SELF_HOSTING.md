# Self-hosting Chantivo

Chantivo has no central service. There is no Chantivo-operated server, account system, or directory —
every Dedicated Server is independently operated, owns its own data, and works fine on an isolated or
private network. This guide gets a technically capable operator from "nothing running" to "friends can
connect," then covers the deeper operational questions (backup, upgrades, TLS, TURN) once the basics
work.

If you just want the fastest path, read only [Quick start](#quick-start) and
[Port matrix](#port-matrix). Everything after that is reference material for when you need it.

## Quick start

Prerequisites: a Linux host (a small VPS or a home server) with Docker and Docker Compose installed,
and basic comfort with the command line. You do **not** need Node, pnpm, or a TypeScript toolchain —
the server ships as a container image you build or pull, not source you compile yourself.

1. Clone this repository (or just the `infrastructure/` and `services/dedicated-server/` directories)
   onto the host.
2. Copy the environment template and fill in what you need:
   ```sh
   cd infrastructure/docker
   cp .env.example .env
   ```
   At minimum, set `DISCO_VOADOR_SERVER_NAME` to something your friends will recognize. Everything
   else has a safe default — see [Configuration reference](#configuration-reference) if you want more
   control now, or come back to it later.
3. Start the server alone (no TURN relay yet — fine for a LAN or for peers that connect directly
   without needing relay):
   ```sh
   docker compose -f compose.server.example.yaml up -d --build
   ```
4. Check it's healthy:
   ```sh
   curl http://<host>:8090/healthz
   # {"status":"ok"}
   ```
5. Open port `8090/tcp` on your firewall/router (see [Port matrix](#port-matrix)).
6. In the Chantivo desktop client, choose "Add Server" and enter your host's address (e.g.
   `voice.example.com` or its IP) — see [What to type in "Add Server"](#what-a-user-types-in-add-server).

That's a real, working, self-hosted Chantivo server. Everything below extends this: TURN for
NAT-hard peers, TLS for a public internet deployment, backup, and upgrades.

## Two ways to run this

**Simple self-hosting** — the path above. A small VPS or home server, Docker, `docker compose up -d`,
open the documented ports, connect. This is the intended default experience.

**Advanced operation** — nothing here requires Docker. `services/dedicated-server` is an ordinary
Node process (`node dist/cli.js`) that reads its configuration from a JSON file plus environment
variables (see [Configuration reference](#configuration-reference)); an operator who prefers running
it directly, behind a custom reverse proxy, under systemd, with an external data path, or with
external log/metrics collection can do all of that — the container is a packaging convenience, not
the only supported shape. This path has been validated end to end on a real Ubuntu 24.04 host — see
[Native Linux with systemd](#native-linux-with-systemd) below.

### Native Linux with systemd

1. Install Node.js 24 (matching `engines.node` in the repo's root `package.json`) and build the real
   production artifact — either the full monorepo build (`pnpm --filter @disco-voador/dedicated-server... build`)
   or the same pruned `pnpm --filter @disco-voador/dedicated-server deploy --prod --config.inject-workspace-packages=true <dir>`
   the Docker image itself uses (recommended — it's the smaller, dependency-pruned artifact).
2. Create a dedicated, unprivileged, no-login service account:
   ```sh
   useradd --system --no-create-home --shell /usr/sbin/nologin chantivo
   ```
3. Lay out config and data separately from the application code — none of these need to share a
   directory, and the application code itself needs no write access anywhere:
   ```
   /opt/chantivo/dedicated-server/   # the built runtime artifact (root-owned, read-only to chantivo)
   /etc/chantivo/server.env          # environment overrides — owned root:chantivo, mode 640
   /var/lib/chantivo/                # persistent data — owned chantivo:chantivo, mode 750
   ```
4. **Set an explicit `WorkingDirectory=` (or an absolute `DISCO_VOADOR_SERVER_CONFIG_PATH`).**
   `DISCO_VOADOR_SERVER_CONFIG_PATH` defaults to a _relative_ filename
   (`disco-voador-server.config.json`), resolved against the process's current working directory.
   Under systemd, that's `/` unless `WorkingDirectory=` is set — and if the `chantivo` user can't
   read `/`, the server fails loudly at startup (a permissions error, not a graceful "no config file,
   using defaults" fallback — that distinction is deliberate: a config path that exists but can't be
   read is treated as a real misconfiguration, not silently ignored). Point `WorkingDirectory=` at the
   deployed artifact directory (which the service can read) to avoid this entirely.
5. A real, validated systemd unit (`/etc/systemd/system/chantivo-server.service`):
   ```ini
   [Unit]
   Description=Chantivo Dedicated Server
   After=network.target

   [Service]
   User=chantivo
   Group=chantivo
   WorkingDirectory=/opt/chantivo/dedicated-server
   EnvironmentFile=/etc/chantivo/server.env
   ExecStart=/usr/bin/node /opt/chantivo/dedicated-server/dist/cli.js
   Restart=on-failure
   RestartSec=2
   NoNewPrivileges=true
   ProtectSystem=strict
   ReadWritePaths=/var/lib/chantivo
   PrivateTmp=true

   [Install]
   WantedBy=multi-user.target
   ```
   `Restart=on-failure` (not `always`) matches the server's own graceful-exit(0) contract — a clean
   `SIGTERM`/`SIGINT` shutdown should not trigger a restart. The hardening directives shown
   (`NoNewPrivileges`, `ProtectSystem=strict` + an explicit `ReadWritePaths`, `PrivateTmp`) were
   verified not to break normal startup, restart, or shutdown.
6. `/etc/chantivo/server.env` (mode `640`, owned `root:chantivo` — readable by the service, not
   writable by it):
   ```
   DISCO_VOADOR_SERVER_DATA_DIR=/var/lib/chantivo
   REALTIME_HOST=0.0.0.0
   REALTIME_PORT=8090
   DISCO_VOADOR_SERVER_NAME=My Chantivo Server
   ```
7. `systemctl daemon-reload && systemctl enable --now chantivo-server`, then confirm with
   `systemctl status chantivo-server` and `curl http://127.0.0.1:8090/healthz`. `journalctl -u
chantivo-server -f` follows the structured logs. `systemctl stop chantivo-server` delivers a real
   `SIGTERM` and completes a clean shutdown (stores closed, instance lock released) well within
   systemd's default stop timeout.

## Deployment topology

```
Internet
   |
 HTTPS/WSS (Caddy, optional — see TLS)
   |
 Chantivo Dedicated Server (WebSocket + GET /healthz, /readyz — one port, 8090 by default)
   |
 SQLite (authorization.sqlite, chat.sqlite, channels.sqlite, profiles.sqlite — one data directory)

Clients
   |
 STUN (optional, best-effort) / TURN (optional, Coturn — for NAT-hard peers)
```

TURN relay traffic is never routed through the reverse proxy above — it is a separate, directly
exposed UDP/TCP service (Coturn). See [TURN](#turn).

## Port matrix

| Purpose                             | Protocol | Default     | Public?                           | Configurable?                                                                                                                              |
| ----------------------------------- | -------- | ----------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Dedicated Server (WS + health)      | TCP      | 8090        | Yes (or via reverse proxy)        | `REALTIME_PORT` / compose `ports:` mapping                                                                                                 |
| Reverse proxy HTTP (ACME challenge) | TCP      | 80          | Yes, if using Caddy automatic TLS | N/A (Caddy's own default)                                                                                                                  |
| Reverse proxy HTTPS/WSS             | TCP      | 443         | Yes, if using Caddy               | N/A (Caddy's own default)                                                                                                                  |
| TURN listener                       | TCP+UDP  | 3478        | Yes, if running Coturn            | `infrastructure/coturn/turnserver*.conf`                                                                                                   |
| TURN TLS/TCP (optional)             | TCP      | 5349        | Only if TLS certs configured      | commented out by default in the production template                                                                                        |
| TURN relay range                    | UDP      | 49152–49351 | Yes, if running Coturn            | `min-port`/`max-port` in the Coturn config — see [TURN relay range sizing](../infrastructure/coturn/README.md#sizing-the-relay-port-range) |

Only the ports actually implemented are listed. Never expose a database port — there isn't one; all
persistence is local SQLite files, never a network-listening database.

## Firewall example (generic)

```sh
# Dedicated Server (skip if only reachable through a reverse proxy)
ufw allow 8090/tcp

# Reverse proxy (Caddy), if used
ufw allow 80/tcp
ufw allow 443/tcp

# Coturn, if used
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 49152:49351/udp
```

Adjust the relay range to match whatever you actually configured. This is not tied to any specific
cloud provider — apply the equivalent rule for your platform's firewall or security-group mechanism.

**Home server behind a router**: your OS firewall alone is not enough — the router must also forward
each of these ports (TCP and UDP separately where both are listed) to the server's LAN address. A VPS
with a public IP usually only needs the host firewall rule.

## What a user types in "Add Server"

A bare hostname or IP, optionally with a port: `voice.example.com`, `voice.example.com:8090`, or an
IPv4/bracketed-IPv6 address. This connects over plain `ws://` (fine for a LAN or a direct, proxy-less
deployment). If you've set up a TLS reverse proxy (see [TLS](#tls)), a user instead types an explicit
`wss://voice.example.com` — no port needed when the proxy terminates on the standard `443`.

## TURN

TURN (via Coturn) is optional. Without it, clients that can't reach each other directly (most peers
on ordinary home networks, some behind symmetric NAT) may fail to connect their voice/video streams;
STUN alone gets most peers through, but not all. TURN is what makes those remaining peers work, by
relaying their media through your server.

Chantivo never uses a Chantivo-operated TURN service — if you want TURN, you run Coturn yourself,
alongside the Dedicated Server.

1. Copy `infrastructure/coturn/turnserver.conf.example` to an ignored runtime file (see
   `infrastructure/coturn/README.md`) and append a strong random `static-auth-secret`:
   ```sh
   openssl rand -hex 32
   ```
2. Set the **same** secret as `DISCO_VOADOR_TURN_SHARED_SECRET` in `infrastructure/docker/.env`, and
   set `DISCO_VOADOR_TURN_URLS` to your Coturn instance's real reachable address (e.g.
   `turn:voice.example.com:3478`).
3. Set `external-ip` in your Coturn config if it's behind NAT (a home server, most cloud providers'
   internal networking).
4. Start the combined stack: `docker compose -f compose.self-hosted.example.yaml --profile turn up -d --build`.
5. Open the TURN ports (see [Port matrix](#port-matrix)) — the listener port **and** the entire relay
   range, both TCP and UDP where listed.

The Dedicated Server mints a short-lived, per-connection credential for each client (a Coturn
`use-auth-secret` REST credential, valid for 6 hours by default) — the shared secret itself never
reaches a client. See
[`architecture/PRODUCTION_SELF_HOSTING.md`](architecture/PRODUCTION_SELF_HOSTING.md) and
[`adr/0023-turn-rest-credential-minting-architecture.md`](adr/0023-turn-rest-credential-minting-architecture.md)
for the full mechanism.

### STUN

If you run Coturn, it also serves as your STUN server at the same address/port — you don't need a
separate STUN deployment. A LAN-only deployment can skip STUN and TURN entirely; peers on the same
network connect via host candidates.

## TLS

For a public, internet-facing deployment, put a TLS-terminating reverse proxy in front of the
Dedicated Server so clients connect over `wss://` instead of plain `ws://`. Chantivo's own
`services/realtime` does not terminate TLS itself — see
[`adr/0024-tls-and-reverse-proxy-responsibility.md`](adr/0024-tls-and-reverse-proxy-responsibility.md)
for why.

**Caddy** (`infrastructure/reverse-proxy/Caddyfile.example`) is the one first-class, documented
example — chosen for automatic HTTPS with no manual certificate lifecycle:

1. Point real public DNS at your host (`voice.example.com -> your public IP`).
2. Set `CHANTIVO_PUBLIC_HOSTNAME=voice.example.com` and run Caddy with the example Caddyfile.
3. Ensure ports 80 and 443 are reachable from the internet (required for Caddy's automatic
   certificate issuance/renewal).
4. Connect clients with `wss://voice.example.com` — no port needed.

A **LAN-only or development deployment doesn't need any of this** — plain `ws://` on a private network
is a fully supported, permanent posture, not a "not done yet" placeholder.

## Configuration reference

The Dedicated Server reads a small JSON config file (`disco-voador-server.config.json` by default) plus
environment-variable overrides, with precedence `defaults < config file < environment variables`. See
[`CONFIGURATION.md`](CONFIGURATION.md) for the complete, authoritative field list (this section
covers only the fields most relevant to a first deployment):

| Variable                                   | Secret? | Meaning                                                                         |
| ------------------------------------------ | ------- | ------------------------------------------------------------------------------- |
| `DISCO_VOADOR_SERVER_NAME`                 | No      | Display name shown to connecting clients. Default: "Chantivo Server".           |
| `DISCO_VOADOR_SERVER_ACCESS_MODE`          | No      | `open` (default) or `invite-only`.                                              |
| `DISCO_VOADOR_SERVER_DATA_DIR`             | No      | Where persistent state lives (see [Persistent data](#persistent-data)).         |
| `DISCO_VOADOR_SERVER_PUBLIC_HOST`          | No      | Display-only address for docs/invites — never used for binding.                 |
| `DISCO_VOADOR_TURN_SHARED_SECRET`          | **Yes** | Coturn `use-auth-secret` shared secret. Set with `..._TURN_URLS` or not at all. |
| `DISCO_VOADOR_TURN_URLS`                   | No      | Comma-separated `turn:`/`turns:` URIs.                                          |
| `DISCO_VOADOR_TURN_CREDENTIAL_TTL_SECONDS` | No      | Default `21600` (6 hours).                                                      |

Never set a real secret in the versioned config file — `DISCO_VOADOR_TURN_SHARED_SECRET` is
environment-variable-only by design (see `CONFIGURATION.md`). Every value has a safe default; a
minimal deployment needs to set none of them.

**Generating a strong secret**: `openssl rand -hex 32` (or, without OpenSSL, `node -e
"console.log(require('crypto').randomBytes(32).toString('hex'))"`). Never use a guessable or
short value for `DISCO_VOADOR_TURN_SHARED_SECRET`.

## Persistent data

Everything the Dedicated Server owns lives under one data directory (`/data` inside the container,
via a named Docker volume; `DISCO_VOADOR_SERVER_DATA_DIR` on bare metal):

```
/data/
  authorization.sqlite   # groups, permissions, invite/privilege tokens, bans
  chat.sqlite             # server-wide and per-channel chat history
  channels.sqlite         # channel/category hierarchy and access control
  profiles.sqlite         # avatars, status, presence
  .lock                   # instance lock — prevents two processes sharing this directory
```

Nothing else is production state. Client cryptographic identity, bookmarks, and local settings live
entirely on each desktop client, never here.

## Backup and restore

Backup is intentionally simple: stop the server, copy the entire data directory, start it again. This
is a deliberate choice, not a shortcut — a copy taken _while the server is running_ is not guaranteed
consistent (SQLite's WAL mode can leave uncheckpointed writes in `-wal`/`-shm` sidecar files next to
each `.sqlite` file), so the documented, supported method always stops first.

```sh
docker compose -f compose.server.example.yaml stop chantivo-server
docker run --rm -v chantivo-server-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/chantivo-server-data-backup.tar.gz -C /data .
docker compose -f compose.server.example.yaml start chantivo-server
```

Native/systemd deployments use the same model against the real filesystem path directly, with the
same "stop first" reasoning — verified on real Linux to leave no `-wal`/`-shm` sidecar files behind
after a clean stop, confirming a copy taken at that point is a complete, self-contained snapshot:

```sh
systemctl stop chantivo-server
tar czf /root/chantivo-backup-$(date +%Y%m%d).tar.gz -C /var/lib/chantivo .
systemctl start chantivo-server
```

**Restore** is the reverse: stop the server, extract the archive back into the (empty or replaced)
data directory/volume, start the server again — migrations run automatically if the backup predates
the running server's schema version.

**A forcibly-removed container skips the graceful shutdown path.** `docker stop` (and `systemctl
stop` natively) deliver a real `SIGTERM` and wait for a clean exit — the correct way to stop a
container/service before backup or recreation. `docker rm -f` on a still-running container is
equivalent to `docker kill`: an immediate `SIGKILL` with no grace period, which skips the instance
lock's release. If you do this by accident, a subsequent start fails with the documented "data
directory already in use" error even though nothing is actually still running — delete the stale
`<dataDir>/.lock` file (the error message itself tells you the exact path) and start again; no data
is lost, only the lock file is stale. Prefer `docker stop` (or `docker compose stop`) before removing
or recreating a container.

**Backups are sensitive.** A backup archive contains authorization state (including who has
Server Admin), full chat history, channel structure, and profile data. Treat it like you would the
live data directory — restrict its permissions, and never upload it anywhere automatically. Chantivo
has no cloud backup feature; where a backup is stored is entirely up to the operator.

If you run TURN, `DISCO_VOADOR_TURN_SHARED_SECRET` and any TLS certificate live outside the data
directory (in your `.env`/Coturn config and your reverse-proxy's certificate storage respectively) —
back those up separately if you'd need to reconstruct this exact deployment from scratch.

## Upgrading

```sh
# back up first (see above)
git pull   # or otherwise update your checkout
docker compose -f compose.server.example.yaml up -d --build
```

Database schema migrations run automatically on startup. **Rollback is not guaranteed** once a schema
migration has run — a server binary will refuse to open a data directory whose schema is newer than
what it understands, rather than silently downgrading it. Back up before every upgrade.

## Health and diagnosing problems

- `GET /healthz` — process liveness. `{"status":"ok"}` if the process is up.
- `GET /readyz` — accepting new connections. 200 while under the connection limit, 503 once at
  capacity.
- The container's own `HEALTHCHECK` uses `/healthz` — `docker ps` shows `healthy`/`unhealthy`
  directly.
- Startup errors are meant to be actionable: an unwritable data directory, a malformed TURN
  configuration, or an invalid port all fail immediately with a specific message, not a generic crash
  or a silent fallback to defaults.
- Logs go to stdout/stderr as structured JSON lines — let Docker/systemd/your log collector own
  rotation; the server does not manage log files itself.

## Server-admin vs. host-operator

These are two different responsibilities, and Chantivo keeps them separate on purpose:

- **Server admin** (a role granted through the app itself — channels, groups, bans, server avatar) is
  managed entirely from the Chantivo desktop client, by whoever holds (or was granted) that
  permission. This is the surface most people who help run a community server will ever touch.
- **Host operator** (listen address, TLS, TURN secret, data directory, backups) is managed entirely
  through this document's configuration files and environment variables — never exposed in the
  desktop client's admin UI, and not something a Server Admin can see or change from inside the app.

## chantivo.app

`chantivo.app` may host product documentation. It is never required at runtime — nothing here calls
it, checks it, or depends on it being reachable. A Chantivo deployment on a fully isolated or private
network works exactly the same as one on the public internet.
