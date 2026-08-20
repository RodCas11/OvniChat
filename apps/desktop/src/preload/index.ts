import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC_CHANNELS,
  type DesktopApi,
  type DesktopBookmarkInput,
  type DesktopClientSettings,
  type DesktopClientSettingsPatch,
  type DesktopE2ESettingsPersistenceConfig,
  type DesktopE2EVoiceConfig,
  type DesktopIdentity,
  type DesktopIdentityChallenge,
  type DesktopRealtimeConfig,
  type DesktopScreenSource,
  type DesktopServerBookmark,
  type DesktopVersionInfo,
} from '../shared/ipc-contract.js';

const desktopApi: DesktopApi = {
  getVersionInfo: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getVersionInfo) as Promise<DesktopVersionInfo>,
  getRealtimeConfig: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getRealtimeConfig) as Promise<DesktopRealtimeConfig>,
  getE2EVoiceConfig: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getE2EVoiceConfig) as Promise<
      DesktopE2EVoiceConfig | undefined
    >,
  getE2ESettingsPersistenceConfig: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getE2ESettingsPersistenceConfig) as Promise<
      DesktopE2ESettingsPersistenceConfig | undefined
    >,
  listScreenShareSources: () =>
    ipcRenderer.invoke(IPC_CHANNELS.listScreenShareSources) as Promise<
      readonly DesktopScreenSource[]
    >,
  selectScreenShareSource: (sourceId: string, shareAudio: boolean) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.selectScreenShareSource,
      sourceId,
      shareAudio,
    ) as Promise<boolean>,
  getIdentity: () => ipcRenderer.invoke(IPC_CHANNELS.getIdentity) as Promise<DesktopIdentity>,
  signIdentityChallenge: (challenge: DesktopIdentityChallenge) =>
    ipcRenderer.invoke(IPC_CHANNELS.signIdentityChallenge, challenge) as Promise<string>,
  regenerateIdentity: () =>
    ipcRenderer.invoke(IPC_CHANNELS.regenerateIdentity) as Promise<DesktopIdentity>,
  getNickname: () => ipcRenderer.invoke(IPC_CHANNELS.getNickname) as Promise<string>,
  setNickname: (nickname: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.setNickname, nickname) as Promise<boolean>,
  getClientSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getClientSettings) as Promise<DesktopClientSettings>,
  updateClientSettings: (patch: DesktopClientSettingsPatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateClientSettings, patch) as Promise<DesktopClientSettings>,
  addBookmark: (input: DesktopBookmarkInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.addBookmark, input) as Promise<DesktopServerBookmark>,
  updateBookmark: (bookmark: DesktopServerBookmark) =>
    ipcRenderer.invoke(IPC_CHANNELS.updateBookmark, bookmark) as Promise<boolean>,
  removeBookmark: (bookmarkId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.removeBookmark, bookmarkId) as Promise<boolean>,
};

contextBridge.exposeInMainWorld('desktopApp', desktopApi);
