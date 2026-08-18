# Coturn self-hosting reference

Research date: **2026-08-17**

This note separates verified upstream behavior from deployment choices made for the T0 scaffold. TURN is a stateful Internet-facing relay, not an ordinary HTTP service.

## Verified upstream facts

### Version, image, and license

- Current upstream Coturn is **4.17.2**. The corresponding official immutable container build is **`coturn/coturn:4.17.2-r0`**. Upstream states that concrete `X.Y.Z-rN` tags are not updated after publication; floating tags are mutable.
- Coturn uses the [BSD 3-Clause license](https://github.com/coturn/coturn/blob/4.17.2/LICENSE). The container also includes dependencies governed by their own licenses.
- The upstream image is a Linux-container image with published architectures including amd64 and ARM variants.

Primary sources:

- [Coturn — 4.17.2 release](https://github.com/coturn/coturn/releases/tag/4.17.2)
- [Coturn — Docker 4.17.2-r0 release](https://github.com/coturn/coturn/releases/tag/docker%2F4.17.2-r0)
- [Coturn — official container documentation](https://github.com/coturn/coturn/blob/4.17.2/docker/coturn/README.md)

### Network exposure and NAT

- Default listener ports are 3478/TCP and 3478/UDP. TLS/TCP and DTLS/UDP conventionally use 5349. The default relay range is 49152-65535 and can be constrained with `min-port` and `max-port`.
- Every allocated relay port must be reachable. Behind NAT, `external-ip=PUBLIC/PRIVATE` maps the advertised public address to the local relay address, and the NAT must preserve relay ports 1:1.
- Publishing a large relay range through Docker's bridge/NAT has a performance cost; Coturn's container documentation recommends host networking for that case.
- Docker host networking is supported for Linux containers. Docker Desktop requires version 4.34 or later and opt-in enablement. Published `ports` are ignored in host mode, and Compose rejects port mapping combined with `network_mode: host`.
- TURN runs over UDP, TCP, TLS, or explicitly enabled DTLS. A normal HTTP reverse proxy does not provide these transports; direct exposure or a suitable layer-4 proxy is required.

Primary sources:

- [Coturn — container ports and host networking](https://github.com/coturn/coturn/blob/4.17.2/docker/coturn/README.md)
- [Coturn — configuration reference](https://github.com/coturn/coturn/blob/4.17.2/docker/coturn/turnserver.conf)
- [Docker — host network driver](https://docs.docker.com/engine/network/drivers/host/)
- [Docker — Compose service network and port rules](https://docs.docker.com/reference/compose-file/services/)
- [IETF — TURN, RFC 8656](https://www.rfc-editor.org/rfc/rfc8656)
- [IETF — TURN URI scheme, RFC 7065](https://www.rfc-editor.org/rfc/rfc7065)

### Authentication, TLS, and hardening

- A server with no authentication mechanism configured can operate without authentication and must not be exposed publicly.
- `use-auth-secret` implements time-limited TURN REST credentials derived from a shared `static-auth-secret`. The client receives only an expiring username and derived password; the shared secret must remain server-side. `use-auth-secret` and explicit `lt-cred-mech` configuration are alternative modes, not options to combine casually.
- `realm` participates in long-term credential derivation. Changing it invalidates stored long-term credentials.
- TLS requires readable PEM certificate and private-key files. Starting in Coturn 4.17.0, DTLS listeners are opt-in with `--dtls`; opening 5349/UDP alone does not enable DTLS.
- Coturn 4.17 enables stateless nonces by default. Replicas behind a load balancer need the same `stateless-nonce-secret`, or clients can receive stale-nonce failures after reaching another instance or after restart.
- User and total quotas are unlimited by default. Coturn also provides unauthorized-request rate limiting, and multicast peer blocking can be enabled. Loopback peers are rejected by default; enabling them is intended only for controlled development.
- CLI and web administration are disabled by default in the current sample configuration. Prometheus is optional on port 9641 and must not be exposed indiscriminately.
- Compose secrets are mounted as files, while Coturn does not document a `static-auth-secret-file` option. Using Compose secrets therefore requires a controlled startup step that generates runtime configuration, or a supported database/configuration integration; committing the secret to the image or repository is not an acceptable substitute.

Primary sources:

- [Coturn — complete configuration reference](https://github.com/coturn/coturn/blob/4.17.2/docker/coturn/turnserver.conf)
- [Coturn — 4.17.0 release and upgrade notes](https://github.com/coturn/coturn/releases/tag/4.17.0)
- [Docker — Compose secrets](https://docs.docker.com/reference/compose-file/secrets/)

## T0 scaffold decisions

- Pin **`coturn/coturn:4.17.2-r0`**. Do not use `latest` or another floating tag.
- Keep Coturn in an optional deployment profile; it is not a required local-development dependency and the scaffold is not represented as production-ready.
- Target a Linux host/VPS for production. Use Docker Desktop only for local validation.
- Use `network_mode: host` and no `ports` list in the Linux production profile. Provide a separate bridge-network development override with a deliberately small relay range and exact matching TCP/UDP mappings.
- Expose 3478/TCP, 3478/UDP, and the configured relay UDP range. Add 5349/TCP only when real certificates and rotation procedures exist. Do not expose 5349/UDP unless `--dtls` is deliberately enabled and tested.
- When deployed behind NAT, require explicit public/private `external-ip` mapping and firewall/NAT forwarding for the listener ports and the entire relay range with 1:1 relay-port preservation.
- Have the realtime service mint short-lived TURN REST credentials. Never distribute `static-auth-secret`, permanent server credentials, private keys, or database credentials to the desktop application. Keep only placeholders in `.env.example`.
- Committed Coturn examples omit the `static-auth-secret` field entirely. Add the generated secret
  only to an ignored, access-restricted runtime copy; an unchanged example must reject TURN REST
  credentials rather than accept a public placeholder.
- Leave CLI and web administration off. Bind metrics privately if enabled. Configure finite user/total quotas, unauthorized-request rate limiting, and multicast-peer blocking; retain the default loopback-peer rejection outside isolated development.
- Public deployments must prevent authenticated relay clients from reaching internal services.
  The production example denies common RFC1918, CGNAT, link-local, IPv6 ULA, and IPv6 link-local
  ranges. Review the host's reachable networks and cloud metadata addresses, then add only narrow
  `allowed-peer-ip` exceptions required by the deployment.
- Size the relay range from expected concurrent allocations. A narrow range is a development or small-deployment tradeoff, not a generally safe production default.
- Do not add a process-only healthcheck and call the service healthy. Operational validation must perform a real STUN/TURN allocation using `turnutils_uclient` or an external canary.
- Acceptance tests must force WebRTC relay with `iceTransportPolicy: 'relay'` across clients on separate networks and verify UDP relay, TCP/TLS fallback, credential expiry, allocation logs, firewall/NAT behavior, secret handling, and restart recovery.
