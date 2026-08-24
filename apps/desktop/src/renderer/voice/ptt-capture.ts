import type { PttBinding } from '../../shared/ipc-contract.js';

/**
 * T13.4 — Renderer-local, focused-window key/mouse-button capture for the Voice & Video settings
 * "Shortcut: [Press a key...]" control. Deliberately **not** the global hook (`packages/windows-media`'s
 * `uiohook-napi` listener, owned by `main/ptt-hotkey.ts`) — this only ever listens while the settings
 * window itself has focus, purely to let the user pick a binding, then hands the resulting
 * `PttBinding` to `actions.setPttShortcut`, which is what actually arms the real global listener.
 *
 * `PttBinding.keycode`/`button` must be in `uiohook-napi`'s own numeric code space (Windows
 * scan-code-derived for keyboard, libuiohook's `MOUSE_BUTTON1..5` ordinals for mouse — see
 * `packages/windows-media/src/ptt-binding.ts`'s own doc comment), which is a *different* numeric
 * space from the DOM `KeyboardEvent`/`MouseEvent` this capture control actually observes — the two
 * mapping tables below translate between them for the bounded, realistic-for-a-gamer-PTT-bind subset
 * this control supports (A-Z, 0-9, F1-F12, arrows, a handful of common keys, and mouse buttons 0-4).
 * A key/button outside this subset is reported as unsupported rather than silently mis-mapped.
 */

/** DOM `KeyboardEvent.code` -> the real `uiohook-napi@1.5.5` `UiohookKey` numeric value (verified by
 * installing the real package and reading `UiohookKey` directly — the same values
 * `main/ptt-hotkey.ts`'s own conflict-probe mapping uses, from the opposite direction). */
const DOM_CODE_TO_UIOHOOK_KEYCODE: ReadonlyMap<string, number> = new Map<string, number>([
  ['Digit0', 11],
  ['Digit1', 2],
  ['Digit2', 3],
  ['Digit3', 4],
  ['Digit4', 5],
  ['Digit5', 6],
  ['Digit6', 7],
  ['Digit7', 8],
  ['Digit8', 9],
  ['Digit9', 10],
  ['KeyA', 30],
  ['KeyB', 48],
  ['KeyC', 46],
  ['KeyD', 32],
  ['KeyE', 18],
  ['KeyF', 33],
  ['KeyG', 34],
  ['KeyH', 35],
  ['KeyI', 23],
  ['KeyJ', 36],
  ['KeyK', 37],
  ['KeyL', 38],
  ['KeyM', 50],
  ['KeyN', 49],
  ['KeyO', 24],
  ['KeyP', 25],
  ['KeyQ', 16],
  ['KeyR', 19],
  ['KeyS', 31],
  ['KeyT', 20],
  ['KeyU', 22],
  ['KeyV', 47],
  ['KeyW', 17],
  ['KeyX', 45],
  ['KeyY', 21],
  ['KeyZ', 44],
  ['F1', 59],
  ['F2', 60],
  ['F3', 61],
  ['F4', 62],
  ['F5', 63],
  ['F6', 64],
  ['F7', 65],
  ['F8', 66],
  ['F9', 67],
  ['F10', 68],
  ['F11', 87],
  ['F12', 88],
  ['Space', 57],
  ['Tab', 15],
  ['Backspace', 14],
  ['Escape', 1],
  ['Delete', 3667],
  ['Insert', 3666],
  ['Home', 3655],
  ['End', 3663],
  ['PageUp', 3657],
  ['PageDown', 3665],
  ['ArrowLeft', 57419],
  ['ArrowUp', 57416],
  ['ArrowRight', 57421],
  ['ArrowDown', 57424],
  ['BracketLeft', 26],
  ['BracketRight', 27],
  ['Semicolon', 39],
  ['Quote', 40],
  ['Backquote', 41],
  ['Backslash', 43],
  ['Comma', 51],
  ['Period', 52],
  ['Slash', 53],
  ['Minus', 12],
  ['Equal', 13],
]);

