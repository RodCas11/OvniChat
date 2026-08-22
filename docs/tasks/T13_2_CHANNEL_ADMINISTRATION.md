# T13.2 — Channels & server administration

## Goal

Transform the static, config-only voice-channel model (T3/T8) into a real, dynamic, server-owned
channel administration system: authorized admins create/rename/move/delete channels and categories,
configure per-channel visibility/join/manage access policy against T9 groups, set optional user
limits and passwords, and use TeamSpeak-style temporary channels — all live, from the Client, with
no server restart and no hand-edited config file. The Dedicated Server remains the sole source of
truth; channel structure is never client-owned data.

## Context

T8 made channels "server-owned" but only in the sense that an operator's config file defined a fixed
list at startup (`DEFAULT_VOICE_CHANNELS`/`config.voiceChannels`, a flat `{channelId, name}[]` with no
hierarchy). T13.2 makes that structure genuinely dynamic and hierarchical, administered through the
T13.1/T13.1.1 UI foundation. A `software-architect` review was conducted before implementation (see
Handoff notes and [`architecture/CHANNELS_AND_SERVER_ADMINISTRATION.md`](../architecture/CHANNELS_AND_SERVER_ADMINISTRATION.md))
covering storage, migration, the ACL model, password verification, and live-update strategy — this
task implements that design.

## In scope

- A new server-local `channels.sqlite` store (categories + voice channels + subchannels, ACL,
  password verifiers), composed into `services/dedicated-server` alongside the existing
  `authorization.sqlite`/`chat.sqlite` stores.
- Safe bootstrap/migration from the existing static config (`general`/`games`/`afk` IDs preserved
  exactly, so T10 chat history never orphans).
- A bounded, ordered, categorized, sub-channelable hierarchy with a closed group-based ACL model
  (Visibility / Join / Manage, each Inherit / Everyone / Selected Groups, referencing stable T9
  group IDs).
- Optional per-channel user limits (server-enforced, race-safe) and optional salted-scrypt
  password protection (never plaintext, never client-persisted, never bypassing group ACL).
- TeamSpeak-style temporary channels: created explicitly, destroyed automatically when the last
  participant leaves, never surviving a restart, with their chat purged rather than orphaned.
- Live, per-connection-filtered catalog updates on every mutation and on T9 group-membership
  changes — no reconnect required; live force-removal from voice when access is revoked.
- Full privacy enforcement: a channel invisible to an identity must never leak its name, ID,
  password flag, membership, or chat history through any protocol path (catalog, chat send/history,
  signaling, reconnect state).
- Renderer admin UI: channel/category create/edit/move/delete dialogs, access-policy configuration,
  password dialogs, a polished Server Settings → Channels admin surface, and a tree-rendering
  `ChannelSidebar` update — reusing the T13.1.1 design system, never a raw/native admin screen.
- A new `e2e:channel-admin-smoke` and hidden-channel/temporary-channel proof scenarios.

## Out of scope (deferred to later T13.x tasks)

Real avatars/presence/status (T13.3); push-to-talk, voice-activity UX, per-user volume, speaking
indicators, join/leave sounds (T13.4); stream theatre, detached windows, PiP, new camera-grid
architecture (T13.5). **Authoritative "who may speak" enforcement is deliberately never implemented**
— this app's P2P-mesh WebRTC architecture has no media relay point to enforce it at, so exposing such
a control would be a misleading checkbox; deferred until an SFU exists (T17, if ever justified).

## Architecture constraints

- `ChannelPort` (new, in `services/realtime`) never imports `AuthorizationPort` or talks to
  `VoiceRegistry` directly — every ACL-evaluating method takes the caller's already-resolved
  `effectiveGroupIds` as a parameter, resolved by `protocol-handlers.ts` from the existing
  `AuthorizationPort.getSnapshot()`. This avoids a circular dependency between the two
  `services/dedicated-server` store classes.
- `channels.sqlite` is a third, deliberately separate SQLite file — never merged into
  `authorization.sqlite` or `chat.sqlite`, and never linked to either via a foreign key (a channel
  ACL entry references a group ID as a plain string; `chat.sqlite`'s `channel_id` column has zero FK
  relationship to `channels.sqlite`, exactly mirroring the pre-existing chat-to-authorization
  posture). This is what makes permanent-channel deletion a single-file, single-transaction
  tombstone write with no cross-database coordination.
- Existence and visibility are the same check everywhere — a hidden channel and a nonexistent one
  are structurally indistinguishable to every caller, by construction, not by convention.
- No fabricated data, no client-side-only security control: every mutation is server-authorized;
  hiding an admin action in the UI is a courtesy, never the real boundary.

## Relevant packages

`packages/protocol`, `services/realtime`, `services/dedicated-server`, `apps/desktop`.

## Relevant agents

