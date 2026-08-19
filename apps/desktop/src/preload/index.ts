import { contextBridge, ipcRenderer } from 'electron';

import {
  IPC_CHANNELS,
  type DesktopApi,
  type DesktopE2EVoiceConfig,
  type DesktopIdentity,
  type DesktopIdentityChallenge,
  type DesktopRealtimeConfig,
  type DesktopScreenSource,
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
};

contextBridge.exposeInMainWorld('desktopApp', desktopApi);
