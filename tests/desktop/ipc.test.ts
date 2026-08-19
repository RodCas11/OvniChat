import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const handlers = new Map<string, Handler>();
const ipcHandleSpy = vi.fn((channel: string, listener: Handler) => {
  handlers.set(channel, listener);
});

const listScreenShareSourcesMock = vi.fn(async () => [
  {
    id: 'screen:0:0',
    name: 'Entire Screen',
    type: 'screen' as const,
    thumbnailDataUrl: 'data:image/png;base64,abc',
    appIconDataUrl: undefined,
    displayId: undefined,
  },
]);
const selectScreenShareSourceMock = vi.fn((sourceId: string) => sourceId === 'screen:0:0');

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0' },
  ipcMain: { handle: ipcHandleSpy },
}));

vi.mock('../../apps/desktop/src/main/screen-share.js', () => ({
  listScreenShareSources: listScreenShareSourcesMock,
  selectScreenShareSource: selectScreenShareSourceMock,
}));

const { IPC_CHANNELS } = await import('../../apps/desktop/src/shared/ipc-contract.js');
const { isTrustedSender, registerIpcHandlers } = await import('../../apps/desktop/src/main/ipc.js');

function fakeMainWebContents(id: number): WebContents {
  return { id } as unknown as WebContents;
}

function fakeEvent(senderId: number, frameUrl: string | undefined): IpcMainInvokeEvent {
  return {
    sender: { id: senderId },
    senderFrame: frameUrl ? { url: frameUrl } : null,
  } as unknown as IpcMainInvokeEvent;
}

describe('isTrustedSender', () => {
  const mainWebContents = fakeMainWebContents(1);
  const allowedOrigins = ['app://renderer'];

  it('trusts the main window sending from the allowed origin', () => {
    expect(
      isTrustedSender(fakeEvent(1, 'app://renderer/index.html'), mainWebContents, allowedOrigins),
    ).toBe(true);
  });

  it('rejects a different sender id (e.g. a devtools or foreign webContents)', () => {
    expect(
      isTrustedSender(fakeEvent(2, 'app://renderer/index.html'), mainWebContents, allowedOrigins),
    ).toBe(false);
  });

  it('rejects a sender frame outside the allowed origin', () => {
    expect(
      isTrustedSender(fakeEvent(1, 'https://evil.example/'), mainWebContents, allowedOrigins),
    ).toBe(false);
  });

  it('rejects a missing sender frame', () => {
    expect(isTrustedSender(fakeEvent(1, undefined), mainWebContents, allowedOrigins)).toBe(false);
  });
});

