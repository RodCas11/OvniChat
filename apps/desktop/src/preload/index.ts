import type { IpcRendererEvent } from 'electron';
import { contextBridge, ipcRenderer } from 'electron';

import type { AvatarImageFormat } from '@disco-voador/protocol';

import {
  IPC_CHANNELS,
  PROCESS_AUDIO_PORT_WINDOW_MESSAGE_TYPE,
  type AvatarMaxDimension,
  type DesktopApi,
  type DesktopAvatarPickResult,
  type DesktopAvatarValidationResult,
  type DesktopBookmarkInput,
  type DesktopClientSettings,
  type DesktopClientSettingsPatch,
  type DesktopE2EScreenshotConfig,
  type DesktopE2ESettingsPersistenceConfig,
  type DesktopE2EVoiceConfig,
  type DesktopIdentity,
  type DesktopIdentityChallenge,
  type DesktopProcessAudioCandidatesResult,
  type DesktopProcessAudioCapabilityResult,
  type DesktopProcessAudioEndedInfo,
  type DesktopProcessAudioStartResult,
  type DesktopRealtimeConfig,
  type DesktopScreenSource,
  type DesktopServerBookmark,
  type DesktopVersionInfo,
} from '../shared/ipc-contract.js';

/**
 * T12 — relays a `MessagePort` transferred from Main (via `webContents.postMessage`, arriving here
 * as `event.ports[0]`) into the Renderer's main world via the standard DOM `window.postMessage`
 * transfer mechanism — the officially documented Electron pattern for handing a real `MessagePort`
 * across the contextIsolation boundary (`contextBridge.exposeInMainWorld` itself cannot clone a
 * `MessagePort`, unlike the plain JSON-shaped/function values every other bridged call here uses).
 * Registered exactly once, for exactly this one fixed channel — never a generic `ipcRenderer.on`
 * passthrough the Renderer could use to listen on an arbitrary channel of its own choosing.
 * Targets `window.location.origin` explicitly (never `'*'`) — a security review noted `'*'` is a
 * caution flag for `postMessage` in general; this app has no iframe/cross-origin content today so
 * the practical risk was already low, but naming the real origin is free defense-in-depth against a
 * future page ever embedding untrusted content.
 */
ipcRenderer.on(IPC_CHANNELS.processAudioPort, (event: IpcRendererEvent, data: unknown) => {
  const port = event.ports[0];
  if (!port) return;
  const sessionId =
    data &&
    typeof data === 'object' &&
    typeof (data as { sessionId?: unknown }).sessionId === 'number'
      ? (data as { sessionId: number }).sessionId
      : undefined;
  window.postMessage(
    { channel: PROCESS_AUDIO_PORT_WINDOW_MESSAGE_TYPE, sessionId },
    window.location.origin,
    [port],
  );
});

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
  // T13.1 screenshot-capture tooling only — see `DesktopE2EScreenshotConfig`'s doc comment.
  getE2EScreenshotConfig: () =>
    ipcRenderer.invoke(IPC_CHANNELS.getE2EScreenshotConfig) as Promise<
      DesktopE2EScreenshotConfig | undefined
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
  getProcessAudioCapability: () =>
    ipcRenderer.invoke(
      IPC_CHANNELS.getProcessAudioCapability,
    ) as Promise<DesktopProcessAudioCapabilityResult>,
  listProcessAudioCandidates: () =>
    ipcRenderer.invoke(
      IPC_CHANNELS.listProcessAudioCandidates,
    ) as Promise<DesktopProcessAudioCandidatesResult>,
  cancelProcessAudioEnumeration: () =>
    ipcRenderer.invoke(IPC_CHANNELS.cancelProcessAudioEnumeration) as Promise<void>,
  startProcessAudioCapture: (pid: number) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.startProcessAudioCapture,
      pid,
    ) as Promise<DesktopProcessAudioStartResult>,
  stopProcessAudioCapture: () =>
    ipcRenderer.invoke(IPC_CHANNELS.stopProcessAudioCapture) as Promise<void>,
  onProcessAudioEnded: (listener: (info: DesktopProcessAudioEndedInfo) => void) => {
    const wrapped = (_event: IpcRendererEvent, info: unknown): void => {
      // Defensive runtime shape-check even though Main is the trusted sender — mirrors this bridge's
      // own "never assume the other side's payload shape" discipline used nowhere else yet only
      // because every other push-style API in this file is new to T12.
      if (
        info &&
        typeof info === 'object' &&
        typeof (info as { sessionId?: unknown }).sessionId === 'number' &&
        typeof (info as { reason?: unknown }).reason === 'string'
      ) {
        listener(info as DesktopProcessAudioEndedInfo);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.processAudioEnded, wrapped);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.processAudioEnded, wrapped);
    };
  },
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
  selectAvatarImageFile: (maxDimension: AvatarMaxDimension) =>
    ipcRenderer.invoke(IPC_CHANNELS.selectAvatarImageFile, maxDimension) as Promise<
      DesktopAvatarPickResult | undefined
    >,
  validateAvatarImageBytes: (
    base64: string,
    format: AvatarImageFormat,
    maxDimension: AvatarMaxDimension,
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.validateAvatarImageBytes, {
      base64,
      format,
      maxDimension,
    }) as Promise<DesktopAvatarValidationResult>,
};

contextBridge.exposeInMainWorld('desktopApp', desktopApi);
