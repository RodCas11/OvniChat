import { app, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';

import {
  IPC_CHANNELS,
  type DesktopE2EVoiceConfig,
  type DesktopRealtimeConfig,
  type DesktopScreenSource,
  type DesktopVersionInfo,
} from '../shared/ipc-contract.js';
import { isAllowedOrigin } from './origins.js';
import { listScreenShareSources, selectScreenShareSource } from './screen-share.js';

/** Bounds the IPC argument before it ever reaches `selectScreenShareSource` — real
 * `DesktopCapturerSource` ids are short (`window:1234:0`/`screen:0:0`-shaped); this is generous
 * headroom, not a real expected length, purely to reject an absurd payload cheaply. */
const MAX_SCREEN_SOURCE_ID_LENGTH = 256;

/**
 * A sender is trusted only if the invoking WebContents is the one main-process window we created
 * and the frame that sent the request is actually loaded at an allowed origin. Channel names are
 * not authorization by themselves.
 */
export function isTrustedSender(
  event: IpcMainInvokeEvent,
  mainWebContents: WebContents,
  allowedOrigins: readonly string[],
): boolean {
  if (event.sender.id !== mainWebContents.id) return false;
  const frameUrl = event.senderFrame?.url;
  return typeof frameUrl === 'string' && isAllowedOrigin(frameUrl, allowedOrigins);
}

let currentMainWebContents: WebContents | undefined;
let currentAllowedOrigins: readonly string[] = [];
let currentRealtimeConfig: DesktopRealtimeConfig = { url: '', iceServers: [] };
let currentE2EVoiceConfig: DesktopE2EVoiceConfig | undefined;
let handlersRegistered = false;

function assertTrustedSender(event: IpcMainInvokeEvent, channel: string): void {
  if (
    !currentMainWebContents ||
    !isTrustedSender(event, currentMainWebContents, currentAllowedOrigins)
  ) {
    throw new Error(`Rejected "${channel}" from an untrusted sender`);
  }
}

/**
 * `ipcMain.handle` registration is process-global, not scoped to a `BrowserWindow`, so calling it
 * twice for the same channel throws. On Windows the app only ever has zero-or-one windows and
 * `window-all-closed` always quits, but `activate` recreating a window (if it ever ran) would
 * otherwise call this again and crash before the new window could load. Registering every IPC
 * handler exactly once and updating which window/origins/config are "current" keeps this safe to
 * call on every window (re)creation regardless.
 */
export function registerIpcHandlers(
  mainWebContents: WebContents,
  allowedOrigins: readonly string[],
  realtimeConfig: DesktopRealtimeConfig,
  e2eVoiceConfig: DesktopE2EVoiceConfig | undefined = undefined,
): void {
  currentMainWebContents = mainWebContents;
  currentAllowedOrigins = allowedOrigins;
  currentRealtimeConfig = realtimeConfig;
  currentE2EVoiceConfig = e2eVoiceConfig;

  if (handlersRegistered) return;
  handlersRegistered = true;

  ipcMain.handle(IPC_CHANNELS.getVersionInfo, (event: IpcMainInvokeEvent): DesktopVersionInfo => {
    assertTrustedSender(event, IPC_CHANNELS.getVersionInfo);
    return {
      appVersion: app.getVersion(),
      electronVersion: process.versions.electron ?? 'unknown',
    };
  });

  ipcMain.handle(
    IPC_CHANNELS.getRealtimeConfig,
    (event: IpcMainInvokeEvent): DesktopRealtimeConfig => {
      assertTrustedSender(event, IPC_CHANNELS.getRealtimeConfig);
      return currentRealtimeConfig;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.getE2EVoiceConfig,
    (event: IpcMainInvokeEvent): DesktopE2EVoiceConfig | undefined => {
      assertTrustedSender(event, IPC_CHANNELS.getE2EVoiceConfig);
      return currentE2EVoiceConfig;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.listScreenShareSources,
    async (event: IpcMainInvokeEvent): Promise<readonly DesktopScreenSource[]> => {
      assertTrustedSender(event, IPC_CHANNELS.listScreenShareSources);
      return listScreenShareSources();
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.selectScreenShareSource,
    (event: IpcMainInvokeEvent, sourceId: unknown, shareAudio: unknown): boolean => {
      assertTrustedSender(event, IPC_CHANNELS.selectScreenShareSource);
      // Runtime-validate every renderer-supplied argument before it ever reaches
      // `selectScreenShareSource` — an invalid shape is rejected the same way an unknown/stale id
      // is (returning `false`, never throwing a detail-leaking error).
      if (
        typeof sourceId !== 'string' ||
        sourceId.length === 0 ||
        sourceId.length > MAX_SCREEN_SOURCE_ID_LENGTH ||
        typeof shareAudio !== 'boolean'
      ) {
        return false;
      }
      return selectScreenShareSource(sourceId, shareAudio);
    },
  );
}
