# ADR 0018: Renderer UI foundation — CSS Modules, design tokens, and shell/workspace/ui layering

## Status

Accepted and implemented (T13.1).

## Context

T0-T12 built a fully functional Renderer with zero CSS files, no design tokens, no icon library, no
component library, and a single monolithic `VoiceChannelView.tsx`. T13 was redefined into a five-part
Product Experience series (T13.1-T13.5); T13.1 is the visual/interaction foundation every later part
depends on having a consistent place to live in. A `software-architect` review was conducted before
implementation to decide the styling mechanism, icon library, testing approach, and component/file
architecture, and separately flagged a real correctness risk in the server-switching design (see
"Consequences" below).

## Decision

**Styling: CSS Modules**, using Vite's built-in `*.module.css` support — zero new runtime dependency,
scoped class names, no CSP change (`style-src 'self' 'unsafe-inline'` already covers both dev-mode
injected `<style>` and the production `<link rel="stylesheet">`). Rejected alternatives: a full UI
framework (unjustified weight for this app's scope, and this project's own guidance is to avoid one
unless clearly justified) and CSS-in-JS (extra runtime dependency and bundle cost with no benefit CSS
Modules doesn't already provide here). Design tokens (`styles/tokens.css`) are `--ovni-*` custom
properties on `:root` — colors, spacing, radius, typography, shadow, z-index, and transition values —
consumed by every component's own `.module.css`, never hand-picked literals. Elevation is shadow-only
by deliberate constraint (no `backdrop-filter` anywhere), to protect the GPU/CPU budget real-time
WebRTC media needs.

**Icon library: `lucide-react`**, pinned to an exact version — tree-shakeable inline SVG React
components, no runtime CSS, no font/CDN fetch, MIT-licensed, and categorically distinct from Discord's
own proprietary iconography. The one and only icon mechanism in the redesigned Renderer; no emoji, ad
hoc SVG, or second icon library.

**Component layering**: `ui/` (generic primitives — Button, IconButton, Tooltip, Modal, ContextMenu,
Toast, EmptyState, Avatar — with zero application-domain imports), `shell/` (AppShell, ServerRail,
ServerHome, AddServerDialog — the disconnected/server-picker and connected-workspace-root layer), and
`workspace/` (ChannelSidebar, ChannelRow, ParticipantRow, MainContent, ChatView, MemberPanel, MemberRow,
UserControlBar — the connected-workspace content layer). `voice/use-voice-channel.ts` remains the sole
owner of WebSocket/RTC/identity-signing/native-process-audio/chat-persistence state; `shell/` and
`workspace/` consume its state/actions as props, never duplicating or reimplementing any part of that
contract. `voice/ChatPanel.tsx` was renamed to `workspace/ChatView.tsx` (hooks/effects/handlers
unchanged) rather than kept in `voice/`, since it is workspace-layout presentation, not voice-hook
logic; `voice/SettingsPanel.tsx`, `voice/AuthorizationPanel.tsx`, and `voice/ScreenSourcePicker.tsx`
were restyled in place rather than relocated, since their logic remains voice-domain-specific enough
to stay beside `use-voice-channel.ts`.

**Testing**: `@testing-library/react`/`@testing-library/jest-dom`/`jsdom` added as **root-level**
devDependencies (not `apps/desktop`'s own `package.json`), since `vitest.config.ts` is a single
repository-wide config; scoped per test file via a `// @vitest-environment jsdom` docblock pragma so
the global `environment: 'node'` setting (load-bearing for every existing Main-process/domain test)
never changes. This is the repository's first Renderer component-test layer — no browser-based
component-testing framework (Storybook, Playwright component testing) was introduced, matching the
task's own "do not introduce a huge new browser testing framework solely for component tests unless
justified" constraint.

**Interaction contract**: a channel row's single click selects it for chat viewing and must never join
its voice — a local, presentation-only `ChatTarget` selection state (`workspace/chat-target.ts`),
entirely independent of `use-voice-channel.ts`'s own `state.currentChannelId`. Joining voice remains
the pre-existing explicit Join/Leave action. This is the one interaction rule explicitly called out as
non-negotiable in the task's own specification, and is proven at three levels: a component test, a
real-Electron E2E event-ordering assertion, and the chat header's own copy (never a bare `#` prefix,
which would falsely imply a Discord-style separate text-channel hierarchy this architecture does not
have).

## Consequences

- A real TypeScript 6 blocker (`TS2882`, `noUncheckedSideEffectImports`) required understanding that
  pattern ambient module declarations (`declare module '*.css'`) only apply inside a script file (no
  top-level `import`/`export`) — `global.d.ts` is a module (it uses `declare global`, which requires
  one), so hand-written wildcard CSS declarations there are silently treated as meaningless module
  augmentations, never pattern matches. Resolved with a dedicated `vite-env.d.ts` containing
  `/// <reference types="vite/client" />`, which is also the idiomatic Vite convention and gives
  correct `.module.css` class-map typing for free. See
  [`architecture/PRODUCT_UI_FOUNDATION.md`](../architecture/PRODUCT_UI_FOUNDATION.md) for the full
  diagnostic trail.
- A React 19 automatic-batching risk was found by the pre-implementation architect review: calling
  `disconnect()` then `connectTo()` synchronously in one server-switch handler can collapse into a
  single commit that never renders an intermediate `'disconnected'` state, meaning the
  connected-workspace root would not unmount/remount across a switch and would silently leak one
  server's local UI state into the next. Fixed by giving the workspace root an explicit React `key`
  derived from the connection URL plus a monotonic per-connection-attempt counter, guaranteeing a full
  remount on every switch regardless of batching. The same class of bug was independently found (by
  this task's own visual/security review, not the architect) one level lower — `MainContent` mounting
  `ChatView` without a per-thread `key` — and fixed the same way.
- No IPC, Main, Preload, protocol, or persistence boundary changed. This ADR is scoped entirely to
  `apps/desktop/src/renderer/`.
- Future T13.2-T13.5 tasks are expected to add new `workspace/` components (channel administration,
  presence/avatars, voice-activity UX, stream layout) and extend `ui/` primitives, not introduce a
  second styling mechanism or icon library.

## Alternatives

- **A UI framework (e.g. MUI, Chakra, Ant Design)**: rejected — unjustified bundle/complexity cost for
  an app whose UI surface is this task's own scope, and the project's own guidance is to avoid a giant
  framework unless clearly justified; CSS Modules plus a small hand-built primitive set was sufficient.
- **CSS-in-JS (e.g. styled-components, Emotion)**: rejected — adds a runtime dependency and
  runtime style-injection cost with no capability CSS Modules doesn't already provide for this app's
  needs (no dynamic per-instance theming requirement exists).
- **A second, Discord-matching icon set or custom SVG icons**: rejected outright — the task explicitly
  prohibits copying Discord's proprietary artwork; `lucide-react` provides an equivalent visual
  vocabulary without that risk.
- **Storybook or a browser-based component-testing framework**: rejected for this task's scope —
  `@testing-library/react` + `jsdom` under the existing Vitest runner was sufficient for the required
  component-behavior coverage without a new tool category.
