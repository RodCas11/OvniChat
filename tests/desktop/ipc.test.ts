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

const getProcessAudioCapabilityMock = vi.fn(() => ({ supported: true }) as const);
const listProcessAudioCandidatesMock = vi.fn(async () => ({
  supported: true as const,
  candidates: [{ pid: 4242, exeName: 'Game.exe', displayTitle: 'Game' }],
}));
const cancelProcessAudioEnumerationMock = vi.fn();
const startProcessAudioCaptureMock = vi.fn(async (pid: number) =>
  pid === 4242 ? { accepted: true as const, sessionId: 1 } : { accepted: false as const },
);
const stopProcessAudioCaptureMock = vi.fn();

const getPublicIdentityMock = vi.fn(async () => ({
  identityId: `dv1_${'A'.repeat(43)}`,
  publicKey: 'B'.repeat(43),
}));
const signIdentityChallengeMock = vi.fn(async () => 'C'.repeat(86));
const regenerateIdentityMock = vi.fn(async () => ({
  identityId: `dv1_${'D'.repeat(43)}`,
  publicKey: 'E'.repeat(43),
}));
const getNicknameMock = vi.fn(async () => 'Ana');
const setNicknameMock = vi.fn((nickname: string) => nickname.length > 0 && nickname.length <= 32);

const DEFAULT_SETTINGS = {
  version: 1,
  audio: { inputDeviceId: null, outputDeviceId: null },
  video: { cameraDeviceId: null },
  screenShare: { qualityPreset: 'high' as const },
  voice: { startMuted: false, startDeafened: false },
  bookmarks: [],
  lastServerAddress: null,
  connectOnStartup: false,
};
const getClientSettingsMock = vi.fn(async () => DEFAULT_SETTINGS);
const updateClientSettingsMock = vi.fn(async () => DEFAULT_SETTINGS);
const addBookmarkMock = vi.fn(async () => ({
  bookmarkId: 'bm-1',
  displayName: 'Rodrigo Server',
  serverAddress: 'voice.rodrigo.com:8090',
}));
const updateBookmarkMock = vi.fn(async () => true);
const removeBookmarkMock = vi.fn(async () => true);

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0' },
  ipcMain: { handle: ipcHandleSpy },
}));

vi.mock('../../apps/desktop/src/main/screen-share.js', () => ({
  listScreenShareSources: listScreenShareSourcesMock,
  selectScreenShareSource: selectScreenShareSourceMock,
}));

vi.mock('../../apps/desktop/src/main/process-audio.js', () => ({
  getProcessAudioCapability: getProcessAudioCapabilityMock,
  listProcessAudioCandidates: listProcessAudioCandidatesMock,
  cancelProcessAudioEnumeration: cancelProcessAudioEnumerationMock,
  startProcessAudioCapture: startProcessAudioCaptureMock,
  stopProcessAudioCapture: stopProcessAudioCaptureMock,
}));

vi.mock('../../apps/desktop/src/main/identity/identity-service.js', () => ({
  getPublicIdentity: getPublicIdentityMock,
  signIdentityChallenge: signIdentityChallengeMock,
  regenerateIdentity: regenerateIdentityMock,
}));

vi.mock('../../apps/desktop/src/main/identity/nickname-store.js', () => ({
  getNickname: getNicknameMock,
  setNickname: setNicknameMock,
}));

