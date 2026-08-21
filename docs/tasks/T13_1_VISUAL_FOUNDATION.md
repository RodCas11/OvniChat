# T13.1 — OvniChat visual foundation & main application layout

## Goal

Transform OvniChat's current bare, unstyled, functional engineering Renderer UI into the visual and
interaction foundation of the actual product: a dark, modern, Discord-familiar desktop layout (server
rail, channel sidebar, chat, member panel, persistent bottom controls) with OvniChat green used
sparingly as an accent, while preserving every existing T0-T12 capability unchanged (voice, camera,
screen share, system/process audio, chat persistence, authorization, settings, reconnect, bookmarks).
This is presentation and component-organization work only — no protocol, IPC, hook-logic, or
persistence change.

## Context

T0-T12 built a fully functional but visually undeveloped desktop client: zero CSS files exist
anywhere in `apps/desktop/src/renderer/`, no design tokens, no icon library, no component library, no
router — a single `App.tsx` does sequential conditional rendering between a bare `ConnectionScreen`
and a monolithic `VoiceChannelView.tsx` whose controls are plain text-label `<button>`s with no
styling. T13 was redefined, by explicit product direction, from a single "self-hosting production
package" task into a five-part Product Experience series (T13.1-T13.5, see
[`STATUS.md`](STATUS.md) for the full renumbering, including production self-hosting moving to T14)
covering the visual foundation first, then channel/server administration, profiles/presence, the
gamer voice experience, and stream/camera integration, in that order. T13.1 is the first of these:
every later T13.x feature needs an obvious, consistent place to live in the interface, which does not
exist today.

## In scope

- A from-scratch design-token system (colors, spacing, typography, radius, elevation, z-index,
  transitions) and a small set of reusable UI primitives (button, icon button, tooltip, modal, context
  menu, toast, empty state, avatar).
- A Home/server-picker screen built around minimal local server-bookmark icons (no DM/feed/discovery
  concepts) with an integrated Add Server flow reusing the existing bookmark IPC/address parser.
- A connected-workspace layout: server rail (local bookmarks, real disconnect-then-reconnect
  switching), channel sidebar (authoritative channel/participant data, Server Chat entry), a
  redesigned chat view (Discord-style message grouping, same T10 persistence/pagination semantics),
  a collapsible member panel, and a persistent bottom user-control bar wired to the existing
  mute/deafen/camera/screen-share/settings actions.
- Removing stale user-visible "Disco Voador" product-facing strings discovered during the redesign
  (the internal `@disco-voador/*` package namespace is explicitly not renamed).
- Component-level tests (this repository's first — `@testing-library/react` + `jsdom`, scoped via a
  per-file Vitest environment pragma) plus a real-Electron product-shell smoke E2E and stable
  `data-testid` hooks for it.

## Out of scope (explicitly deferred to later T13.x tasks)

- Channel create/edit/delete/hierarchy, subchannels, temporary channels, channel passwords/ACLs, new
  permission semantics, richer server admin UX (T13.2).
- Real server/user avatar upload or storage, member directory/presence, online/away/DND, custom status
  (T13.3).
- Push-to-talk, voice-activity UX, speaking indicator, per-user volume, local participant mute,
  join/leave sounds (T13.4).
- Discord-like stream viewing/focus, camera layout, detached stream window/PiP, final call UX
  integration (T13.5).
- Anything under T14+ (production self-hosting, installer/releases, private beta polish, SFU,
  hardening).

## Architecture constraints

- Entirely inside `apps/desktop/src/renderer/` — no Main/Preload/protocol/RTC/media-boundary change,
  no new IPC channel, no new persistence. `use-voice-channel.ts`'s state/action contract is consumed
  as-is, never duplicated or re-implemented in a visual component.
- The single-active-connection architecture is preserved: a server rail that lets a user click between
  local bookmarks uses the existing `disconnect()`/`connectTo()` lifecycle already proven safe by T8/
  T11's reconnect design — never a simultaneous multi-server connection model.
- E2E scripts assert on `console.info` stdout markers, not DOM structure — the redesign must never
  remove or rename an existing marker string, and the underlying hook logic that decides when a marker
  fires must not change.
- No fabricated data: participants/channels/authorization render only what the current protocol
  actually exposes (no speaking indicator, no per-remote-participant mute/camera flag beyond what can
  be honestly derived from existing stream maps, no single "role" field beyond the real `groups`
  array, no channel categories/nesting). Component APIs may be _shaped_ for future T13.2/T13.3 data
  without inventing placeholder values now.
- Technical/debug internals (identity fingerprint, ICE/SDP/mid/participantId, WebSocket state, TURN
  addresses, PCM format, Windows PID, native-helper protocol) move out of the normal product flow into
  an explicit Advanced/Diagnostics area if currently shown prominently; nothing safe and useful is
  deleted outright.

