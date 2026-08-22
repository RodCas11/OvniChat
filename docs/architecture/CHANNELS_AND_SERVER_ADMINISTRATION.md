# Channels & server administration (T13.2)

> This document describes the dynamic, server-owned channel hierarchy and access-control system
> T13.2 implemented. It supersedes T3/T8's static, flat, config-only voice-channel catalog. See
> [`tasks/T13_2_CHANNEL_ADMINISTRATION.md`](../tasks/T13_2_CHANNEL_ADMINISTRATION.md) for the task
> record and [`adr/0019-channel-hierarchy-storage-and-acl.md`](../adr/0019-channel-hierarchy-storage-and-acl.md)
> for the accepted decision. A `software-architect` review preceded implementation; this document
> reflects what was actually built and verified, not just what was designed.

## Why this exists

T8 made channels "server-owned" only in the sense that an operator's config file defined a fixed,
flat `{channelId, name}[]` list at startup, with no runtime way to change it and no hierarchy. T13.2
makes channel structure genuinely dynamic: authorized administrators create, rename, move, and delete
categories and voice channels (including subchannels) live, from the Client, with per-channel
visibility/join/management access control against T9's existing groups, optional user limits and
passwords, and TeamSpeak-style temporary channels — all enforced authoritatively by the Dedicated
Server, never the Renderer.

## Storage: a third, separate SQLite file

`<dataDir>/channels.sqlite` — a new file, opened via the same `openManagedDatabase`/`withTransaction`
utilities `authorization.sqlite` and `chat.sqlite` already share
(`services/dedicated-server/src/storage/sqlite-store-utils.ts`), with its own independent migration
sequence, never a shared file/connection/`schema_migrations` table with either existing store. This
mirrors [ADR 0014](../adr/0014-persistent-server-owned-chat-history.md)'s own reasoning exactly:
retention-policy independence, an acceptable-loss profile distinct from both existing stores (channel
structure is rare, admin-driven, and — unlike chat — not something an operator can shrug off losing),
and module-boundary consistency (`services/dedicated-server/src/channels/{store,migrations}.ts`,
mirroring `authorization/` and `chat/` exactly).

**No foreign key exists between `channels.sqlite` and either other store.** A channel's ACL entry
references a T9 group by its plain string ID, not a foreign key — the same posture `chat.sqlite`'s
`channel_id` column has always had toward `authorization.sqlite`. This is what makes permanent-channel
deletion a single-file, single-transaction operation with no cross-database coordination (see
"Permanent deletion" below).

### Schema (version 1)

```sql
CREATE TABLE channel_nodes (
  node_id            TEXT PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('category','voice')),
  parent_id          TEXT REFERENCES channel_nodes(node_id) ON DELETE RESTRICT,
  name               TEXT NOT NULL,
  sort_order         INTEGER NOT NULL,
  visibility_policy  TEXT NOT NULL DEFAULT 'inherit' CHECK (visibility_policy IN ('inherit','everyone','selected-groups')),
  join_policy        TEXT NOT NULL DEFAULT 'inherit' CHECK (join_policy IN ('inherit','everyone','selected-groups')),
  manage_policy      TEXT NOT NULL DEFAULT 'inherit' CHECK (manage_policy IN ('inherit','selected-groups')),
  user_limit         INTEGER,                 -- voice kind only; 1..64; NULL = falls back to MAX_CHANNEL_PARTICIPANTS
  password_verifier  TEXT,                    -- voice kind only; NULL = no password
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  deleted_at         INTEGER,                 -- tombstone marker; NULL = active
  legacy_seed        INTEGER NOT NULL DEFAULT 0  -- informational: 1 for the bootstrap-preserved general/games/afk rows
);

CREATE TABLE channel_acl_groups (
  node_id     TEXT NOT NULL REFERENCES channel_nodes(node_id) ON DELETE CASCADE,
  policy_kind TEXT NOT NULL CHECK (policy_kind IN ('visibility','join','manage')),
  group_id    TEXT NOT NULL,   -- a T9 group id; deliberately not a foreign key
  PRIMARY KEY (node_id, policy_kind, group_id)
);
```

