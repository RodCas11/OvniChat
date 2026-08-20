# ADR 0014: Persistent, server-owned chat history in a separate SQLite store

## Status

Accepted and implemented (T10).

## Context

T9 introduced the Dedicated Server's first persistent runtime state — a SQLite-backed authorization
store (`<dataDir>/authorization.sqlite`) holding groups, memberships, token digests, and bans (see
ADR 0013). T10 needed the server's second persistent concern: chat message history, for two scopes
(server-wide and per-voice-channel), explicitly **not** ephemeral — a correction to an earlier,
now-superseded roadmap assumption that T10 would be session-only chat. The task's own spec required
an explicit, recorded architectural decision on whether chat history should live in the same
`authorization.sqlite` file T9 already introduced, or in its own separate store, plus whatever
migration/transaction strategy follows from that choice.

A `software-architect` review was conducted before implementation. Its recommendation, adopted
below: separate physical files, sharing only the small `withTransaction`/migration-runner _pattern_
T9 already established — never a shared `DatabaseSync` handle or shared `schema_migrations` table.

## Decision

**Separate SQLite file: `<dataDir>/chat.sqlite`, entirely independent of `authorization.sqlite`.**
Ranked reasoning, from the architecture review:

1. **Retention-policy independence is the load-bearing argument.** T10's own spec anticipates future
   operator-configurable retention (`retentionDays`, `maxMessagesPerChannel`) for chat, while
   explicitly forbidding any equivalent retention/pruning machinery on authorization data (bans,
   bootstrap tokens, admin memberships must never be silently discarded — T9's fail-closed
   philosophy). Retention work is exactly the class of operation (bulk `DELETE`, `VACUUM`, WAL
   checkpoint pressure) most likely to interact with unrelated tables sharing one file. Keeping the
   files separate lets a _future_ retention feature touch only `chat.sqlite`, structurally,
   without needing continued discipline to avoid the authorization tables.
2. **Asymmetric acceptable-loss profile.** Chat is written far more often than authorization data
   (every message send, versus occasional group/token/ban mutations) — a higher write volume
   carries a higher (still small) risk of an unclean shutdown or full-disk event landing mid-write.
   Losing chat history is an accepted, on-spec outcome if it ever happened (chat is not the
   product's source of truth for "who can administer this server"); losing authorization state is
   the one thing this codebase has already gone out of its way to make structurally
   near-impossible (last-admin protection, fail-closed corruption handling, no silent
   regeneration). Separate files mean a chat-store problem can never reach the authorization file at
   the storage-engine level — SQLite has no cross-file write path by construction.
3. **Module-boundary consistency.** `services/dedicated-server/src/authorization/` is a
   self-contained module implementing one narrow port (`AuthorizationPort`). A new
   `services/dedicated-server/src/chat/` module implementing its own narrow port (`ChatPort`,
   defined in `services/realtime`) mirrors that exactly, rather than blurring two bounded contexts
   with different lifecycle philosophies into one store class.

The cross-database-foreign-key argument that might otherwise favor a shared file does not apply
here regardless: a chat message's `sender_identity_id` is never enforced via `FOREIGN KEY` even in
principle, because a Guest with zero authorization rows must still be able to send and have a
message persisted (T10 Section 52 — chat authorship is never gated on holding a persistent
authorization record).

**Shared _pattern_, never shared state.** `withTransaction` and a small generic
`openManagedDatabase(path, migrations, now)` (open + `PRAGMA journal_mode=WAL` + `PRAGMA
foreign_keys=ON` + run-not-yet-applied migrations) were factored out of `AuthorizationStore` into
`services/dedicated-server/src/storage/sqlite-store-utils.ts` and now back both `AuthorizationStore`
and the new `ChatStore`. Each store still owns its own physical file and its own independent
`schema_migrations` table — the shared code is DRY on the _loop shape_ T9 already proved correct,
not a shared database connection or shared migration history. Kept inside `services/dedicated-server`
rather than a new `packages/` workspace, for the same reason ADR 0013 gave for not extracting
authorization into its own package: no cross-workspace consumer exists, and both stores only ever
run in this one process.

**Ordering authority: the message's own `INTEGER PRIMARY KEY AUTOINCREMENT` rowid, not
`created_at`.** T10's spec explicitly warns against relying on wall-clock timestamp uniqueness (two
messages can share a millisecond) and asks for "a monotonic database integer ID + timestamp." SQLite's
own `AUTOINCREMENT` rowid already is exactly that monotonic sequence, with no additional counter
table needed — `created_at` is stored purely for display, `message_id` is the sole ordering and
pagination-cursor authority.

