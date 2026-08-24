import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T13.4 — `main/ptt-hotkey.ts`'s own lifecycle/conflict-probe logic, exercised with a mocked
 * `electron` `globalShortcut` and a mocked `@disco-voador/windows-media`'s `startPttHotkeyListener`
 * (never the real native `uiohook-napi` listener — this is a Main-process unit test, not an E2E
 * smoke test). Mirrors `process-audio.test.ts`'s own "mock the native boundary, test the lifecycle
 * glue" scope split.
 */

const registerMock = vi.fn(() => true);
const unregisterMock = vi.fn();

vi.mock('electron', () => ({
  globalShortcut: {
    register: registerMock,
    unregister: unregisterMock,
  },
}));

const startPttHotkeyListenerMock = vi.fn();

vi.mock('@disco-voador/windows-media', () => ({
  startPttHotkeyListener: startPttHotkeyListenerMock,
}));

async function freshPttHotkey() {
  vi.resetModules();
  return import('../../apps/desktop/src/main/ptt-hotkey.js');
}

const KEYBOARD_BINDING = {
  kind: 'keyboard' as const,
  keycode: 47, // 'V', per uiohook-napi's own UiohookKey.V
  modifiers: { ctrl: false, alt: false, shift: false, meta: false },
};

const MOUSE_BINDING = {
  kind: 'mouseButton' as const,
  button: 4,
  modifiers: { ctrl: false, alt: false, shift: false, meta: false },
};

function fakeListener() {
  return { stop: vi.fn() };
}

function fakeWebContents(): WebContents {
  return { isDestroyed: () => false, send: vi.fn() } as unknown as WebContents;
}

