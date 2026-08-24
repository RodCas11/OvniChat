# T13.5.1 — Final visual polish

A focused Renderer/CSS polish pass on top of the already-correct T13.5 structure — no architecture,
protocol, media, or server-side change. See [`../architecture/PRODUCT_UI_FOUNDATION.md`](../architecture/PRODUCT_UI_FOUNDATION.md)
for where this fits into the overall visual-foundation history, and
[`../BRANDING.md`](../BRANDING.md) for the brand-token values this task adjusted.

## What changed

**Home scale (Section 4-5).** `ServerHome.module.css`'s content column widened 760px → 860px, the
`ChantivoLogo` grew 40px → 52px, the subheading promoted `text-md` → `text-lg`, and server tiles grew
via a new `Avatar` `xlarge` (96px) size — added as a genuine shared-primitive size, not a one-off
inline style (Section 44). The composition now reads as intentionally centered rather than merely
small, at both 1920x1080 and 1366x768.

**Typography (Section 6-7).** `tokens.css`'s two smallest steps nudged up 1px (`--chantivo-text-xs`
11→12, `--chantivo-text-sm` 12→13) — `base` and above were already correctly sized. Three specific
"this is primary content, not a label" fixes: `ParticipantRow`'s name (voice-channel roster) and
`MemberRow`'s name (Member Panel) promoted from `text-sm`/secondary to `text-base`/primary;
`MemberPanel`'s own "Members — N" header promoted the same way. Everything already correctly styled
as secondary/muted (`"(you)"`, category labels, helper copy, connection-status text) was left alone —
this was a hierarchy fix, not an across-the-board size increase.

**Focus-visible / Close button (Section 13, 33).** The global `:focus-visible` rule
(`global.css`) went from a 2px/2px-offset outline at full `--chantivo-accent` saturation to a
1.5px/1px-offset outline against a new, dedicated, 70%-opacity `--chantivo-focus-ring` token. A
merely-focused control (most visibly Settings' own Close button, auto-focused on open by the T13.4
Modal fix) now reads as "here," not as a filled primary action — while remaining a real, always-on,
clearly visible outline. This is a single global-rule change, so it applies identically everywhere
focus already worked, per Section 44's "fix the shared primitive, not 12 consumers."

**Chat empty state (Section 21-22).** `ChatView` gained an optional `channelName` prop (threaded from
`MainContent.tsx`'s own already-computed channel name — never fabricated). Server Chat's empty state
stays "No messages yet" / "Start the conversation."; a channel's empty state now reads "This channel
is quiet" / "Send the first message in {channelName}." (falling back to a generic "Send the first
message." if the name were ever unavailable). Deliberately never a `#channel` prefix — T13.1's own
established rule against implying a Discord-style channel-hash hierarchy this app does not have.

## Typography scale (final)

| Token                  | Before | After            | Used for                                  |
| ---------------------- | ------ | ---------------- | ----------------------------------------- |
| `--chantivo-text-xs`   | 11px   | 12px             | badges, category labels, timestamps       |
| `--chantivo-text-sm`   | 12px   | 13px             | helper copy, secondary field labels       |
| `--chantivo-text-base` | 14px   | 14px (unchanged) | primary body text, names, message content |
| `--chantivo-text-md`   | 15px   | 15px (unchanged) | subheadings                               |
| `--chantivo-text-lg`   | 17px   | 17px (unchanged) | section titles, modal titles              |

## Spacing / radius / brand tokens

No spacing-scale, radius-scale, or functional-accent value changed — an audit (Section 27-29) found
the existing `--chantivo-space-*`/`--chantivo-radius-*` scale already consistently applied via the
existing CSS Modules, and `--chantivo-accent`/`--chantivo-accent-hover`/`--chantivo-accent-fg` already
correctly tuned for on-dark contrast (T13.5's own explicit reasoning for leaving them alone still
applies). Only `--chantivo-focus-ring` (new, dedicated, softened value — see above) and the two
smallest typography steps changed.

## Brand usage

Unchanged from T13.5's own restraint policy (`BRANDING.md`) — the mark/wordmark still appear only at
Home and in Settings' About subsection; the connected-server view still shows no Chantivo branding.
This task's own Home-scale change makes that one real identity moment slightly more confident, not
more frequent.

## Responsive review

Reviewed via real Electron screenshots at 1920x1080, 1366x768, and a narrow 1024x700 desktop size
(Section 39) — Home, connected-server (chat + Member Panel + sidebar), all four Settings sections, a
real context menu, and real grouped chat messages. No clipping, no unreadable text, no modal
overflowing its own bounds at any reviewed size. See Screenshots below.

## Accessibility

The focus-visible refinement (above) keeps a real, always-on outline — never removed, never
opacity-zeroed — at every keyboard-focusable element; only its visual weight changed. The shared
Modal's focus-trap/Escape/restore-focus behavior (`Modal.tsx`) was not touched by this task at all;
`tests/desktop/components/modal.test.tsx`'s existing suite (typing-keeps-focus, Escape-after-re-render,
`autoFocus` preference, restore-on-close) continues to pass unmodified, confirming no regression.

## Tests

New: two `ChatView` empty-state tests (`tests/desktop/components/chat-view.test.tsx`) proving the
real channel name appears in channel-scope empty-state copy, that Server Chat's own copy stays
distinct, and that a missing channel name falls back cleanly rather than blocking render. No new
tests were needed for the pure-CSS token changes (Section 52: no brittle pixel-position assertions) —
those are covered by visual screenshot review instead, per the task's own explicit guidance.

## Impact-based regression

This is a Renderer/CSS-only task. **Did not run** `camera-smoke`, `screen-smoke`, `screen-audio-smoke`,
`process-audio-smoke`, or `ptt-smoke` — the final diff touches no capture, negotiation, protocol, or
native-audio code at all (confirmed by reviewing the actual changed files: `tokens.css`, `global.css`,
`Avatar.tsx`/`.module.css`, `ServerHome.tsx`/`.module.css`, `ParticipantRow.module.css`,
`MemberRow.module.css`, `MemberPanel.module.css`, `ChatView.tsx`, `MainContent.tsx`, plus QA-only
screenshot-capture scaffolding in `main/index.ts`). No camera was activated, no screen was shared, and
no audible test tone was played during this task's own verification.

## Screenshots

`docs/tasks/screenshots/t13-5-1/` — all 14 required files, captured from a real packaged-equivalent
Electron build and visually reviewed (see the final report for the detailed per-screenshot findings).