One unified `channel_nodes` table covers both categories and voice channels (a plain `kind`
discriminator) because both share the same parent/child/order/three-policy shape, and the
ACL-resolution ancestor walk is one recursive query regardless of kind. Category rows leave
`user_limit`/`password_verifier` `NULL`; `join_policy` is never meaningful for a category (categories
are never joinable, enforced in code, not just by leaving the column unused).

## Config-to-database migration

On first-ever `channels.sqlite` initialization, the store seeds itself from
`config.voiceChannels ?? DEFAULT_VOICE_CHANNELS` (the same source T8 always used), preserving the
existing `general`/`games`/`afk` channel IDs **exactly** — this is load-bearing: T10 chat history keys
off `channelId`, so a changed ID would silently orphan every pre-T13.2 message. Seeding runs exactly
once, at first-ever database creation, identically to how `BUILT_IN_GROUPS` seeds T9's
`authorization.sqlite` only on a genuinely fresh store (`legacy_seed = 1` marks these rows, purely
informational — it changes no runtime behavior, only lets an operator recognize which rows predate
T13.2). **After that first initialization, `config.voiceChannels` is no longer consulted at all** —
the database is the sole source of truth from that point forward; an operator who edits their old
config file after upgrading has no effect. This mirrors T9 permissions' own non-retroactive seeding
precedent exactly.

An existing pre-T13.2 Dedicated Server upgrading to this version: on first startup with a fresh
`channels.sqlite` (the file doesn't exist yet, since this store didn't exist before T13.2), the same
seed-once bootstrap runs using that operator's actual configured channel list — the migration path and
the fresh-install path are the same code path, deliberately, since a config-only server's list _is_
"the initial seed" whether the surrounding install is brand new or two years old.

## Node model and bounds

Two node kinds: **Category** (organizational only — never joinable, no chat, no membership; always
top-level, `parent_id` must be `NULL`) and **Voice Channel** (joinable; may nest under a category, the
root, or another voice channel — enabling subchannel-of-a-subchannel).

- `MAX_CHANNEL_TREE_NODES = 256` (active, non-tombstoned, categories + voice combined) — sized so a
  worst-case full catalog snapshot stays comfortably inside `REALTIME_MAX_MESSAGE_BYTES` (65536,
  raised in T6 for SDP), following this codebase's established practice of reasoning from an actual
  measured/estimated payload size rather than picking a round number (see T5/T6's own SDP-bound
  history).
- `MAX_CHANNEL_NAME_LENGTH = 64` — the same bound `voiceChannelSummarySchema`/T9 group names already
  use.
- `MAX_CHANNEL_DEPTH = 4` (root = depth 0, up to 3 further nesting levels) — bounds the ACL-resolution
  ancestor walk to a small constant regardless of tree size, and keeps the sidebar legible without
  Windows-Explorer-style deep nesting.
- Sibling order is an explicit persisted `sort_order` integer, never object/Map iteration order or
  creation-timestamp accident; `client:channel-reorder` rewrites a full sibling list's order in one
  transaction.
- Rejected outright: self-parent, a missing or tombstoned parent, a category with a non-null parent,
  any create/move exceeding `MAX_CHANNEL_DEPTH`, and any move that would create a cycle (all
  `CHANNEL_PARENT_INVALID`). Exceeding `MAX_CHANNEL_TREE_NODES` on create is
  `CHANNEL_TREE_LIMIT_EXCEEDED`.

## Access-control model

