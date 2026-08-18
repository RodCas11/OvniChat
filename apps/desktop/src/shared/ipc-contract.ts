import type { RtcIceServerConfig } from '@disco-voador/rtc-core';

/**
 * Canonical, narrow IPC contract shared by Main and Preload. Renderer only ever sees the typed
 * `DesktopApi` shape through the Preload bridge, never a channel name or `ipcRenderer`.
 */

export const IPC_CHANNELS = {
  getVersionInfo: 'app:get-version-info',
  getRealtimeConfig: 'app:get-realtime-config',
  getE2EVoiceConfig: 'app:get-e2e-voice-config',
} as const;

export interface DesktopVersionInfo {
  readonly appVersion: string;
  readonly electronVersion: string;
}

/**
 * The realtime WebSocket endpoint and ICE server list this build is configured to use (operator/
 * deployment configuration — see `main/desktop-config.ts` — never a Renderer-editable free-text
 * field). `iceServers` may be empty: on a LAN, host ICE candidates alone are often enough to
 * connect without a STUN server at all.
 */
export interface DesktopRealtimeConfig {
  readonly url: string;
  readonly iceServers: readonly RtcIceServerConfig[];
}

/**
 * Present only for the automated two-Electron-instance voice smoke test (see
 * `apps/desktop/scripts/e2e-voice-smoke.mjs`), and only when `!app.isPackaged` — a packaged build
 * always resolves this to `undefined`, so it can never auto-join anything for a real user.
 */
export interface DesktopE2EVoiceConfig {
  readonly channelId: string;
  readonly displayName: string;
}

export interface DesktopApi {
  getVersionInfo: () => Promise<DesktopVersionInfo>;
  getRealtimeConfig: () => Promise<DesktopRealtimeConfig>;
  getE2EVoiceConfig: () => Promise<DesktopE2EVoiceConfig | undefined>;
}