## Relevant packages

`apps/desktop` only (Renderer: new `styles/`, `ui/`, `shell/`, `workspace/` trees; `voice/` mostly
untouched — hook logic and `SettingsPanel.tsx`/`AuthorizationPanel.tsx`/`ScreenSourcePicker.tsx` logic
unchanged, restyled in place). No other workspace package is touched.

## Relevant agents

`electron-desktop-engineer` (primary implementer), `software-architect` (consulted before
implementation for the file/component architecture and a real remount-state-leak risk in the
server-switching design — see Handoff notes), `qa-engineer` and `security-reviewer` (final gates).

## Relevant skills

`project-orientation`, `planning-feature`, `electron-development`, `testing-quality`,
`security-review`.

## Acceptance criteria

See [`docs/DEFINITION_OF_DONE.md`](../DEFINITION_OF_DONE.md) and the exhaustive T13.1 checklist the
task's own brief specified — summarized in the Handoff notes below with each item's actual evidence.
There is no single non-negotiable technical proof the way T12 had one; acceptance is the accumulated
checklist (coherent visual identity, correct interaction rules — one click views channel chat and
never auto-joins voice, joined-voice state is visually distinct from selected-for-viewing state — all
existing functionality/E2Es intact, security and QA review passed).

## Definition of Done

Complete only when every applicable item in `docs/DEFINITION_OF_DONE.md` and the task's own checklist
is satisfied with real evidence — real screenshots from an actual Electron instance, actually visually
reviewed (not just "it renders"), the full existing E2E suite re-passing unchanged, a real packaged
build, security and QA review findings addressed, and documentation reflecting the actual final UI.
Otherwise: IN PROGRESS.

## Handoff notes

### What is real and verified

- **Design system**: `styles/tokens.css` (colors, spacing, radius, typography, shadow, z-index,
  transitions — all `--ovni-*` custom properties) and `styles/global.css` (resets only), consumed by
  every new component via CSS Modules. A single sparing green accent; no `backdrop-filter` anywhere;
  `prefers-reduced-motion` respected.
- **`ui/` primitives**: Button, IconButton, Tooltip, Modal, ContextMenu, Toast/ToastProvider,
  EmptyState, Avatar (deterministic initials/color, no `Math.random()`).
- **`shell/`**: AppShell (connected-workspace root, remount-key fix), ServerRail, ServerHome,
  AddServerDialog (reused for edit).
- **`workspace/`**: ChannelSidebar, ChannelRow, ParticipantRow, MainContent, ChatView (renamed from
  `voice/ChatPanel.tsx`, hooks unchanged), MemberPanel, MemberRow, UserControlBar.
- **Restyled in place, logic unchanged**: `voice/SettingsPanel.tsx` (User & Identity / Voice & Video /
  Advanced), `voice/AuthorizationPanel.tsx`, `voice/ScreenSourcePicker.tsx`.
- **Click-never-joins-voice rule**: implemented via a local `ChatTarget` selection state independent
  of `state.currentChannelId`; proven by a component test, a real E2E event-ordering assertion, and a
  chat header that never uses a bare `#`.
- **Self appears in member/participant lists**: fixed by synthesizing a real self entry
  (`participantsWithSelf` in `VoiceChannelView.tsx`) from data already owned for real — found and
  fixed during this task's own visual screenshot review, not anticipated in the original
  implementation pass.
- **Server-switching remount-key fix**: `AppShell` keyed on `${connection.config.url}#{sequence}`;
  proven by a component test and two distinct real `VoiceChannelView` mount markers in
  `e2e:product-shell-smoke`. A second instance of the same bug class (`ChatView` unmounted-on-switch
  leaking composer drafts) was found and fixed the same way.
- **Settings Advanced/Diagnostics boundary**: Identity ID and "Regenerate Identity" relocated from
  "User & Identity" into "Advanced" after a screenshot review showed them violating the task's own
  "must not be prominent" requirement.
- **Admin/moderation visibility**: the pre-existing `can(permission)` real-conditional-rendering
  pattern preserved in the restyled `AuthorizationPanel.tsx`/`ChatView.tsx`.
- **No fabricated data**: confirmed by a case-insensitive `mock|demo|fixture|placeholder` grep across
  the Renderer (security review) finding none, and by component API shapes (`MemberPanel.groups`,
  empty status/role slots) prepared for future data without inventing values now.
- **Tests**: 12 new component-test files (62 tests) under `tests/desktop/components/` plus a 13th
  (`add-server-dialog.test.tsx`, 4 tests) added during the security-fix pass — 1085 total Vitest
  tests, all passing. `data-testid` attributes added additively.