Three independent policy axes per node — **Visibility**, **Join**, **Manage** — each one of `Inherit`
/ `Everyone` / `Selected Groups` (Manage never allows `Everyone`: an ungated "everyone can administer
this channel" is structurally inexpressible, not merely discouraged). Policies reference stable T9
group IDs, never display names — renaming a group never breaks a channel's ACL.

**Visibility bounds all descendants.** Resolution walks the ancestor chain **top-down** (root first):
an `Inherit` ancestor defers to the next level down; an `Everyone` ancestor imposes no restriction; a
`Selected Groups` ancestor that the identity's effective groups don't intersect makes the _entire_
subtree invisible from that point down, regardless of what a descendant's own visibility policy says.
If every ancestor up to the root is `Inherit`, the hardcoded root default is `Everyone` (matching this
product's default-open bias — Guest already defaults to `voice.channel.join`).

**Join and Manage use nearest-non-`Inherit`-ancestor resolution** (bottom-up: check the node itself
first, then its parent, and so on) and do **not** bound descendants the way Visibility does — a
category's own Join/Manage setting is irrelevant (categories aren't joinable), and a channel-local
Manage grant on a specific channel is not restricted merely because an ancestor category has a
tighter Manage policy (delegated per-channel administration is the entire point of channel-local
Manage). **Join is still always gated by Visibility passing first** — an invisible channel is never
joinable no matter its own join policy, which is why a join attempt against a hidden channel returns
`CHANNEL_NOT_FOUND`, not `CHANNEL_ACCESS_DENIED`.

**Worked example**: a "STAFF" category set to `Visibility: Selected Groups [staff]` contains a "Raid
Planning" voice channel set to `Visibility: Inherit`, `Join: Selected Groups [staff, raid-leaders]`.
An identity holding only `raid-leaders` (not `staff`): the visibility walk fails at "STAFF" itself (the
root ancestor) — the channel is invisible, full stop, regardless of "Raid Planning" listing
`raid-leaders` in its own join policy. An identity holding `staff`: visibility passes at "STAFF";
"Raid Planning" is `Inherit` for visibility, so nothing further restricts it — visible, and `staff`
also satisfies the join policy — joinable.

**Existence and visibility are the same check everywhere**, deliberately — a hidden channel and a
nonexistent one are structurally indistinguishable to every protocol path (catalog contents, chat
send, chat history, join), not merely filtered differently in different places. This is the actual
mechanism behind the privacy guarantee in "Privacy boundaries" below.

## Passwords

An optional, additional gate on top of (never a bypass of) group-based Join policy — a Guest denied by
group ACL stays denied even with the correct password, because password verification is the _last_
check in the join sequence (visibility → join policy → capacity → password), so a request that would
fail anyway never even reaches the password check.

Verifier format: `scrypt$1$16384$8$1$<saltBase64url>$<hashBase64url>` — `node:crypto`'s `scryptSync`
with its own built-in default cost parameters (`N=16384, r=8, p=1`), a random 16-byte salt per
`set-password` call, and the version/cost parameters embedded in the stored string itself so a future
cost-parameter change never invalidates existing verifiers. Called synchronously, inside the
already-synchronous connection hot path — this preserves the same "no async gap in the connection
message-handling path" invariant `AuthorizationPort`/`ChatPort` already document, accepting a
~30-80ms blocking cost per password-gated join attempt as a deliberate, documented tradeoff (mitigated
by the rate limiter below; a self-hosted small-room server's shared event loop is not a
high-throughput authentication service, so the lighter end of OWASP's scrypt-cost guidance was chosen
deliberately). The Admin UI has no way to retrieve an existing raw password — `hasPassword: boolean`
is the only signal ever sent on the wire for a protected channel; changing or removing a password are
one-way, write-only operations.

**The Client never persists a channel password anywhere** — not in bookmarks, not in
`settings.json`, not in `localStorage`/`IndexedDB`, not logged. It exists only as transient form state
for the duration of one join attempt.

**Rate limiting**: reuses the existing `RateLimiter` class (the same mechanism `chatSendRateLimiter`/
`chatHistoryRateLimiter` already use) — a new per-connection channel-password limiter (default 5
attempts per 60 seconds), consulted only when the target channel actually has a password, before the
`scryptSync` call runs at all.

## Live updates

**A full, per-connection-filtered catalog snapshot is re-sent on every relevant mutation** — never a
differential/patch protocol — matching this codebase's repeated bias toward "resend the whole small
bounded thing" (T8's original catalog, T9's `server:authorization-state`, T10's chat all made the same
choice). Every channel-tree mutation, and every T9 group-membership change (grant/revoke/delete) that
could alter what a connection may see or join, triggers a rebuilt, filtered `voice:catalog` for each
affected connection — no reconnect required. Live-role-change and live-catalog-update are proven by a
real-socket integration test that grants a group to an already-connected identity and observes the
same live connection's catalog update without disconnecting.

