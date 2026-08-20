# ADR 0013: Server-local authorization storage and RBAC

## Status

Accepted and implemented (T9).

## Context

T7 gave every client a local cryptographic identity a server can verify. T8 turned the realtime
backend into an independently-operated Dedicated Server product. Neither introduced any notion of
_authorization_ — until T9, every authenticated identity could do everything an authenticated
connection could do, with no groups, no permissions, no bans, and no way for a self-hoster to
designate an administrator.

T9 needed the Dedicated Server's first genuinely persistent runtime state: which identities hold
which server-local groups, what bearer tokens exist and whether they've been consumed, and which
identities are banned. This raised two questions ADR 0009 (SQLite first) deliberately left open —
driver and migration strategy — plus a new one: how does this state stay compatible with the
connection state machine's existing fully-synchronous design (`services/realtime/src/connection.ts`,
`protocol-handlers.ts`), which has no `await` anywhere between validating a message and producing a
result?

## Decision

**Storage: `node:sqlite`'s `DatabaseSync`, zero new dependencies.** Confirmed working on this
project's pinned Node 24 runtime with no experimental-API warning, and `@types/node` already ships
its type definitions. `better-sqlite3` (a native npm dependency) was the obvious alternative and was
rejected: this code only ever runs inside `services/dedicated-server`, a plain Node process, never
inside Electron — so `better-sqlite3`'s prebuilt-binary-per-ABI packaging risk is pure downside with
no corresponding upside `node:sqlite` doesn't already provide.

**Synchronous, not async — and this is the more important half of the decision.** `DatabaseSync`'s
API is synchronous, which means every `AuthorizationStore` method (`admit`, `can`, `redeemToken`,
`grantGroup`, ...) runs to completion with no `await` inside it. Combined with Node's single-threaded
event loop, this makes token redemption's required atomicity (T9 Section 47/80: exactly one
concurrent redeemer of the same token can ever win) **free** — a `UPDATE tokens SET consumed_at = ?
WHERE token_digest = ? AND consumed_at IS NULL` followed by granting membership, wrapped in one
transaction, cannot be interleaved by a second "simultaneous" redemption, because the runtime never
context-switches mid-function. Making this asynchronous would have reintroduced exactly the race
window the atomicity requirement exists to prevent, not merely added engineering overhead — so
"stay synchronous" was a correctness requirement, not just a convenience that avoided restructuring
`Connection`/`routeClientMessage` into async code.

**Accepted tradeoff, stated explicitly:** every connecting identity now performs synchronous disk
I/O on the realtime service's single shared event loop, momentarily blocking every other connection.
This is acceptable at this product's stated small-self-hosted scale and is a distinct, later scaling
concern from the SFU question ADR 0010/T16 already deferred — not something T9 needed to solve.

**No migration framework.** A hand-rolled, ordered list of SQL statements
(`services/dedicated-server/src/authorization/migrations.ts`), tracked in a `schema_migrations`
table, applied inside one transaction at startup, before the server ever binds a socket (fail
loudly on any migration error, matching the "invalid configuration fails clearly" discipline T8
already established for the config file). The table count and query shapes here are small and fixed
by this task's own spec; no ORM or query builder was justified.

**Package boundary: inside `services/dedicated-server`, not a new shared package.** The RBAC
evaluator, token/ban logic, and SQLite store all live in `services/dedicated-server/src/
authorization/`. `services/realtime` gains exactly one new narrow, synchronous interface —
`AuthorizationPort` (`services/realtime/src/authorization-port.ts`) — injected via
`RealtimeServerDependencies.authorization`, mirroring T8's `voiceChannels`/`serverMetadata` seam
exactly. `services/realtime`'s own tests and dev CLI use a permissive `createNoopAuthorizationPort()`
default (admits everyone, no groups, all permissions granted) so nothing outside
`services/dedicated-server` needed to change. `packages/identity` was considered as a precedent for
a new package, but does not apply here: that package exists to enforce a _trust boundary_
(`packages/identity` is architecturally forbidden from Renderer/Preload imports, enforced by
`scripts/verify-architecture.mjs`). T9's authorization state never touches Renderer/Electron at all,
so there is no equivalent trust-boundary argument for a new package — only a speculative-reuse one
(T10 text chat _might_ want the same local database later), which this repository's own established
practice (see ADR 0012's alternatives) rejects as premature. If T10 genuinely needs it, extraction is
a small, well-justified follow-up then.

**Bootstrap token also satisfies invite-only admission.** Found necessary while implementing the
admission flow, not anticipated in the original design: a server started directly in
`accessMode: invite-only` would otherwise permanently lock out its own operator, since a fresh
identity with no persistent membership and no invite token is rejected before ever reaching `ready`
— and the one-time bootstrap token is a `kind: 'bootstrap'` row, not `kind: 'invite'`. Fixed by
having the admission check accept either kind. This is a correctness fix to the admission design
this ADR authorizes, not a separate decision — see `docs/architecture/SERVER_AUTHORIZATION.md`'s
"Bootstrap on an invite-only server" section for the full detail.

## Consequences

- `services/dedicated-server`'s data directory now holds a real, restart-persistent SQLite file
  (`<dataDir>/authorization.sqlite` by default; `dataDir: ':memory:'` is a supported escape hatch for
  tests and fully ephemeral deployments) — the first persistent Dedicated Server runtime state any
  task has introduced.
- `Connection` (`services/realtime/src/connection.ts`) now retains a `identityId` field for its
  lifetime, set once the identity proof and admission both succeed — needed for ban checks and for
  resolving admin-initiated moderation (`participantId` -> `identityId`) without ever broadcasting
  a raw identity id to other participants.
- `RouteResult` (`protocol-handlers.ts`) gained an optional `identityId` field on its `ok: true`
  variant, and `OutgoingAction` gained a `'close'` variant (forcibly closing a _different_
  connection than the one that triggered the action) — both minimal, additive changes to an
  already-tested pure function/type, not a restructuring.
- The realtime protocol gained a `serverToken` field on `client:hello` and a full set of new
  `client:authorization-*`/`server:authorization-*` message types — all additive (new message types,
  one new optional field), so `CURRENT_PROTOCOL_VERSION` was **not** bumped, unlike T7/T8's own
  additions (both of which added _required_ fields). See `docs/architecture/REALTIME_PROTOCOL.md`'s
  evolution-policy section.
- This ADR does not implement T10 (text chat) or any future extraction of this module into a shared
  package — both remain later, separately justified decisions.

## Alternatives

- **`better-sqlite3`:** rejected — see Decision above; adds a native dependency with prebuilt-binary
  packaging risk for zero benefit in a context (`services/dedicated-server`, never Electron) where
  that risk has no offsetting advantage.
- **An async database driver (e.g. a Promise-based SQLite wrapper, or a future networked database):**
  rejected for T9 — would have reintroduced the exact race window the token-atomicity requirement
  exists to prevent, and this product's current scale does not need it. Revisit only if measured
  concurrency actually requires it, the same evidence-driven threshold ADR 0009 already set for a
  SQLite -> PostgreSQL migration.
- **A new `packages/server-authorization` package:** rejected — no trust-boundary argument applies
  (unlike `packages/identity`), and no second real consumer exists yet; see Decision above.
- **A full migration framework/ORM:** rejected as unjustified for this task's small, fixed schema.
