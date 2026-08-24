# T13.5 — Chantivo branding + streams/camera/product integration

Two phases: Phase A rebranded the product to **Chantivo** (chantivo.app); Phase B built the
Discord-like media stage `MainContent.tsx` had explicitly deferred since T13.1.

## Phase A — Chantivo branding

- Official public name **Chantivo**, domain **chantivo.app** — replaces "OvniChat" in all
  current-facing UI/docs. Historical task docs/ADRs from the OvniChat era are left unchanged (they
  describe what was true at the time). Internal `@disco-voador/*` npm namespace deliberately
  unchanged. Full record: [`BRANDING.md`](../BRANDING.md).
- Authoritative brand assets (`apps/desktop/src/assets/brand/`) consumed directly via three new
  presentation components (`ChantivoMark`/`ChantivoWordmark`/`ChantivoLogo`,
  `apps/desktop/src/renderer/ui/brand/`) — never redrawn/approximated.
  - Home shows the real mark+wordmark with restraint (never a marketing landing page).
  - A new About subsection (Settings → Advanced → About) shows the mark, real app version, and
    `chantivo.app` — no login/account/subscription/telemetry.
  - Connected-server UI deliberately does **not** repeat the Chantivo mark (channel headers, Member
    Panel, chat header, other settings sections) — the server is the primary context there.
- `apps/desktop/package.json` gained `productName: "Chantivo"`; `forge.config.ts` embeds the
  authoritative `chantivo.ico` into the packaged executable (`packagerConfig.icon`) and copies it to
  `resources/` for the dev/packaged `BrowserWindow` icon too.
- **Data-compatibility, release-blocking, verified**: `main/index.ts` explicitly pins
  `app.setPath('userData', ...)` to the historical `%APPDATA%\@disco-voador\desktop` path _before_
  anything else in the process can read it, so the `productName` change cannot silently move local
  storage. Proven with a real packaged-build launch: the pre-existing `identity/`, `settings.json`,
  `preferences.json` all survived untouched, and no new `%APPDATA%\Chantivo` directory was created.
- Design tokens: every `--ovni-*` CSS custom property renamed to `--chantivo-*` (681 occurrences,
  30 files) for naming consistency; a new `--chantivo-brand`/`--chantivo-brand-subtle` pair holds the
  exact official mark color (`#3f7353`), while the existing, already-tuned `--chantivo-accent*`
  functional-accent values are unchanged (contrast/legibility already correct; no reason to risk
  regressing dozens of components' on-dark contrast for a color swap this task did not need to make).
- `services/dedicated-server`'s compiled-in default server name/CLI banner updated to
  "Chantivo Server"/"Chantivo Dedicated Server" (a default only — an operator's own configured name is
  never affected).

## Phase B — media stage

Full design: [`../architecture/MEDIA_STAGE_AND_STREAM_UX.md`](../architecture/MEDIA_STAGE_AND_STREAM_UX.md).

New: `MediaStage.tsx`, `MediaTile.tsx` (`apps/desktop/src/renderer/workspace/`). Modified:
`MainContent.tsx` (layout decision), `VoiceChannelView.tsx` (one line, threads the existing
`participantsWithSelf` one prop deeper).

- Chat stays the sole, full-width primary content whenever no camera/screen stream is actually
  active — the deliberate default (Section 18/80), unchanged from T13.1's own architecture.
- Once real media is active: an adaptive camera grid (CSS Grid `auto-fit`, every voice participant —
  camera-off participants render as a real avatar-fallback tile via the shared `UserAvatar`, never a
  black rectangle), or a screen-share-focused layout (any active screen share is always primary
  content; a camera filmstrip renders alongside if cameras are also active; multiple simultaneous
  screen shares get an explicit switcher).
- Click-to-focus a camera tile, with an explicit "Back to grid" return path; a stream that ends while
  focused (track ended, participant left, share stopped) falls back cleanly, never a frozen tile.
- Chat becomes a narrower, user-toggleable side panel during media viewing — never removed, never a
  second chat system (the exact same `ChatView`/`state.chatThreads`).
- Speaking ring and avatar/nickname on media tiles reuse the existing T13.4/T13.3 sources exactly —
  no second `AnalyserNode`, no second avatar-resolution path.
- **Picture-in-Picture via native `HTMLVideoElement.requestPictureInPicture()`** — the deliberately
  chosen "smallest robust architecture" (see the architecture doc's own reasoning for why a second
  Electron window was evaluated and not built for this task).
- `ParticipantRow`'s camera/screen status icons, `ScreenSourcePicker`'s source/quality/audio-mode
  picker, and `UserControlBar`'s camera/share active-state controls were already in a
  product-consistent, non-jargon state from T4/T5/T12/T13.1/T13.4 and needed no rework.

### Deliberately not built

- A secondary Electron pop-out window — evaluated against native PiP and not chosen (see the
  architecture doc). Not a limitation of this pass; a considered decision.
- Per-stream local volume controls — the brief explicitly marks this optional beyond "existing stream
  audio must work correctly," which it does (screen/system/application audio playback is unmodified
  T6/T12 code, untouched by this task).

