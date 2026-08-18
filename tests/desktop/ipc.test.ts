import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { describe, expect, it, vi } from 'vitest';

type Handler = (event: IpcMainInvokeEvent) => unknown;

const handlers = new Map<string, Handler>();
const ipcHandleSpy = vi.fn((channel: string, listener: Handler) => {
  handlers.set(channel, listener);
});

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0' },
  ipcMain: { handle: ipcHandleSpy },
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
    // Three channels (getVersionInfo, getRealtimeConfig, getE2EVoiceConfig) are each registered
    // exactly once, ever — not once per `registerIpcHandlers` call.
    expect(ipcHandleSpy).toHaveBeenCalledTimes(3);

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
    const e2eVoiceConfig = { channelId: 'general', displayName: 'e2e-tester' };
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig, e2eVoiceConfig);

    const handler = handlers.get(IPC_CHANNELS.getE2EVoiceConfig);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'));
    expect(result).toEqual(e2eVoiceConfig);
  });
});
