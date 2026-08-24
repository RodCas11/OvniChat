import type { UiohookKeyboardEvent, UiohookMouseEvent } from 'uiohook-napi';

import {
  type PttBinding,
  type PttEdgeEvent,
  PttBindingMatcher,
  type PttRawInputEvent,
  type RawMouseButtonEvent,
} from './ptt-binding.js';

/**
 * T13.4 — the one real native boundary for this feature: a thin wrapper around `uiohook-napi`'s
 * process-wide `uIOhook` singleton, narrowed down to exactly one caller-configured
 * {@link PttBinding}'s `'down'`/`'up'` edges (see `ptt-binding.ts`'s `PttBindingMatcher`, which does
 * all the actual filtering/repeat-suppression/edge-detection logic and is the piece this file's own
 * unit tests do not need to re-prove). This module has no Electron dependency and is plain Node/
 * TypeScript, consumable from a future Electron Main process or from plain Node/Vitest alike — see
 * `docs/adr/0021-global-ptt-in-process-keyboard-hook.md` for why this mechanism/boundary was chosen.
 *
 * **Deliberately lazy, dynamic `import('uiohook-napi')` inside {@link startPttHotkeyListener} —
 * never a static top-level import of the real (non-type-only) module.** Verified directly by
 * installing the real published package and reading its shipped `dist/index.js`: merely
 * `require`/`import`-ing `uiohook-napi` synchronously loads its prebuilt native addon at *module
 * evaluation* time (`node-gyp-build(...)` runs at the top of the file, before `uIOhook.start()` is
 * ever called) — a static import here would mean every consumer of `@disco-voador/windows-media`
 * (including this package's own T12 `capability.ts`/`process-loopback-supervisor.ts` consumers, and
 * their tests, which have nothing to do with PTT) would eagerly load this native module the instant
 * they imported anything from this package's barrel, and a load failure in some environment lacking a
 * matching prebuild would surface as an uncaught synchronous throw at import time, not as this
 * function's own typed failure result. The dynamic import confines that cost and that failure mode to
 * the one call site that actually needs it, and only type-only imports of `uiohook-napi` are used at
 * the top of this file (erased entirely at compile time — this project's `verbatimModuleSyntax`
 * ensures that).
 *
 * **Verified directly by reading `uiohook-napi`'s real native addon source (`src/lib/addon.c`), not
 * assumed:** `uIOhook.start()` throws synchronously (a real native-to-JS `napi_throw`) if the
 * underlying hook registration fails — on Windows, most relevantly `UIOHOOK_ERROR_SET_WINDOWS_HOOK_EX`
 * if `SetWindowsHookEx` itself fails. This is exactly Requirement 6's "never throw synchronously for
 * binding currently unregistrable" scenario, which is why `start()` is wrapped in its own `try/catch`
 * below rather than assumed to always succeed. The same source also confirms clean restartability:
 * the addon tracks a single `is_worker_running` flag and `uIOhook.stop()` synchronously joins the
 * native hook thread before returning, so a `stop()` that completes without throwing guarantees a
 * subsequent `startPttHotkeyListener()` call's own `uIOhook.start()` genuinely reinitializes rather
 * than silently no-op-ing against an already-running hook (Requirement 5).
 *
 * **Single shared native singleton, serialized use only.** `uiohook-napi` exposes one process-wide
 * `uIOhook` instance; this module does not implement multi-owner reference counting for it, matching
 * this task's own described usage (Main re-calls this function once per user rebind, always after
 * calling the previous listener's `stop()` first). Do not call `startPttHotkeyListener` again for a
 * second, concurrently-active binding without stopping the first — this is a documented constraint on
 * the caller, not a scenario this module attempts to arbitrate.
 */

export interface PttHotkeyListener {
  /** Fully tears down this listener: removes this call's own event listeners from the shared
   * `uIOhook` emitter and stops the native hook (`uIOhook.stop()`). Idempotent — calling this more
   * than once is a safe no-op after the first call. Never throws; a failure while stopping the native
   * hook is swallowed after this listener's own event listeners are still removed, so a caller can
   * always safely call `startPttHotkeyListener` again afterward without leaking this instance's
   * listeners regardless of whether the native `stop()` itself succeeded. */
  readonly stop: () => void;
}

export type PttHotkeyStartFailureReason = 'native-module-load-failed' | 'hook-start-failed';