**One narrow `ChatPort`, mirroring `AuthorizationPort` exactly** (`services/realtime/src/
chat-port.ts`): two methods (`sendMessage`, `getHistory`), both synchronous for the same reason
every `AuthorizationPort` method is (`node:sqlite`'s `DatabaseSync` is synchronous; `Connection`/
`routeClientMessage` have no `await` anywhere in the hot path). The port's return types never carry
a sender's stable `identityId` at all — not merely omitted on the wire, genuinely never returned by
the store to its caller — since no current T10 feature needs it server-side either (T10 Section
13/53: stable identity stays server-local unless a concrete feature requires it; none does yet).

**No message editing or deletion in T10.** Both were explicitly optional per the task's own spec
("if implementing deletion meaningfully expands T10, it may be deferred"). Given T10's already large
surface (protocol, two new stores/ports, client UI, E2E, docs), implementing deletion properly
(a new permission, a new message type, sender-derived-ownership enforcement, live synchronization
across viewers) would have been a genuine scope expansion, not a small addition — deferred to a
future task. Message ids are already stable, server-local, and monotonic, so introducing deletion
later needs no schema migration to become possible, only new query/permission logic.

## Consequences

- `services/dedicated-server`'s data directory now holds two independent SQLite files:
  `authorization.sqlite` (T9) and `chat.sqlite` (T10) — both under the same operator-owned data
  directory, so "back up one directory" (this repository's own documented backup mental model,
  `docs/ARCHITECTURE.md`) remains true; it does not become "back up two files you have to remember."
  `dataDir: ':memory:'` continues to work as a fully-ephemeral escape hatch for both stores
  independently.
- `AuthorizationStore`'s constructor was refactored (mechanically, same public behavior) to use the
  new shared `openManagedDatabase` helper instead of its own inline copy of the same logic — the
  full existing T9 test suite is the regression guard for this refactor, and it passed unchanged.
- `services/realtime` gained one more narrow injected port (`ChatPort`), defaulting to
  `createNoopChatPort()` for any consumer that doesn't compose its own (its own dev CLI,
  `tests/realtime/*`) — mirrors `AuthorizationPort`'s own default exactly.
- `HandlerContext` gained `chat: ChatPort` and `nickname: string | undefined` (the latter needed so
  a chat send can record `senderNicknameAtSend` without re-deriving it from anywhere); `Connection`
  now retains the connection's nickname for its lifetime the same way it already retains
  `identityId`.
- `OutgoingAction` gained a `'broadcast-ready'` variant (push a message to every currently-`ready`
  connection) for server-wide chat broadcast, which has no bounded membership set the way a voice
  channel does — channel-scoped chat instead reuses the existing per-channel `deliver` fan-out via a
  new `VoiceRegistry.getChannelMemberConnectionIds` method, identical in shape to
  `voice:participant-joined`'s existing delivery pattern.
- A joint-composition integration test (`tests/dedicated-server/integration.test.ts`, "chat and
  authorization operations both work correctly in the same process") exercises both stores open
  concurrently in one real server process, satisfying the task spec's explicit testing requirement
  for whichever storage topology was chosen — under separate files, this proves no interference
  rather than proving corruption-recovery, since file-level isolation makes cross-store corruption
  structurally impossible by construction.
- This ADR does not implement message editing/deletion, retention policy, or full-text search —
  all explicitly deferred; see `docs/architecture/PERSISTENT_TEXT_CHAT.md`'s "Known limitations."

## Alternatives

- **Shared `authorization.sqlite`, add chat tables to it:** rejected — see Decision above. Would
  have blurred two bounded contexts with structurally opposite retention/durability philosophies
  into one file, and the task's own spec flagged this option as carrying enough risk to require an
  explicit joint authorization+chat test if chosen — read as a signal to avoid it by default, not a
  green light.
- **A single `DatabaseSync` connection with logical table-prefix separation, still one physical
  file:** rejected — strictly worse than the shared-tables option: identical physical-file risk,
  more indirection, no additional benefit.
- **A new `packages/chat` (or similarly named) shared package:** rejected for the same reason ADR
  0013 rejected a new package for authorization — no trust-boundary argument applies, and no
  second real consumer exists.
- **Implementing message deletion in T10:** rejected as unforced scope growth for an already large
  task; deferred to a future task with message ids already shaped to support it without a schema
  migration.
