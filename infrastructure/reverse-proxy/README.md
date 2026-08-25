# Reverse proxy boundary

An optional Caddy reverse proxy may terminate TLS and forward HTTP/WebSocket traffic to the
Chantivo Dedicated Server. It is not required for core operation (ADR 0004/0010): a self-hosted
deployment can run without it, reachable over plain `ws://` on a LAN or via a manually distributed
certificate, exactly as it already can today. Caddy is one convenient, self-hostable way to get
automatic public TLS for the `wss://` case, not a mandatory component.

## What this Caddyfile does — and does not do

`Caddyfile.example` terminates TLS for one public hostname and reverse-proxies both ordinary HTTP and
WebSocket traffic to the Dedicated Server's one bound port (`127.0.0.1:8090` by default — see
`docs/CONFIGURATION.md`'s `REALTIME_PORT`) — with one deliberate exception (see "Public vs. internal
routes" below). Caddy's `reverse_proxy` directive upgrades WebSocket connections automatically in
Caddy v2 — it detects the `Connection: Upgrade`/`Upgrade: websocket` request headers and proxies the
hijacked TCP connection transparently, with no extra directive needed (confirmed against Caddy's own
current documentation and changelog; this has been true since v2 and was never a `v1`-style opt-in
feature). The one real caveat found while verifying this: a Caddy issue reported in 2026 around
WebSocket upgrades specifically over a **Unix domain socket** upstream (returning `200` instead of
`101 Switching Protocols`) — irrelevant here, since this template proxies to a TCP `host:port`
upstream, not a Unix socket. If a future change points this Caddyfile at a Unix-socket upstream
instead, re-verify WebSocket upgrade behavior separately before relying on it.

## Public vs. internal routes

`GET /healthz` and `GET /readyz` are internal operational endpoints — used by Docker's/systemd's own
health checks, this installer's own TLS-readiness probe, and `chantivo-server doctor`, all of which
talk to the Dedicated Server directly over `http://127.0.0.1:8090` and never go through this proxy at
all. A real production deployment (`beta.chantivo.app`) was found serving both routes publicly through
Caddy, exposing internal operational status to anyone on the internet — not a secret leak (both routes
already return only a boolean-shaped status, never version/config/secret data — see
`services/realtime/src/server.ts`), but still unnecessary public surface for an anonymous scanner to
learn from.

This template now blocks both paths from ever reaching the backend publicly: a named matcher
(`@blocked_health`) matches exactly `/healthz` and `/readyz`, and a `respond @blocked_health 404`
directive — placed BEFORE the `reverse_proxy` catch-all — answers them with a bare `404` (no body, no
operational information) instead of proxying them. Everything else, including the real WebSocket
upgrade path, is unaffected: the `reverse_proxy 127.0.0.1:8090` directive remains unconditional and
still receives every request that isn't exactly `/healthz` or `/readyz`. If you need to check health
through the public hostname for some other reason, use SSH/a private network to reach
`http://127.0.0.1:8090/healthz` directly on the host instead of exposing it publicly again.

**What it explicitly does NOT do: TURN.** Coturn's TURN/STUN relay runs over UDP, TCP, TLS, and
optionally DTLS on its own ports (3478, optionally 5349, plus the entire configured relay port
range — see `infrastructure/coturn/README.md`). None of that is ordinary HTTP/WebSocket traffic, and
an HTTP reverse proxy like Caddy cannot proxy it. TURN must be exposed directly (Linux host
networking, as `infrastructure/docker/compose.turn.example.yaml` already does) or through an
explicitly configured layer-4-aware proxy — never through this Caddyfile. This reiterates
`docs/references/COTURN.md`'s own "T0 scaffold decisions" and `docs/ARCHITECTURE.md`'s deployment
shape exactly; nothing about TURN's exposure model has changed.

## `CHANTIVO_PUBLIC_HOSTNAME` and the desktop client

`{$CHANTIVO_PUBLIC_HOSTNAME}` is a Caddy environment-variable placeholder — set it to the real public
DNS hostname this deployment is reachable at (e.g. `chantivo.example.com`) before starting Caddy.
Once Caddy is running and has obtained a certificate, a user connects the desktop client by typing
`wss://<that same hostname>` into the client's "Add Server" address field — the client's own address
parser (`apps/desktop/src/renderer/connection/parse-server-address.ts`) accepts an explicit
`wss://host[:port]` scheme and resolves it to a secure WebSocket connection through this reverse
proxy, the same way it already accepts a plain `ws://host[:port]` for a direct, proxy-less
connection. No port is needed in the typed address when Caddy terminates on the standard `443`.

## Real operational preconditions

Caddy's automatic HTTPS is not magic — it requires, before it can succeed:

- Real public DNS: `CHANTIVO_PUBLIC_HOSTNAME` must actually resolve to this host's public IP address.
- Ports `80` and `443` reachable from the public Internet on this host, for the ACME HTTP-01 and/or
  TLS-ALPN-01 challenge Caddy performs automatically against Let's Encrypt (or another configured CA)
  the first time it starts for a given hostname, and again on renewal. A firewall or NAT that blocks
  either port will make certificate issuance fail, not silently degrade to plain HTTP.
- No other process already bound to `80`/`443` on the host Caddy runs on.

None of this is specific to Chantivo — it is Caddy's own documented automatic-HTTPS precondition,
restated here because it is the one genuine operational dependency this reverse-proxy template adds
on top of the Dedicated Server itself.

## Long-lived WebSocket connections and proxy timeouts

The realtime service sends a server-initiated heartbeat ping on `REALTIME_HEARTBEAT_INTERVAL_MS`
(default 15000ms — see `docs/CONFIGURATION.md`), which keeps a long-lived, low-traffic WebSocket
connection from ever sitting idle long enough to hit a typical reverse-proxy idle-connection timeout.
No special Caddy timeout tuning (`transport`/`read_timeout`/similar) should be needed for this
reason. **Empirically verified (T14)**: a real WSS connection through a real Caddy instance (this
exact Caddyfile topology, internal-CA TLS) was held open for 38 seconds — spanning two full
heartbeat intervals — with two real WebSocket ping/pong exchanges observed and no drop. If an
operator reports unexpected disconnects specifically when running behind this Caddyfile (and not
when connecting directly), check the heartbeat interval against Caddy's default proxy timeouts first,
before assuming a different root cause — but the default configuration is confirmed sufficient on its
own.
