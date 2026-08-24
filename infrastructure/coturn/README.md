# Coturn boundary

Coturn supplies self-hosted STUN/TURN fallback; it is not the signaling server and never becomes
an application data store. T0 pins the immutable `coturn/coturn:4.17.2-r0` image in templates. T14
validated this template end to end (real allocation, real Chantivo-minted credentials, a real
forced-relay WebRTC connection) on both the pinned Docker image's config and a native install.

**Native package installs may be an older Coturn than the pinned image — check your startup logs.**
Ubuntu 24.04's own `apt install coturn` currently ships 4.6.1, which does not recognize the
`unauthorized-ratelimit`/`unauthorized-ratelimit-rps` directives in this template — Coturn logs `Bad
configuration format: unauthorized-ratelimit` at startup and silently continues without that specific
protection, rather than failing to start. Every other directive in this template (blacklisting,
quotas, `min-port`/`max-port`, `no-cli`, `no-multicast-peers`) was confirmed to apply correctly on
4.6.1. If you install Coturn from your distro's package manager rather than the pinned Docker image,
check `journalctl -u coturn` (or your init system's equivalent) after first start for any "Bad
configuration format" lines, and treat a version new enough to accept every directive in this
template as the safer choice where practical.

The examples deliberately omit `static-auth-secret`; copied unchanged, they cannot authenticate
TURN REST credentials. Generate an ignored runtime copy, obtain a strong random secret from the
operator's secret mechanism, append it only to that restricted file, and run
`pnpm verify:secrets` before committing. Never substitute a public placeholder value.

The realtime service should eventually mint short-lived TURN REST credentials. The long-lived
shared secret belongs only on the server. The production example denies common private, CGNAT,
link-local, and IPv6 ULA peers so authenticated clients cannot use TURN to reach internal services;
review those ranges for the deployment and prefer narrow `allowed-peer-ip` exceptions over broad
removal. The development example is not safe for an untrusted network.

Actual allocation tests—not a process-only health check—must exercise UDP, TCP/TLS fallback,
credential expiry, forced relay, NAT, peer restrictions, and restart recovery before production
use.

## Sizing the relay port range

The production template (`turnserver.conf.example`) sets `min-port=49152 max-port=49351` — 200 UDP
ports — rather than Coturn's own full default ephemeral range (`49152-65535`, ~16,384 ports). This
is a deliberate small-self-hosted-deployment default, not a Coturn limitation: `docs/references/
COTURN.md` records that a narrow range is a development/small-deployment tradeoff, and this
repository's own scope (`docs/ARCHITECTURE.md`, `docs/PRODUCT.md`) targets small self-hosted
rooms, not a public multi-tenant service.

**Why 200 ports.** Coturn allocates one UDP relay port per TURN _allocation_, and — because this
app's WebRTC transport uses modern default bundling (one negotiated ICE candidate pair serving all
bundled audio/video/screen m-lines over a single 5-tuple per `RTCPeerConnection`, not one relay port
per media kind) — one allocation corresponds to one relayed peer-to-peer connection, not one relay
port per stream. In a P2P mesh, the worst case is every pairwise connection in a room forced onto
TURN relay simultaneously: for `n` participants that is `n(n-1)/2` allocations. `n(n-1)/2` reaches
190 at `n = 20`, so 200 ports gives a small self-hosted server headroom for a single ~20-person
voice room with every participant simultaneously relay-only (an intentionally pessimistic bound —
in practice most pairs connect directly and only NAT-hard pairs fall back to TURN), or for several
smaller rooms/channels active at once. Each allocation is released when its permission/channel
binding expires or the peer connection tears down, so the range is a concurrent-allocation ceiling,
not a cumulative session counter.

**Enlarging the range for more concurrent users.** If an operator expects a larger room, more
simultaneous rooms, or a userbase where TURN relay is the common case (e.g. many clients behind
symmetric NAT), raise `max-port` in the operator's own ignored runtime copy of the config — e.g.
`min-port=49152 max-port=49999` (~850 ports) for roughly 40 fully-relayed concurrent participants
worst-case, or restore the full `49152-65535` range Coturn ships by default for no practical ceiling
short of host resource limits. Widening the range means widening the matching firewall/NAT UDP
forwarding rule identically — the advertised range and the actually-reachable range must stay in
sync, or clients will receive relay candidates the network never delivers traffic to.
