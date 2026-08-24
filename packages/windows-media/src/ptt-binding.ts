/**
 * T13.4 — Global Push-to-Talk (PTT) binding shape and the pure, injectable edge-detection logic that
 * decides whether one raw keyboard/mouse event activates or releases it. See
 * `docs/adr/0021-global-ptt-in-process-keyboard-hook.md` for why a global hold-to-talk hotkey exists
 * at all and why `uiohook-napi` is the chosen mechanism; this module has no dependency on
 * `uiohook-napi` itself (not even its types) and no dependency on Node's `EventEmitter` — it is pure,
 * synchronous TypeScript, importable and unit-testable under plain Node/Vitest with no native module
 * installed or loadable, matching this task's own testability requirement.
 *
 * **Actual finding on `uiohook-napi`'s event shape (verified by installing the real published
 * package, `uiohook-napi@1.5.5`, and reading its shipped `dist/index.d.ts`/`dist/index.js`, not
 * merely assumed from the ADR):** every keyboard event (`UiohookKeyboardEvent`, delivered via both
 * `'keydown'`/`EVENT_KEY_PRESSED` and `'keyup'`/`EVENT_KEY_RELEASED`) and every mouse-button event
 * (`UiohookMouseEvent`, delivered via `'mousedown'`/`'mouseup'`) already carries the *current*
 * `ctrlKey`/`altKey`/`shiftKey`/`metaKey` boolean modifier state directly alongside the event's own
 * `keycode`/`button` — libuiohook does not fire one event per physical key that a consumer would need
 * to correlate itself. This is a strictly better fit than the ADR's own "investigate this" framing
 * left open: modifier combinations are natively representable with no combining logic of this
 * module's own invention. `keycode` values are `uiohook-napi`'s own `UiohookKey` numeric constants
 * (Windows scan-code-derived, e.g. `UiohookKey.V === 0x2F`); `button` values are libuiohook's own
 * `MOUSE_BUTTON1..5` ordinals (1 = left, 2 = right, 3 = middle, 4/5 = the side/thumb buttons a gamer
 * PTT bind commonly wants) — this module never invents a parallel code space for either.
 */

/**
 * Exact modifier-key requirement for a {@link PttBinding}. Every field is a plain, non-optional
 * boolean — there is no "don't care" state. A binding activates only when the observed event's own
 * modifier flags match this record exactly, so binding a bare `V` never also activates while the user
 * happens to be mid-way through an unrelated `Ctrl+V`, and binding `Ctrl+Shift+V` never activates on
 * a plain `V`. This mirrors this package's existing preference for explicit tri-state results over
 * guessed defaults (see `capability.ts`'s `detectedBuild: number | undefined`, never a guessed number).
 *
 * One deliberate exception to "exact match," documented in full on {@link PttBindingMatcher.handle}:
 * exact-match is enforced only for the *down* transition. The *up* transition intentionally ignores
 * this record entirely once a binding is active, because Requirement 3/ADR 0021's "no way to get
 * stuck open" guarantee is otherwise breakable (see that method's doc comment for the exact scenario).
 */
export interface PttModifierState {
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
  readonly meta: boolean;
}

/** Convenience constant for "no modifier held" — most PTT bindings (a single free key, e.g. an unused
 * side mouse button or a rarely-used keyboard key) need no modifier at all. */
export const NO_PTT_MODIFIERS: PttModifierState = {
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
};

/**
 * One user-configured Push-to-Talk binding: a plain, JSON-serializable data structure (no functions,
 * no classes, no `Map`/`Set`) since this shape is designed to cross an Electron IPC boundary in a
 * later phase (Main <-> Renderer, and eventually Main <-> `settings.json`) without any transform.
 *
 * `keyboard.keycode` and `mouseButton.button` are `uiohook-napi`'s own numeric code spaces verbatim
 * (see this module's doc comment) — deliberately not re-mapped into a private enum, which would be an
 * avoidable second source of truth that could silently drift from the library's own values. A future
 * Settings-capture UI (out of this task's scope) is expected to read `keycode`/`button` and the four
 * modifier flags directly off the real `uiohook-napi` event it captures during "press a key to bind"
 * flow, including when the bound key is itself a modifier key (see the note on
 * {@link PttBindingMatcher.handle} about binding a bare `Ctrl`/`Alt`/`Shift`/`Meta` key).
 */
export type PttBinding =
  | {
      readonly kind: 'keyboard';
      readonly keycode: number;
      readonly modifiers: PttModifierState;
    }
  | {
      readonly kind: 'mouseButton';
      readonly button: number;
      readonly modifiers: PttModifierState;
    };

/** The subset of `uiohook-napi`'s own `UiohookKeyboardEvent` shape this module's matching logic
 * actually reads, declared locally rather than imported from `uiohook-napi` — this is what keeps this
 * file (and every test exercising it) free of any dependency on the real native module. See
 * `ptt-hotkey-listener.ts` for the one real boundary where the actual library's events are narrowed
 * down to this shape. */
