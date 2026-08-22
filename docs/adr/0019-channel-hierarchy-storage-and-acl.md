# ADR 0019: Dynamic server-owned channel hierarchy — storage, tombstone deletion, and ACL model

## Status

Accepted and implemented (T13.2).

## Context

T8 made voice channels "server-owned" only in the narrow sense that an operator's static config file
defined a fixed, flat list at startup (`DEFAULT_VOICE_CHANNELS`/`config.voiceChannels`, a
`{channelId, name}[]` with no hierarchy, no access control, no runtime mutation). T13.2's product
requirement is a real, dynamic, hierarchical channel-administration system managed live from the
Client: categories, voice channels, subchannels, per-node group-based access policy, optional
passwords, optional user limits, and TeamSpeak-style temporary channels — all enforced authoritatively
by the Dedicated Server. This requires new persistent state, a new cross-cutting privacy boundary (a
channel a user cannot see must leak nothing about itself through any protocol path), and a decision
about how the new store relates to the two existing ones (`authorization.sqlite`, T9;
`chat.sqlite`, T10). A `software-architect` review was conducted before implementation specifically to
settle these questions, given their scale and long-term-consequential nature — comparable to T9's own
storage/RBAC ADR and T10's own chat-storage ADR.

## Decision

**A third, separate SQLite file, `channels.sqlite`**, opened via the same
`openManagedDatabase`/`withTransaction` utilities the two existing stores share
(`services/dedicated-server/src/storage/sqlite-store-utils.ts`), with its own independent migration
sequence — never merged into either existing file, and never linked to either via a foreign key. This
extends [ADR 0014](0014-persistent-server-owned-chat-history.md)'s own reasoning (retention-policy
independence, an acceptable-loss profile distinct from chat's, module-boundary consistency) to a third
store rather than special-casing channel data into one of the first two. A channel's ACL entry
references a T9 group by plain string ID — deliberately not a foreign key, the same posture
`chat.sqlite`'s `channel_id` column has always taken toward `authorization.sqlite`.

**Channel structure is a unified `channel_nodes` table**, not separate `categories`/`channels` tables
— both node kinds (Category, Voice Channel) share the same parent/child/sibling-order/three-policy
shape, and the access-control ancestor-walk is one recursive query regardless of kind; splitting the
table would force every such query to `UNION` two tables for no benefit. A plain `kind` discriminator
column distinguishes them; category rows simply leave voice-only columns (`user_limit`,
`password_verifier`) `NULL`.

**Deletion is a tombstone (`deleted_at` timestamp), never a row delete, and `node_id` is never
reused.** This is the decision that makes permanent-channel deletion safe without any cross-database
coordination: because `chat.sqlite` never had a foreign-key relationship to channel structure to begin
with, tombstoning a channel in `channels.sqlite` requires zero corresponding write in `chat.sqlite` —
that channel's chat rows simply persist, unreachable, because every read path (catalog, chat history,
chat send) already resolves a channel through the same visibility-checking lookup that treats a
tombstoned node exactly like one that never existed.

**Access control is three independent policy axes per node — Visibility, Join, Manage — each
Inherit/Everyone/Selected-Groups** (Manage never allows Everyone), referencing stable T9 group IDs
rather than display names, deliberately simpler than TeamSpeak's numeric permission-power/negation
system. Visibility resolution walks the ancestor chain top-down and treats a restrictive ancestor as
absolute (bounding every descendant regardless of the descendant's own setting) — a category's
invisibility to an identity makes everything under it invisible too. Join and Manage resolve via
nearest-non-Inherit-ancestor instead, and do not bound descendants the same way, since delegated
per-channel administration is the actual point of channel-local Manage grants. An unbroken chain of
Inherit resolves to Everyone at the root — matching this product's existing default-open bias (Guest
already defaults to `voice.channel.join`).

**Existence and visibility are made the same check everywhere**, structurally — every
port method and every protocol-handler code path that resolves a channel ID does so through one
function that returns "found and visible" or "not found," never distinguishing "doesn't exist" from
"exists but hidden from you." This is what delivers the actual privacy guarantee (a hidden channel
leaks nothing through any path), rather than relying on each of catalog-building, chat-send,
chat-history, and join independently remembering to filter correctly.

**Temporary channels get no database row at all** — an in-memory-only registry in `services/realtime`,
since a temporary channel structurally cannot survive a restart and a persisted-but-flagged row would
only add a crash-recovery hazard with no corresponding benefit. Their destruction (on last participant
leaving) purges any chat they accumulated — the one deliberate exception to T10's normal permanent-chat
rule, chosen because temporary-channel chat has no persisted channel identity to remain attached to
once the channel itself is gone.