/** DOM `MouseEvent.button` -> libuiohook's own `MOUSE_BUTTON1..5` ordinals (1=left, 2=right,
 * 3=middle, 4/5=side/thumb) — deliberately a different order than DOM's own (0=left, 1=middle,
 * 2=right, 3=back, 4=forward). */
const DOM_MOUSE_BUTTON_TO_UIOHOOK_BUTTON: ReadonlyMap<number, number> = new Map<number, number>([
  [0, 1],
  [1, 3],
  [2, 2],
  [3, 4],
  [4, 5],
]);

/** The narrow slice of a real `KeyboardEvent`/`MouseEvent` this module reads — declared locally so
 * tests can construct plain objects without a real DOM event. */
export interface CapturedKeyboardEvent {
  readonly code: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

export interface CapturedMouseEvent {
  readonly button: number;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

/** Converts one captured keydown into a `PttBinding`, or `undefined` if this specific key is outside
 * the supported subset (the caller should show an honest "that key isn't supported yet" message,
 * never silently bind the wrong thing). Modifier-only keys (bare Ctrl/Alt/Shift/Meta) are
 * deliberately excluded from `DOM_CODE_TO_UIOHOOK_KEYCODE` entirely — binding a bare modifier as the
 * PTT key itself is a real, supported case for the underlying matcher (`ptt-binding.ts`'s own doc
 * comment), but capturing it correctly via `keydown`/modifier-flag timing is meaningfully trickier
 * and out of this pass's scope; a real key/mouse-button bind covers the realistic majority of gamer
 * PTT choices (an unused letter key or a spare mouse button). */
export function pttBindingFromKeyboardEvent(event: CapturedKeyboardEvent): PttBinding | undefined {
  const keycode = DOM_CODE_TO_UIOHOOK_KEYCODE.get(event.code);
  if (keycode === undefined) return undefined;
  return {
    kind: 'keyboard',
    keycode,
    modifiers: {
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    },
  };
}

export function pttBindingFromMouseEvent(event: CapturedMouseEvent): PttBinding | undefined {
  const button = DOM_MOUSE_BUTTON_TO_UIOHOOK_BUTTON.get(event.button);
  if (button === undefined) return undefined;
  return {
    kind: 'mouseButton',
    button,
    modifiers: {
      ctrl: event.ctrlKey,
      alt: event.altKey,
      shift: event.shiftKey,
      meta: event.metaKey,
    },
  };
}

const KEYCODE_TO_LABEL: ReadonlyMap<number, string> = new Map(
  [...DOM_CODE_TO_UIOHOOK_KEYCODE.entries()].map(([code, keycode]) => [
    keycode,
    code.replace(/^(Key|Digit)/u, ''),
  ]),
);

const BUTTON_TO_LABEL: ReadonlyMap<number, string> = new Map([
  [1, 'Mouse Left'],
  [2, 'Mouse Right'],
  [3, 'Mouse Middle'],
  [4, 'Mouse Back'],
  [5, 'Mouse Forward'],
]);

/** Human-readable label for an already-configured `PttBinding` (e.g. "Ctrl+Shift+V" or "Mouse
 * Back") — never the raw numeric codes, which would mean nothing to a user. Falls back to a generic
 * "(unrecognized key)" label for a keycode outside this module's own supported-for-capture subset
 * (e.g. one set through a future, richer capture UI) — this never throws or shows a raw number. */
export function describePttBinding(binding: PttBinding): string {
  const modifierParts: string[] = [];
  if (binding.modifiers.ctrl) modifierParts.push('Ctrl');
  if (binding.modifiers.alt) modifierParts.push('Alt');
  if (binding.modifiers.shift) modifierParts.push('Shift');
  if (binding.modifiers.meta) modifierParts.push('Win');

  const keyLabel =
    binding.kind === 'keyboard'
      ? (KEYCODE_TO_LABEL.get(binding.keycode) ?? '(unrecognized key)')
      : (BUTTON_TO_LABEL.get(binding.button) ?? '(unrecognized button)');

  return [...modifierParts, keyLabel].join('+');
}