export interface RawKeyboardEvent {
  readonly keycode: number;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

/** The subset of `uiohook-napi`'s own `UiohookMouseEvent` shape this module's matching logic actually
 * reads. See {@link RawKeyboardEvent}'s doc comment — same rationale. */
export interface RawMouseButtonEvent {
  readonly button: number;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
}

/** One observed, already-edge-classified native input event fed into {@link PttBindingMatcher}. The
 * `edge` field mirrors which real `uiohook-napi` event delivered it (`'down'` <- `'keydown'`/
 * `'mousedown'`, `'up'` <- `'keyup'`/`'mouseup'`) — this module never receives, and has no shape for,
 * anything else `uiohook-napi` can emit (`'mousemove'`, `'wheel'`, `'click'`, the generic `'input'`
 * firehose) because `ptt-hotkey-listener.ts` never subscribes to those events for a listener it
 * constructs, not merely because this type excludes them. */
export type PttRawInputEvent =
  | { readonly source: 'keyboard'; readonly edge: 'down' | 'up'; readonly event: RawKeyboardEvent }
  | {
      readonly source: 'mouseButton';
      readonly edge: 'down' | 'up';
      readonly event: RawMouseButtonEvent;
    };

/** The narrow, closed output this whole feature exists to produce — never a raw keystroke stream,
 * never "everything," exactly the ADR's own stated interface intent. */
export type PttEdgeEvent = { readonly type: 'down' } | { readonly type: 'up' };

/**
 * Pure, synchronous edge detector for exactly one {@link PttBinding}. One instance tracks exactly one
 * binding's current "is it currently held" state; construct a fresh instance per binding (this is
 * cheap — it holds a single boolean) rather than trying to reuse one instance across a rebind.
 *
 * This is the injectable logic Requirement/testing guidance asks for: `ptt-hotkey-listener.ts` is the
 * only place that ever constructs this class against real `uiohook-napi` events; every behavior this
 * class implements (filtering, repeat suppression, edge detection) is exercised directly in
 * `tests/windows-media/ptt-binding.test.ts` by feeding it synthetic {@link PttRawInputEvent} values —
 * no real global input, no real native module, required to prove this logic correct.
 */
export class PttBindingMatcher {
  private readonly binding: PttBinding;
  private isDown = false;

  constructor(binding: PttBinding) {
    this.binding = binding;
  }

  /** Whether this binding is currently considered "held" — exposed only for tests/diagnostics; the
   * only externally meaningful signal is still the `PttEdgeEvent`s `handle()` returns. */
  get currentlyDown(): boolean {
    return this.isDown;
  }

  /**
   * Feeds one raw native event through this binding's matching logic. Returns the `PttEdgeEvent` this
   * event produces, or `undefined` if the event does not affect this binding at all — the caller must
   * never forward anything other than this return value onward (Requirement 1: an irrelevant key is
   * filtered in the same tick it arrives, never buffered, logged, or otherwise observable past this
   * call).
   *
   * **Down transition — exact modifier match, and real repeat suppression.** A `'down'` edge fires
   * only the first time this binding's own key/button code and exact modifier state
   * ({@link PttModifierState}) are observed while the binding was not already down; every subsequent
   * `'down'`-edge event for the same code while still down (OS key-repeat, or a duplicate native
   * event) is silently absorbed with no repeated activation (Requirement 3).
   *
   * **Up transition — deliberately *not* gated on modifier match, for a specific, load-bearing
   * reason.** Consider binding `Ctrl+V`: the user presses Ctrl, then V (activates, `ctrlKey: true`
   * matches). If the user releases Ctrl *before* releasing V, libuiohook still fires a `'keyup'` for V
   * whose `ctrlKey` flag is now `false` (Ctrl is no longer held) — if this method required an exact
   * modifier match on the up edge too, that keyup would fail to match and this binding would report
   * "held" forever with no way to ever observe its release, a stuck-open transmit state this
   * product's own PTT requirement (ADR 0021: "releasing the key must stop transmission immediately,
   * with no way to get stuck open") explicitly forbids. The up transition therefore matches on the
   * bound key/button code alone, and only while this binding is currently down — this is strictly
   * *more* permissive on release than on activation, which is the safe direction for a transmit-stop
   * signal to err toward.
   *
   * A binding whose own key is itself a modifier (e.g. binding bare `Ctrl` as the PTT key) is not
   * special-cased here: the down event's own `ctrlKey` flag is `true` in that case purely because
   * pressing Ctrl sets it, and a caller/UI that captured this binding from a real key-down event would
   * naturally have recorded `modifiers.ctrl: true` alongside `keycode: UiohookKey.Ctrl` — the match
   * logic above still applies unchanged and correctly.
   */
  handle(raw: PttRawInputEvent): PttEdgeEvent | undefined {
    if (raw.source !== this.binding.kind) return undefined;

    const codeMatches =
      raw.source === 'keyboard'
        ? this.binding.kind === 'keyboard' && raw.event.keycode === this.binding.keycode
        : this.binding.kind === 'mouseButton' && raw.event.button === this.binding.button;
    if (!codeMatches) return undefined;

    if (raw.edge === 'down') {
      if (this.isDown) return undefined; // OS key-repeat / duplicate-event suppression.
      if (!this.modifiersMatch(raw.event)) return undefined;
      this.isDown = true;
      return { type: 'down' };
    }

    // edge === 'up': code-only match while active — see this method's doc comment above.
    if (!this.isDown) return undefined;
    this.isDown = false;
    return { type: 'up' };
  }

  private modifiersMatch(event: RawKeyboardEvent | RawMouseButtonEvent): boolean {
    const wanted = this.binding.modifiers;
    return (
      event.ctrlKey === wanted.ctrl &&
      event.altKey === wanted.alt &&
      event.shiftKey === wanted.shift &&
      event.metaKey === wanted.meta
    );
  }
}