vi.mock('../../apps/desktop/src/main/settings/settings-service.js', () => ({
  getClientSettings: getClientSettingsMock,
  updateClientSettings: updateClientSettingsMock,
  addBookmark: addBookmarkMock,
  updateBookmark: updateBookmarkMock,
  removeBookmark: removeBookmarkMock,
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
    // Twenty-two channels (getVersionInfo, getRealtimeConfig, getE2EVoiceConfig,
    // getE2ESettingsPersistenceConfig, getE2EScreenshotConfig, listScreenShareSources,
    // selectScreenShareSource, getProcessAudioCapability, listProcessAudioCandidates,
    // cancelProcessAudioEnumeration, startProcessAudioCapture, stopProcessAudioCapture, getIdentity,
    // signIdentityChallenge, regenerateIdentity, getNickname, setNickname, getClientSettings,
    // updateClientSettings, addBookmark, updateBookmark, removeBookmark) are each registered exactly
    // once, ever — not once per `registerIpcHandlers` call.
    expect(ipcHandleSpy).toHaveBeenCalledTimes(22);

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
      autoScreenShareAudio: false,
      processAudioTargetPid: undefined,
      processAudioTargetExe: undefined,
      processAudioExpectedHz: undefined,
      processAudioRejectedHz: undefined,
      processAudioLifecycleScenario: false,
      connectUrl: undefined,
      redeemToken: undefined,
      autoChatSendServerBody: undefined,
      autoChatSendChannelBody: undefined,
      productShellSmoke: undefined,
    };
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig, e2eVoiceConfig);

    const handler = handlers.get(IPC_CHANNELS.getE2EVoiceConfig);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'));
    expect(result).toEqual(e2eVoiceConfig);
  });

  it('returns undefined for getE2ESettingsPersistenceConfig when not supplied', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);

    const handler = handlers.get(IPC_CHANNELS.getE2ESettingsPersistenceConfig);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'));
    expect(result).toBeUndefined();
  });

  it('returns the configured E2E settings-persistence config for a trusted sender when supplied', async () => {
    const e2eSettingsPersistenceConfig = { write: true };
    registerIpcHandlers(
      fakeMainWebContents(1),
      allowedOrigins,
      realtimeConfig,
      undefined,
      e2eSettingsPersistenceConfig,
    );

    const handler = handlers.get(IPC_CHANNELS.getE2ESettingsPersistenceConfig);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'));
    expect(result).toEqual(e2eSettingsPersistenceConfig);
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

    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'), 'screen:0:0', true);
    expect(result).toBe(true);
    expect(selectScreenShareSourceMock).toHaveBeenCalledWith('screen:0:0', true);
  });

  it('rejects selectScreenShareSource from an untrusted sender without calling into screen-share.ts', () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    selectScreenShareSourceMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.selectScreenShareSource);
    expect(() => handler?.(fakeEvent(99, 'https://evil.example/'), 'screen:0:0', false)).toThrow(
      /untrusted sender/,
    );
    expect(selectScreenShareSourceMock).not.toHaveBeenCalled();
  });

  it('rejects a non-string selectScreenShareSource argument without calling into screen-share.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    selectScreenShareSourceMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.selectScreenShareSource);
    const result = await handler?.(
      fakeEvent(1, 'app://renderer/index.html'),
      { evil: true },
      false,
    );
    expect(result).toBe(false);
    expect(selectScreenShareSourceMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized selectScreenShareSource argument without calling into screen-share.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    selectScreenShareSourceMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.selectScreenShareSource);
    const result = await handler?.(
      fakeEvent(1, 'app://renderer/index.html'),
      'x'.repeat(1000),
      false,
    );
    expect(result).toBe(false);
    expect(selectScreenShareSourceMock).not.toHaveBeenCalled();
  });

  it('rejects a non-boolean shareAudio argument without calling into screen-share.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    selectScreenShareSourceMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.selectScreenShareSource);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'), 'screen:0:0', 'yes');
    expect(result).toBe(false);
    expect(selectScreenShareSourceMock).not.toHaveBeenCalled();
  });

  it('returns process-audio capability for a trusted sender', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);

    const handler = handlers.get(IPC_CHANNELS.getProcessAudioCapability);
    expect(handler).toBeTypeOf('function');
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'));
    expect(result).toEqual({ supported: true });
  });

  it('rejects getProcessAudioCapability from an untrusted sender', () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);

    const handler = handlers.get(IPC_CHANNELS.getProcessAudioCapability);
    expect(() => handler?.(fakeEvent(99, 'https://evil.example/'))).toThrow(/untrusted sender/);
  });

  it('lists process-audio candidates for a trusted sender', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);

    const handler = handlers.get(IPC_CHANNELS.listProcessAudioCandidates);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'));
    expect(result).toEqual({
      supported: true,
      candidates: [{ pid: 4242, exeName: 'Game.exe', displayTitle: 'Game' }],
    });
  });

  it('rejects listProcessAudioCandidates from an untrusted sender', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);

    const handler = handlers.get(IPC_CHANNELS.listProcessAudioCandidates);
    await expect(handler?.(fakeEvent(99, 'https://evil.example/'))).rejects.toThrow(
      /untrusted sender/,
    );
  });

  it('cancels process-audio enumeration for a trusted sender', () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    cancelProcessAudioEnumerationMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.cancelProcessAudioEnumeration);
    handler?.(fakeEvent(1, 'app://renderer/index.html'));
    expect(cancelProcessAudioEnumerationMock).toHaveBeenCalledOnce();
  });

  it('starts process-audio capture for a trusted sender with a valid pid', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);

    const handler = handlers.get(IPC_CHANNELS.startProcessAudioCapture);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'), 4242);
    expect(result).toEqual({ accepted: true, sessionId: 1 });
    expect(startProcessAudioCaptureMock).toHaveBeenCalledWith(4242, expect.anything());
  });

  it('rejects startProcessAudioCapture from an untrusted sender without calling into process-audio.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    startProcessAudioCaptureMock.mockClear();

    // `async`, like `listScreenShareSources`/`getIdentity` above — a throw inside surfaces as a
    // rejected promise, never a synchronous throw.
    const handler = handlers.get(IPC_CHANNELS.startProcessAudioCapture);
    await expect(handler?.(fakeEvent(99, 'https://evil.example/'), 4242)).rejects.toThrow(
      /untrusted sender/,
    );
    expect(startProcessAudioCaptureMock).not.toHaveBeenCalled();
  });

  it('rejects a non-integer/negative/oversized pid without calling into process-audio.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    startProcessAudioCaptureMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.startProcessAudioCapture);
    for (const badPid of [-1, 0, 1.5, 'evil', Number.MAX_SAFE_INTEGER]) {
      const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'), badPid);
      expect(result).toEqual({ accepted: false });
    }
    expect(startProcessAudioCaptureMock).not.toHaveBeenCalled();
  });

  it('stops process-audio capture for a trusted sender', () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    stopProcessAudioCaptureMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.stopProcessAudioCapture);
    handler?.(fakeEvent(1, 'app://renderer/index.html'));
    expect(stopProcessAudioCaptureMock).toHaveBeenCalledOnce();
  });

  it('returns the public identity for a trusted sender', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);

    const handler = handlers.get(IPC_CHANNELS.getIdentity);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'));
    expect(result).toEqual({ identityId: `dv1_${'A'.repeat(43)}`, publicKey: 'B'.repeat(43) });
  });

  it('rejects getIdentity from an untrusted sender without calling into identity-service.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    getPublicIdentityMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.getIdentity);
    await expect(handler?.(fakeEvent(99, 'https://evil.example/'))).rejects.toThrow(
      /untrusted sender/,
    );
    expect(getPublicIdentityMock).not.toHaveBeenCalled();
  });

  it('signs a well-formed identity challenge for a trusted sender', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    signIdentityChallengeMock.mockClear();

    const challenge = {
      protocolVersion: 2,
      connectionId: 'conn-1',
      nonce: 'A'.repeat(43),
      expiresAt: Date.now() + 30_000,
      nickname: 'Ana',
    };
    const handler = handlers.get(IPC_CHANNELS.signIdentityChallenge);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'), challenge);
    expect(result).toBe('C'.repeat(86));
    expect(signIdentityChallengeMock).toHaveBeenCalledWith(challenge);
  });

  it('rejects a malformed identity challenge without calling into identity-service.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    signIdentityChallengeMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.signIdentityChallenge);
    await expect(
      handler?.(fakeEvent(1, 'app://renderer/index.html'), { protocolVersion: 2 }),
    ).rejects.toThrow(/Invalid identity challenge/);
    expect(signIdentityChallengeMock).not.toHaveBeenCalled();
  });

  it('rejects signIdentityChallenge from an untrusted sender without calling into identity-service.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    signIdentityChallengeMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.signIdentityChallenge);
    await expect(
      handler?.(fakeEvent(99, 'https://evil.example/'), {
        protocolVersion: 2,
        connectionId: 'conn-1',
        nonce: 'A'.repeat(43),
        expiresAt: Date.now() + 30_000,
        nickname: 'Ana',
      }),
    ).rejects.toThrow(/untrusted sender/);
    expect(signIdentityChallengeMock).not.toHaveBeenCalled();
  });

  it('regenerates the identity for a trusted sender', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);

    const handler = handlers.get(IPC_CHANNELS.regenerateIdentity);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'));
    expect(result).toEqual({ identityId: `dv1_${'D'.repeat(43)}`, publicKey: 'E'.repeat(43) });
  });

  it('rejects regenerateIdentity from an untrusted sender without calling into identity-service.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    regenerateIdentityMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.regenerateIdentity);
    await expect(handler?.(fakeEvent(99, 'https://evil.example/'))).rejects.toThrow(
      /untrusted sender/,
    );
    expect(regenerateIdentityMock).not.toHaveBeenCalled();
  });

  it('returns the current nickname for a trusted sender', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);

    const handler = handlers.get(IPC_CHANNELS.getNickname);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'));
    expect(result).toBe('Ana');
  });

  it('sets a valid nickname for a trusted sender', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    setNicknameMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.setNickname);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'), 'Bob');
    expect(result).toBe(true);
    expect(setNicknameMock).toHaveBeenCalledWith('Bob');
  });

  it('rejects a non-string setNickname argument without calling into nickname-store.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    setNicknameMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.setNickname);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'), { evil: true });
    expect(result).toBe(false);
    expect(setNicknameMock).not.toHaveBeenCalled();
  });

  it('rejects setNickname from an untrusted sender without calling into nickname-store.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    setNicknameMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.setNickname);
    await expect(handler?.(fakeEvent(99, 'https://evil.example/'), 'Bob')).rejects.toThrow(
      /untrusted sender/,
    );
    expect(setNicknameMock).not.toHaveBeenCalled();
  });

  it('returns the client settings for a trusted sender', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);

    const handler = handlers.get(IPC_CHANNELS.getClientSettings);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'));
    expect(result).toEqual(DEFAULT_SETTINGS);
  });

  it('rejects getClientSettings from an untrusted sender without calling into settings-service.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    getClientSettingsMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.getClientSettings);
    await expect(handler?.(fakeEvent(99, 'https://evil.example/'))).rejects.toThrow(
      /untrusted sender/,
    );
    expect(getClientSettingsMock).not.toHaveBeenCalled();
  });

  it('applies a well-formed settings patch for a trusted sender', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    updateClientSettingsMock.mockClear();

    const patch = { audio: { inputDeviceId: 'mic-1' } };
    const handler = handlers.get(IPC_CHANNELS.updateClientSettings);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'), patch);
    expect(result).toEqual(DEFAULT_SETTINGS);
    expect(updateClientSettingsMock).toHaveBeenCalledWith(patch);
  });

  it('rejects a malformed settings patch (unknown key) without calling into settings-service.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    updateClientSettingsMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.updateClientSettings);
    await expect(
      handler?.(fakeEvent(1, 'app://renderer/index.html'), { evil: true }),
    ).rejects.toThrow(/Invalid client settings patch/);
    expect(updateClientSettingsMock).not.toHaveBeenCalled();
  });

  it('rejects a settings patch with an unexpected *nested* field, not only a top-level one', async () => {
    // `clientSettingsPatchSchema`'s nested objects are built with `.strict().partial()` — this
    // confirms `.partial()` preserves the inner `.strict()`'s rejection of an extra key (a real,
    // non-obvious zod behavior flagged during T11's security review), not just that the top-level
    // patch object itself is strict.
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    updateClientSettingsMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.updateClientSettings);
    await expect(
      handler?.(fakeEvent(1, 'app://renderer/index.html'), {
        audio: { inputDeviceId: 'mic-1', evilField: true },
      }),
    ).rejects.toThrow(/Invalid client settings patch/);
    expect(updateClientSettingsMock).not.toHaveBeenCalled();
  });

  it('rejects updateClientSettings from an untrusted sender without calling into settings-service.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    updateClientSettingsMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.updateClientSettings);
    await expect(
      handler?.(fakeEvent(99, 'https://evil.example/'), { connectOnStartup: true }),
    ).rejects.toThrow(/untrusted sender/);
    expect(updateClientSettingsMock).not.toHaveBeenCalled();
  });

  it('adds a well-formed bookmark for a trusted sender', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    addBookmarkMock.mockClear();

    const input = { displayName: 'Rodrigo Server', serverAddress: 'voice.rodrigo.com:8090' };
    const handler = handlers.get(IPC_CHANNELS.addBookmark);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'), input);
    expect(result).toEqual({
      bookmarkId: 'bm-1',
      displayName: 'Rodrigo Server',
      serverAddress: 'voice.rodrigo.com:8090',
    });
    expect(addBookmarkMock).toHaveBeenCalledWith(input);
  });

  it('rejects a bookmark input carrying an unexpected field (e.g. a token) without calling into settings-service.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    addBookmarkMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.addBookmark);
    await expect(
      handler?.(fakeEvent(1, 'app://renderer/index.html'), {
        displayName: 'X',
        serverAddress: 'x:1',
        token: 'DV-secret',
      }),
    ).rejects.toThrow(/Invalid bookmark/);
    expect(addBookmarkMock).not.toHaveBeenCalled();
  });

  it('rejects addBookmark from an untrusted sender without calling into settings-service.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    addBookmarkMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.addBookmark);
    await expect(
      handler?.(fakeEvent(99, 'https://evil.example/'), {
        displayName: 'X',
        serverAddress: 'x:1',
      }),
    ).rejects.toThrow(/untrusted sender/);
    expect(addBookmarkMock).not.toHaveBeenCalled();
  });

  it('updates a well-formed bookmark for a trusted sender', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    updateBookmarkMock.mockClear();

    const bookmark = { bookmarkId: 'bm-1', displayName: 'Renamed', serverAddress: 'x:1' };
    const handler = handlers.get(IPC_CHANNELS.updateBookmark);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'), bookmark);
    expect(result).toBe(true);
    expect(updateBookmarkMock).toHaveBeenCalledWith(bookmark);
  });

  it('rejects a malformed updateBookmark argument (missing bookmarkId) without calling into settings-service.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    updateBookmarkMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.updateBookmark);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'), {
      displayName: 'X',
      serverAddress: 'x:1',
    });
    expect(result).toBe(false);
    expect(updateBookmarkMock).not.toHaveBeenCalled();
  });

  it('rejects an updateBookmark argument carrying an unexpected field (e.g. a token) without calling into settings-service.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    updateBookmarkMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.updateBookmark);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'), {
      bookmarkId: 'bm-1',
      displayName: 'X',
      serverAddress: 'x:1',
      token: 'DV-secret',
    });
    expect(result).toBe(false);
    expect(updateBookmarkMock).not.toHaveBeenCalled();
  });

  it('rejects updateBookmark from an untrusted sender without calling into settings-service.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    updateBookmarkMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.updateBookmark);
    await expect(
      handler?.(fakeEvent(99, 'https://evil.example/'), {
        bookmarkId: 'bm-1',
        displayName: 'X',
        serverAddress: 'x:1',
      }),
    ).rejects.toThrow(/untrusted sender/);
    expect(updateBookmarkMock).not.toHaveBeenCalled();
  });

  it('removes a bookmark by id for a trusted sender', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    removeBookmarkMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.removeBookmark);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'), 'bm-1');
    expect(result).toBe(true);
    expect(removeBookmarkMock).toHaveBeenCalledWith('bm-1');
  });

  it('rejects a non-string removeBookmark argument without calling into settings-service.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    removeBookmarkMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.removeBookmark);
    const result = await handler?.(fakeEvent(1, 'app://renderer/index.html'), { evil: true });
    expect(result).toBe(false);
    expect(removeBookmarkMock).not.toHaveBeenCalled();
  });

  it('rejects removeBookmark from an untrusted sender without calling into settings-service.ts', async () => {
    registerIpcHandlers(fakeMainWebContents(1), allowedOrigins, realtimeConfig);
    removeBookmarkMock.mockClear();

    const handler = handlers.get(IPC_CHANNELS.removeBookmark);
    await expect(handler?.(fakeEvent(99, 'https://evil.example/'), 'bm-1')).rejects.toThrow(
      /untrusted sender/,
    );
    expect(removeBookmarkMock).not.toHaveBeenCalled();
  });
});
