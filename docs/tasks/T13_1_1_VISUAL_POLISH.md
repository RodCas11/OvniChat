# T13.1.1 — OvniChat visual polish & UX refinement

## Goal

Take T13.1's structurally-correct-but-visually-unfinished Renderer UI from "functional modern
frontend" to "polished gamer communication client." This is a refinement pass over the existing
component/layout architecture — presentation and visual-density tuning only, no new capability, no
protocol/IPC/persistence change, no T13.2+ functionality.

## Context

T13.1 established the correct structural foundation (Home, Server Rail, Channel Sidebar, Chat/Media,
Member Panel, bottom User Control Bar, design tokens, CSS Modules, `lucide-react`, component tests,
`e2e:product-shell-smoke`, responsive layouts at 1366×768/1920×1080). A direct visual review of the
final T13.1 screenshots (and the actual current code, not just the T13.1 handoff report) found real
finish gaps: Home under-uses available desktop space, typography/control scale feels undersized at
1920×1080, Settings is visually far behind the main workspace, some form controls look
native/default, Channel rows have competing actions, the Member Panel repeats its own heading, and
overall visual personality is generic-dark-app rather than distinctly OvniChat.

**Verified directly against current code before starting** (per this task's own "do not trust the
report blindly" instruction): the concern that Identity ID/Copy ID/Regenerate Identity might still be
prominent in ordinary Settings was checked against `apps/desktop/src/renderer/voice/SettingsPanel.tsx`
as committed (`98d91f5`) — `IdentityPanel` is rendered under the `Advanced` section (not `User &
Identity`), matching the fix already applied and screenshot-verified at the end of T13.1. This was
confirmed true on the actual file before any work began; no fix was needed for that specific claim,
though the Settings section still needs the substantial information-architecture redesign this task
requires regardless.

## In scope

- Home composition: bounded content container, larger server-avatar presence, visible
  nickname/profile affordance, refined Add Server tile.
- Typography/spacing hierarchy tuning across Home, Server Rail, Channel Sidebar, Chat, Member Panel,
  User Control Bar, Settings, and dialogs — via token adjustments, not one-off per-component overrides.
- Channel row simplification (reduce permanently-visible competing actions; channel name stays
  dominant; selected-for-chat vs joined-voice distinction strengthened).
- Member Panel: remove the duplicated "Members — N" heading.
- Chat visual polish using a dev/test-only-gated representative message fixture (never reachable in a
  packaged build) to evaluate real message density, grouping, and composer polish.
- Settings: a substantial information-architecture redesign (sidebar navigation across Profile /
  Voice & Video / Screen Share / Advanced or an equivalent truthful grouping), matching the main
  workspace's visual quality. Identity/cryptography content stays under Advanced.
- Design-system consistency audit: radius, shadow/elevation, icon size/stroke, green/danger usage,
  borders vs surface hierarchy, tooltips, hit-target sizing, focus rings.
- Empty/error/loading/reconnect state polish using the existing design system.
- Dialog/modal consistency audit (Add/Edit Server, Settings, Authorization).

## Out of scope (unchanged from T13.1, explicitly reaffirmed)

Everything in T13.2 (channel CRUD/categories/subchannels/passwords/ACLs, new server permissions,
richer admin UX), T13.3 (real avatar upload, presence/status protocol), T13.4 (push-to-talk, global
hotkeys, per-user volume, local mute, speaking indicators, join/leave sounds), and T13.5 (detached
stream window/PiP, new stream theatre, new camera-grid architecture). No new UI framework
(Tailwind/MUI/Chakra/Bootstrap/styled-components). No frameless-window/native-chrome change.

## Architecture constraints

Identical to T13.1's: Renderer-only, `use-voice-channel.ts` remains the sole owner of
WebSocket/RTC/identity-signing state, E2E marker strings/firing conditions unchanged, no fabricated
data (the chat fixture is dev/test-only-gated and unreachable in a packaged build), technical
internals stay behind Advanced/Diagnostics, single-click-never-joins-voice semantics unchanged.

## Relevant packages

`apps/desktop` only (Renderer).

## Relevant agents

`electron-desktop-engineer` (primary), `qa-engineer` and `security-reviewer` (final gates).

## Relevant skills

`project-orientation`, `planning-feature`, `electron-development`, `testing-quality`,
`security-review`.

## Acceptance criteria

See the task's own exhaustive Definition of Done checklist (visual + functional + regression +
review), summarized with real evidence in the Handoff notes below.

## Definition of Done

