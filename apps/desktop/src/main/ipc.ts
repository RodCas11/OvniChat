import {
  displayNameSchema,
  identityConnectionIdSchema,
  identityExpiresAtSchema,
  identityNonceSchema,
} from '@disco-voador/protocol';
import { app, ipcMain } from 'electron';
import type { IpcMainInvokeEvent, WebContents } from 'electron';
import { z } from 'zod';

import {
  IPC_CHANNELS,
  type DesktopBookmarkInput,
  type DesktopClientSettings,
  type DesktopClientSettingsPatch,
  type DesktopE2ESettingsPersistenceConfig,
  type DesktopE2EVoiceConfig,
  type DesktopIdentity,
  type DesktopIdentityChallenge,
  type DesktopProcessAudioCandidatesResult,
  type DesktopProcessAudioCapabilityResult,
  type DesktopProcessAudioStartResult,
  type DesktopRealtimeConfig,
  type DesktopScreenSource,
  type DesktopServerBookmark,
  type DesktopVersionInfo,
} from '../shared/ipc-contract.js';
import {
  getPublicIdentity,
  regenerateIdentity,
  signIdentityChallenge,
} from './identity/identity-service.js';
import { getNickname, setNickname } from './identity/nickname-store.js';
import { isAllowedOrigin } from './origins.js';
import {
  cancelProcessAudioEnumeration,
  getProcessAudioCapability,
  listProcessAudioCandidates,
  startProcessAudioCapture,
  stopProcessAudioCapture,
} from './process-audio.js';
import { listScreenShareSources, selectScreenShareSource } from './screen-share.js';
import {
  addBookmark,
  getClientSettings,
  removeBookmark,
  updateBookmark,
  updateClientSettings,
} from './settings/settings-service.js';

/** Mirrors the wire protocol's own bounds for each field exactly (see `@disco-voador/protocol`'s
 * `identity.ts`), so a challenge Main is willing to sign is always one the realtime server would
 * also accept a proof for — never looser. */
const identityChallengeSchema = z
  .object({
    protocolVersion: z.number().int().positive(),
    connectionId: identityConnectionIdSchema,
    nonce: identityNonceSchema,
    expiresAt: identityExpiresAtSchema,
    nickname: displayNameSchema,
  })
  .strict();

/** Bounds the IPC argument before it ever reaches `selectScreenShareSource` — real
 * `DesktopCapturerSource` ids are short (`window:1234:0`/`screen:0:0`-shaped); this is generous
 * headroom, not a real expected length, purely to reject an absurd payload cheaply. */
const MAX_SCREEN_SOURCE_ID_LENGTH = 256;

/** T12 — Windows `PROCESSENTRY32`'s own `th32ProcessID` is a `DWORD`; this is generous headroom
 * above any real PID, purely to reject an absurd payload cheaply before it ever reaches
 * `startProcessAudioCapture`'s own last-enumerated-set validation. */
const MAX_PROCESS_AUDIO_PID = 4_294_967_295;

// T11 — mirrors `settings/settings-file.ts`'s own bounds exactly (see that file's doc comment for
// why), so a patch Main is willing to accept is always one `settings-file.ts`'s own schema would
// also accept — the same "never looser than the storage layer" discipline `identityChallengeSchema`
// above already establishes for the wire protocol.
const MAX_BOOKMARK_NAME_LENGTH = 100;
const MAX_SERVER_ADDRESS_LENGTH = 300;
const MAX_BOOKMARK_ID_LENGTH = 64;
const MAX_DEVICE_ID_LENGTH = 256;

const deviceIdPatchSchema = z.string().min(1).max(MAX_DEVICE_ID_LENGTH).nullable();

const clientSettingsPatchSchema = z
  .object({
    audio: z
      .object({ inputDeviceId: deviceIdPatchSchema, outputDeviceId: deviceIdPatchSchema })
      .strict()
      .partial()
      .optional(),
    video: z.object({ cameraDeviceId: deviceIdPatchSchema }).strict().partial().optional(),
    screenShare: z
      .object({ qualityPreset: z.enum(['standard', 'high', 'smooth', 'smooth720']) })
      .strict()
      .partial()
      .optional(),
    voice: z
      .object({ startMuted: z.boolean(), startDeafened: z.boolean() })
      .strict()
      .partial()
      .optional(),
    lastServerAddress: z.string().min(1).max(MAX_SERVER_ADDRESS_LENGTH).nullable().optional(),
    connectOnStartup: z.boolean().optional(),
  })
  .strict();

const bookmarkInputSchema = z
  .object({
    displayName: z.string().min(1).max(MAX_BOOKMARK_NAME_LENGTH),
    serverAddress: z.string().min(1).max(MAX_SERVER_ADDRESS_LENGTH),
  })
  .strict();