describe('ptt-hotkey', () => {
  beforeEach(() => {
    registerMock.mockReset().mockReturnValue(true);
    unregisterMock.mockReset();
    startPttHotkeyListenerMock.mockReset();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('starts the real listener when no conflict is detected for a keyboard binding', async () => {
    const listener = fakeListener();
    startPttHotkeyListenerMock.mockResolvedValueOnce({ ok: true, listener });
    const { setPttShortcut } = await freshPttHotkey();

    const result = await setPttShortcut(KEYBOARD_BINDING);

    expect(result).toEqual({ ok: true });
    expect(registerMock).toHaveBeenCalledWith('V', expect.any(Function));
    expect(unregisterMock).toHaveBeenCalledWith('V');
    expect(startPttHotkeyListenerMock).toHaveBeenCalledWith(KEYBOARD_BINDING, expect.any(Function));
  });

  it('builds a full modifier-qualified accelerator for the conflict probe', async () => {
    startPttHotkeyListenerMock.mockResolvedValueOnce({ ok: true, listener: fakeListener() });
    const { setPttShortcut } = await freshPttHotkey();

    await setPttShortcut({
      kind: 'keyboard',
      keycode: 47,
      modifiers: { ctrl: true, alt: false, shift: true, meta: false },
    });

    expect(registerMock).toHaveBeenCalledWith('Control+Shift+V', expect.any(Function));
  });

  it('reports a conflict (and never starts the real listener) when globalShortcut.register fails', async () => {
    registerMock.mockReturnValue(false);
    const { setPttShortcut } = await freshPttHotkey();

    const result = await setPttShortcut(KEYBOARD_BINDING);

    expect(result).toMatchObject({ ok: false, reason: 'conflict' });
    expect(unregisterMock).not.toHaveBeenCalled();
    expect(startPttHotkeyListenerMock).not.toHaveBeenCalled();
  });

  it('never probes for a mouseButton binding (globalShortcut has no mouse-button concept) and starts directly', async () => {
    startPttHotkeyListenerMock.mockResolvedValueOnce({ ok: true, listener: fakeListener() });
    const { setPttShortcut } = await freshPttHotkey();

    const result = await setPttShortcut(MOUSE_BINDING);

    expect(result).toEqual({ ok: true });
    expect(registerMock).not.toHaveBeenCalled();
    expect(startPttHotkeyListenerMock).toHaveBeenCalledWith(MOUSE_BINDING, expect.any(Function));
  });

  it('forwards startPttHotkeyListener native-module-load-failed / hook-start-failed reasons unchanged', async () => {
    startPttHotkeyListenerMock.mockResolvedValueOnce({
      ok: false,
      reason: 'hook-start-failed',
      message: 'SetWindowsHookEx failed',
    });
    const { setPttShortcut } = await freshPttHotkey();

    const result = await setPttShortcut(KEYBOARD_BINDING);

    expect(result).toEqual({
      ok: false,
      reason: 'hook-start-failed',
      message: 'SetWindowsHookEx failed',
    });
  });

  it('never leaves two listeners active: stops the previous one only after the new one starts', async () => {
    const firstListener = fakeListener();
    const secondListener = fakeListener();
    startPttHotkeyListenerMock
      .mockResolvedValueOnce({ ok: true, listener: firstListener })
      .mockResolvedValueOnce({ ok: true, listener: secondListener });
    const { setPttShortcut } = await freshPttHotkey();

    await setPttShortcut(KEYBOARD_BINDING);
    expect(firstListener.stop).not.toHaveBeenCalled();

    await setPttShortcut({ ...KEYBOARD_BINDING, keycode: 48 });
    expect(firstListener.stop).toHaveBeenCalledTimes(1);
    expect(secondListener.stop).not.toHaveBeenCalled();
  });

  it('never stops the still-running listener if a rebind attempt fails', async () => {
    const firstListener = fakeListener();
    startPttHotkeyListenerMock
      .mockResolvedValueOnce({ ok: true, listener: firstListener })
      .mockResolvedValueOnce({ ok: false, reason: 'hook-start-failed', message: 'boom' });
    const { setPttShortcut } = await freshPttHotkey();

    await setPttShortcut(KEYBOARD_BINDING);
    const result = await setPttShortcut({ ...KEYBOARD_BINDING, keycode: 48 });

    expect(result.ok).toBe(false);
    expect(firstListener.stop).not.toHaveBeenCalled();
  });

  it('clearPttShortcut stops the current listener and is idempotent', async () => {
    const listener = fakeListener();
    startPttHotkeyListenerMock.mockResolvedValueOnce({ ok: true, listener });
    const { setPttShortcut, clearPttShortcut } = await freshPttHotkey();

    await setPttShortcut(KEYBOARD_BINDING);
    clearPttShortcut();
    clearPttShortcut();

    expect(listener.stop).toHaveBeenCalledTimes(1);
  });

  it('stopPttHotkeyListener (app-quit path) stops whatever listener is currently running', async () => {
    const listener = fakeListener();
    startPttHotkeyListenerMock.mockResolvedValueOnce({ ok: true, listener });
    const { setPttShortcut, stopPttHotkeyListener } = await freshPttHotkey();

    await setPttShortcut(KEYBOARD_BINDING);
    stopPttHotkeyListener();

    expect(listener.stop).toHaveBeenCalledTimes(1);
  });

  it('initializePttHotkeyFromSettings is a silent no-op for a null (never-configured) binding', async () => {
    const { initializePttHotkeyFromSettings } = await freshPttHotkey();

    await initializePttHotkeyFromSettings(null);

    expect(startPttHotkeyListenerMock).not.toHaveBeenCalled();
  });

  it('initializePttHotkeyFromSettings starts the persisted binding without a conflict probe', async () => {
    const listener = fakeListener();
    startPttHotkeyListenerMock.mockResolvedValueOnce({ ok: true, listener });
    const { initializePttHotkeyFromSettings, stopPttHotkeyListener } = await freshPttHotkey();

    await initializePttHotkeyFromSettings(KEYBOARD_BINDING);

    expect(startPttHotkeyListenerMock).toHaveBeenCalledWith(KEYBOARD_BINDING, expect.any(Function));
    expect(registerMock).not.toHaveBeenCalled();

    stopPttHotkeyListener();
    expect(listener.stop).toHaveBeenCalledTimes(1);
  });

  it('initializePttHotkeyFromSettings never throws on a startup failure', async () => {
    startPttHotkeyListenerMock.mockResolvedValueOnce({
      ok: false,
      reason: 'native-module-load-failed',
      message: 'boom',
    });
    const { initializePttHotkeyFromSettings } = await freshPttHotkey();

    await expect(initializePttHotkeyFromSettings(KEYBOARD_BINDING)).resolves.toBeUndefined();
  });

  it('forwards every real down/up edge to the current push target via webContents.send', async () => {
    let forwarder: (event: { type: 'down' | 'up' }) => void = () => undefined;
    startPttHotkeyListenerMock.mockImplementationOnce(
      async (_binding: unknown, onEvent: (event: { type: 'down' | 'up' }) => void) => {
        forwarder = onEvent;
        return { ok: true, listener: fakeListener() };
      },
    );
    const { setPttShortcut, setPttPushTarget } = await freshPttHotkey();
    const webContents = fakeWebContents();
    setPttPushTarget(webContents);

    await setPttShortcut(KEYBOARD_BINDING);
    forwarder({ type: 'down' });

    expect(webContents.send).toHaveBeenCalledWith('app:ptt-state', { type: 'down' });
  });
});
