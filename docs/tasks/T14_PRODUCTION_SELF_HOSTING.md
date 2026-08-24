# T14 — Production self-hosting

Turns the Dedicated Server from "runs on a developer's machine" into something a technically capable
operator can self-host safely, without needing to understand Chantivo's internal architecture. See
[`../SELF_HOSTING.md`](../SELF_HOSTING.md) for the operator-facing guide and
[`../architecture/PRODUCTION_SELF_HOSTING.md`](../architecture/PRODUCTION_SELF_HOSTING.md) for the
full technical design and verification record (kept in sync with this doc — this doc summarizes and
points there for detail rather than duplicating it).

## Status

**COMPLETE.** Every code slice is implemented, tested, and passing the full repository gate. Docker
was not available on the Windows implementation workstation, so final production verification moved
to a real Ubuntu 24.04 VPS reachable over SSH (`chantivo-vps`) — the workstation itself was never
modified (no WSL2, no Docker Desktop, no Windows networking/BIOS changes). Every deployment path
(native systemd, native Coturn + Caddy, Docker/Compose) and the decisive forced-relay WebRTC proof
passed with real evidence on that VPS; see [Verification](#verification) for the full record.

## What changed

**Configuration (extend, not redesign).** `DedicatedServerConfig` gained `publicHost` (display-only)
and an environment-variable-only `turn` block (`DISCO_VOADOR_TURN_SHARED_SECRET`,
`DISCO_VOADOR_TURN_URLS`, `DISCO_VOADOR_TURN_CREDENTIAL_TTL_SECONDS`), both/neither validated
together. The existing flat shape, `defaults < file < env` precedence, and `.strict()` file validation
were preserved exactly — a nested `server:`/`public:`/`data:`/`turn:` restructure was considered and
deliberately rejected as unforced churn to working, tested config code. `turn` is never permitted in
the hand-edited config file, matching the file's own pre-existing "no secrets here" rule.

**TURN credential minting.** New: `services/dedicated-server/src/turn/mint-turn-credentials.ts`
(Coturn `use-auth-secret` REST convention, HMAC-SHA1), a new additive `server:turn-credentials`
protocol message (`packages/protocol/src/messages/turn.ts`, no version bump — protocol stays v5),
pushed once to an already-authenticated connection alongside the existing post-auth message burst.
`packages/rtc-core`'s `P2PMeshTransport` gained `setIceServers()` (REPLACE semantics, deliberately
kept off the shared `MediaTransport` interface). The desktop client merges STUN + TURN and applies
them to every peer connection created after they arrive. See
[ADR 0023](../adr/0023-turn-rest-credential-minting-architecture.md).