export type PttHotkeyStartResult =
  | { readonly ok: true; readonly listener: PttHotkeyListener }
  | {
      readonly ok: false;
      readonly reason: PttHotkeyStartFailureReason;
      /** A short, local-diagnostic-only English message (e.g. the underlying error's own `.message`)
       * — never anything key-content-shaped, matching this module's "no keystroke content is ever
       * logged/surfaced" posture even in its failure path. */
      readonly message: string;
    };

/**
 * Starts observing global keyboard/mouse input for exactly one {@link PttBinding}, invoking `onEvent`
 * synchronously, in the same tick, only for that binding's own `'down'`/`'up'` edges — never for any
 * other observed key/button (Requirement 1). Resolves to a typed failure result rather than throwing
 * or rejecting if the native module cannot be loaded or the underlying hook cannot be registered
 * (Requirement 6) — see this module's own doc comment for exactly which native failure paths this
 * covers, verified against the real library's source rather than assumed.
 *
 * Only the two events relevant to `binding.kind` are ever subscribed to (`'keydown'`/`'keyup'` for a
 * `'keyboard'` binding, `'mousedown'`/`'mouseup'` for a `'mouseButton'` binding) — this listener never
 * even receives the other input source's events at all, a stricter posture than merely filtering them
 * out after the fact.
 */
export async function startPttHotkeyListener(
  binding: PttBinding,
  onEvent: (event: PttEdgeEvent) => void,
): Promise<PttHotkeyStartResult> {
  let uiohookModule: typeof import('uiohook-napi');
  try {
    uiohookModule = await import('uiohook-napi');
  } catch (err) {
    return {
      ok: false,
      reason: 'native-module-load-failed',
      message: describeError(err),
    };
  }

  const { uIOhook } = uiohookModule;
  const matcher = new PttBindingMatcher(binding);

  const dispatch = (raw: PttRawInputEvent): void => {
    const edge = matcher.handle(raw);
    if (edge) onEvent(edge);
  };

  const onKeyDown = (event: UiohookKeyboardEvent): void => {
    dispatch({ source: 'keyboard', edge: 'down', event });
  };
  const onKeyUp = (event: UiohookKeyboardEvent): void => {
    dispatch({ source: 'keyboard', edge: 'up', event });
  };
  // `UiohookMouseEvent` also carries cursor position (`x`/`y`) and click count — deliberately never
  // read or forwarded here, narrowed down to exactly the fields `RawMouseButtonEvent` declares, so
  // this listener structurally cannot leak cursor-position telemetry through the PTT edge-event path
  // even though the underlying library event happens to carry it.
  const toRawMouseButtonEvent = (event: UiohookMouseEvent): RawMouseButtonEvent => ({
    button: Number(event.button),
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
  });
  const onMouseDown = (event: UiohookMouseEvent): void => {
    dispatch({ source: 'mouseButton', edge: 'down', event: toRawMouseButtonEvent(event) });
  };
  const onMouseUp = (event: UiohookMouseEvent): void => {
    dispatch({ source: 'mouseButton', edge: 'up', event: toRawMouseButtonEvent(event) });
  };

  const attachListeners = (): void => {
    if (binding.kind === 'keyboard') {
      uIOhook.on('keydown', onKeyDown);
      uIOhook.on('keyup', onKeyUp);
    } else {
      uIOhook.on('mousedown', onMouseDown);
      uIOhook.on('mouseup', onMouseUp);
    }
  };

  const detachListeners = (): void => {
    if (binding.kind === 'keyboard') {
      uIOhook.off('keydown', onKeyDown);
      uIOhook.off('keyup', onKeyUp);
    } else {
      uIOhook.off('mousedown', onMouseDown);
      uIOhook.off('mouseup', onMouseUp);
    }
  };

  attachListeners();

  try {
    uIOhook.start();
  } catch (err) {
    detachListeners();
    return {
      ok: false,
      reason: 'hook-start-failed',
      message: describeError(err),
    };
  }

  let stopped = false;
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    detachListeners();
    try {
      uIOhook.stop();
    } catch {
      // Requirement 6's "never throw" applies to teardown too — this listener's own event listeners
      // are already detached above regardless of whether the native stop() itself succeeded, so no
      // listener leak results even if this throws (see this module's own doc comment on why a clean
      // `uIOhook.stop()` matters for a later clean restart, and why a failure here is still safe to
      // swallow: the caller has no actionable recovery for a stop-time native failure beyond what
      // detaching this listener's own callbacks already achieves).
    }
  };

  return { ok: true, listener: { stop } };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