`realtime-backend-engineer` (primary, backend), `electron-desktop-engineer` (Renderer admin UI),
`software-architect` (pre-implementation design review — complete, see Handoff notes),
`qa-engineer` and `security-reviewer` (final gates).

## Relevant skills

`project-orientation`, `planning-feature`, `realtime-protocol`, `electron-development`,
`security-review`, `testing-quality`.

## Acceptance criteria

See the task's own exhaustive Definition of Done checklist (the ~50-item list spanning storage,
migration, hierarchy, temporary channels, passwords, ACL, live updates, reconnect, isolation, UI, and
review gates), summarized with real evidence in the Handoff notes below.

## Definition of Done

Complete only when channel state is dynamically server-owned and survives restart with stable IDs;
existing config channels migrate safely; the tree is bounded and abuse-resistant; temporary channels
work end-to-end including crash recovery; passwords are safely stored/verified/rate-limited and never
bypass ACL; group-based visibility/join/manage work with correct inheritance; hidden channels leak no
metadata through any protocol path; live updates require no reconnect; reconnect never fails outright
over an unrestorable channel; server-to-server state is isolated; the admin UI matches the T13.1.1
design language and is invisible to unauthorized users; the new E2E scenarios and the full existing
regression suite pass; security and QA review findings are addressed; and documentation reflects the
actual final system. Otherwise: IN PROGRESS.

## Handoff notes

### What is real and verified

**Backend**: `channels.sqlite` (v1 schema), config-to-database migration preserving existing channel
IDs exactly, the bounded hierarchy (`MAX_CHANNEL_TREE_NODES`/`_NAME_LENGTH`/`_DEPTH`), the three-axis
ACL model with correct top-down Visibility / bottom-up Join+Manage resolution, scrypt-verified
passwords (last in the join sequence, never bypassing ACL, per-connection rate-limited), temporary
channels (in-memory, opportunistic pruning, real chat purge on destruction), tombstone deletion (no
row/ID reuse, zero cross-database coordination with `chat.sqlite`), live per-connection-filtered
catalog updates on every mutation and T9 group-membership change, live force-removal from voice on
access revocation, and the three-case reconnect-restore behavior (deleted/denied/password-added) are
all implemented in `services/realtime`/`services/dedicated-server`/`packages/protocol` and covered by
`tests/dedicated-server/{channel-store,channels-integration}.test.ts` and
`tests/realtime/temporary-channels.test.ts`.

