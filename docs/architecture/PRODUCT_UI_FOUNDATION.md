# Product UI foundation (T13.1, refined by T13.1.1)

> This document describes the Renderer's visual/interaction foundation established by T13.1 and
> visually refined by T13.1.1. It supersedes nothing structural in
> [`ARCHITECTURE.md`](../ARCHITECTURE.md) — Main/Preload/RTC/media/protocol ownership and trust
> boundaries are unchanged by either task. This is a Renderer-internal presentation-layer record.

## Why this exists

T0-T12 built a fully functional but visually undeveloped desktop client: zero CSS files anywhere in
`apps/desktop/src/renderer/`, no design tokens, no icon library, no component library, no router — a
single `App.tsx` did sequential conditional rendering between a bare `ConnectionScreen` and a
monolithic `VoiceChannelView.tsx` whose controls were plain unstyled `<button>`s. T13 was redefined,
by explicit product direction, from a single "self-hosting production package" task into a five-part
Product Experience series (T13.1-T13.5 — see [`tasks/STATUS.md`](../tasks/STATUS.md)). T13.1 is the
first: every later T13.x feature needs an obvious, consistent place to live in the interface, which
did not exist before this task.

## Design tokens

`apps/desktop/src/renderer/styles/tokens.css` defines every color, spacing, radius, typography,
shadow, z-index, and transition value as a `--ovni-*` custom property on `:root`. Component styles
consume tokens, never raw hex/px literals, so a future theme or density change is a token edit, not a
per-component hunt. Surfaces are dark neutral (`--ovni-bg-base` through `--ovni-bg-selected`); the
single green accent (`--ovni-accent`) is reserved for active/selected state, primary actions, and
positive/connected state — the product is deliberately not "a green app." Elevation is shadow-only
(no `--ovni-*-blur` token exists, and no component uses `backdrop-filter`) specifically to protect the
GPU/CPU budget real-time WebRTC media already needs. `@media (prefers-reduced-motion: reduce)`
collapses every transition/animation duration to `0.01ms` and forces `scroll-behavior: auto`.
`styles/global.css` imports tokens.css and sets document-level resets only (box-sizing, focus-visible
outline, scrollbar coloring) — no component-specific rule lives there.

## Styling mechanism: CSS Modules