**Health endpoint.** `services/realtime/src/server.ts` now runs an explicit `http.Server` (WebSocket
server attached via `ws`'s `server` option) serving `GET /healthz`/`GET /readyz` on the same port —
no new dependency, no new port.

**Data-directory instance lock.** New `services/dedicated-server/src/storage/data-dir-lock.ts` —
`O_CREAT|O_EXCL` exclusive-create lock, released on every shutdown/failure path (a gap found during
architecture review — `uncaughtException`/`unhandledRejection`/mid-`start()` failure now release it
too, not just the graceful-shutdown path).

**Client TLS addressing.** `parseServerAddress` now accepts an explicit `ws://`/`wss://` scheme prefix
(bare `host[:port]` unchanged, still defaults to `ws://`:8090); `wss://` with no explicit port
defaults to `443`. `services/realtime` itself still does not terminate TLS in-process — see
[ADR 0024](../adr/0024-tls-and-reverse-proxy-responsibility.md).

**Docker.** New `services/dedicated-server/Dockerfile` (multi-stage, `pnpm deploy --prod`-pruned so no
Electron/desktop dependency enters the image, non-root user, `/data` volume, `HEALTHCHECK` against
`/healthz`), new `infrastructure/docker/compose.server.example.yaml` and
`compose.self-hosted.example.yaml` (the latter composing the former with the pre-existing
`compose.turn.example.yaml` via Compose `include:`, no duplication), new
`infrastructure/docker/.env.example`.

**Coturn.** Pre-existing templates extended, not redesigned: the production relay range narrowed from
the full ephemeral range to a documented, sized default (`49152-49351`, ~200 ports) with a documented
path to enlarge it.

**Reverse proxy.** New `infrastructure/reverse-proxy/Caddyfile.example` and real README content
(previously a one-paragraph stub) — Caddy chosen as the one first-class example for automatic HTTPS
and default WebSocket-upgrade support.

**Documentation.** New `SELF_HOSTING.md`, `architecture/PRODUCTION_SELF_HOSTING.md`, this task doc,
ADR 0023 and ADR 0024; every doc identified as stale by architecture review was corrected
(`ARCHITECTURE.md`, `HANDOFF.md`, `architecture/DEDICATED_SERVER.md`, `architecture/WEBRTC_VOICE.md`,
`CONFIGURATION.md`, `SECURITY.md`, `tasks/STATUS.md`, `adr/README.md`).

## Deployment architecture

```
Internet
   |
 HTTPS/WSS (Caddy, optional)
   |
 Chantivo Dedicated Server (WebSocket + GET /healthz,/readyz — one port)
   |
 SQLite (4 files, one data directory)

Clients
   |
 STUN/TURN (Coturn, optional)
```

## Configuration model

File format: JSON (`disco-voador-server.config.json`), `.strict()`-validated. Precedence:
`defaults < config file < environment variables`. Minimal required fields: none — every value has a
safe default. Secret handling: `DISCO_VOADOR_TURN_SHARED_SECRET` is environment-variable-only, never
in the config file, never logged, never baked into the Docker image.

## Persistent data

`<dataDir>/{authorization,chat,channels,profiles}.sqlite` + `.lock` — see
`architecture/PRODUCTION_SELF_HOSTING.md#persistent-data` for full detail. Unchanged from pre-T14
except the new lock file.

## Docker image

Base: `node:24.18.1-slim`, pinned exactly. Multi-stage, `pnpm deploy --prod` pruning. Runtime user:
`chantivo` (uid 10001, non-root). Contents: only `@disco-voador/dedicated-server`'s real dependency
closure — no Electron, no desktop Renderer, no `packages/windows-media`. Healthcheck: `GET /healthz`
via Node's built-in `fetch`. Writable path: `/data` only.

## Docker Compose

Services: `chantivo-server` (always), `coturn` (optional, `profiles: ['turn']`). Networks: Compose
default bridge network for `chantivo-server`; Coturn uses Linux host networking (unchanged from the
pre-existing template, required for practical large-UDP-range relay performance). Volumes:
`chantivo-server-data` (named, mounted at `/data`). Published ports: `8090:8090` only for the server;
Coturn's ports per its own template (host networking means no explicit Compose `ports:` mapping).

## Port matrix

See [`../SELF_HOSTING.md#port-matrix`](../SELF_HOSTING.md#port-matrix) for the full table.

## TURN

Authentication model: Coturn `use-auth-secret` TURN REST convention. Credential issuance: minted
server-side, pushed once per connection right after identity-proof succeeds. Credential TTL: 21600s
(6h) default, operator-overridable. Shared-secret handling: environment-variable-only, never
client-visible, never logged. Relay range: `49152-49351` (~200 ports) by default, documented sizing
and enlargement path. STUN: served by the same Coturn instance at the same address; no dependency on
any public STUN service.

## Verification

**Passing, with real evidence:**

- `corepack pnpm check` (prettier, eslint, whole-repo typecheck, full Vitest suite — 1679+ tests,
  composite build, repository verification, dependency audit) — clean.
- Every implementing engineer's own scoped test suite — clean.
- The pruned `pnpm deploy --prod` artifact (the exact Docker build-stage output) built and run
  standalone, `GET /healthz`/`GET /readyz` responding correctly over real HTTP.
- Real restart/persistence proof: genuine state (category, voice channel, channel chat message,
  profile status) created via a real WebSocket client speaking the actual protocol, server stopped,
  fresh process against the same data directory, state confirmed intact via the real protocol on
  reconnect — not by inspecting `.sqlite` files directly.
- Real data-directory lock proof: a third process against an already-held data directory failed
  immediately with the documented `DataDirLockError`.
- Real backup/restore proof: a checkpoint-clean data directory copy, original destroyed, server
  started against the restored copy, all state confirmed intact via the real protocol.
- Real WAL-checkpoint evidence supporting the offline-backup model: the same store `.close()` calls
  `stop()` performs were shown to fully checkpoint WAL content and remove `-wal`/`-shm` sidecars.
- A real OS-level `SIGTERM` delivered from outside the process on Windows could not be confirmed in
  the sandboxed implementation environment (`GenerateConsoleCtrlEvent` did not propagate to spawned
  children there) — the shutdown _logic_ was verified directly regardless; **this gap is now closed**
  by the real Linux VPS SIGTERM test below.

**Passing, with real evidence from a live Ubuntu 24.04 VPS** (Docker was not available on the Windows
workstation; per explicit operator instruction, final verification moved to a real remote Linux VPS
over SSH — the workstation itself was never modified, no WSL2/Docker Desktop/Windows networking
change of any kind):

- **Native systemd**: a dedicated `chantivo` service user, config/data cleanly separated
  (`/etc/chantivo`, `/var/lib/chantivo`), a real systemd unit with hardening directives that didn't
  break normal operation, `start`/`status`/`restart`/`stop` all real. **A real external `SIGTERM`
  (`kill -TERM <pid>`)** triggered the documented clean-shutdown log sequence within milliseconds —
  the exact evidence the Windows sandbox couldn't produce.
- **Data-directory lock**, re-verified: a manual second process against the live data directory failed
  immediately with the documented error; confirmed released after a clean stop, confirmed _not_
  released after a forced kill (matching documented, accepted behavior).
- **Backup/restore**, re-verified natively: stop → tar the real data directory (confirmed no
  `-wal`/`-shm` sidecars survive a clean stop) → restore → real protocol client confirms all state
  intact.
- **Native Coturn** (Ubuntu 24.04's own package, not just the pinned Docker image): installed
  non-root, a real manually-computed TURN REST credential got a real Coturn allocation, an invalid
  credential was correctly rejected.
- **Real TURN credential pipeline, end to end**: a real authenticated WebSocket client received
  `server:turn-credentials` only post-auth (confirmed absent pre-auth), containing only the derived
  credential (never the raw shared secret) — and that exact credential worked against real Coturn.
- **The decisive forced-relay WebRTC proof**: two real `RTCPeerConnection`-equivalent peers (`werift`),
  both `iceTransportPolicy: 'relay'`, using the same real Chantivo-minted credential, established a
  real data-channel connection through Coturn. Both peers' **selected candidate pairs show
  `candidateType: "relay"` on both local and remote sides** — concrete evidence, not inference — with
  no host/srflx candidate ever gathered on either side, using an address:port inside the documented
  bounded relay range. A corrupted credential correctly failed to gather any relay candidate at all.
- **Native Caddy**: real TLS handshake (internal CA — no public DNS exists for the validation host,
  honestly distinguished from an untested public Let's Encrypt path), a real `wss://` connection
  completed a full identity handshake and survived 38 seconds across two heartbeat intervals.
- **Docker**: Engine + Compose installed via the official method, the production image built clean
  (345MB, confirmed free of Electron/desktop/windows-media content), the container confirmed running
  as real non-root uid 10001, graceful `docker stop` exiting 0 in under a second, persistence
  confirmed across both restart and full container recreation.
- **Docker Compose Coturn, actually started and proven** (not just `docker compose config`): native
  Coturn/Chantivo temporarily stopped to free their shared ports, the real `compose.self-hosted.
example.yaml --profile turn` stack started, and the full mint → relay chain re-proven entirely
  within Compose — a fresh credential minted by the _Compose_ Chantivo server, accepted by the
  _Compose_ Coturn, producing a real relay-only WebRTC connection with both peers' selected candidate
  pairs `candidateType: "relay"`. Native services were restored to their prior running state
  afterward, with no lingering conflict.

Real, non-blocking findings from this pass (folded into the docs, not left as silent gaps): a systemd
`WorkingDirectory=` requirement for the relative default config path, older distro-packaged Coturn
silently ignoring two rate-limit directives the pinned Docker image's Coturn version supports,
`docker rm -f` (unlike `docker stop`) skipping the graceful path and requiring a manual stale-lock
clear, the Compose-deployed Coturn image running as `nobody` requiring different config-file
permissions than the native/systemd path, and `compose.server.example.yaml`/`compose.self-hosted.
example.yaml` using different Compose project names and therefore different data-volume namespaces.
See [`../SELF_HOSTING.md`](../SELF_HOSTING.md), `infrastructure/coturn/README.md`, and
`infrastructure/docker/README.md` for where each landed.

Per `docs/DEFINITION_OF_DONE.md`'s explicit requirement that TURN be verified through real allocations
and forced relay — not process liveness alone — **T14 is marked COMPLETE in `docs/tasks/STATUS.md`**
on the strength of the real evidence above, including the decisive forced-relay proof run separately
against both the native Coturn deployment and the Docker Compose Coturn deployment.

## Security review

A read-only architecture review (software-architect) covered the protocol-additivity claim, the
config-extend-not-restructure claim, the ADR 0006 SFU-seam interaction, and a full stale-documentation
audit — findings incorporated above and into the corrected docs.

A focused code-level security review (security-reviewer) covered secret handling, container
hardening, the TURN credential lifecycle, health-endpoint minimality, trusted-proxy behavior, and
downgrade/schema compatibility — **no release-blocking findings**; two informational doc-drift items
(a stale `desktop-config.ts` comment, a stale root `.env.example` TURN placeholder table) were found
and fixed.

A separate, real-deployment security sweep was then run directly against the live VPS: grepped every
service's logs (`chantivo-server`, `coturn`, `caddy`) for secret-shaped strings (none found), verified
`server.env`/`turnserver.conf` are `640`-permissioned and group-restricted, confirmed the Docker
daemon exposes no TCP listener, confirmed Caddy's admin API is bound to `127.0.0.1` only, and
confirmed `ufw` exposes exactly the documented ports (`22`, `8090`, `3478/tcp+udp`,
`49152-49351/udp`, `8443`) with no accidental extra surface.

## What's deliberately not in T14

No installer/release packaging (T15). No SFU (T17). No desktop UI redesign. No P2P mesh transport
redesign. No new central Chantivo-operated service of any kind. No cloud backup, no auto-update, no
admin web dashboard, no online/hot SQLite backup mechanism, no CLI subcommand parsing machinery for a
plain filesystem copy.