**Live enforcement, not just live display**: if an already-joined participant's access to their
_current_ voice channel is revoked (a group revoke, or a channel-update narrowing that channel's join
policy), the server force-removes them from that voice channel through the existing
leave/signaling-cleanup lifecycle and sends them a dedicated `server:voice-removed-by-policy` message
— distinct from a self-initiated leave and from a moderation kick/ban, so the Client can show an
accurate, non-punitive "you can no longer access this channel" message. The participant's connection
to the server itself is never affected. A participant who merely loses _visibility_ to a channel
they're viewing chat for (not joined) needs no separate push message at all — the personalized catalog
refresh already removes it from their view, and the same visibility check that gates the catalog also
now gates every chat-history/chat-send request, so a client that hasn't reacted to the catalog update
yet still cannot successfully request anything for a channel it can no longer see.

## Temporary channels

A temporary ("quick") channel has **no database row at all** — since it structurally cannot survive a
restart, persisting even a flagged row would buy nothing and would add a real crash-recovery hazard (a
row that must be specially recognized and cleaned up on every boot). Instead, `services/realtime`
holds temporary channels in a small in-memory `TemporaryChannelRegistry`, merged into the filtered
catalog view alongside the real, persisted tree. A temporary channel's access policy is always
`Inherit` at every axis, by construction — it has no override fields at all.

Creation (`client:channel-create-voice{temporary: true}`) and joining remain two separate
client-issued messages — there is no atomic server-side create-and-join. This is deliberately simple
(reusing the existing, unmodified `voice:join` path entirely), at the cost of a possible
"created but never joined" zombie if a client crashes or a follow-up join fails. This is handled by
**opportunistic pruning** rather than a background timer: every time any connection's catalog is
rebuilt (which happens often — every connect, every mutation, every group change), any temporary
channel older than 30 seconds with zero current members is swept and its (if any) chat purged as a
side effect of that same rebuild — no separate scheduled job exists or is needed.

Destruction on the last participant leaving is handled identically whether that departure was an
explicit `voice:leave`, a channel switch, or an abrupt disconnect — one shared helper function is
called from all three paths, specifically to prevent the two original call sites from silently
diverging in behavior over time. Destroying a temporary channel also deletes any chat history it
accumulated while it existed (`ChatPort.deleteChannelHistory`) — this is the one intentional exception
to T10's normal "chat is permanent" rule, documented explicitly rather than left as a surprising
retention difference. A server restart while temporary channels are "alive" needs no special recovery
logic at all: both the registry and the underlying voice membership start empty on every boot, and the
same mandatory visibility check that gates ordinary chat/join requests will never again resolve a
temporary channel's old ID, so any chat rows written before an unclean shutdown become permanently
unreachable through the protocol immediately — an optional, purely-hygienic startup prune
(`ChatPort.pruneOrphanedChannelHistory`, comparing against the real persisted-node-id list) additionally
reclaims that disk space, but is not itself the safety mechanism.

## Permanent deletion and chat history

**Deletion is a tombstone, never a row delete.** `channel_nodes.deleted_at` is set; the row and its
`node_id` are never removed or reused. Every read path (`getFilteredTree`, `getVisibleNode`) filters
`deleted_at IS NULL`, so a tombstoned channel is indistinguishable from one that never existed, to
every caller, including an administrator (there is no "restore a deleted channel" affordance in
T13.2 — recovering into a possibly-since-changed tree is its own product decision, deliberately
deferred).

This is what dissolves the cross-database-delete hazard a naive design might worry about: because
`chat.sqlite`'s `channel_id` column was never a foreign key into `channels.sqlite` (see "Storage"
above), tombstoning a channel is a single-file, single-transaction write with **zero required
corresponding write** in `chat.sqlite` at all. That channel's chat rows persist forever, on disk,
correctly reachable by nothing — no catalog entry resolves to that ID anymore, and the same
`getVisibleNode` check every chat-history request already goes through returns nothing for it,
producing the identical `CHANNEL_NOT_FOUND` a request for a channel that never existed would get.
"History remains server-local but is no longer reachable through normal channel navigation" — the
explicit target semantics this task set out to achieve — falls out of the existing visibility
mechanism with no special-cased delete-time coordination between the two stores.

Deleting a node with children cascades the tombstone to the entire subtree in one transaction (a
recursive update entirely internal to `channels.sqlite`). Deleting an occupied voice channel
force-removes its current members from voice (same mechanism as the live-ACL-revocation case above)
without disconnecting them from the server.

## Privacy boundaries

A user who cannot see a channel must never learn its name, ID, parent, password-protected flag, user
count, membership, or chat history through **any** protocol path — not just the catalog. This is
enforced at every one of the following points, each individually checked and covered by a hostile-
client integration test using a real socket (never assumed safe from UI-layer filtering alone):

