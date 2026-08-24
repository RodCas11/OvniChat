import { globalShortcut } from 'electron';
import type { WebContents } from 'electron';

import {
  startPttHotkeyListener,
  type PttBinding,
  type PttHotkeyListener,
} from '@disco-voador/windows-media';

import {
  IPC_CHANNELS,
  type DesktopPttEvent,
  type DesktopSetPttShortcutResult,
} from '../shared/ipc-contract.js';

/**
 * T13.4 — Main-process lifecycle owner for the global Push-to-Talk hotkey (ADR 0021). Owns exactly
 * one `@disco-voador/windows-media` `PttHotkeyListener` at a time: starts it from whatever binding
 * was persisted at app startup (`initializePttHotkeyFromSettings`), and re-starts it (stop the old
 * one only after the new one is confirmed running — never two active at once, never zero active
 * just because a rebind failed) whenever the Renderer requests a change (`setPttShortcut`).
 *
 * Deliberately never imports `uiohook-napi` itself, even for its own `UiohookKey` numeric constants
 * — `@disco-voador/windows-media`'s own `ptt-hotkey-listener.ts` documents (and this file mirrors)
 * why a *static* import of that package eagerly loads its native addon at module-evaluation time:
 * this module hardcodes the small subset of `UiohookKey` values it needs for the conflict-probe
 * accelerator mapping below as plain numeric literals (verified against the real, installed
 * `uiohook-napi@1.5.5` package — see `KEYCODE_TO_ACCELERATOR_KEY`'s own comment) rather than
 * importing them, exactly mirroring `packages/windows-media/src/ptt-binding.ts`'s own
 * "declare the shape locally, never import the real library just for this" discipline.
 *
 * Fail-closed lifecycle boundary (binding, per this task's brief): this module's listener lifecycle
 * is independent of window reload, app disconnect, voice-channel leave, and device changes — only an
 * explicit `setPttShortcut`/`clearPttShortcut` call or app quit ever stops it. The Renderer-side
 * `TransmitGate` (constructed fresh per voice session) is what guarantees a stale "held" edge can
 * never resume transmission after a reconnect — this module has no notion of "voice session" at all.
 */

let currentListener: PttHotkeyListener | undefined;
let pushTarget: WebContents | undefined;

/** Called once the main window's `WebContents` is known (`window.ts`) — every PTT edge event is
 * pushed there, mirroring `process-audio.ts`'s `mainWebContents.send` pattern exactly. Safe to call
 * again on window (re)creation. */
export function setPttPushTarget(webContents: WebContents): void {
  pushTarget = webContents;
}

function forwardPttEvent(event: DesktopPttEvent): void {
  if (pushTarget && !pushTarget.isDestroyed()) {
    pushTarget.send(IPC_CHANNELS.pttState, event);
  }
}

/**
 * The small subset of `uiohook-napi@1.5.5`'s real `UiohookKey` numeric values (verified directly by
 * `require('uiohook-napi').UiohookKey` against the installed package, not assumed) this module's
 * best-effort `globalShortcut` conflict probe can map to an Electron `Accelerator` key-name string.
 * A binding whose `keycode` is not present here simply cannot be probed (see `buildAccelerator`) —
 * treated as "no conflict detected" (never as a false-positive block), matching ADR 0021's own
 * "honestly weak, never claim a stronger guarantee" posture.
 */
const KEYCODE_TO_ACCELERATOR_KEY: ReadonlyMap<number, string> = new Map<number, string>([
  [11, '0'],
  [2, '1'],
  [3, '2'],
  [4, '3'],
  [5, '4'],
  [6, '5'],
  [7, '6'],
  [8, '7'],
  [9, '8'],
  [10, '9'],
  [30, 'A'],
  [48, 'B'],
  [46, 'C'],
  [32, 'D'],
  [18, 'E'],
  [33, 'F'],
  [34, 'G'],
  [35, 'H'],
  [23, 'I'],
  [36, 'J'],
  [37, 'K'],
  [38, 'L'],
  [50, 'M'],
  [49, 'N'],
  [24, 'O'],
  [25, 'P'],
  [16, 'Q'],
  [19, 'R'],
  [31, 'S'],
  [20, 'T'],
  [22, 'U'],
  [47, 'V'],
  [17, 'W'],
  [45, 'X'],
  [21, 'Y'],
  [44, 'Z'],
  [59, 'F1'],
  [60, 'F2'],
  [61, 'F3'],
  [62, 'F4'],
  [63, 'F5'],
  [64, 'F6'],
  [65, 'F7'],
  [66, 'F8'],
  [67, 'F9'],
  [68, 'F10'],
  [87, 'F11'],
  [88, 'F12'],
  [91, 'F13'],
  [92, 'F14'],
  [93, 'F15'],
  [99, 'F16'],
  [100, 'F17'],
  [101, 'F18'],
  [102, 'F19'],
  [103, 'F20'],
  [104, 'F21'],
  [105, 'F22'],
  [106, 'F23'],
  [107, 'F24'],
  [57, 'Space'],
  [15, 'Tab'],
  [14, 'Backspace'],
  [1, 'Escape'],
  [3667, 'Delete'],
  [3666, 'Insert'],
  [3655, 'Home'],
  [3663, 'End'],
  [3657, 'PageUp'],
  [3665, 'PageDown'],
  [57419, 'Left'],
  [57416, 'Up'],
  [57421, 'Right'],
  [57424, 'Down'],
  [82, 'num0'],
  [79, 'num1'],
  [80, 'num2'],
  [81, 'num3'],
  [75, 'num4'],
  [76, 'num5'],
  [77, 'num6'],
  [71, 'num7'],
  [72, 'num8'],
  [73, 'num9'],
  [55, 'nummult'],
  [78, 'numadd'],
  [74, 'numsub'],
  [83, 'numdec'],
  [3637, 'numdiv'],
]);