- **New E2E**: `apps/desktop/scripts/e2e-product-shell-smoke.mjs` — fresh profile, nickname, two
  bookmarks, Home, connect, select-without-join, real Join, Settings open/close, real
  disconnect→connect switch to a second server with a verified fresh mount, clean return to Home with
  bookmarks intact. Passed on every run performed (including after every subsequent fix).
- **Full regression**: all twelve pre-existing E2E scripts (`e2e:voice-smoke`, `e2e:camera-smoke`,
  `e2e:screen-smoke`, `e2e:screen-audio-smoke`, `e2e:process-audio-smoke`, `e2e:identity-auth`,
  `e2e:identity-persistence`, `e2e:connection-smoke`, `e2e:authorization`,
  `e2e:text-chat-persistence`, `e2e:settings-persistence`, `e2e:reconnect-smoke`) re-run against the
  final, security-fixed, repackaged build — no regression.
- **Screenshots**: five real screenshots from an actual packaged Electron instance (Home 1920×1080,
  connected workspace 1920×1080 and 1366×768, Settings, collapsed-member-panel) captured and
  personally visually reviewed twice — the first review surfaced the self-participant and
  Settings-prominence defects above; the second, post-fix review confirmed both resolved.
- **Repository checks**: `npx tsc --noEmit -p tsconfig.typecheck.json`, `npx eslint .`,
  `npx prettier --check .`, `node scripts/verify-secrets.mjs`, `node scripts/verify-repository.mjs`,
  `node scripts/verify-architecture.mjs`, and `corepack pnpm audit --audit-level high` (one
  pre-existing allowlisted advisory, no new findings) all clean. `electron-forge package` and
  `pnpm --filter @disco-voador/dedicated-server run build` both succeeded.

### Security and QA review

**Security review** (`security-reviewer`, full 17-item checklist against the actual diff): no
high/medium findings. Four low-severity findings, all fixed and re-verified in this task:

1. Stale `AddServerDialog` form state across openings (an abandoned Add-mode draft could reappear in
   a later Edit-mode opening and silently repoint an unrelated bookmark) — fixed with a guarded
   closed→open resync effect.
2. Quadratic, unmemoized Discord-style chat-message grouping in `ChatView` — a Renderer-side
   responsiveness risk against a long, unbounded, server-controlled thread — fixed with in-place
   array mutation and `useMemo`.
3. Redundant chat-history re-requests on every thread switch (a component-local dedup ref reset on
   each remount) — a self-inflicted amplifier against the server's chat-history rate limit — fixed by
   checking `state.chatThreads.has(key)` (hook-owned, outliving the remount) instead.
4. One unpinned dependency range (`@testing-library/dom: ^10.4.1`) — pinned to the exact locked
   version, `10.4.1`.

Positive controls the review independently confirmed by reading the actual code (not doc-trust):
Renderer sandbox boundaries untouched; CSP unmodified and sufficient; no `dangerouslySetInnerHTML`
anywhere in the redesign; bookmarks structurally cannot hold a token even from a compromised
Renderer; admin gating is real conditional rendering; server-switching cannot produce two live
connections; no new remote endpoint/telemetry/CDN; no fabricated data path reachable in a packaged
build; screen/camera consent UI unchanged.

**QA review** (`qa-engineer`, building the test/E2E layer): wrote this repository's first Renderer
component-test suite (62 tests, 12 files) plus `e2e:product-shell-smoke`, and found and fixed one
further real bug during that work — `MainContent` rendered `ChatView` with no `key`, so switching the
selected chat target reused the same instance and could leak an unsent composer draft into the
newly-selected thread (fixed by keying on `chatThreadKey`). All twelve pre-existing E2E scripts
re-verified passing, including two consecutive runs of the new `e2e:product-shell-smoke` and the full
`e2e:process-audio-smoke` multi-scenario suite (dual-direction isolation, mic-mute lifecycle,
target-exit cleanup) against the final build.

**This task's own visual-review pass** (performed directly against real screenshots, after both
formal reviews above) found two further real defects invisible to any automated test: the local user
never appearing in their own member/participant lists, and the cryptographic Identity ID/"Regenerate
Identity" action being prominent in the main Settings flow rather than in Advanced. Both fixed and
re-verified with a fresh screenshot capture showing the corrected behavior.

### Privacy confirmation

- No central account, no DM system, no server discovery, no cloud bookmark sync, no new analytics, no
  mandatory OvniChat-operated service — unchanged from every prior task; T13.1 is presentation only.

### Next task

**T13.2 — Channels & Server Administration** (categories, subchannels, temporary channels, channel
create/edit/delete, channel access policies, richer server admin UX). Not implemented as part of
T13.1.