**Passwords use `node:crypto`'s built-in `scrypt`** (no new dependency), called synchronously inside
the existing connection message-handling hot path — preserving this codebase's established "no async
gap in the hot path" invariant (`AuthorizationPort`/`ChatPort`'s own documented design) rather than
introducing the first asynchronous seam into connection handling. Password verification is the _last_
step in the join sequence, after visibility, join-policy, and capacity all already passed — a Guest
denied by group policy never reaches password verification at all, which is also what prevents a
correct password from ever being usable to bypass group-based access control.

**Live updates use full-catalog-resend-on-mutation**, not a differential/patch protocol — the same
choice T8's original catalog, T9's `server:authorization-state`, and T10's chat history all made when
facing an equivalent tradeoff, and justified the same way: the bounded catalog size (`MAX_CHANNEL_TREE_NODES
= 256`) keeps a full resend cheap, and a simple, fully-observable "just resend the current truth"
design is easier to reason about and test than an incremental event stream.

## Consequences

- `create-dedicated-server.ts`'s composition root gained a third store dependency
  (`DedicatedServerDependencies.channels`), opened before `chat` specifically so a best-effort startup
  hygiene step (pruning orphaned temporary-channel chat rows) can query the now-known active channel
  ID list.
- `VoiceRegistry` (`services/realtime`) lost its own channel-catalog ownership entirely — it is now
  purely a live-membership tracker, taking an explicit per-join capacity limit from its caller instead
  of enforcing one fixed global constant. This was the single highest-regression-risk refactor in the
  implementation, since `VoiceRegistry`'s public API changed in a way every existing T3/T9/T10 unit
  test touching it had to be updated for.
- `voice:catalog`'s wire shape changed from a flat `{channels: [...]}` to a hierarchical
  `{nodes: [...]}` — a breaking protocol version bump (3→4), with no parallel old-shape support kept,
  matching the precedent T7 already set when it dropped v1 support outright rather than maintaining
  two parallel handshake paths.
- Every existing protocol path that resolved a channel by ID (`chat-send`, `chat-history-request`) now
  performs a visibility check it previously didn't need, since hidden channels didn't exist before
  T13.2 — this closes what would otherwise be a "guess a channelId, read its history" privacy gap the
  moment hidden channels became possible.
- No change was required to `packages/rtc-core`, `packages/media-core`, or `packages/windows-media` —
  channel administration is purely a signaling/authorization/storage concern; media transport is
  untouched, confirming the P2P/media boundary this task's own speak-permission finding also relies on.

## Alternatives

- **Storing channel structure inside `authorization.sqlite`**: rejected — channel ACL entries
  reference groups but are not themselves an authorization concept the way memberships/tokens/bans
  are; conflating the two stores would also reintroduce exactly the kind of retention-policy coupling
  ADR 0014 already rejected once for chat, for no offsetting benefit.
- **Storing channel structure inside `chat.sqlite`**: rejected — chat and channel structure have
  unrelated write patterns (chat is a firehose; channel-tree edits are rare, admin-driven), and the
  whole point of the tombstone design is that channel deletion must not need to touch chat's storage
  at all; sharing a file would make that boundary much easier to accidentally violate later.
- **A differential/patch protocol for live catalog updates** (send only what changed, not the whole
  tree): rejected for this stage — added protocol complexity and a new class of client-side
  reconciliation bugs (ordering, missed patches) for a catalog that is already bounded and cheap to
  resend whole; revisit only if a future measured scale problem actually demonstrates the full-resend
  approach is too expensive, the same "don't build the differential version until the simple version
  is proven insufficient" discipline this codebase has applied at every prior similar choice.
- **Hard-deleting a channel row and its chat together in one best-effort, ordered, two-database
  operation**: rejected — `node:sqlite`'s `DatabaseSync` gives no cross-file transaction, so any
  "delete from both, in order, and hope nothing fails in between" design would have a real partial-
  failure window; the tombstone design was chosen specifically because it needs no second write at
  all, eliminating the failure mode rather than accepting and documenting it.
- **A full TeamSpeak-style numeric permission-power/negation/skip ACL model**: rejected as
  deliberately over-engineered for this product's own stated goal of being simpler and more
  understandable than TeamSpeak's administration model, per the task's own explicit instruction.
