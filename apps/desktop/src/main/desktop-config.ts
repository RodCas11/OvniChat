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
  // T4: automated two-Electron-instance camera smoke test only (see
  // `apps/desktop/scripts/e2e-camera-smoke.mjs`) — after auto-joining voice, also auto-enables the
  // camera with no user interaction. Meaningless without an auto-join channel also configured;
  // gated behind `!app.isPackaged` at the same point the auto-join config itself is.
  DISCO_VOADOR_E2E_VOICE_AUTO_CAMERA: z.enum(['1', '0']).optional(),
  // T4: automatically disables the camera again this many milliseconds after it turns on —
  // deterministic camera-off proof for the camera smoke test, meaningless without
  // `DISCO_VOADOR_E2E_VOICE_AUTO_CAMERA=1`. Same `!app.isPackaged` gating as everything else here.
  DISCO_VOADOR_E2E_VOICE_AUTO_CAMERA_OFF_MS: z.coerce.number().int().positive().optional(),
  // T5: automated two-Electron-instance screen-share smoke test only — mirrors
  // `DISCO_VOADOR_E2E_VOICE_AUTO_CAMERA` exactly, but for screen sharing. Meaningless without an
  // auto-join channel also configured; gated behind `!app.isPackaged` at the same point as
  // everything else here. Does not skip `listScreenShareSources`/`selectScreenShareSource` — the
  // Renderer still drives the real production IPC, just without a human clicking the picker.
  DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE: z.enum(['1', '0']).optional(),
  // T5: automatically disables screen sharing again this many milliseconds after it turns on —
  // deterministic screen-share-off proof, meaningless without
  // `DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE=1`. Same `!app.isPackaged` gating as everything else
  // here.
  DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_OFF_MS: z.coerce.number().int().positive().optional(),
  // T5 stabilization: automatically re-enables screen sharing this many milliseconds after the
  // auto-off above fires — deterministic re-share proof (a second share cycle must still produce
  // real decoded remote frames, guarding against stale mid/transceiver/sender state left over from
  // the first cycle). Meaningless without both of the two flags above also set. Same gating.
  DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_RESHARE_AFTER_MS: z.coerce
    .number()
    .int()
    .positive()
    .optional(),
});

export interface DesktopConfig {
  readonly realtimeUrl: string;
  readonly e2eFakeMediaRequested: boolean;
  readonly iceServers: readonly RtcIceServerConfig[];
  readonly e2eVoiceAutoJoin:
    | {
        readonly channelId: string;
        readonly displayName: string;
        readonly autoCamera: boolean;
        readonly autoCameraOffAfterMs: number | undefined;
        readonly autoScreenShare: boolean;
        readonly autoScreenShareOffAfterMs: number | undefined;
        readonly autoScreenShareReshareAfterMs: number | undefined;
      }
    | undefined;
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
          autoCamera: parsed.DISCO_VOADOR_E2E_VOICE_AUTO_CAMERA === '1',
          autoCameraOffAfterMs: parsed.DISCO_VOADOR_E2E_VOICE_AUTO_CAMERA_OFF_MS,
          autoScreenShare: parsed.DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE === '1',
          autoScreenShareOffAfterMs: parsed.DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_OFF_MS,
          autoScreenShareReshareAfterMs:
            parsed.DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_RESHARE_AFTER_MS,
        }
      : undefined,
  };
}