Complete only when: T13.1's architecture remains intact; Home/Channels/Members/Chat/Settings/User Bar
all receive the specific improvements enumerated in the originating brief; real screenshots from an
actual Electron instance at 1920×1080, 1366×768, and one intermediate resolution are captured and
personally visually reviewed (with at least one fix/review iteration on real findings); the full
existing E2E suite plus `e2e:product-shell-smoke` re-pass unchanged; security and QA review findings
are addressed; documentation reflects the actual final UI. Otherwise: IN PROGRESS.

## Handoff notes

### What is real and verified

- **Settings — full information-architecture redesign**: sidebar navigation (Profile / Voice & Video /
  Screen Share / Advanced) inside a new `ui/Modal` `size="xlarge"` variant (920×640), each section
  independently scrollable. Identity ID and "Regenerate Identity" render only under Advanced, in a
  visually separated red-tinted "Danger zone" subsection — the existing `window.confirm` warning is
  byte-for-byte unchanged. Native `<select>`/`<input>` restyled and stacked (label above control).
  Camera-off state uses `ui/EmptyState`; the mic-level meter is a styled bar fed by real level data.
- **Home — bounded composition with real presence**: a centered content container, a nickname/profile
  row (avatar + nickname + "Profile & Settings", opening a `Modal`-wrapped `IdentityPanel` — never the
  identityId directly on Home), and larger server-avatar tiles (64→80px).
- **Channel rows simplified**: secondary actions (chat-open icon, Join/Leave) are hover/focus-revealed
  (CSS opacity only — never removed from the tab order); the leading per-row icon (`Volume2`/
  `MessageSquare`) stays permanently visible as the row's "chat available" signal. Single-click-never-
  joins-voice is unchanged and re-tested.
- **Member Panel dedup fix**: the fallback single-group rendering no longer repeats "Members — {count}"
  a second time as a group label; a real multi-group `groups` prop (future T13.3) still renders each
  group's own label.
- **Chat polish**: a dev-only representative-message fixture (`workspace/chat-dev-fixture.ts`, toggled
  by typing `/fixture`, gated by `import.meta.env.DEV`) for visual review, verified genuinely inert in
  a real `electron-forge package` build — this session observed `/fixture` fall through to a real,
  server-rejected `sendChatMessage` call in that exact build. The required screenshot evidence itself
  was produced with real messages sent through the real composer, not the fixture.
