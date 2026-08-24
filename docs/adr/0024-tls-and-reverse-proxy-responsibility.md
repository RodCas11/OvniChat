# ADR 0024: TLS and reverse-proxy responsibility

## Status

Accepted and implemented (T14 — Production Self-Hosting).

## Context

`docs/architecture/REALTIME_PROTOCOL.md` and `docs/architecture/DEDICATED_SERVER.md` had already
stated, since T2/T8, that production TLS was a deferred self-hosting concern and that a plain
`ws://127.0.0.1:8090` was an accepted development/self-hosted-LAN posture, not a production claim.
T14 needed to decide, concretely: does `services/realtime` terminate TLS itself, does a reverse proxy
do it, or both — and if a reverse proxy, which one gets documented as the first-class example, since
the T14 brief explicitly asked for one excellent example rather than several near-duplicate ones.

## Decision

**`services/realtime` does not terminate TLS in-process.** No certificate/key handling, no `https`/
`tls` module usage, exists anywhere in `server.ts` after T14 (confirmed by direct inspection — this
was true before T14 and remains true after). The health endpoint added in T14
(`GET /healthz`/`GET /readyz`) shares the exact same plain-HTTP listener the WebSocket server already
used, for the same reason: adding an in-process TLS stack would duplicate work a reverse proxy already
does well, and would add certificate-lifecycle code (renewal, rotation, expiry monitoring) to a
service that has none today.

**Caddy is the one first-class, documented reverse-proxy example**
(`infrastructure/reverse-proxy/Caddyfile.example` + README), chosen over Nginx specifically for its
automatic-HTTPS behavior (ACME HTTP-01/TLS-ALPN-01, no manual certificate lifecycle for an operator
to manage) and because its `reverse_proxy` directive upgrades WebSocket connections by default with
no special configuration — directly satisfying the brief's "must correctly support WebSocket
upgrades... must not break voice sessions after 60s" requirement without bespoke timeout tuning. The
realtime service's own heartbeat (`REALTIME_HEARTBEAT_INTERVAL_MS`, default 15s) keeps a long-lived,
low-traffic connection from ever appearing idle to a proxy in the first place.

**TURN is never routed through this reverse proxy.** `docs/SECURITY.md`'s existing rule ("an
ordinary HTTP reverse proxy cannot proxy TURN... terminate TLS with real certificates [for TURN
separately, if used]") is unchanged by this ADR — UDP/TCP relay traffic is exposed directly by Coturn
(`infrastructure/coturn/`), never through Caddy. This ADR governs only the WebSocket/health HTTP
surface.

**The desktop client now supports explicit `wss://` addressing.**
`parseServerAddress` (`apps/desktop/src/renderer/connection/parse-server-address.ts`) previously
produced only `ws://`, unconditionally. It now detects an explicit `ws://`/`wss://` scheme prefix; a
bare `host[:port]` input still defaults to `ws://` (unchanged LAN/dev behavior), while an explicit
`wss://host` defaults its port to 443 (matching what a TLS-terminating reverse proxy actually listens
on) rather than the internal `8090`. `RealtimeClient`'s underlying `new WebSocket(url)` call was
already scheme-agnostic, and Electron's CSP already allowed `wss:` in `connect-src` — so this was a
contained, single-module client change with no IPC/Preload/CSP impact.

## Consequences

- An operator running a public, internet-facing deployment gets one clear, tested path: point DNS at
  the host, run Caddy in front of `services/realtime`, done — no in-process certificate configuration
  to get wrong.
- LAN/private/development deployments remain fully supported with zero TLS setup, exactly as before —
  a bare `host[:port]` client address still resolves to `ws://`, unchanged.
- `services/realtime` itself gained no new attack surface from this decision (no cert/key file
  reading, no TLS library dependency) — the only new HTTP surface in T14 is the two health routes,
  covered separately.
- An operator who genuinely cannot or does not want to run a reverse proxy has no first-class
  documented alternative for in-process TLS. This is an accepted gap for T14 — it can be revisited if
  real operator demand for it emerges, but is not expected to be common given how well the reverse-
  proxy path already covers the public-internet case.

## Alternatives

- **In-process TLS termination in `services/realtime`:** rejected — duplicates a reverse proxy's job,
  adds certificate-lifecycle responsibility to a service architected to have none, and the brief
  explicitly favored the simplest safe operator experience over supporting every possible topology.
- **Nginx as the first-class example instead of Caddy:** rejected — Nginx's WebSocket proxying and
  TLS require more explicit, error-prone manual configuration (`proxy_set_header Upgrade`/
  `Connection`, manual certbot/ACME wiring) than Caddy's defaults; the brief asked for the option with
  the least manual TLS-cert-lifecycle burden.
- **Documenting multiple reverse-proxy examples (Caddy and Nginx and Traefik, etc.):** rejected —
  the brief explicitly said to avoid maintaining several near-duplicate examples; an advanced operator
  who prefers a different proxy can adapt the one documented topology (plain `wss://` in, plain
  `ws://` out, no TURN).
- **A managed/bundled TLS solution operated by Chantivo:** rejected outright — would violate ADR
  0010's no-mandatory-central-service constraint.
