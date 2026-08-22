# T13.2.1 — Administration UX polish

## Goal

Fix two specific product-language problems found during T13.2's own final screenshot review, without
reopening T13.2's architecture or starting T13.3: (1) the Groups & Permissions panel rendered raw,
comma-joined `PermissionKey` strings (e.g. `authorization.groups.manage, chat.channel.send`) instead
of human-readable labels; (2) `ChannelAclEditor.tsx`, shared unchanged between `ChannelModal.tsx`
(voice channels) and `CategoryModal.tsx` (categories), hardcoded channel-specific wording ("Who can
join this channel?") for both callers even though a category is never joinable itself.

## Context

T13.2's own handoff notes explicitly recorded the raw-permission-key rendering as an accepted,
out-of-scope rough edge: "a worthwhile follow-up for a later polish pass, not a T13.2 defect." This
task is that follow-up. The category/channel ACL-wording mismatch was found independently during this
task's own file read-through of `ChannelAclEditor.tsx` and its two call sites.

## In scope

- A new, pure presentation module (`apps/desktop/src/renderer/voice/permission-presentation.ts`)
  mapping every current `PermissionKey` to a human-readable label, an optional one-line description,
  and one of four categories (Voice & Chat / Channels / Moderation / Server Management).
- `GroupsSection.tsx`: existing groups render a categorized, human-readable permission summary (a
  "Full server administration" summary for a group holding literally every current permission,
  computed by comparison against the full registry — never a hardcoded group id/name check); the
  Create Group form's checkbox grid is grouped under the same category headings.
- `ChannelAclEditor.tsx`: a new required `kind: NodeKind` prop (`'voice'` | `'category'`) branching the
  three axis legends — category wording never implies a category itself is joinable — plus a short
  helper note under the category Join axis, and the "Same as parent" inherit option split into a
  short primary label with a muted "no parent" caveat shown only when relevant.
- `ChannelModal.tsx` (`kind="voice"`) and `CategoryModal.tsx` (`kind="category"`) updated call sites.
- A CSS fix carried over to `AuthorizationPanel.module.css`'s own `.checkboxField` (the
  `min-width: 0` / `overflow-wrap: anywhere` pair `ChannelAdminForm.module.css` already had from
  T13.2's QA pass), plus new classes for the categorized group-summary/checkbox-heading layout.
- New/extended Vitest coverage (see Tests below) and real Electron screenshot re-verification.

## Out of scope

Everything T13.2's own "hard scope boundary" already excluded, unchanged: `services/realtime`,
`services/dedicated-server`, the permission registry itself
(`packages/protocol/src/authorization.ts` — no permission key added, renamed, or removed), the
protocol version, the ACL evaluator, password hashing, temporary-channel/tombstone/reconnect/
catalog-filtering behavior, group IDs, and server-side enforcement of any kind. No "who can speak"
control (or anything resembling one), no role colors/icons/hierarchy/badges, no permission search box.
This is a Renderer presentation-layer change only — the wire value sent to
`createGroup`/`updateGroup` for a given permission is completely unchanged; only the rendered label
changes.

## Architecture constraints

- `permission-presentation.ts` is Electron/React-free (a plain TypeScript module, same posture as
  every other `voice/*.ts` helper) and derives its own completeness guarantee from
  `packages/protocol`'s `permissionKeySchema` — compile-time via the `Record<PermissionKey, ...>`
  literal, runtime via a dedicated test enumerating `permissionKeySchema.options`.
- `server.manage`'s label/description is written to match its actual current scope (reserved,
  unchecked by any server action today), verified by re-reading `authorization.ts`'s own comment and
  grepping `services/realtime`/`services/dedicated-server` for any real check — never aspirational.
- The Manage axis's "no parent" caveat copy was verified against `channel-port.ts`'s own ACL
  resolution doc comment (an all-`'inherit'` Manage chain resolves to "nobody via delegation," so only
  an identity holding the _global_ `channels.manage` permission — checked by
  `protocol-handlers.ts` before ever calling into `ChannelPort` — can manage it) before being written
  as "only server administrators can manage it," never naming the raw permission key.

## Relevant packages

`apps/desktop` only. No `packages/protocol`, `services/realtime`, or `services/dedicated-server`
changes.

## Relevant agents

`electron-desktop-engineer` (primary and only implementer — this is a Renderer-only presentation
change).

## Relevant skills

`electron-development`, `testing-quality`.

## Definition of Done

Complete only when: no raw `PermissionKey` string is visible anywhere in ordinary Groups & Permissions
UI (list or create form); a group holding every current permission renders a compact summary rather
than a 13-item list; `ChannelAclEditor` renders category-accurate copy for `CategoryModal` and
unchanged channel copy for `ChannelModal`; the "Same as parent" caveat is accurate and never names a
raw permission key; every listed test passes; `tsc`/`eslint`/`prettier` are clean; the listed E2E
scripts pass against a real, rebuilt Electron + Dedicated Server; and real screenshots confirm no raw
permission key is visible. Otherwise: IN PROGRESS.