/**
 * Builds an Electron `Accelerator` string for the conflict probe, or `undefined` if this binding
 * cannot be probed at all — either because it is a `mouseButton` binding (`globalShortcut` has no
 * mouse-button concept whatsoever) or because its `keycode` is not in the small mapped subset above.
 */
function buildAccelerator(binding: PttBinding): string | undefined {
  if (binding.kind !== 'keyboard') return undefined;
  const keyName = KEYCODE_TO_ACCELERATOR_KEY.get(binding.keycode);
  if (!keyName) return undefined;

  const modifierParts: string[] = [];
  if (binding.modifiers.ctrl) modifierParts.push('Control');
  if (binding.modifiers.alt) modifierParts.push('Alt');
  if (binding.modifiers.shift) modifierParts.push('Shift');
  if (binding.modifiers.meta) modifierParts.push('Super');
  return [...modifierParts, keyName].join('+');
}

/** A no-op — this probe never intends to actually react to the accelerator firing; it only exists
 * to observe `globalShortcut.register()`'s own boolean return before immediately unregistering. */
function noopShortcutHandler(): void {
  // Intentionally empty.
}

/**
 * ADR 0021's "honestly weak" conflict probe: momentarily registers `accelerator` as a real Windows
 * global hotkey via `globalShortcut`, checks whether that succeeded, and immediately unregisters it
 * either way — this module never holds a real `globalShortcut` registration for longer than this one
 * synchronous check, so it can never itself block a later probe or collide with the real
 * `uiohook-napi` hook this feature actually uses for observation. Returns `true` only when
 * `register()` reported failure (another application already holds this exact accelerator via its
 * own `RegisterHotKey` call) — a thrown/malformed-accelerator case is treated as "cannot probe",
 * never as a conflict, matching `buildAccelerator`'s own "never falsely claim a stronger signal than
 * the mechanism provides" posture.
 */
function probeAcceleratorConflict(accelerator: string): boolean {
  try {
    const registered = globalShortcut.register(accelerator, noopShortcutHandler);
    if (!registered) return true;
    globalShortcut.unregister(accelerator);
    return false;
  } catch {
    return false;
  }
}

/**
 * Validates for conflicts (best-effort), then starts the real global listener, swapping out any
 * previously-running one only after the new one is confirmed live. Never persists anything itself —
 * `main/ipc.ts`'s handler persists the binding to settings once this resolves `{ ok: true }`, keeping
 * this module's own responsibility scoped to lifecycle exactly as `process-audio.ts` keeps capture
 * lifecycle separate from `settings-service.ts`.
 */
export async function setPttShortcut(binding: PttBinding): Promise<DesktopSetPttShortcutResult> {
  const accelerator = buildAccelerator(binding);
  if (accelerator && probeAcceleratorConflict(accelerator)) {
    return {
      ok: false,
      reason: 'conflict',
      message: 'That shortcut is already in use — choose another key.',
    };
  }

  const result = await startPttHotkeyListener(binding, forwardPttEvent);
  if (!result.ok) {
    return { ok: false, reason: result.reason, message: result.message };
  }

  const previousListener = currentListener;
  currentListener = result.listener;
  // Stop the previous listener only now that the new one is confirmed running — per ADR 0021, this
  // module must never have two `uiohook-napi` listeners registered at once, but also must never
  // leave zero running just because a rebind attempt failed (that failure already returned above,
  // before `currentListener` was ever reassigned).
  previousListener?.stop();
  return { ok: true };
}

/** Stops the current listener (if any). Idempotent. Persisting the cleared binding to settings is
 * `main/ipc.ts`'s responsibility, mirroring `setPttShortcut`'s own division of labor. */
export function clearPttShortcut(): void {
  currentListener?.stop();
  currentListener = undefined;
}

/**
 * Starts the listener from whatever binding was persisted at app startup, if any — called once from
 * `bootstrap()`. `binding: null` (no shortcut ever configured) is a normal, silent no-op. A startup
 * failure (a stale binding that now conflicts with the native module, or a hook-start failure) is
 * logged, never thrown — this must never block app startup (mirrors `settings-file.ts`'s own
 * fail-open discipline for non-security-sensitive local preferences).
 */
export async function initializePttHotkeyFromSettings(binding: PttBinding | null): Promise<void> {
  if (!binding) return;
  const result = await startPttHotkeyListener(binding, forwardPttEvent);
  if (!result.ok) {
    console.error(
      `ptt-hotkey: failed to start the persisted PTT shortcut at startup (${result.reason})`,
      result.message,
    );
    return;
  }
  currentListener = result.listener;
}

/** Called from `app.on('before-quit', ...)` — never leave a native `uiohook-napi` hook running after
 * the app itself has exited (mirrors `process-audio.ts`'s `disposeProcessAudioSession` on the same
 * lifecycle hook). */
export function stopPttHotkeyListener(): void {
  currentListener?.stop();
  currentListener = undefined;
}