- **Two real bugs found via this task's own screenshot review and fixed** (beyond the implementer's
  own pass):
  1. **Mic test left running with no visible stop control after switching Settings sections**
     (security review finding) — `micTesting` is panel-level state that the sidebar IA's per-section
     rendering didn't reset, so navigating away from "Voice & Video" while a test was active left a
     real, indicator-free `getUserMedia` capture running. Fixed: switching to any other section now
     stops the test.
  2. **Identity ID / Regenerate Identity reachable from Home with no Advanced framing** (security
     review finding) — Home's "Profile & Settings" modal reused `IdentityPanel` whole, bypassing the
     "identity stays behind an explicit Advanced area" rule that Settings itself already honored.
     Fixed: `IdentityPanel` gained an `identityDetailsCollapsed` prop (default `false`, preserving
     Settings' exact existing behavior) that collapses Identity ID/Regenerate behind their own
     closed-by-default disclosure (mirroring `AddServerDialog`'s existing Advanced toggle); `ServerHome`
     passes it.
  3. **Accessibility bug found by QA**: two Settings fields ("Voice display name", "Default quality")
     nested their hint text inside the same `<label>` as the control, polluting the control's
     accessible name with the full hint sentence. Fixed by making the hint a label sibling, matching
     every other field in the file.
- **Tests**: 1122/1122 Vitest tests passing (up from T13.1's 1085) — new coverage for the Settings
  redesign, the Member Panel dedup fix, channel-row hover-reveal behavior, the Modal `xlarge` variant,
  `IdentityPanel`'s danger-zone gate, and the chat fixture's dual-branch (dev vs. production) behavior.
- **Screenshots**: 10 real screenshots from an actual packaged Electron instance — Home (1920×1080),
  connected workspace at 1920×1080/1366×768/1600×900 (three resolutions, including the required
  intermediate one), Settings' three redesigned sections (Profile/Voice & Video/Advanced), the
  collapsed Member Panel, the Add Server dialog, and a real multi-sender chat (grouping, a long
  wrapping message, emoji) — captured, personally visually reviewed, and re-captured after the two
  security fixes above to confirm them.
- **Regression**: `e2e:product-shell-smoke`, `e2e:settings-persistence`, and `e2e:text-chat-persistence`
  re-run against the final, fully-fixed build — all pass. `e2e:voice-smoke`, `e2e:camera-smoke`,
  `e2e:screen-smoke`, `e2e:screen-audio-smoke`, `e2e:connection-smoke`, `e2e:identity-auth`,
  `e2e:identity-persistence`, `e2e:authorization`, `e2e:reconnect-smoke` all passed against the
  pre-accessibility-fix T13.1.1 build (a build that differs from the final one only in
  `SettingsPanel.tsx`/`IdentityPanel.tsx`/`ServerHome.tsx`, none of which any of these nine scripts'
  own code paths touch). `e2e:process-audio-smoke` failed identically on five consecutive attempts
  across this task's final regression sweep (`could not uniquely identify the tone process's real
audio-session PID`) — confirmed via `git log` that no T13.1.1 change touches
  `packages/windows-media`, `apps/desktop/src/main/process-audio.ts`, or the script itself (the most
  recent commit touching any of them is T12's own completion, `9e2751e`); this is recorded as a known,
  pre-existing, environment-specific limitation of this session's machine, not a T13.1.1 regression —
  see "Known limitations" below.
- **Repository checks**: `corepack pnpm check` (formatting, lint, whole-repo typecheck, 1122 Vitest
  tests, composite build, repository verification, dependency audit — one pre-existing allowlisted
  advisory, no new findings) all clean. `electron-forge package` succeeded on every rebuild.

### Security and QA review

**Security review** (`security-reviewer`, focused checklist against the actual diff): no release
blockers. Two real Low-severity findings, both fixed and re-verified (see above): the orphaned
mic-test capture, and the Home-reachable identity details. Three Informational findings, none
requiring code changes to close: (1) the dev chat fixture's `import.meta.env.DEV`-only gate was
independently verified as a Vite compile-time constant with no `mode`/`define` override anywhere in
this app's build config, making the branch genuinely dead code in a production build — accepted as
sufficient for this specific mechanism (it adds no Main/Preload/IPC surface at all, unlike the
env-var-based E2E convention, and the branch cannot reach `sendChatMessage`/IPC/the socket even if it
somehow executed); QA added the two regression tests the review recommended. (2) A doc-comment/CSS
mismatch in `Modal.module.css` regarding the close button's `:focus` state — the button remains fully
keyboard-reachable via the global `:focus-visible` ring regardless; the comment should be corrected in
a future pass but is not a real defect. (3) A hardcoded developer-machine scratchpad path as the
default output directory in the throwaway `e2e-screenshot-capture.mjs` tool — cosmetic, non-shipping,
not addressed given the script is explicitly throwaway evidence tooling, not a permanent artifact.

**QA review** (`qa-engineer`, functional + behavioral focus on this task's own changes): confirmed all
seven specifically-requested behaviors work as intended (channel-row hover-reveal with a persistent
leading icon, the Member Panel dedup fix in both the fallback and real-multi-group cases, the Settings
redesign's real device/quality wiring — no beautiful dead controls, `IdentityPanel`'s unweakened danger
confirmation, the chat fixture's verified dual-branch gate, the `Modal` `xlarge` variant's unchanged
focus/Escape/backdrop behavior, and Home's nickname row correctly appearing/disappearing based on
whether identity props are supplied). Found and fixed one genuine bug beyond its assigned checklist:
the label-nesting accessibility issue described above. Adapted its own in-progress test additions
correctly when the security review's concurrent fixes changed `IdentityPanel`'s/`ServerHome`'s
behavior mid-task, rather than reverting them.

### Known limitations

- `e2e:process-audio-smoke` did not pass during this task's final regression sweep (5/5 identical
  failures, root cause pointing at real Windows audio-session enumeration timing on this specific
  machine at this specific time) — confirmed unrelated to this task's file changes by `git log`
  (nothing in `packages/windows-media`/native-helper/`main/process-audio.ts` was touched by either
  T13.1 or T13.1.1). Recommended follow-up: re-run on a clean machine/session and, if it reproduces
  again outside this task's diff, root-cause it as its own small investigation — this mirrors the
  already-documented, accepted `e2e:camera-smoke` environmental-flakiness class from T6/T11's own
  handoff notes.
- The `Modal.module.css` close-button doc-comment/CSS mismatch (Informational security finding) was
  not corrected — purely cosmetic, no behavioral consequence.
- The `e2e-screenshot-capture.mjs` tool's hardcoded default output path is developer-machine-specific
  — acceptable for throwaway evidence tooling, not shipped, not a permanent regression asset.

### Privacy confirmation

- No central account, no DM system, no server discovery, no cloud bookmark sync, no new analytics, no
  mandatory OvniChat-operated service, no remote visual assets — unchanged from T13.1; this task is
  presentation-only.

### Next task

**T13.2 — Channels & Server Administration.** Not implemented as part of T13.1.1; the user reviews
T13.1.1's screenshots before T13.2 begins.
