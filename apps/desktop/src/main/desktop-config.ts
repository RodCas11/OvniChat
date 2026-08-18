import { parseConfig } from '@disco-voador/config';
import { channelIdSchema } from '@disco-voador/protocol';
import type { RtcIceServerConfig } from '@disco-voador/rtc-core';
import { z } from 'zod';

/**
 * The realtime server URL is operator/deployment configuration, not an end-user-editable field in
 * the Renderer — see `docs/architecture/WEBRTC_VOICE.md` for why. This keeps the Content-Security-
 * Policy's `connect-src` an exact, single allowlisted origin (computed from this same value) rather
 * than a wildcard: an arbitrary runtime-user-typed endpoint could never be safely pre-declared in a
 * CSP set before the page loads.
 */
function isWebSocketUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'ws:' || protocol === 'wss:';
  } catch {
    return false;
  }
}

const DEFAULT_REALTIME_URL = 'ws://127.0.0.1:8090';

/**
 * STUN is optional, best-effort NAT-traversal help, not required core communication — two peers on
 * the same LAN (T3's verification scenario) connect via host candidates without one. TURN/coturn
 * relay support needs short-lived credential minting that does not exist yet (see
 * `docs/references/COTURN.md`, `infrastructure/coturn/`) and is out of scope here.
 */
function isStunUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'stun:' || protocol === 'stuns:';
  } catch {
    return false;
  }
}

const stunUrlsSchema = z
  .string()
  .optional()
  .transform((value) =>
    value === undefined
      ? []
      : value
          .split(',')
          .map((entry) => entry.trim())
          .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(z.string().refine(isStunUrl, 'must be a stun: or stuns: URL')));

const desktopConfigSchema = z.object({
  DISCO_VOADOR_REALTIME_URL: z
    .string()
    .min(1)
    .refine(isWebSocketUrl, 'must be a ws:// or wss:// URL')
    .optional(),
  // Enables Chromium's fake-media-device switches for automated end-to-end verification. Reading
  // the flag here is harmless by itself; `main/index.ts` additionally requires `!app.isPackaged`
  // before ever acting on it — see docs/architecture/WEBRTC_VOICE.md and the security review of
  // this flag for why that second, Electron-level gate is load-bearing, not just this schema.
  DISCO_VOADOR_E2E_FAKE_MEDIA: z.enum(['1', '0']).optional(),
  // Comma-separated `stun:`/`stuns:` URLs, e.g. "stun:turn.example.com:3478,stun:stun2.example.com".
  DISCO_VOADOR_STUN_URLS: stunUrlsSchema,
  // Automated two-Electron-instance voice smoke test only (see
  // `apps/desktop/scripts/e2e-voice-smoke.mjs`): when set, this instance joins the named voice
  // channel on its own as soon as it connects, with no user interaction. Reading these here is
  // harmless by itself; `main/index.ts` additionally requires `!app.isPackaged` before ever
  // exposing them to the Renderer — the same second, Electron-level gate used for
  // `DISCO_VOADOR_E2E_FAKE_MEDIA`, so a packaged build can never auto-join anything.
  DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: channelIdSchema.optional(),
  DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: z.string().min(1).max(32).optional(),
});

export interface DesktopConfig {
  readonly realtimeUrl: string;
  readonly e2eFakeMediaRequested: boolean;
  readonly iceServers: readonly RtcIceServerConfig[];
  readonly e2eVoiceAutoJoin:
    { readonly channelId: string; readonly displayName: string } | undefined;
}

export function loadDesktopConfig(
  source: Record<string, string | undefined> = process.env,
): DesktopConfig {
  const parsed = parseConfig(desktopConfigSchema, source);
  const autoJoinChannel = parsed.DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL;

  return {
    realtimeUrl: parsed.DISCO_VOADOR_REALTIME_URL ?? DEFAULT_REALTIME_URL,
    e2eFakeMediaRequested: parsed.DISCO_VOADOR_E2E_FAKE_MEDIA === '1',
    iceServers: parsed.DISCO_VOADOR_STUN_URLS.map((urls) => ({ urls })),
    e2eVoiceAutoJoin: autoJoinChannel
      ? {
          channelId: autoJoinChannel,
          displayName: parsed.DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME ?? 'e2e-tester',
        }
      : undefined,
  };
}