Chosen over a UI framework or CSS-in-JS: zero new runtime dependency (Vite has built-in
`*.module.css` support), scoped class names with no global-namespace risk, and no CSP change needed
(`apps/desktop/src/main/content-security-policy.ts` already allows `style-src 'self' 'unsafe-inline'`,
which covers both Vite's dev-mode injected `<style>` and the production `<link rel="stylesheet">`).

**Real blocker found and fixed during this task**: TypeScript 6's `noUncheckedSideEffectImports`
(on by default) rejects a bare `import './styles/global.css'` with `TS2882` unless an ambient module
declaration resolves it. Four attempts at hand-writing `declare module '*.css'` inside
`global.d.ts` all failed identically — the actual cause is that pattern (wildcard) ambient module
declarations only apply inside a **script file** (no top-level `import`/`export`); `global.d.ts` has
both (it augments `Window` via `declare global`, which itself requires the file to be a module), so
TypeScript was silently treating the wildcard declaration as a meaningless module augmentation, never
as a pattern match. The fix is `apps/desktop/src/renderer/vite-env.d.ts` containing only
`/// <reference types="vite/client" />` — Vite's own ambient declarations (a pure script file) cover
`*.css` and `*.module.css` correctly, including proper typing for the exported class-name map.

## Icon system

`lucide-react` (pinned exact version) is the one coherent icon library used everywhere — tree-shakeable
inline SVG React components, no runtime CSS, no font/CDN fetch, no license concern for a Discord-style
icon set (never Discord's own proprietary artwork). No emoji, no ad hoc inline SVG, and no second icon
library exist anywhere in the redesigned Renderer.

## Component architecture

```text
apps/desktop/src/renderer/
  styles/           tokens.css, global.css
  ui/               generic primitives: Button, IconButton, Tooltip, Modal, ContextMenu,
                     Toast/ToastProvider, EmptyState, Avatar
  shell/            AppShell, ServerRail, ServerHome, AddServerDialog
  workspace/        ChannelSidebar, ChannelRow, ParticipantRow, MainContent, ChatView,
                     MemberPanel, MemberRow, UserControlBar, chat-target.ts
  voice/            unchanged hook logic (use-voice-channel.ts); SettingsPanel.tsx,
                     AuthorizationPanel.tsx, ScreenSourcePicker.tsx restyled in place
                     (JSX/markup only — every hook/effect/handler byte-for-byte unchanged)
```

`ui/` has no application knowledge (no import of `use-voice-channel.ts` or `ipc-contract.ts`).
`shell/` and `workspace/` compose `ui/` primitives with real application state passed down as props;
neither layer owns WebSocket, RTC, identity-signing, native-process-audio, or SQLite/chat-persistence
state — all of that remains exactly where T3-T12 put it (`use-voice-channel.ts` and its dependencies).
`voice/ChatPanel.tsx` was renamed to `workspace/ChatView.tsx`: its `loadChatHistory`/`sendChatMessage`
calls, dedup/merge/pagination handling, and plain-text (never `dangerouslySetInnerHTML`) message
rendering are unchanged — only the scope/channelId selection mechanism moved from an internal
`activeTab` derived from `state.currentChannelId` to explicit `scope`/`channelId` props, which is
what makes "view a channel's chat without joining its voice" (see below) actually expressible.

## The click-never-joins-voice rule

The single hardest interaction requirement: clicking a channel row selects it (shows its chat) and
must never join its voice. `workspace/chat-target.ts`'s `ChatTarget` is local, presentation-only
selection state, entirely independent of `state.currentChannelId` (the one real "am I in this
channel's voice" fact `use-voice-channel.ts` owns). `ChannelRow.tsx` renders a separate, explicit
Join/Leave action and visually distinguishes "selected for viewing" from "joined" using an icon
(`Volume2` vs `MessageSquare`) plus color, never color alone. Proven three ways: a component test
(`tests/desktop/components/channel-row.test.tsx`) asserts clicking a row never calls the join handler
while the Join control does; a real Electron E2E (`e2e:product-shell-smoke`) proves selection strictly
precedes the real `voice-joined` marker in event order; and the center pane's chat header never uses a
bare `#` prefix (which would falsely imply a Discord-style separate text-channel hierarchy this
architecture does not have) — it shows an explicit "Server Chat" or "{channel} — Chat" title instead.

## Self appearing in the member/participant lists

`use-voice-channel.ts`'s `state.participants` is populated only from the server's roster of _other_
participants (it exists to drive peer-connection setup) — the local user was never in it, so
`MemberRow`/`ParticipantRow`'s already-built `isSelf`/"(you)" rendering had nothing to render against.
Found during this task's own visual review (a real screenshot showed "Members — 1" with only the
remote participant listed, despite two people genuinely being connected). Fixed in
`VoiceChannelView.tsx` by synthesizing a self entry (`participantsWithSelf`, a `useMemo`) from data
this component already owns for real — its own effective display name, `state.selfParticipantId`, and
`state.myGroups` — merged into the array passed to `ChannelSidebar`/`MemberPanel`. `connectionState` on
the synthesized entry is genuinely `undefined` (there is no `RTCPeerConnection` to oneself to report a
state for) — not a fabricated value. Re-verified with a fresh, real-Electron screenshot after the fix:
the local user now appears with a "(you)" label in both the joined channel's roster and the member
panel.

## Server switching: the remount-key fix

Exactly one WebSocket/auth session exists at a time (`App.tsx`'s single `connection` state). The
server rail's "switch server" action reuses the existing `disconnect()` → `connectTo()` lifecycle —
never a second simultaneous connection. A `software-architect` review (consulted before
implementation) flagged a real React 19 risk: calling `disconnect()` then `connectTo()` synchronously
in one handler can be batched into a single commit that never renders an intermediate `'disconnected'`
state, meaning the connected-workspace root would not unmount/remount across a switch — silently
leaking one server's local UI state (draft chat text, selected channel, open settings) into the next
server's freshly-connected UI. Fixed by giving `AppShell` an explicit React `key` derived from
`${connection.config.url}#${connectionSequenceRef.current}` (a monotonic counter bumped inside
`connectTo`, since two bookmarks could theoretically share a host:port), guaranteeing a full
unmount/remount on every switch regardless of how React batches the underlying state transition.
Proven by `tests/desktop/components/app-shell-remount-key.test.tsx` (mechanism-level) and by
`e2e:product-shell-smoke` observing two distinct `VoiceChannelView` mount markers across a real
Server-A-to-Server-B switch. A second, smaller instance of the same class of bug was found and fixed
inside the workspace itself: `MainContent.tsx` originally rendered `ChatView` with no `key`, so
switching between Server Chat and a channel's chat (or between two channels) reused the same
`ChatView` instance and could leak an unsent composer draft into the newly-selected thread — fixed by
keying `ChatView` on `chatThreadKey(scope, channelId)` (imported from `use-voice-channel.ts`, not
duplicated).

## Settings reorganization and the Advanced/Diagnostics boundary

`SettingsPanel.tsx` is now organized into three sections a Discord-familiar user recognizes: **User &
Identity** (only the "Voice display name" convenience field — a distinct concept from identity
nickname, see `use-voice-channel.ts`'s own doc comment), **Voice & Video** (device selection, mic/output
test, screen-share quality default), and **Advanced** (connect-on-startup, the full `IdentityPanel` —
nickname, Identity ID, Regenerate Identity — Electron/app version diagnostics, and an honest
"Not implemented yet" list). Only sections that actually exist are shown — there is no fake
"Appearance" section. The cryptographic Identity ID and the destructive "Regenerate Identity" action
were initially placed in "User & Identity" during implementation; a visual-review pass (informed by a
real screenshot) found this violated the task's own explicit "must not be prominent" requirement and
relocated the entire `IdentityPanel` into Advanced, with its own heading demoted from `h2` to `h4` to
read correctly as a subsection alongside its new siblings ("Diagnostics", "Not implemented yet").
Nickname editing stays inside `IdentityPanel` rather than being split out, since it is genuinely part
of the same identity record as the id/regenerate action beside it.

## No fabricated data

Every rendered state comes from real `ipc-contract.ts` data or real hook state. There is no dev/demo
fixture reachable in a packaged build anywhere in the Renderer (verified by a case-insensitive grep
for `mock|demo|fixture|placeholder` across `apps/desktop/src/renderer` during security review, which
found none). `ServerHome`/`ServerRail` render only real bookmarks from `getClientSettings()`. Channel
categories and per-remote-participant mute/speaking flags are intentionally absent rather than
invented — `ParticipantRow`'s empty status/role slots remain shaped for future T13.4 data without
inventing placeholder values now. `MemberPanel`'s `groups` prop and `MemberRow`'s badge slot, both
previously dormant, are now real as of T13.3 (see below) — driven by actual `server:presence-*`
data and the server-derived `roleBucket` enum, never fabricated client-side classification.

## Admin/moderation visibility

`AuthorizationPanel.tsx`/`ChatView.tsx` preserve the pre-existing `can(permission) =>
state.myPermissions.includes(permission)` closure pattern: an unauthorized control is genuinely absent
from the component tree (`{can(...) && <Section />}`), never merely `disabled`. The server independently
re-validates every mutation (T9) — this is a UX courtesy, never the real boundary.

## Testing

This task introduced the repository's first Renderer component tests:
`@testing-library/react`/`@testing-library/jest-dom`/`jsdom` as root-level devDependencies (not
`apps/desktop`, since `vitest.config.ts` is a single root config), scoped per test file via a
`// @vitest-environment jsdom` docblock pragma — the global Vitest environment stays `node` for every
existing Main-process/domain test. `data-testid` attributes were added additively to key interactive
elements for both the component tests and a new real-Electron E2E,
`apps/desktop/scripts/e2e-product-shell-smoke.mjs`, which drives the full journey (fresh profile,
nickname, two bookmarks, Home, connect, select-without-joining, real Join, Settings open/close,
real disconnect→connect switch to a second server with a verified fresh mount, clean return toward
Home with bookmarks intact) through a real Electron instance and two real Dedicated Servers, following
the same `console.info` marker-observation convention every prior E2E script uses — no DOM
scraping/Playwright-style automation was introduced.

## Security-review findings fixed in this task

1. **Stale `AddServerDialog` state across openings** — the dialog component stays mounted across
   `open` toggles (`Modal` itself returns `null` while closed, but its parent does not unmount), so an
   abandoned "Add Server" draft could reappear when later opening "Edit Server" for an unrelated
   bookmark, silently repointing it. Fixed with a closed→open resync effect, deliberately guarded to
   never fire merely because the `bookmark` prop's object identity changed while already open (which
   would wipe an in-progress edit on an unrelated parent re-render).
2. **Quadratic, unmemoized chat message grouping** — `ChatView`'s Discord-style consecutive-sender
   grouping rebuilt each group via array spread on every message and ran unmemoized on every render;
   against a long same-sender run in an unbounded, server-controlled thread this was a real
   Renderer-side responsiveness risk. Fixed with in-place array mutation and a `useMemo`.
3. **Redundant chat-history re-requests on thread switch** — the mount-time history-load dedup lived
   in a component-local ref, which reset on every remount; since `MainContent` (correctly) keys
   `ChatView` per thread, switching back to a thread with `hasMoreOlder: true` re-requested a page of
   already-loaded history every time, amplifying load against the server's chat-history rate limit.
   Fixed by checking `state.chatThreads.has(key)` (owned by `use-voice-channel.ts`, outliving the
   component's own remounts) instead of a local ref.
4. **One unpinned dependency range** — `@testing-library/dom` was added as `^10.4.1`; every other
   dependency this task introduced is exact-pinned. Corrected to `10.4.1`.

All four were fixed and re-verified (typecheck, lint, the full Vitest suite, and — for the two
UI-visible fixes — a fresh real-Electron screenshot). `corepack pnpm audit --audit-level high` remains
exactly the one pre-existing allowlisted advisory; no new findings from any dependency this task added.

## T13.1.1 — visual polish and UX refinement

A direct visual review of T13.1's own final screenshots (not just its handoff report) found real
finish gaps beyond what T13.1's Definition of Done required: Home under-used available desktop space,
typography/control scale felt undersized at 1920×1080, Settings was visually far behind the main
workspace, Channel rows had too many permanently-visible competing actions, and the Member Panel
repeated its own heading. T13.1.1 is a Renderer-only refinement pass over T13.1's architecture — no
new capability, no protocol/IPC/persistence change, no T13.2+ functionality.

**Settings — full information-architecture redesign.** `SettingsPanel.tsx` moved from one
long vertically-scrolling column to a sidebar-navigation layout (Profile / Voice & Video /
Screen Share / Advanced) inside a new, larger `ui/Modal` `size="xlarge"` variant (920×640) — a real
desktop-scale settings surface, each section independently scrollable. "User & Identity" was renamed
"Profile" and now holds only the "Voice display name" field; `IdentityPanel` (Nickname, Identity ID,
Regenerate Identity) moved entirely into Advanced, with Regenerate Identity now in its own
visually-separated, red-tinted "Danger zone" subsection — the existing `window.confirm` warning is
unchanged. Native `<select>`/`<input>` elements are now visually styled and stacked (label above
control, never a cramped single line); the camera-off state uses `ui/EmptyState` inside a bounded
aspect-ratio box instead of plain text; the mic-level meter is a styled bar fed by the same real
`useMicLevelMeter` data.

**Home — bounded composition with real presence.** `ServerHome.tsx` gained a bounded, centered content
container, a nickname/profile row (avatar-fallback + nickname + a "Profile & Settings" link opening a
`Modal`-wrapped `IdentityPanel` — never the identityId directly on Home), and larger server-avatar
tiles (`ui/Avatar`'s `large` size raised 64→80px) with matching Add-Server-tile sizing.

**Channel rows — hover-revealed secondary actions.** The chat-open icon and Join/Leave control are now
CSS-`opacity`-hidden by default (never `display:none`/`disabled` — still in the tab order and reachable
via `:focus-within`), revealed on hover/focus, or forced visible via a `.actionsVisible` class when a
row `isJoined || isSelected` (ambient state worth always showing, unlike a hover-only affordance). The
leading per-row icon (`Volume2` when joined, `MessageSquare` otherwise, inside the always-visible
`selectButton`) is never hover-gated — it is the row's persistent "this is a channel, chat is
available" signal. No handler, testid, or the underlying single-click-never-joins-voice behavior
changed; `tests/desktop/components/channel-row.test.tsx` passed unmodified against the restyle.

**Member Panel — duplicate heading removed.** The fallback single-group rendering path previously
built one group literally labeled `'Members'` and rendered its own `"{label} — {count}"` immediately
below the panel's own `"Members — {count}"` header — a pure, real duplication. Fixed by suppressing
the group-label row specifically for that one-group fallback case; a real, distinctly-labeled `groups`
prop (future T13.3 role grouping) still renders each group's own label and count.

**Chat — a dev-only fixture and real message-density polish.** `workspace/chat-dev-fixture.ts` provides
representative fixture messages (consecutive-sender grouping, a long wrapping message, Unicode/emoji,
multiple senders), toggled by typing `/fixture` into the composer, gated by `import.meta.env.DEV` — a
Vite compile-time constant that is `false` for any `vite build` output, so the entire toggle branch is
dead code eliminated from a packaged build; this needed no new Main/Preload/IPC surface at all, unlike
the codebase's existing `!app.isPackaged`-plus-env-var E2E convention. **Empirically confirmed, not
just reasoned:** this session ran the exact command against a real `electron-forge package` build and
observed `/fixture` fall through to a real `sendChatMessage('channel', 'games', '/fixture')` call,
which the server correctly rejected ("Must be in this voice channel to send chat there") since the
composing client was not actually joined to that channel's voice — proof the fixture path is genuinely
unreachable in a packaged artifact, not merely theorized. The final required screenshot evidence
(message density/grouping/wrapping) was produced with real messages sent through the real production
composer/`sendChatMessage` action instead of the fixture, avoiding any fixture-related risk in the
evidence itself.

**Design tokens.** Typography scale increased (`--ovni-text-lg/xl/2xl`, new `--ovni-text-3xl` for the
Home brand heading only) and panel widths tuned — token edits, not per-component overrides. Icon-button
hit targets grew slightly (28→32px for `small`); active/danger states on `IconButton` now carry an
always-on background tint rather than only a hover/color change.

See [`tasks/T13_1_1_VISUAL_POLISH.md`](../tasks/T13_1_1_VISUAL_POLISH.md) for the full evidence record
(screenshots, security/QA review findings, regression results).

## T13.2.1 — administration UX polish

T13.2's own handoff notes recorded, as an accepted out-of-scope rough edge, that the reused T9 Groups
& Permissions panel rendered raw `PermissionKey` strings (e.g. `chat.channel.send,
voice.channel.join`) rather than human-readable labels. T13.2.1 is the follow-up: a new, pure
presentation module, `apps/desktop/src/renderer/voice/permission-presentation.ts`, maps every current
`PermissionKey` to a human-readable label, an optional one-line description, and one of four
categories (Voice & Chat / Channels / Moderation / Server Management) — completeness enforced both by
a `Record<PermissionKey, ...>` literal's own type-checking and a dedicated runtime test enumerating
the real registry. `GroupsSection.tsx` now renders each group's permissions as a categorized,
human-readable summary (a "Full server administration" special case for a group holding literally
every permission, computed by real comparison against the registry, not a hardcoded group id), and the
Create Group form's checkbox grid is grouped under the same category headings — the wire value sent to
`createGroup`/`updateGroup` is unchanged.

A second, independently-found issue was fixed in the same task: `ChannelAclEditor.tsx` is shared
unchanged between `ChannelModal.tsx` (voice channels) and `CategoryModal.tsx` (categories), and
hardcoded channel-specific legends ("Who can join this channel?") for both, even though a category is
never joinable itself — its "Join" axis is really the default a descendant channel inherits.
`ChannelAclEditor` now takes a required `kind: NodeKind` prop branching the three axis legends
accordingly, with a helper note under the category Join axis clarifying the inheritance relationship.
The "Same as parent" inherit option's caveat ("no parent" case) was also split into a short primary
label plus a muted secondary note, verified truthful against `channel-port.ts`'s own ACL-resolution
doc comment rather than guessed. See
[`tasks/T13_2_1_ADMIN_UX_POLISH.md`](../tasks/T13_2_1_ADMIN_UX_POLISH.md) for the full record.

## T13.3 — profiles, avatars, members, presence

T13.1's `Avatar` primitive shipped with a prepared-but-dormant `imageUrl` prop, and `MemberPanel`/
`MemberRow`/`ParticipantRow` shipped with prepared-but-empty `groups`/badge/status slots — all
explicitly reserved for this task rather than built speculatively. T13.3 fills them with real data:
`UserAvatar`/`ServerAvatar` (new, thin wrappers over `Avatar`) resolve a real `AvatarRef` to a
cached `data:` URI; `MemberPanel` widens from "in this voice channel" to "connected to this server
at all," sourced from `server:presence-snapshot`/`-updated`/`-removed`, grouped into "Admins"/
"Moderators"/"Members" by the server-derived `roleBucket` enum (never a client-side guess, never a
raw ACL group name). Three new components — `ProfileEditor` (self avatar/status/presence),
`MemberProfilePopover` (read-mostly, zero DM/friend affordance), and `ServerProfileSection` (server
avatar admin control, hidden entirely without `server.manage`) — all reuse the T13.1/T13.1.1 design
system (`ChannelAdminForm.module.css`'s form/section/footer classes) rather than introducing a
parallel style. See
[`SERVER_LOCAL_PROFILES_AND_PRESENCE.md`](SERVER_LOCAL_PROFILES_AND_PRESENCE.md) and
[`tasks/T13_3_PROFILES_AVATARS_PRESENCE.md`](../tasks/T13_3_PROFILES_AVATARS_PRESENCE.md) for the
full record.

## What T13.1 deliberately does not do

Channel create/edit/delete/hierarchy and richer server admin UX (T13.2); real server/user avatar
upload or storage, member directory/presence, online/away/DND, custom status (T13.3 — now
implemented, see above); push-to-talk, voice-activity UX, speaking indicator, per-user volume, local
participant mute, join/leave sounds (T13.4); Discord-like stream viewing/focus, camera layout,
detached stream window/PiP, final call UX integration (T13.5). `Avatar`'s fallback remains
deterministic initials for any target with no avatar set — upload/storage/backend now exist (T13.3),
scoped entirely server-local per Dedicated Server.