- The catalog itself (`voice:catalog`) — built per-connection, filtered before serialization.
- `client:chat-send` (channel scope) and `client:chat-history-request` (channel scope) — both now
  resolve the target channel through the same visibility-checking `getVisibleNode` call the join path
  uses, replacing the old "does this channel id exist at all" check that predated T13.2's hidden
  channels. A raw history request for a hidden channel's ID, even a correctly-guessed one, fails with
  `CHANNEL_NOT_FOUND` — never a different error that would confirm the channel's existence.
- `voice:join` itself, obviously — the primary enforcement point.
- `client:channel-update`/`-set-password`/`-remove-password`/`-get-editable-node` — each now resolves
  the target through `getVisibleNode` **before** ever considering Manage rights (see "Security fix"
  below); `client:channel-move`/`-delete` already did this from initial implementation.
- Group-membership changes (`grant`/`revoke`/`delete-group`) — each now also triggers a personalized
  catalog refresh for the affected identity, so a change in what they're allowed to see is reflected
  immediately, not only at next reconnect.

### Security fix: Manage authorization requires visibility first

A pre-release security review found that `handleChannelUpdate`/`handleChannelSetPassword`/
`handleChannelRemovePassword`/`handleChannelGetEditableNode` authorized a caller via global
`channels.manage` **or** node-local delegated Manage rights (`ChannelPort.hasManageRights`) without
first checking whether the caller could actually _see_ the target node — `hasManageRights` evaluates
only the Manage-policy ancestor chain, entirely independent of Visibility. `client:channel-move`/
`-delete` were unaffected; both already resolved the target via `getVisibleNode` first.

**Concrete failure this allowed**: a node-local Manage grant is a deliberately separate axis from
Visibility (see "Access-control model" above — "a channel-local Manage grant... is not restricted
merely because an ancestor category has a tighter Manage policy"), so a real, intended configuration
— an ancestor category visible only to `execs`, containing a channel whose own `Manage` policy
delegates to `it-support` (not a member of `execs`) — let an `it-support` identity read the channel's
full admin-detail view (name, `parentId`, `userLimit`, `hasPassword`, and all three group-id lists) or
mutate it, via a rejection (`AUTHORIZATION_DENIED`) that itself confirmed the node's existence to an
identity that should never have been able to distinguish it from nonexistent. This directly
contradicted "existence and visibility are the same check everywhere" for these four handlers
specifically.

**Fix**: all four handlers now call `ChannelPort.getVisibleNode(nodeId, effectiveGroupIds)` first and
return `CHANNEL_NOT_FOUND` — never `AUTHORIZATION_DENIED` — for an invisible node, before ever
evaluating Manage rights, matching the pattern `handleChannelMove`/`handleChannelDelete` already used.
A caller's own global `channels.manage`/`channels.create`/`channels.delete` permission is unaffected
by this — it is documented as "a global override of any node's Manage" and continues to authorize
mutating any node regardless of that caller's own Visibility, since global permission holders are not
themselves subject to the ACL they administer.

**Regression coverage**: `tests/dedicated-server/channels-integration.test.ts` has a dedicated test
constructing exactly this scenario (disjoint Visibility-gating and Manage-delegated groups) and
asserting `CHANNEL_NOT_FOUND` from all six node-addressing actions (get-editable-node, update,
set-password, remove-password, move, delete) — the full regression matrix this fix requires, not just
the one handler the review happened to name first. `e2e:channel-hidden-smoke` independently proves the
same invariant at the real-socket level.

## Reconnect interaction

Unchanged in kind, extended in specificity: `voice:join` failures have never been fatal in this
codebase (a non-fatal error code, never present in `CLOSE_CODE_BY_ERROR`), so reconnect has never been
at risk of failing outright over an unrestorable channel. T13.2 adds three specific, distinguishable
outcomes for a reconnect-triggered restore attempt: the channel was deleted or is now hidden (both
`CHANNEL_NOT_FOUND`, deliberately indistinguishable — the restore silently gives up, no error shown,
since this is a background reconciliation, not a user action), the channel is still visible but no
longer joinable (`CHANNEL_ACCESS_DENIED`, same silent give-up), or the channel now requires a password
it doesn't have (`CHANNEL_PASSWORD_REQUIRED` — the Client still reconnects successfully, but rather
than silently abandoning the restore, prompts the user to manually re-enter a password, since they can
still complete the rejoin themselves).

