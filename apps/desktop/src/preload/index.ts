import { contextBridge, ipcRenderer } from 'electron';

import { IPC_CHANNELS, type DesktopApi, type DesktopVersionInfo } from '../shared/ipc-contract.js';

const desktopApi: DesktopApi = {
  getVersionInfo: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getVersionInfo) as Promise<DesktopVersionInfo>,
};

contextBridge.exposeInMainWorld('desktopApp', desktopApi);
