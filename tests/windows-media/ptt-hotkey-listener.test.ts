import { beforeEach, describe, expect, it, vi } from 'vitest';
import { uIOhook } from 'uiohook-napi';

import { NO_PTT_MODIFIERS, type PttBinding } from '../../packages/windows-media/src/ptt-binding.js';
import { startPttHotkeyListener } from '../../packages/windows-media/src/ptt-hotkey-listener.js';

/**
 * Mocks `uiohook-napi` itself, never `ptt-hotkey-listener.ts`'s own logic — this test exercises the
 * real wrapper module end to end (listener attach/detach, `start()`/`stop()` error handling, restart
 * behavior) against a fake native singleton shaped exactly like the real `uIOhook` EventEmitter (`on`/
 * `off`/`start`/`stop`, plus a test-only `emit`/`listenerCount` used only from this file to drive and
 * assert against it — the real library also happens to expose `emit`/`listenerCount` since `uIOhook`
 * is a real `EventEmitter`, so this fake's shape is not inventing anything the real object lacks).
 * `control` lets individual tests make `start()`/`stop()` throw, reproducing the real native failure
 * paths found by reading `uiohook-napi`'s own `addon.c` (see `ptt-hotkey-listener.ts`'s doc comment).
 */
const control = vi.hoisted(() => ({
  startError: undefined as Error | undefined,
  stopError: undefined as Error | undefined,
}));

vi.mock('uiohook-napi', () => {
  type Listener = (event: unknown) => void;
  const listeners = new Map<string, Set<Listener>>();
  const uIOhook = {
    on(event: string, cb: Listener) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(cb);
    },
    off(event: string, cb: Listener) {
      listeners.get(event)?.delete(cb);
    },
    start() {
      if (control.startError) throw control.startError;
    },
    stop() {
      if (control.stopError) throw control.stopError;
    },
    emit(event: string, payload: unknown) {
      for (const cb of [...(listeners.get(event) ?? [])]) cb(payload);
    },
    listenerCount(event: string) {
      return listeners.get(event)?.size ?? 0;
    },
  };
  return { uIOhook };
});

const fakeUIOhook = uIOhook as unknown as {
  emit: (event: string, payload: unknown) => void;
  listenerCount: (event: string) => number;
};

const noRawModifiers = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };

const vBinding: PttBinding = { kind: 'keyboard', keycode: 0x2f, modifiers: NO_PTT_MODIFIERS };

beforeEach(() => {
  control.startError = undefined;
  control.stopError = undefined;
});

describe('startPttHotkeyListener', () => {
  it('reports down/up for the configured binding and silently ignores everything else', async () => {
    const events: string[] = [];
    const result = await startPttHotkeyListener(vBinding, (e) => events.push(e.type));
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    fakeUIOhook.emit('keydown', { keycode: 0x1e, ...noRawModifiers }); // 'A' — irrelevant
    fakeUIOhook.emit('keydown', { keycode: 0x2f, ...noRawModifiers }); // matches -> down
    fakeUIOhook.emit('keydown', { keycode: 0x2f, ...noRawModifiers }); // OS repeat -> suppressed
    fakeUIOhook.emit('keyup', { keycode: 0x2f, ...noRawModifiers }); // matches -> up

    expect(events).toEqual(['down', 'up']);
    result.listener.stop();
  });

  it('only subscribes to the two events relevant to a keyboard binding', async () => {
    const result = await startPttHotkeyListener(vBinding, () => {});
    if (!result.ok) throw new Error('expected ok result');
    expect(fakeUIOhook.listenerCount('keydown')).toBe(1);
    expect(fakeUIOhook.listenerCount('keyup')).toBe(1);
    expect(fakeUIOhook.listenerCount('mousedown')).toBe(0);
    expect(fakeUIOhook.listenerCount('mouseup')).toBe(0);
    result.listener.stop();
  });

  it('only subscribes to the two events relevant to a mouse-button binding', async () => {
    const mouseBinding: PttBinding = {
      kind: 'mouseButton',
      button: 4,
      modifiers: NO_PTT_MODIFIERS,
    };
    const result = await startPttHotkeyListener(mouseBinding, () => {});
    if (!result.ok) throw new Error('expected ok result');
    expect(fakeUIOhook.listenerCount('mousedown')).toBe(1);
    expect(fakeUIOhook.listenerCount('mouseup')).toBe(1);
    expect(fakeUIOhook.listenerCount('keydown')).toBe(0);
    expect(fakeUIOhook.listenerCount('keyup')).toBe(0);
    result.listener.stop();
  });

  it('stop() fully tears down: no further callbacks and no leaked listeners (Requirement 5)', async () => {
    const events: string[] = [];
    const result = await startPttHotkeyListener(vBinding, (e) => events.push(e.type));
    if (!result.ok) throw new Error('expected ok result');

    result.listener.stop();
    fakeUIOhook.emit('keydown', { keycode: 0x2f, ...noRawModifiers });

    expect(events).toEqual([]);
    expect(fakeUIOhook.listenerCount('keydown')).toBe(0);
    expect(fakeUIOhook.listenerCount('keyup')).toBe(0);
  });

  it('stop() is idempotent', async () => {
    const result = await startPttHotkeyListener(vBinding, () => {});
    if (!result.ok) throw new Error('expected ok result');
    result.listener.stop();
    expect(() => result.listener.stop()).not.toThrow();
  });

  it('permits a clean restart with a different binding after stop() (Requirement 5)', async () => {
    const first = await startPttHotkeyListener(vBinding, () => {});
    if (!first.ok) throw new Error('expected ok result');
    first.listener.stop();

    const events: string[] = [];
    const mouseBinding: PttBinding = {
      kind: 'mouseButton',
      button: 4,
      modifiers: NO_PTT_MODIFIERS,
    };
    const second = await startPttHotkeyListener(mouseBinding, (e) => events.push(e.type));
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    fakeUIOhook.emit('mousedown', { button: 4, ...noRawModifiers });
    fakeUIOhook.emit('mouseup', { button: 4, ...noRawModifiers });
    expect(events).toEqual(['down', 'up']);

    // The old binding's own keydown listener must be long gone — proves stop() really detached it
    // rather than merely being shadowed by the new registration.
    expect(fakeUIOhook.listenerCount('keydown')).toBe(0);

    second.listener.stop();
  });

  it(
    'surfaces a typed failure rather than an uncaught throw when the native hook fails to start ' +
      '(Requirement 6)',
    async () => {
      control.startError = new Error('UIOHOOK_ERROR_SET_WINDOWS_HOOK_EX');
      const result = await startPttHotkeyListener(vBinding, () => {});
      expect(result).toEqual({
        ok: false,
        reason: 'hook-start-failed',
        message: 'UIOHOOK_ERROR_SET_WINDOWS_HOOK_EX',
      });
      // A failed start must not leave this attempt's own listeners attached.
      expect(fakeUIOhook.listenerCount('keydown')).toBe(0);
      expect(fakeUIOhook.listenerCount('keyup')).toBe(0);
    },
  );

  it('stop() swallows a native uIOhook.stop() failure without throwing or leaking listeners', async () => {
    const result = await startPttHotkeyListener(vBinding, () => {});
    if (!result.ok) throw new Error('expected ok result');

    control.stopError = new Error('UIOHOOK_FAILURE');
    expect(() => result.listener.stop()).not.toThrow();
    expect(fakeUIOhook.listenerCount('keydown')).toBe(0);
    expect(fakeUIOhook.listenerCount('keyup')).toBe(0);
  });
});
