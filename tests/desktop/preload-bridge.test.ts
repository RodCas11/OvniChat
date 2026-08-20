import { describe, expect, it, vi } from 'vitest';

const exposed = new Map<string, unknown>();
const invoke = vi.fn(async (channel: string) => {
  if (channel === 'app:list-screen-share-sources') return [];
  if (channel === 'app:select-screen-share-source') return true;
  if (channel === 'app:get-process-audio-capability')
    return { supported: false, reason: 'not-windows' };
  if (channel === 'app:list-process-audio-candidates') {
    return { supported: false, reason: 'not-windows' };
  }
  if (channel === 'app:start-process-audio-capture') return { accepted: false };
  return { appVersion: '0.0.0', electronVersion: '43.4.0' };
});
const on = vi.fn();
const removeListener = vi.fn();

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      exposed.set(key, api);
    },
  },
  ipcRenderer: { invoke, on, removeListener },
}));

await import('../../apps/desktop/src/preload/index.js');
const { IPC_CHANNELS } = await import('../../apps/desktop/src/shared/ipc-contract.js');

describe('preload bridge', () => {
  it('exposes exactly one narrow "desktopApp" capability on the main world', () => {
    expect([...exposed.keys()]).toEqual(['desktopApp']);
  });

  it('never exposes ipcRenderer, generic channels, or a send/invoke passthrough', () => {
    const api = exposed.get('desktopApp') as Record<string, unknown>;

    expect(Object.keys(api).sort()).toEqual([
      'addBookmark',
      'cancelProcessAudioEnumeration',
      'getClientSettings',
      'getE2ESettingsPersistenceConfig',
      'getE2EVoiceConfig',
      'getIdentity',
      'getNickname',
      'getProcessAudioCapability',
      'getRealtimeConfig',
      'getVersionInfo',
      'listProcessAudioCandidates',
      'listScreenShareSources',
      'onProcessAudioEnded',
      'regenerateIdentity',
      'removeBookmark',
      'selectScreenShareSource',
      'setNickname',
      'signIdentityChallenge',
      'startProcessAudioCapture',
      'stopProcessAudioCapture',
      'updateBookmark',
      'updateClientSettings',
    ]);
    expect(api['ipcRenderer']).toBeUndefined();
    expect(api['invoke']).toBeUndefined();
    expect(api['send']).toBeUndefined();
  });

  it('getVersionInfo invokes the explicit versioned channel with no attacker-controlled arguments', async () => {
    const api = exposed.get('desktopApp') as { getVersionInfo: () => Promise<unknown> };

    const result = await api.getVersionInfo();

    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.getVersionInfo);
    expect(result).toMatchObject({ appVersion: '0.0.0' });
  });

  it('getRealtimeConfig invokes the explicit versioned channel with no attacker-controlled arguments', async () => {
    const api = exposed.get('desktopApp') as { getRealtimeConfig: () => Promise<unknown> };

    await api.getRealtimeConfig();

    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.getRealtimeConfig);
  });

  it('getE2EVoiceConfig invokes the explicit versioned channel with no attacker-controlled arguments', async () => {
    const api = exposed.get('desktopApp') as { getE2EVoiceConfig: () => Promise<unknown> };

    await api.getE2EVoiceConfig();

    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.getE2EVoiceConfig);
  });

  it('listScreenShareSources invokes the explicit versioned channel with no attacker-controlled arguments', async () => {
    const api = exposed.get('desktopApp') as { listScreenShareSources: () => Promise<unknown> };

    const result = await api.listScreenShareSources();

    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.listScreenShareSources);
    expect(result).toEqual([]);
  });

  it('selectScreenShareSource forwards exactly the caller-supplied sourceId and shareAudio', async () => {
    const api = exposed.get('desktopApp') as {
      selectScreenShareSource: (sourceId: string, shareAudio: boolean) => Promise<unknown>;
    };

    const result = await api.selectScreenShareSource('screen:0:0', true);

    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.selectScreenShareSource, 'screen:0:0', true);
    expect(result).toBe(true);
  });

  it('getProcessAudioCapability invokes the explicit versioned channel with no arguments', async () => {
    const api = exposed.get('desktopApp') as { getProcessAudioCapability: () => Promise<unknown> };

    const result = await api.getProcessAudioCapability();

    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.getProcessAudioCapability);
    expect(result).toEqual({ supported: false, reason: 'not-windows' });
  });

  it('startProcessAudioCapture forwards exactly the caller-supplied pid', async () => {
    const api = exposed.get('desktopApp') as {
      startProcessAudioCapture: (pid: number) => Promise<unknown>;
    };

    await api.startProcessAudioCapture(4242);

    expect(invoke).toHaveBeenCalledWith(IPC_CHANNELS.startProcessAudioCapture, 4242);
  });

  it('onProcessAudioEnded subscribes/unsubscribes via ipcRenderer.on without exposing ipcRenderer', () => {
    const api = exposed.get('desktopApp') as {
      onProcessAudioEnded: (listener: (info: unknown) => void) => () => void;
    };
    const listener = vi.fn();

    const unsubscribe = api.onProcessAudioEnded(listener);
    expect(on).toHaveBeenCalledWith(IPC_CHANNELS.processAudioEnded, expect.any(Function));

    // Simulate Main pushing a well-formed notification through the registered listener.
    const wrapped = on.mock.calls.find(
      (call) => call[0] === IPC_CHANNELS.processAudioEnded,
    )?.[1] as (event: unknown, info: unknown) => void;
    wrapped({}, { sessionId: 1, reason: 'target-ended' });
    expect(listener).toHaveBeenCalledWith({ sessionId: 1, reason: 'target-ended' });

    // A malformed payload is dropped defensively, never forwarded to the caller's listener.
    wrapped({}, { nonsense: true });
    expect(listener).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith(IPC_CHANNELS.processAudioEnded, wrapped);
  });
});
