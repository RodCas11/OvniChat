import { describe, expect, it } from 'vitest';

import {
  describePttBinding,
  pttBindingFromKeyboardEvent,
  pttBindingFromMouseEvent,
} from '../../apps/desktop/src/renderer/voice/ptt-capture.js';

const NO_MODIFIERS = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };

describe('pttBindingFromKeyboardEvent', () => {
  it('maps a plain letter key to the real uiohook-napi keycode, with no modifiers', () => {
    expect(pttBindingFromKeyboardEvent({ code: 'KeyV', ...NO_MODIFIERS })).toEqual({
      kind: 'keyboard',
      keycode: 47,
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    });
  });

  it('captures every held modifier exactly', () => {
    expect(
      pttBindingFromKeyboardEvent({
        code: 'KeyV',
        ctrlKey: true,
        altKey: false,
        shiftKey: true,
        metaKey: false,
      }),
    ).toEqual({
      kind: 'keyboard',
      keycode: 47,
      modifiers: { ctrl: true, alt: false, shift: true, meta: false },
    });
  });

  it('maps digits and function keys correctly', () => {
    expect(pttBindingFromKeyboardEvent({ code: 'Digit5', ...NO_MODIFIERS })?.kind).toBe('keyboard');
    expect(
      (pttBindingFromKeyboardEvent({ code: 'Digit5', ...NO_MODIFIERS }) as { keycode: number })
        .keycode,
    ).toBe(6);
    expect(
      (pttBindingFromKeyboardEvent({ code: 'F5', ...NO_MODIFIERS }) as { keycode: number }).keycode,
    ).toBe(63);
  });

  it('returns undefined for a key outside the supported subset, never a wrong/silent mapping', () => {
    expect(pttBindingFromKeyboardEvent({ code: 'ControlLeft', ...NO_MODIFIERS })).toBeUndefined();
    expect(pttBindingFromKeyboardEvent({ code: 'NumpadEnter', ...NO_MODIFIERS })).toBeUndefined();
  });
});

describe('pttBindingFromMouseEvent', () => {
  it('maps DOM mouse button ordinals to the real uiohook-napi MOUSE_BUTTON ordinals (different order)', () => {
    expect(pttBindingFromMouseEvent({ button: 0, ...NO_MODIFIERS })).toEqual({
      kind: 'mouseButton',
      button: 1, // left
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    });
    expect(pttBindingFromMouseEvent({ button: 2, ...NO_MODIFIERS })).toEqual({
      kind: 'mouseButton',
      button: 2, // right
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    });
    expect(pttBindingFromMouseEvent({ button: 3, ...NO_MODIFIERS })).toEqual({
      kind: 'mouseButton',
      button: 4, // back/side
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    });
    expect(pttBindingFromMouseEvent({ button: 4, ...NO_MODIFIERS })).toEqual({
      kind: 'mouseButton',
      button: 5, // forward/side
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    });
  });

  it('returns undefined for an unrecognized button ordinal', () => {
    expect(pttBindingFromMouseEvent({ button: 99, ...NO_MODIFIERS })).toBeUndefined();
  });
});

describe('describePttBinding', () => {
  it('describes a bare key with no modifiers', () => {
    expect(
      describePttBinding({
        kind: 'keyboard',
        keycode: 47,
        modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      }),
    ).toBe('V');
  });

  it('describes modifiers in a stable, readable order', () => {
    expect(
      describePttBinding({
        kind: 'keyboard',
        keycode: 47,
        modifiers: { ctrl: true, alt: false, shift: true, meta: false },
      }),
    ).toBe('Ctrl+Shift+V');
  });

  it('describes a mouse button binding by name, never a raw ordinal', () => {
    expect(
      describePttBinding({
        kind: 'mouseButton',
        button: 4,
        modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      }),
    ).toBe('Mouse Back');
  });

  it('never throws for an unrecognized code, falling back to an honest label', () => {
    expect(
      describePttBinding({
        kind: 'keyboard',
        keycode: 999999,
        modifiers: { ctrl: false, alt: false, shift: false, meta: false },
      }),
    ).toBe('(unrecognized key)');
  });
});