describe('registerIpcHandlers', () => {
  // `registerIpcHandlers` registers the IPC handler with `ipcMain.handle` at most once per
  // process (see the idempotency test below), so — unlike a typical mock — `handlers` is
  // intentionally *not* reset between these tests: every test after the first observes the same
  // registered listener, which is exactly the behavior under test.
  const allowedOrigins = ['app://renderer'];

  const realtimeConfig = { url: 'ws://127.0.0.1:8090', iceServers: [] };

  it('returns version info for a trusted sender', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);

    const handler = handlers.get(IPC_CHANNELS.getVersionInfo);
    expect(handler).toBeTypeOf('function');

    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'));
    expect(result).toMatchObject({ appVersion: '0.0.0' });
  });

  it('rejects an untrusted sender instead of returning data', () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);

    const handler = handlers.get(IPC_CHANNELS.getVersionInfo);
    expect(handler).toBeTypeOf('function');
    expect(() => handler?.(fakeEvent(99, 'https://evil.example/'))).toThrow(/untrusted sender/);
  });

  it('is safe to call again for a recreated window instead of throwing on double registration', async () => {
    // `ipcMain.handle` throws if called twice for the same channel — this is what would happen
    // if `registerIpcHandlers` re-registered a handler every time a window is (re)created (e.g.
    // via the `activate` lifecycle event). Calling it again for a *different* window must not
    // throw, must not re-register with `ipcMain.handle`, and must trust the new window instead of
    // the stale one.
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    expect(() =>
      registerIpcHandlers(fakeMainWebContents(2), allowedOrigins, realtimeConfig),
    ).not.toThrow();
    // Five channels (getVersionInfo, getRealtimeConfig, getE2EVoiceConfig,
    // listScreenShareSources, selectScreenShareSource) are each registered exactly once, ever —
    // not once per `registerIpcHandlers` call.
    expect(ipcHandleSpy).toHaveBeenCalledTimes(5);

    const handler = handlers.get(IPC_CHANNELS.getVersionInfo);
    expect(() => handler?.(fakeEvent(1, 'app://renderer/index.html'))).toThrow(/untrusted sender/);

    const result = await handler?.(fakeEvent(2, 'app://renderer/index.html'));
    expect(result).toMatchObject({ appVersion: '0.0.0' });
  });

  it('returns the configured realtime URL and ICE servers for a trusted sender', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);

    const handler = handlers.get(IPC_CHANNELS.getRealtimeConfig);
    expect(handler).toBeTypeOf('function');

    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'));
    expect(result).toEqual(realtimeConfig);
  });

  it('returns undefined for getE2EVoiceConfig when no auto-join config was supplied', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);

    const handler = handlers.get(IPC_CHANNELS.getE2EVoiceConfig);
    expect(handler).toBeTypeOf('function');

    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'));
    expect(result).toBeUndefined();
  });

  it('returns the configured E2E auto-join config for a trusted sender when supplied', async () => {
    const e2eVoiceConfig = {
      channelId: 'general',
      displayName: 'e2e-tester',
      autoCamera: false,
      autoCameraOffAfterMs: undefined,
      autoScreenShare: false,
      autoScreenShareOffAfterMs: undefined,
      autoScreenShareReshareAfterMs: undefined,
    };
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig, e2eVoiceConfig);

    const handler = handlers.get(IPC_CHANNELS.getE2EVoiceConfig);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'));
    expect(result).toEqual(e2eVoiceConfig);
  });

  it('lists screen share sources for a trusted sender', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);

    const handler = handlers.get(IPC_CHANNELS.listScreenShareSources);
    expect(handler).toBeTypeOf('function');

    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'));
    expect(result).toEqual([
      {
        id: 'screen:0:0',
        name: 'Entire Screen',
        type: 'screen',
        thumbnailDataUrl: 'data:image/png;base64,abc',
        appIconDataUrl: undefined,
        displayId: undefined,
      },
    ]);
  });

  it('rejects listScreenShareSources from an untrusted sender', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);

    // Unlike the other handlers above, this one is `async` (it awaits real source enumeration in
    // production) — the sender check still runs first, but throwing inside an `async function`
    // always surfaces as a rejected promise, never a synchronous throw, so this must be asserted
    // with `rejects` rather than the synchronous `expect(() => ...).toThrow()` pattern used
    // elsewhere in this file for the non-async handlers.
    const handler = handlers.get(IPC_CHANNELS.listScreenShareSources);
    await expect(handler?.(fakeEvent(99, 'https://evil.example/'))).rejects.toThrow(
      /untrusted sender/,
    );
  });

  it('selects a screen share source for a trusted sender with a valid string id', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);

    const handler = handlers.get(IPC_CHANNELS.selectScreenShareSource);
    expect(handler).toBeTypeOf('function');

    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'), 'screen:0:0');
    expect(result).toBe(true);
    expect(selectScreenShareSourceMock).toHaveBeenCalledWith('screen:0:0');
  });

  it('rejects selectScreenShareSource from an untrusted sender without calling into screen-share.ts', () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    selectScreenShareSourceMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.selectScreenShareSource);
    expect(() => handler?.(fakeEvent(99, 'https://evil.example/'), 'screen:0:0')).toThrow(
      /untrusted sender/,
    );
    expect(selectScreenShareSourceMock).not.toHaveBeenCalled();
  });

  it('rejects a non-string selectScreenShareSource argument without calling into screen-share.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    selectScreenShareSourceMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.selectScreenShareSource);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'), { evil: true });
    expect(result).toBe(false);
    expect(selectScreenShareSourceMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized selectScreenShareSource argument without calling into screen-share.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    selectScreenShareSourceMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.selectScreenShareSource);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'), 'x'.repeat(1000));
    expect(result).toBe(false);
    expect(selectScreenShareSourceMock).not.toHaveBeenCalled();
  });
});
