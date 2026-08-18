---
name: self-hosting
description: Plan, implement, review, or document Disco Voador signaling deployment, Coturn, Docker Compose, TLS, reverse proxies, configuration, credentials, backups, upgrades, or other self-hosted operational concerns.
---

# Preserve self-hosting

Read `docs/CONFIGURATION.md`, `docs/SECURITY.md`, `docs/ARCHITECTURE.md`,
`docs/references/COTURN.md`, and the active task. Consult `infrastructure-engineer`.

1. Keep every core communication dependency deployable by the operator; reject mandatory SaaS.
2. Pin reviewed images/releases and document upgrades; never use floating production tags.
3. Separate public configuration from secrets. Mount/generate secrets outside source control and
   avoid command-line/log exposure.
4. For Coturn, use authenticated short-lived credentials, quotas, peer restrictions, and correct
   public/private address mapping. Keep the shared secret server-only.
5. Treat WSS/HTTP reverse proxying and TURN/L4 exposure as different paths.
6. Document ports, firewall/NAT, TLS certificates, persistence, backup/restore, restart, logging,
   monitoring, and rollback.
7. Validate from a fresh host/configuration. For TURN, perform actual allocations and forced relay
   over relevant UDP/TCP/TLS paths; process liveness is not enough.
8. Test credential expiry, restart recovery, unavailable dependencies, and safe configuration errors.

Report topology, exact pinned versions, secret flow, exposed ports, fresh-host commands, allocation
or end-to-end evidence, backup/rollback, and operator-visible limitations.
