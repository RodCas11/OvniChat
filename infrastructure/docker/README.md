# Docker Compose templates

These files are deployment templates, not a working stack committed with real secrets. Every
`*.example.yaml`/`.env.example` file here is safe to read and copy; the copies you actually run
(`compose.server.yaml`, `compose.self-hosted.yaml`, `.env`, `infrastructure/coturn/turnserver*.conf`)
are gitignored and must never be committed with real values.

## Files

| File                               | What it defines                                                                                                                                         |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `compose.server.example.yaml`      | The Chantivo Dedicated Server alone (no Coturn). Builds `services/dedicated-server/Dockerfile`.                                                         |
| `compose.turn.example.yaml`        | Coturn, Linux host networking, production-oriented (see `infrastructure/coturn/README.md`).                                                             |
| `compose.turn-bridge.example.yaml` | Coturn, bridge networking, small fixed port range — local validation only.                                                                              |
| `compose.self-hosted.example.yaml` | The combined stack an operator actually runs: server + Coturn, via Compose's `include:` over the two files above — no service definition is duplicated. |
| `.env.example`                     | Every `DISCO_VOADOR_*`/`REALTIME_*` value the server service reads, with safe placeholders.                                                             |

## The `chantivo-server` service

`compose.server.example.yaml` builds `services/dedicated-server/Dockerfile` from the repository root
(`context: ../..`) and runs it as the non-root `chantivo` user the image defines. It publishes only
the one port the service needs, `8090:8090` (the WebSocket server and `GET /healthz`/`GET /readyz`
share that port — see `services/realtime/src/server.ts`), and explicitly sets
`REALTIME_HOST=0.0.0.0` in the service definition itself (not `.env`) — the application's own
bare-metal default, `127.0.0.1`, would otherwise be unreachable through Docker's published-port NAT;
see the comment in the compose file for why this is the deliberate "explicit operator choice"
`docs/SECURITY.md` requires, not a relaxation of it.

### The `/data` volume and backup

`chantivo-server-data` is a named Docker volume mounted at `/data` inside the container — the image
pins `DISCO_VOADOR_SERVER_DATA_DIR=/data` (see the Dockerfile), so every SQLite store
(`authorization.sqlite`, `chat.sqlite`, `channels.sqlite`, `profiles.sqlite`) and the instance lock
file live there. Losing this volume loses all server-local authorization/chat/channel/profile state
(never client identity — that stays entirely on each desktop client, see `docs/architecture/CLIENT_IDENTITY.md`).

Backup is intentionally simple, matching this deployment's own scale — this is not a hot/online
backup procedure:

```sh
docker compose -f compose.server.example.yaml stop chantivo-server
docker run --rm -v chantivo-server-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/chantivo-server-data-backup.tar.gz -C /data .
docker compose -f compose.server.example.yaml start chantivo-server
```

Restore is the reverse: stop the service, extract the archive back into the volume (e.g.
`docker run --rm -v chantivo-server-data:/data -v "$PWD":/backup alpine tar xzf /backup/chantivo-server-data-backup.tar.gz -C /data`),
then start it again. There is no online/rolling backup mechanism and none is invented here — a
short stop is the accepted cost of a consistent SQLite file copy at this deployment's scale.

## Setup (either file)

1. Copy `.env.example` to `.env` in this directory and set only the values this deployment needs —
   every value is optional with a safe default; see the comments in `.env.example` and
   [`docs/CONFIGURATION.md`](../../docs/CONFIGURATION.md).
2. If this deployment also runs Coturn: copy the corresponding `infrastructure/coturn/turnserver*.conf.example`
   to its ignored runtime filename, append a strong random `static-auth-secret` there, set the same
   secret as `DISCO_VOADOR_TURN_SHARED_SECRET` in `.env`, and set `DISCO_VOADOR_TURN_URLS` to the
   deployment's real reachable `turn:`/`turns:` address(es). Review firewall/NAT and `external-ip`
   as `infrastructure/coturn/README.md` describes. **Ownership differs from the native/systemd
   path**: the pinned `coturn/coturn:4.17.2-r0` image's `turnserver` process runs as the fixed
   numeric `uid=65534 gid=65534` (`nobody`/`nogroup`) — confirmed via `docker run --rm
coturn/coturn:4.17.2-r0 id`, not assumed from the image's `Config.User` field alone. A config file
   owned/permissioned the native-systemd way (`root:turnserver`, `640`) is unreadable to that uid, and
   Coturn silently falls back to an unauthenticated, unbounded default configuration rather than
   failing loudly — a real, easy-to-miss trap, since the container still reports healthy either way.
   **This file contains the real `static-auth-secret` in plaintext** (the example templates deliberately
   omit it; the runtime copy has it appended, same as the native path) — do not make it world-readable
   to work around the permission mismatch. Instead, `chown` it to the exact numeric UID/GID the pinned
   image runs as and restrict it to owner-read-only:
   ```sh
   chown 65534:65534 infrastructure/coturn/turnserver.conf
   chmod 400 infrastructure/coturn/turnserver.conf
   ```
   This keeps the secret readable by exactly the one process that needs it and no one else on the
   host. Confirm Coturn's own startup logs show your real `realm`/deny-range values (not the template
   defaults, and no permission-denied warning) after any config or permission change. If a future
   version of the pinned image changes its runtime UID, re-run the `id` check above and re-`chown`
   accordingly — don't assume 65534 is permanent.
3. Server-only: `docker compose -f compose.server.example.yaml up -d --build`.
4. Combined stack (server + optional Coturn):
   `docker compose -f compose.self-hosted.example.yaml up -d --build` starts `chantivo-server`
   alone; add `--profile turn` to also start `coturn`
   (`docker compose -f compose.self-hosted.example.yaml --profile turn up -d --build`).
5. Validate structure before running anything real:
   `docker compose -f compose.server.example.yaml config` (or the combined file) — this only parses
   and merges the YAML/topology and needs no secrets present.

Before use, review the firewall and denied/allowed peer ranges for any Coturn service, and see the
self-hosting skill for fresh-host validation expectations.

**Pick one file and stay with it.** `compose.server.example.yaml` (`name: chantivo-server`) and
`compose.self-hosted.example.yaml` (`name: chantivo-self-hosted`) are different Compose _projects_ —
Docker names each project's volumes after its own project name, so `/data` in one is backed by a
different named volume than `/data` in the other, even though both mount to the identical in-container
path. Switching from a server-only deployment to the combined server+Coturn deployment (or back) does
NOT carry your data over automatically — it silently starts against a fresh, empty volume instead.
Decide which file is this deployment's long-term choice up front, or explicitly migrate the volume
(`docker run --rm -v <old>:/from -v <new>:/to alpine cp -a /from/. /to/`) if you deliberately switch.
