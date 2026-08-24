# Architecture decision records

ADRs capture durable decisions and their tradeoffs. Use the next zero-padded number. Never rewrite
history to make a superseded decision appear absent; add a new ADR with `Supersedes ADR NNNN` and
mark the old one `Superseded by ADR NNNN`.

Required sections:

```text
Status
Context
Decision
Consequences
Alternatives
```

Use status language that distinguishes an accepted architectural decision from a proposed or future
hypothesis. An accepted target decision may precede implementation; say so explicitly.

## Initial decisions

1. Windows-first Electron application
2. Simple pnpm monorepo
3. Main/Preload/Renderer security boundary
4. Self-hosted core services
5. One internally modular realtime service
6. P2P first with an SFU-ready seam
7. Windows media isolation
8. VDO.Ninja controlled-reference policy
9. SQLite first behind a storage boundary
10. No mandatory central user control plane
11. Local cryptographic identity without central accounts
12. Dedicated Server product boundary
13. Server authorization storage and RBAC
14. Persistent server-owned chat history
15. Local client settings and bookmarks
16. Automatic reconnect and media restoration policy
17. Windows process-loopback native boundary
18. Renderer UI foundation: CSS Modules, design tokens, and component layering
19. Dynamic server-owned channel hierarchy storage and ACL model
20. Server-local profile/avatar/presence storage and its privacy boundary
21. Global Push-to-Talk via an in-process native keyboard hook
22. Durable per-server identity correlation token for local voice preferences
23. TURN REST credential-minting architecture
24. TLS and reverse-proxy responsibility
