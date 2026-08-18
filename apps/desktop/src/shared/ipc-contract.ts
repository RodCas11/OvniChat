/**
 * Canonical, narrow IPC contract shared by Main and Preload. Renderer only ever sees the typed
 * `DesktopApi` shape through the Preload bridge, never a channel name or `ipcRenderer`.
 */

export const IPC_CHANNELS = {
  getVersionInfo: 'app:get-version-info',
} as const;

export interface DesktopVersionInfo {
  readonly appVersion: string;
  readonly electronVersion: string;
}

export interface DesktopApi {
  getVersionInfo: () => Promise<DesktopVersionInfo>;
}