const bookmarkSchema = z
  .object({
    bookmarkId: z.string().min(1).max(MAX_BOOKMARK_ID_LENGTH),
    displayName: z.string().min(1).max(MAX_BOOKMARK_NAME_LENGTH),
    serverAddress: z.string().min(1).max(MAX_SERVER_ADDRESS_LENGTH),
  })
  .strict();

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
let currentE2ESettingsPersistenceConfig: DesktopE2ESettingsPersistenceConfig | undefined;
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
  e2eSettingsPersistenceConfig: DesktopE2ESettingsPersistenceConfig | undefined = undefined,
): void {
  currentMainWebContents = mainWebContents;
  currentAllowedOrigins = allowedOrigins;
  currentRealtimeConfig = realtimeConfig;
  currentE2EVoiceConfig = e2eVoiceConfig;
  currentE2ESettingsPersistenceConfig = e2eSettingsPersistenceConfig;

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
    IPC_CHANNELS.getE2ESettingsPersistenceConfig,
    (event: IpcMainInvokeEvent): DesktopE2ESettingsPersistenceConfig | undefined => {
      assertTrustedSender(event, IPC_CHANNELS.getE2ESettingsPersistenceConfig);
      return currentE2ESettingsPersistenceConfig;
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

  // --- T12 — Windows per-process/game audio capture ------------------------------------------

  ipcMain.handle(
    IPC_CHANNELS.getProcessAudioCapability,
    (event: IpcMainInvokeEvent): DesktopProcessAudioCapabilityResult => {
      assertTrustedSender(event, IPC_CHANNELS.getProcessAudioCapability);
      return getProcessAudioCapability();
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.listProcessAudioCandidates,
    async (event: IpcMainInvokeEvent): Promise<DesktopProcessAudioCandidatesResult> => {
      assertTrustedSender(event, IPC_CHANNELS.listProcessAudioCandidates);
      return listProcessAudioCandidates();
    },
  );

  ipcMain.handle(IPC_CHANNELS.cancelProcessAudioEnumeration, (event: IpcMainInvokeEvent): void => {
    assertTrustedSender(event, IPC_CHANNELS.cancelProcessAudioEnumeration);
    cancelProcessAudioEnumeration();
  });

  ipcMain.handle(
    IPC_CHANNELS.startProcessAudioCapture,
    async (event: IpcMainInvokeEvent, pid: unknown): Promise<DesktopProcessAudioStartResult> => {
      assertTrustedSender(event, IPC_CHANNELS.startProcessAudioCapture);
      if (
        typeof pid !== 'number' ||
        !Number.isInteger(pid) ||
        pid <= 0 ||
        pid > MAX_PROCESS_AUDIO_PID
      ) {
        return { accepted: false };
      }
      if (!currentMainWebContents) return { accepted: false };
      return startProcessAudioCapture(pid, currentMainWebContents);
    },
  );

  ipcMain.handle(IPC_CHANNELS.stopProcessAudioCapture, (event: IpcMainInvokeEvent): void => {
    assertTrustedSender(event, IPC_CHANNELS.stopProcessAudioCapture);
    stopProcessAudioCapture();
  });

  ipcMain.handle(
    IPC_CHANNELS.getIdentity,
    async (event: IpcMainInvokeEvent): Promise<DesktopIdentity> => {
      assertTrustedSender(event, IPC_CHANNELS.getIdentity);
      return getPublicIdentity();
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.signIdentityChallenge,
    async (event: IpcMainInvokeEvent, challenge: unknown): Promise<string> => {
      assertTrustedSender(event, IPC_CHANNELS.signIdentityChallenge);
      const parsed = identityChallengeSchema.safeParse(challenge);
      if (!parsed.success) {
        throw new Error('Invalid identity challenge parameters');
      }
      return signIdentityChallenge(parsed.data satisfies DesktopIdentityChallenge);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.regenerateIdentity,
    async (event: IpcMainInvokeEvent): Promise<DesktopIdentity> => {
      assertTrustedSender(event, IPC_CHANNELS.regenerateIdentity);
      return regenerateIdentity();
    },
  );

  ipcMain.handle(IPC_CHANNELS.getNickname, async (event: IpcMainInvokeEvent): Promise<string> => {
    assertTrustedSender(event, IPC_CHANNELS.getNickname);
    return getNickname();
  });

  ipcMain.handle(
    IPC_CHANNELS.setNickname,
    async (event: IpcMainInvokeEvent, nickname: unknown): Promise<boolean> => {
      assertTrustedSender(event, IPC_CHANNELS.setNickname);
      if (typeof nickname !== 'string') return false;
      return setNickname(nickname);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.getClientSettings,
    async (event: IpcMainInvokeEvent): Promise<DesktopClientSettings> => {
      assertTrustedSender(event, IPC_CHANNELS.getClientSettings);
      return getClientSettings();
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.updateClientSettings,
    async (event: IpcMainInvokeEvent, patch: unknown): Promise<DesktopClientSettings> => {
      assertTrustedSender(event, IPC_CHANNELS.updateClientSettings);
      const parsed = clientSettingsPatchSchema.safeParse(patch);
      if (!parsed.success) throw new Error('Invalid client settings patch');
      return updateClientSettings(parsed.data satisfies DesktopClientSettingsPatch);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.addBookmark,
    async (event: IpcMainInvokeEvent, input: unknown): Promise<DesktopServerBookmark> => {
      assertTrustedSender(event, IPC_CHANNELS.addBookmark);
      const parsed = bookmarkInputSchema.safeParse(input);
      if (!parsed.success) throw new Error('Invalid bookmark');
      return addBookmark(parsed.data satisfies DesktopBookmarkInput);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.updateBookmark,
    async (event: IpcMainInvokeEvent, bookmark: unknown): Promise<boolean> => {
      assertTrustedSender(event, IPC_CHANNELS.updateBookmark);
      const parsed = bookmarkSchema.safeParse(bookmark);
      if (!parsed.success) return false;
      return updateBookmark(parsed.data satisfies DesktopServerBookmark);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.removeBookmark,
    async (event: IpcMainInvokeEvent, bookmarkId: unknown): Promise<boolean> => {
      assertTrustedSender(event, IPC_CHANNELS.removeBookmark);
      if (typeof bookmarkId !== 'string') return false;
      return removeBookmark(bookmarkId);
    },
  );
}
