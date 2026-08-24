import { describe, expect, it } from 'vitest';

import {
  NO_PTT_MODIFIERS,
  PttBindingMatcher,
  type PttBinding,
  type PttRawInputEvent,
  type RawKeyboardEvent,
} from '../../packages/windows-media/src/ptt-binding.js';

const keyboardBinding: PttBinding = {
  kind: 'keyboard',
  keycode: 0x2f, // UiohookKey.V
  modifiers: NO_PTT_MODIFIERS,
};

const noRawModifiers = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };

function keyDown(overrides: Partial<RawKeyboardEvent> = {}): PttRawInputEvent {
  return {
    source: 'keyboard',
    edge: 'down',
    event: { keycode: 0x2f, ...noRawModifiers, ...overrides },
  };
}

function keyUp(overrides: Partial<RawKeyboardEvent> = {}): PttRawInputEvent {
  return {
    source: 'keyboard',
    edge: 'up',
    event: { keycode: 0x2f, ...noRawModifiers, ...overrides },
  };
}

describe('PttBindingMatcher — keyboard bindings', () => {
  it('ignores every keycode other than the configured binding (filtering, Requirement 1)', () => {
    const matcher = new PttBindingMatcher(keyboardBinding);
    expect(matcher.handle(keyDown({ keycode: 0x1e }))).toBeUndefined(); // 'A'
    expect(matcher.handle(keyDown({ keycode: 0x39 }))).toBeUndefined(); // Space
    expect(matcher.currentlyDown).toBe(false);
  });

  it('produces exactly one down event, suppressing OS key-repeat (Requirement 3)', () => {
    const matcher = new PttBindingMatcher(keyboardBinding);
    expect(matcher.handle(keyDown())).toEqual({ type: 'down' });
    // Simulates repeated keydown events fired by OS auto-repeat while the key stays physically held.
    expect(matcher.handle(keyDown())).toBeUndefined();
    expect(matcher.handle(keyDown())).toBeUndefined();
    expect(matcher.currentlyDown).toBe(true);
  });

  it('produces the up transition on a matching keyup while active', () => {
    const matcher = new PttBindingMatcher(keyboardBinding);
    matcher.handle(keyDown());
    expect(matcher.handle(keyUp())).toEqual({ type: 'up' });
    expect(matcher.currentlyDown).toBe(false);
  });

  it('never produces a spurious up when the binding was never activated', () => {
    const matcher = new PttBindingMatcher(keyboardBinding);
    expect(matcher.handle(keyUp())).toBeUndefined();
  });

  it('ignores keyup for a different keycode entirely while active', () => {
    const matcher = new PttBindingMatcher(keyboardBinding);
    matcher.handle(keyDown());
    expect(matcher.handle(keyUp({ keycode: 0x1e }))).toBeUndefined();
    expect(matcher.currentlyDown).toBe(true);
  });

  it('re-arms after an up transition — a later down activates again', () => {
    const matcher = new PttBindingMatcher(keyboardBinding);
    expect(matcher.handle(keyDown())).toEqual({ type: 'down' });
    expect(matcher.handle(keyUp())).toEqual({ type: 'up' });
    expect(matcher.handle(keyDown())).toEqual({ type: 'down' });
  });

  it('requires an exact modifier match to activate', () => {
    const ctrlShiftBinding: PttBinding = {
      kind: 'keyboard',
      keycode: 0x2f,
      modifiers: { ctrl: true, alt: false, shift: true, meta: false },
    };
    const matcher = new PttBindingMatcher(ctrlShiftBinding);
    // Only Ctrl held (missing Shift) must not activate.
    expect(matcher.handle(keyDown({ ctrlKey: true }))).toBeUndefined();
    // Extra unrequested modifier (Alt) also must not activate — exact match, not "at least".
    expect(
      matcher.handle(keyDown({ ctrlKey: true, shiftKey: true, altKey: true })),
    ).toBeUndefined();
    // Exact match activates.
    expect(matcher.handle(keyDown({ ctrlKey: true, shiftKey: true }))).toEqual({ type: 'down' });
  });

  it('a plain (no-modifier) binding does not activate while an unrelated modifier is held', () => {
    const matcher = new PttBindingMatcher(keyboardBinding);
    expect(matcher.handle(keyDown({ ctrlKey: true }))).toBeUndefined();
  });

  it(
    'releases even if a held modifier was released first — the deliberate "no stuck-open transmit" ' +
      'behavior (up transition is never gated on modifier match)',
    () => {
      const ctrlBinding: PttBinding = {
        kind: 'keyboard',
        keycode: 0x2f,
        modifiers: { ctrl: true, alt: false, shift: false, meta: false },
      };
      const matcher = new PttBindingMatcher(ctrlBinding);
      expect(matcher.handle(keyDown({ ctrlKey: true }))).toEqual({ type: 'down' });
      // Ctrl released first; the V keyup now arrives with ctrlKey: false.
      expect(matcher.handle(keyUp({ ctrlKey: false }))).toEqual({ type: 'up' });
      expect(matcher.currentlyDown).toBe(false);
    },
  );
});

describe('PttBindingMatcher — mouse button bindings', () => {
  const sideButtonBinding: PttBinding = {
    kind: 'mouseButton',
    button: 4, // libuiohook MOUSE_BUTTON4, a common gamer side-button PTT choice
    modifiers: NO_PTT_MODIFIERS,
  };

  it('ignores keyboard events entirely for a mouse-button binding', () => {
    const matcher = new PttBindingMatcher(sideButtonBinding);
    expect(matcher.handle(keyDown())).toBeUndefined();
  });

  it('ignores a different mouse button', () => {
    const matcher = new PttBindingMatcher(sideButtonBinding);
    const wrongButton: PttRawInputEvent = {
      source: 'mouseButton',
      edge: 'down',
      event: { button: 1, ...noRawModifiers },
    };
    expect(matcher.handle(wrongButton)).toBeUndefined();
  });

  it('produces a real down/up lifecycle for the configured button', () => {
    const matcher = new PttBindingMatcher(sideButtonBinding);
    const down: PttRawInputEvent = {
      source: 'mouseButton',
      edge: 'down',
      event: { button: 4, ...noRawModifiers },
    };
    const up: PttRawInputEvent = {
      source: 'mouseButton',
      edge: 'up',
      event: { button: 4, ...noRawModifiers },
    };
    expect(matcher.handle(down)).toEqual({ type: 'down' });
    expect(matcher.handle(down)).toBeUndefined(); // repeat suppression applies to mouse buttons too
    expect(matcher.handle(up)).toEqual({ type: 'up' });
  });

  it('ignores a mouse event for a keyboard binding', () => {
    const matcher = new PttBindingMatcher(keyboardBinding);
    const mouseDown: PttRawInputEvent = {
      source: 'mouseButton',
      edge: 'down',
      event: { button: 4, ...noRawModifiers },
    };
    expect(matcher.handle(mouseDown)).toBeUndefined();
  });
});
