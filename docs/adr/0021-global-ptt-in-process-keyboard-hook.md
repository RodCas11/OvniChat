# ADR 0021: Global Push-to-Talk via an in-process native keyboard hook

## Status

Accepted and implemented (T13.4).

## Context

T13.4 requires a genuine hold-to-talk global Push-to-Talk hotkey — one that works while OvniChat is
not focused (the primary use case: a game has focus). Hold-to-talk needs both a press _and_ a release
signal; releasing the key must stop transmission immediately, with no way to get stuck open.

Electron's only official global-hotkey facility, `globalShortcut`, wraps Windows' `RegisterHotKey`,
which posts `WM_HOTKEY` on key-down only — Win32 defines no matching "global hotkey released"
message. No combination of `globalShortcut`, `browser-window-blur`, or key-repeat suppression can
produce a real release event, because none of them ever receive one. This is a verified, structural
gap in the official API, not an under-researched one: a `software-architect` review confirmed it
before this decision was made, and this repository has an explicit rule (`docs/SECURITY.md`) against
adding keyboard hooks "unless there is overwhelming technical necessity" — precisely the situation
this gap creates, since no OS-level facility other than a low-level keyboard hook
(`WH_KEYBOARD_LL`) can observe a key release system-wide while unfocused, and no Electron-official
alternative exists for it.

## Decision

**Use `uiohook-napi`** (MIT-licensed, N-API-based wrapper around `libuiohook`, real keydown/keyup
events) as the mechanism, verified before this decision — not assumed — via the npm registry:
actively maintained (a release as recently as 2026-03), ships prebuilt binaries via
`node-gyp-build`/`prebuildify` (no compile step at install time on the operator's machine), and built
on Node-API specifically, which is ABI-stable across Node/Electron versions — a materially better fit
than a traditional native addon, and a real improvement over T12's own WASAPI helper's
Electron-ABI-rebuild exposure (see `adr/0017-windows-process-loopback-native-boundary.md`).

**The listener lives inside `packages/windows-media`, not `apps/desktop/src/main` directly** — a
binding rule already stated in `docs/SECURITY.md` ("Keep native functionality in
`packages/windows-media` behind narrow interfaces"), not a new one invented for this task. It exposes
exactly one narrow interface (`startPttListener(binding) -> { stop() }`, emitting only `'down'`/
`'up'` for the one currently-configured binding) — never a raw keystroke stream, never a generic
"listen to everything" capability. Every other observed key event is discarded in the same tick it
arrives, with no buffering or logging of anything beyond the configured binding.

**In-process, not an out-of-process helper — a deliberate departure from T12's own precedent, for a
stated reason.** T12 chose an out-of-process helper primarily for crash isolation around a
meaningfully larger and riskier surface: continuous, COM-activated, real-time WASAPI audio
processing. `uiohook-napi` is a small, mature, widely-deployed event listener with no comparable
complexity; building a second named-pipe supervisor protocol purely to isolate a keyboard-event
listener would be disproportionate engineering cost against the risk it would guard against. If a
real crash is ever observed in production, escalating to an out-of-process helper (mirroring ADR
0017 exactly) is the documented next step — this is an explicit escalation path, not a foreclosed
option.

**Pass-through, never swallowing.** `WH_KEYBOARD_LL` observes without consuming; the bound key still
reaches whatever window has focus (the game). OvniChat does not attempt to consume/suppress the key
event even though the underlying mechanism could — inventing a second failure mode (accidentally
eating a game's own input) is worse than asking the user to pick a key their game doesn't otherwise
need, matching TeamSpeak/Discord-style PTT-key conventions.

**Conflict detection is honestly weak, and is presented to the user as such.** A passive hook has no
OS concept of "this key is already taken" the way `RegisterHotKey`'s real exclusivity does. At
bind-time, OvniChat best-effort probes for a conflict by momentarily calling
`globalShortcut.register()`/checking its boolean return/immediately unregistering — this only
detects another application that itself used `RegisterHotKey` for the identical accelerator, a
narrow, real, but incomplete signal (most games never call `RegisterHotKey`). Product copy states "no
conflict detected with other Windows apps," never an unqualified "not in use," so the UI never claims
a stronger guarantee than the mechanism can provide.

**Elevation boundary, documented rather than worked around.** Windows UIPI (User Interface Privilege
Isolation) means a standard-integrity-level hook does not receive input while a _higher_-integrity
foreground window (an elevated/anti-cheat-protected game) has focus. This is a genuine OS security
boundary, not a defect — OvniChat documents this plainly rather than attempting privilege escalation
to work around it (which `CLAUDE.md`'s own boundaries and this task's brief both explicitly forbid).

## Consequences

- This is the first true native npm dependency (as opposed to from-scratch native source, T12's own
  precedent) in this repository — `uiohook-napi` ships as a normal `dependencies` entry of
  `packages/windows-media`, resolved and installed like any other package, with no custom build step
  this repository owns or maintains.
- `packages/windows-media`'s trust-boundary rules (Renderer never gets raw OS primitives, only
  narrow validated IPC through Main) apply unchanged to this new listener — see `SECURITY.md`'s T13.4
  section for the full IPC/fail-closed accounting.
- A real, permanent product limitation now exists and is documented rather than silently accepted:
  PTT may not function while a higher-privilege window has focus. `docs/SECURITY.md` and the T13.4
  task/architecture docs record this explicitly.
- Every other native-boundary discipline ADR 0007/0017 already established (sender validation, no
  Renderer-controlled raw paths, bounded/validated IPC payloads) applies unchanged to this listener.

## Alternatives

- **`globalShortcut` alone, with heuristics (repeat suppression, focus/blur events):** rejected —
  verified to be structurally incapable of producing a real release signal under any combination,
  not merely inconvenient.
- **A toggle-mode PTT fallback** (press once to start, press again to stop) when reliable hold
  semantics aren't available: rejected outright — this product's own requirement is genuine
  hold-to-talk; silently downgrading to a toggle would misrepresent the feature.
- **`iohook`** (the older, unmaintained predecessor `uiohook-napi` supersedes): rejected — long
  history of breaking on every Electron version bump, no longer actively maintained.
- **An out-of-process helper process** (mirroring T12 exactly): rejected for this specific surface as
  disproportionate engineering cost against a comparatively small, well-understood dependency's actual
  crash risk; kept as the explicit escalation path if evidence ever justifies it.
- **DLL injection or a kernel-mode driver:** never seriously considered — categorically more invasive
  than a standard `WH_KEYBOARD_LL` hook, explicitly out of scope per this task's own brief and
  `CLAUDE.md`'s non-negotiable boundaries.