## Handoff notes

### What is real and verified

**`permission-presentation.ts`** maps all 13 current `PermissionKey` values (see the final mapping
table in the orchestrator's own final report) into four categories, with the `Record<PermissionKey,
...>` literal's own type-checking as the primary completeness guarantee and
`tests/desktop/permission-presentation.test.ts` as the runtime backstop.

**`GroupsSection.tsx`** no longer renders `group.permissions.join(', ')` anywhere — existing groups
render a categorized summary line, with a "Full server administration" special case for a group
holding every permission (computed via `isFullPermissionSet`, a real set-comparison against the
registry — never a check against the built-in `server-admin` group id, since a custom group can
legitimately reach the same state, and the shipped E2E screenshot fixture's own "Owner" group
deliberately proves this by holding every permission _except_ `channels.password.bypass`, correctly
falling through to the categorized list rather than the full-administration summary). The Create Group
form's checkbox grid is grouped under the same four category headings; the checkbox `checked`/
`onChange` wiring, and the wire value sent to `createGroup`, are unchanged.

**`ChannelAclEditor.tsx`** takes a new required `kind: NodeKind` prop. `ChannelModal.tsx` passes
`kind="voice"` (legends unchanged: "Who can see/join/manage this channel?"). `CategoryModal.tsx` passes
`kind="category"` ("Who can see this category?" / "Who can join channels inside this category?" with a
helper note that child channels inherit the setting / "Who can manage this category?"). The "Same as
parent" inherit option's label is now always just "Same as parent," with the "no parent" caveat shown
as a separate, muted secondary note only when `parentId` is `undefined` — for Manage, that caveat reads
"no parent — only server administrators can manage it," verified truthful against
`channel-port.ts`'s own ACL-resolution doc comment rather than guessed.

Tests: 1273 Vitest tests pass repo-wide (`npx vitest run`), including a new
`tests/desktop/permission-presentation.test.ts`, a new
`tests/desktop/components/groups-section.test.tsx`, three new category-vs-voice-kind tests in the
existing `tests/desktop/components/channel-acl-editor.test.tsx`, a corrected legend assertion in
`tests/desktop/components/category-modal.test.tsx`, and accessible-name assertions QA added to both
`groups-section.test.tsx` and `channel-acl-editor.test.tsx` (checkbox accessible names are the human
label, never the raw permission key). `tsc --noEmit`, `eslint .`, and `prettier --check .` are all
clean.

### QA review findings (both closed)

1. **The implementer's own claim that no new screenshot capture point was needed was wrong**, caught
   by QA reproducing it directly: the pre-existing `13-admin-1366x768.png` capture point resizes to
   1366×768 only _after_ the Server Settings modal already closes, so it never actually proved Groups
   & Permissions (or a category ACL form) usable at that width — the one acceptance criterion this
   task named explicitly by number. QA added a new capture point inside
   `armE2EChannelAdminScreenshotCapture` in `apps/desktop/src/main/index.ts` (E2E-only, gated behind
   `!app.isPackaged` and an explicit env var, identical class of instrumentation already in that
   function — no real product code path affected) producing
   `14-server-settings-permissions-1366x768.png`, captured _before_ the modal closes. Rebuilt,
   re-captured, and personally visually confirmed by both QA and the orchestrator: the panel renders
   cleanly at 1366×768, including the "Owner" group's long categorized summary line wrapping to two
   lines with no overflow/clipping.
2. **Terminology inconsistency**: `authorization.memberships.manage`'s label read "Manage member
   roles" while every other surface in this same panel says "groups" ("Groups & Permissions," "Group
   Name," "Create Group," "Grant group…"), risking a non-technical admin wondering whether "roles" and
   "groups" are different concepts. QA correctly reported this as a copy decision rather than guessing
   at a fix; the orchestrator changed the label to "Manage member groups" for consistency and
   re-captured all screenshots to confirm the corrected wording renders correctly.

QA also re-ran `tests/desktop/components/authorization-panel.test.tsx` (GroupsSection's own composed
test suite) and `e2e:authorization`/`e2e:channel-admin-smoke` against a freshly rebuilt app — all pass,
confirming zero regression from either QA's own `main/index.ts` instrumentation or the orchestrator's
terminology fix.

### Screenshots

Real screenshots were captured from a real, freshly rebuilt Electron + Dedicated Server instance,
checked into [`screenshots/t13-2-1/`](screenshots/t13-2-1/): the original T13.2 evidence tool
(`apps/desktop/scripts/e2e-screenshot-capture-t13-2.mjs`, now producing 14 screenshots after QA's
addition) re-run against this task's final code, including the terminology fix above. Every raw
permission key is confirmed absent from every screenshot; the new `14-server-settings-permissions-
1366x768.png` specifically proves the panel's usability at that resolution, closing the one gap QA
found.

### Next task

T13.3 — Profiles / Avatars / Members / Presence. Not implemented as part of T13.2.1.