## Tests

New focused suites: `tests/desktop/components/media-stage.test.tsx` (8 tests — chat-primary default,
camera-off avatar fallback, speaking ring on both video and avatar tiles, screen-focus with camera
filmstrip, multiple-screen-share switcher, focus/return-to-grid, stale-focus cleanup, avatar-request
wiring), `tests/desktop/components/media-tile.test.tsx` (6 tests — video vs. avatar fallback, screen
label wording, no technical-id leakage, PiP button gating, focus click wiring),
`tests/desktop/components/screen-source-picker-modal.test.tsx` (2 tests — real Modal + real
`ScreenSourcePicker`, proving the T13.4 shared-Modal focus fix is not regressed), plus real
component-integration additions to `tests/desktop/components/main-content.test.tsx` (2 tests: no-media
→ chat-primary with no media stage/toggle at all; media-active → media stage + toggleable side chat,
through the real `MainContent` render tree, not `MediaStage` in isolation). Branding coverage added to
`tests/desktop/window-options.test.ts`, `tests/desktop/components/settings-panel.test.tsx`,
`tests/desktop/components/server-home.test.tsx`, plus fixed pre-existing assertions in
`tests/desktop/renderer-shell.test.ts`/`tests/dedicated-server/config.test.ts` that literal-matched
the old "OvniChat" string.

## Impact-based regression

Ran `e2e:camera-smoke` and `e2e:screen-smoke` — the two E2Es that exercise exactly the rendering path
this task's own new code (`MediaTile`) replaced (`RemoteCamera`/`LocalCameraPreview`/`RemoteScreen`/
`LocalScreenPreview`'s call sites in `MainContent`). Both ultimately passed with real evidence (real
decoded remote video/screen frames, correct source distinction, voice continuity across a share
cycle); one `camera-smoke` run hit this repository's own previously-documented intermittent flakiness
(recorded since T6/T11) and passed cleanly on retry. Did not run `screen-audio-smoke`/
`process-audio-smoke` — neither `ScreenSourcePicker.tsx`, the process-audio bridge, nor any
audio-integration code was touched by this task; those E2Es would provide no new evidence about
anything actually changed here.

## Known limitation

The dedicated T13.5-specific media screenshots (grid/focus/speaking/picker states) could not be
captured this session — the real-Electron dev-mode E2E spawn path (`spawn(electronPath, [desktopDir,
'--user-data-dir=...'])`, shared by every screenshot/E2E script in this repository) became
reproducibly stuck mid-session on a fresh `--user-data-dir`, confirmed via a minimal repro using zero
of this task's own code. The packaged-app smoke test (`smoke.mjs`, no custom `--user-data-dir`)
continued to launch and load correctly throughout, and `camera-smoke`/`screen-smoke` had already
passed with real evidence earlier in the same session before this became reproducible — so this is
assessed as a local machine/environment condition (likely related to the very large number of fresh
Electron profile directories launched in one session), not a defect in this task's code. The four
screenshots that do not depend on live camera/screen streams (Home, connected-chat-default, Settings,
About) were captured successfully and visually reviewed.