## Speak-permission: deliberately not implemented

T13.2 does **not** implement any "who may speak" server-enforced control. This app's voice transport
is a P2P mesh (`packages/rtc-core`'s `P2PMeshTransport`) — media flows directly between participants'
`RTCPeerConnection`s, never through `services/realtime`/`services/dedicated-server` at all (only
signaling — SDP/ICE — passes through the realtime service, by explicit long-standing product
principle). A server-side "muted by policy" flag has no real enforcement point in this topology: the
server can prevent someone from _joining_ a channel (a real, already-enforced boundary) and can force
them out of a channel's signaling membership, but it cannot inspect or interrupt audio a still-joined,
possibly-modified client chooses to keep transmitting on an already-negotiated connection to another
member — there is no media relay in the data path to enforce anything at. Shipping a "Who can speak?"
checkbox under these conditions would be a control that visibly exists but cannot actually do what it
implies, which this product's own authorization design explicitly avoids elsewhere (see
`packages/protocol/src/authorization.ts`'s own permission-registry doc comment on only including
permissions the Dedicated Server can authoritatively enforce). This becomes possible only if/when an
SFU is introduced (T17, evaluated only if measured scale ever justifies it) — until then, the honest
choice is to omit the control entirely rather than ship one that lies.

## Renderer admin UI

Reuses the T13.1/T13.1.1 design system exclusively (`ui/Modal`, `ui/ContextMenu`, `ui/Button`,
`ui/IconButton`, `ui/Toast`, CSS Modules, design tokens) — no raw/native admin screens. Right-click
context menus (`ChannelSidebar`/`ChannelRow` → `ChannelContextMenu.tsx`) and a dedicated, always-
reachable "Channels" page inside a new Server Settings shell (`ServerSettingsModal.tsx`,
alongside Groups & Permissions/Invites/Bans — the last three reusing T9's existing `AuthorizationPanel`
logic unchanged, extracted into `GroupsSection`/`TokensSection`/`BansSection` so nothing is
duplicated) both drive the same Create/Edit Category/Channel modals, Move dialog, Delete confirmation,
and a reusable `ChannelAclEditor` (Visibility/Join/Manage radios, real T9 group names, an inheritance
note resolved via `channel-tree.ts`'s read-only mirror of the server's own ACL algorithm — display-only,
never a security decision).

**Per-node admin affordances gate correctly on the exact server-side authorization each action
requires**, not a single blanket "can manage" check:

- Create-subchannel/Edit gate on Manage rights over the node **itself**.
- Move/Delete gate on Manage rights over the node's **parent** — a UI defect found during final QA
  (both `ChannelContextMenu.tsx` and `ChannelsAdminPage.tsx` initially gated "Move" on the node-itself
  check, which would have shown the action to an identity with delegated Manage on a node but not its
  parent — exactly backwards from `handleChannelMove`'s real requirement) was fixed to check the
  parent, mirroring Delete's already-correct gate.
- Since the ordinary (non-admin) `voice:catalog` view omits group-id lists for privacy (an identity
  cannot locally compute whether it holds an arbitrary node's delegated Manage grant), a caller
  lacking the relevant _global_ permission has any per-node admin item merged in only once a real,
  optimistic `client:channel-get-editable-node` request resolves (`use-editable-node-check.ts`) —
  never shown speculatively, never left disabled-but-visible.

A Guest (or any identity with no relevant permission) sees zero admin DOM anywhere — the context menu,
the Channels admin page, and the Server Settings entry point itself are all genuinely absent, not
disabled, verified directly (component tests inspect the rendered DOM tree, not just prop values).

## What T13.2 deliberately does not do

Real server/user avatar upload, member directory/presence, online/away/DND, custom status (T13.3);
push-to-talk, voice-activity UX, per-user volume, local participant mute, speaking indicators,
join/leave sounds (T13.4); Discord-like stream viewing/focus, camera layout, detached stream
window/PiP, new camera-grid architecture (T13.5); authoritative speak enforcement (see above, deferred
to a hypothetical future SFU task).
