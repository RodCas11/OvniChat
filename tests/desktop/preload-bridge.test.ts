import { describe, expect, it, vi } from 'vitest';

const exposed = new Map<string, unknown>();
const invoke = vi.fn(async (channel: string) => {
  if (channel === 'app:list-screen-share-sources') return [];
  if (channel === 'app:select-screen-share-source') return true;
  return { appVersion: '0.0.0', electronVersion: '43.4.0' };
});

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      exposed.set(key, api);
    },
  },
  ipcRenderer: { invoke },
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
      'getE2EVoiceConfig',
      'getIdentity',
      'getNickname',
      'getRealtimeConfig',
      'getVersionInfo',
      'listScreenShareSources',
      'regenerateIdentity',
      'selectScreenShareSource',
      'setNickname',
      'signIdentityChallenge',
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
});