**Renderer**: the full admin UI — context menus, Create/Edit Category/Channel modals, Move dialog,
Delete confirmation, the ACL editor with inheritance visualization, the password join/change/remove
flow, and a Server Settings shell (Channels/Groups & Permissions/Invites/Bans, the last three reusing
T9's existing logic unchanged) — is implemented, reuses the T13.1/T13.1.1 design system throughout,
and hides every admin affordance a caller cannot actually use (verified directly against rendered DOM,
not prop values). 1258 Vitest tests pass repo-wide; `tsc`/`eslint`/`prettier` are clean.

**Live-verified via real Electron + real Dedicated Server E2E** (all re-run against final code, after
every fix below landed): `e2e:channel-admin-smoke` (nested category/channel/subchannel creation, live
ACL grant, live rename/reparent, wrong/right password, password never persisted to disk, capacity
fill/full/recover, every mutation plus a chat message surviving a real server restart);
`e2e:channel-hidden-smoke` (a fully hidden category+channel never appears in a Guest's raw incoming
messages; joining/reading admin-details/reading chat history for the real, guessed hidden ID are all
byte-identical in rejection shape to a genuinely nonexistent ID); `e2e:channel-temporary-smoke` (full
lifecycle: appears on creation, survives while occupied, destroyed with a real chat purge the instant
it empties, never returns after a restart); `e2e:reconnect-channel-smoke` (the three new offline-mutation
cases); plus `e2e:reconnect-smoke` (the fourth, still-allowed-restore case, already covered by the
pre-existing T11 script). The full pre-existing E2E suite (`product-shell-smoke`,
`text-chat-persistence`, `authorization`, `connection-smoke`, `identity-auth`,
`identity-persistence`, `settings-persistence`, `voice-smoke`, `camera-smoke`, `screen-smoke`,
`screen-audio-smoke`, `process-audio-smoke`) was re-run against the final, combined, repackaged build
with no regression.

Thirteen real screenshots from an actual packaged Electron instance (checked into
[`screenshots/t13-2/`](screenshots/t13-2/); full admin hierarchy at
1920×1080; the admin context menu; Create Channel; Create Category; Edit Channel; Move Channel; the
ACL editor with a real Selected-Groups checkbox list and a real inheritance note; the password-join
prompt; a temporary channel; Server Settings → Channels; Server Settings → Groups & Permissions; a
genuine no-permission Guest's sidebar; and the admin workspace at 1366×768) were captured and
personally visually reviewed. Two real, minor visual defects the review surfaced were fixed: channel/
category names truncating in the sidebar with no way to see the full name (added `title` tooltips;
`ChannelSidebar.module.css`'s category header also gained the same overflow/ellipsis handling
`ChannelRow.module.css`'s channel-name span already had). One pre-existing, out-of-T13.2's-scope
visual rough edge was found and is recorded rather than fixed: the reused T9 Groups & Permissions
panel displays raw permission-key strings (e.g. `chat.channel.send, voice.channel.join`) rather than
human-readable labels — this predates T13.2 entirely (`AuthorizationPanel.tsx`'s own pre-existing
rendering), and redesigning it would be a T9 UI change this task's own "do not rewrite working T9
behavior" boundary explicitly excludes; a worthwhile follow-up for a later polish pass, not a T13.2
defect.

### Security and QA review

**Security review** found one high-severity issue, fixed before completion: `handleChannelUpdate`/
`handleChannelSetPassword`/`handleChannelRemovePassword`/`handleChannelGetEditableNode` authorized via
global `channels.manage` **or** local delegated Manage rights without first checking whether the
caller could see the target node — `ChannelPort.hasManageRights` evaluates only the Manage-policy
ancestor chain, never Visibility, so a real configuration (delegated Manage on a node hidden by a
_different_ ancestor's Visibility restriction) let an unauthorized-to-view caller read the node's full
admin-detail view or mutate it, with a rejection code (`AUTHORIZATION_DENIED`) that itself confirmed
the node's existence. Fixed by adding the same `getVisibleNode`-first check `handleChannelMove`/
`-delete` already used correctly, returning `CHANNEL_NOT_FOUND` before ever evaluating Manage rights.
See [`architecture/CHANNELS_AND_SERVER_ADMINISTRATION.md`](../architecture/CHANNELS_AND_SERVER_ADMINISTRATION.md)'s
"Security fix" section and [`SECURITY.md`](../SECURITY.md)'s T13.2 section for the full record.
Regression coverage: a dedicated integration test covering all six node-addressing actions
(get-editable-node/update/set-password/remove-password/move/delete) against the exact
disjoint-Visibility/Manage-group scenario, plus `e2e:channel-hidden-smoke`'s real-socket proof.

Three lower-severity findings were reviewed and accepted as documented, deliberate tradeoffs rather
than fixed: parent-Manage delete/move semantics (deleting/moving requires Manage on the node's
_parent_, never the node itself — filesystem-directory-permission semantics, matching this task's own
explicit "simpler than TeamSpeak's numeric permission-power model" design goal); per-connection
channel-password rate limiting (matches the already-accepted `CHAT_RATE_LIMITED` shape exactly, not a
new or weaker gap); and temporary-channel idle-pruning cadence (opportunistic, not timer-driven, by
original design). See `SECURITY.md` for the full, honest accounting of each.

A separate, independent UI-correctness defect (not from the security review) was found during my own
final code read-through: `ChannelContextMenu.tsx`/`ChannelsAdminPage.tsx` gated the "Move Channel"
action on Manage rights over the node **itself**, when `handleChannelMove`'s real authorization
requires Manage over the node's **parent** — meaning the UI could both wrongly show Move to someone
who couldn't actually perform it, and wrongly hide it from someone who could. Fixed to check the
parent, mirroring the already-correct Delete gate; both affected component tests were corrected (they
had encoded the buggy behavior as their expectation) and two new tests were added distinguishing
node-itself Manage from parent-Manage for both Move and Delete.

**QA review** exercised every admin scenario (hierarchy creation, ACL/inheritance, passwords,
temporary channels, hidden-channel lifecycle, normal-user hiding, Server Settings integration,
keyboard/accessibility basics) via real component tests against the actual rendered UI, not isolated
unit tests alone — extending 8 existing test files and adding a new one
(`voice-channel-view-wiring.test.tsx`) that mounts the real `VoiceChannelView` to prove the
selected-channel-removed fallback and Server Settings gating are genuine UI wiring, not just pure
functions. Found and fixed one real, narrow CSS defect: a group checkbox label had no
`min-width: 0`/`overflow-wrap`, letting a long (up to 64-character), unbroken group name overflow its
grid column. 19 new tests added (1239 → 1258 total). All 12 QA acceptance questions were answered
affirmatively; see the architecture doc's "Renderer admin UI" section for the acceptance summary.

### Privacy confirmation

- No central account, no DM system, no server discovery, no cloud sync, no new analytics, no
  mandatory OvniChat-operated service. Channel structure/ACL/passwords are entirely server-local,
  never shared between independently operated Dedicated Servers, never uploaded anywhere.

### Next task

**T13.3 — Profiles / Avatars / Members / Presence.** Not implemented as part of T13.2.
