# Coturn boundary

Coturn supplies self-hosted STUN/TURN fallback; it is not the signaling server and never becomes
an application data store. T0 pins the immutable `coturn/coturn:4.17.2-r0` image in templates but
does not deploy or claim a working TURN service.

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
