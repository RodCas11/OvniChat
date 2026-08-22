import { parseConfig } from '@disco-voador/config';
import { channelIdSchema } from '@disco-voador/protocol';
import type { RtcIceServerConfig } from '@disco-voador/rtc-core';
import { z } from 'zod';

/**
 * `DISCO_VOADOR_REALTIME_URL` is a deployment/development default only (T8): a pre-fill convenience
 * for `ConnectionScreen`'s address field and the E2E auto-connect path, never the sole allowed
 * server. Before T8 this value was the one CSP `connect-src` origin the Renderer could ever reach;
 * T8 made the connect target a runtime, user-typed value instead, so `content-security-policy.ts`
 * now scopes `connect-src` to the `ws:`/`wss:` schemes generically rather than one pre-declared
 * origin — see that file's doc comment and `docs/architecture/DEDICATED_SERVER.md`.
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
  // T13.2: attaches a password to the initial auto-join attempt above — the same optional
  // `voice:join.password` field a real `PasswordJoinDialog` submission drives. Meaningless without
  // `DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL` also set. See
  // `apps/desktop/scripts/e2e-channel-admin-smoke.mjs`'s wrong-password/right-password sequence,
  // which relaunches this same profile with a different value of this field rather than needing a
  // live in-process retry mechanism (T7's identity, and any group this identity was granted,
  // persist across a relaunch of the same `--user-data-dir` — see `e2e-authorization.mjs`'s own
  // proven relaunch technique).
  DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_PASSWORD: z.string().min(1).max(128).optional(),
  // T13.2: after the initial auto-join above lands, schedules up to two further *scripted*
  // `voice:join` attempts against a second channel — real production `actions.join()` calls fired by
  // a fixed timer (mirroring `DISCO_VOADOR_E2E_VOICE_AUTO_CAMERA_OFF_MS`'s own "config-driven scripted
  // timer calling a real action" pattern exactly), never a second Electron instance or a DOM click.
  // Proves a live ACL grant took effect on an *already-connected* connection with no reconnect: the
  // first scripted attempt fires before `e2e-channel-admin-smoke.mjs`'s admin grants a group, the
  // second fires after — see that script for the full sequencing. Both attempts target the same
  // channel; neither carries a password (this scenario's negative-then-positive proof is about join
  // policy, not password — password is proven separately via the relaunch sequence above).
  DISCO_VOADOR_E2E_CHANNEL_ADMIN_RETRY_CHANNEL: channelIdSchema.optional(),
  DISCO_VOADOR_E2E_CHANNEL_ADMIN_RETRY1_AFTER_MS: z.coerce.number().int().positive().optional(),
  DISCO_VOADOR_E2E_CHANNEL_ADMIN_RETRY2_AFTER_MS: z.coerce.number().int().positive().optional(),
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
  // T6: automated two-Electron-instance screen-audio smoke test only (see
  // `apps/desktop/scripts/e2e-screen-audio-smoke.mjs`) — arms the publisher-role scripted
  // audio-on/off/mute sequence (see `VoiceChannelView.tsx`'s `autoScreenShareAudio` orchestration)
  // and, on both roles, auto-deafens immediately after voice connects so this machine's own remote
  // playback never re-enters the publisher's system-audio loopback capture (same-machine feedback
  // avoidance — see `docs/architecture/WEBRTC_SCREEN_AUDIO.md`). Meaningless without
  // `DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE=1` also set on the publisher instance. Same
  // `!app.isPackaged` gating as everything else here.
  DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_AUDIO: z.enum(['1', '0']).optional(),
  // T12: automated process-loopback isolation smoke test only (see
  // `apps/desktop/scripts/e2e-process-audio-smoke.mjs`), publisher role — when set alongside
  // `DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE=1`, the auto-share sequence picks "Application audio"
  // instead of "System audio", targeting a specific enumerated `listProcessAudioCandidates()`
  // candidate. Meaningless without `DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE=1` also set. Same
  // `!app.isPackaged` gating as everything else here. Never present on a real user's machine — this
  // is the one thing that steers the automated test toward the real `startProcessAudioCapture` IPC
  // path instead of the real `selectScreenShareSource`(`audio: 'loopback'`) path; everything
  // downstream of the pick (enumeration, validation, native capture, WebRTC publication) is the
  // unmodified production path.
  //
  // Two matching strategies, `_TARGET_PID` taking priority when both are set:
  //   `_TARGET_PID` — exact PID match. The E2E harness's two "tone process" candidates (see
  //   `scripts/lib/tone-process/main.mjs`) are themselves plain `electron.exe` processes, same as
  //   every other Electron instance this same test topology runs (the publisher/viewer themselves,
  //   plus each Electron app's own child renderer processes) — `exeName` alone cannot distinguish
  //   between them, so the harness reads each tone process's real PID back from its own
  //   `TONE_PROCESS_READY:pid=<pid>` stdout marker and passes it here directly.
  //   `_TARGET_EXE` — substring match against `exeName`, kept for a real distinctly-named
  //   application/game a human might use to exercise this same env-var-driven path manually.
  DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_PID: z.coerce.number().int().positive().optional(),
  DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_EXE: z.string().min(1).optional(),
  // T12: viewer role — arms `e2e-frequency-probe.ts` (in *addition* to, never instead of, the
  // plain RMS `e2e-audio-probe.ts` general screen-audio check every scenario already gets) on the
  // remote screen-audio track, expecting `..._EXPECTED_HZ` strongly present and `..._REJECTED_HZ`
  // excluded by a wide margin. Both must be set together; independent of `autoScreenShareAudio`
  // (unlike T6's own RMS-only check, this one doesn't need it — see `VoiceChannelView.tsx`'s
  // `probedProcessAudioFrequencies` effect).
  DISCO_VOADOR_E2E_PROCESS_AUDIO_EXPECTED_HZ: z.coerce.number().positive().optional(),
  DISCO_VOADOR_E2E_PROCESS_AUDIO_REJECTED_HZ: z.coerce.number().positive().optional(),
  // T12: publisher role — arms a scripted post-share lifecycle sequence (mute mic -> wait -> unmute
  // -> wait -> stop sharing) proving mic-mute independence and clean-stop behavior, mirroring T6's
  // own scripted sequence but for process audio. See `e2e-process-audio-smoke.mjs`'s "mid-share
  // lifecycle" scenario and `VoiceChannelView.tsx`'s `processAudioLifecycleScenarioStarted` effect.
  // Meaningless unless a process-audio target is also set.
  DISCO_VOADOR_E2E_PROCESS_AUDIO_LIFECYCLE_SCENARIO: z.enum(['1', '0']).optional(),
  // T8: overrides AutoConnect's target address, independent of DISCO_VOADOR_REALTIME_URL — see
  // `DesktopE2EVoiceConfig.connectUrl`'s doc comment in `shared/ipc-contract.ts` for why this exists
  // as its own field rather than reusing DISCO_VOADOR_REALTIME_URL. Same `!app.isPackaged` gating as
  // everything else here.
  DISCO_VOADOR_E2E_CONNECT_URL: z
    .string()
    .min(1)
    .refine(isWebSocketUrl, 'must be a ws:// or wss:// URL')
    .optional(),
  // T9: once connected, automatically redeems this bearer token (privilege key, invite token, or
  // the bootstrap Server Admin token) via `client:authorization-redeem-token` — the same production
  // action the "Use Privilege Key" panel drives, with no human interaction. See
  // `apps/desktop/scripts/e2e-authorization.mjs`. Same `!app.isPackaged` gating as everything else
  // here.
  DISCO_VOADOR_E2E_REDEEM_TOKEN: z.string().min(1).optional(),
  // T10: once connected, automatically sends this body to Server Chat via `client:chat-send` — the
  // same production `sendChatMessage` action the chat composer drives, with no human interaction.
  // See `apps/desktop/scripts/e2e-text-chat-persistence.mjs`. Same `!app.isPackaged` gating as
  // everything else here.
  DISCO_VOADOR_E2E_CHAT_SEND_SERVER: z.string().min(1).optional(),
  // T10: once joined to the auto-join voice channel, automatically sends this body to that
  // channel's chat. See `apps/desktop/scripts/e2e-text-chat-channel-persistence.mjs`.
  DISCO_VOADOR_E2E_CHAT_SEND_CHANNEL: z.string().min(1).optional(),
  // T11: arms `apps/desktop/scripts/e2e-settings-persistence.mjs` — deliberately independent of
  // `DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL`/`e2eVoiceAutoJoin` (see
  // `DesktopE2ESettingsPersistenceConfig`'s own doc comment in `shared/ipc-contract.ts` for why: this
  // scenario needs no realtime service at all). Same `!app.isPackaged` gating as everything else
  // here, applied one layer up in `main/window.ts`.
  DISCO_VOADOR_E2E_SETTINGS_PERSISTENCE: z.enum(['1', '0']).optional(),
  // T11: only meaningful alongside the flag above — see
  // `DesktopE2ESettingsPersistenceConfig.write`'s doc comment.
  DISCO_VOADOR_E2E_SETTINGS_PERSISTENCE_WRITE: z.enum(['1', '0']).optional(),
  // T13.1: arms `apps/desktop/scripts/e2e-product-shell-smoke.mjs` — see
  // `DesktopE2EVoiceConfig.productShellSmoke`'s doc comment. Gated on all four fields being present
  // (mirrors `autoJoinChannel`'s own presence-gating pattern below) rather than a separate boolean
  // flag, since a bookmark with no name/address would be meaningless anyway.
  DISCO_VOADOR_E2E_PSS_BOOKMARK_A_NAME: z.string().min(1).optional(),
  DISCO_VOADOR_E2E_PSS_BOOKMARK_A_ADDRESS: z.string().min(1).optional(),
  DISCO_VOADOR_E2E_PSS_BOOKMARK_B_NAME: z.string().min(1).optional(),
  DISCO_VOADOR_E2E_PSS_BOOKMARK_B_ADDRESS: z.string().min(1).optional(),
  // T13.1 screenshot-capture tooling only — arms `apps/desktop/scripts/e2e-screenshot-capture.mjs`'s
  // Home-screen shot (see `DesktopE2EScreenshotConfig`'s doc comment). Gated on all five fields
  // being present together, mirroring the PSS bookmark fields' own presence-gating pattern above.
  // Never set by a real user; same `!app.isPackaged` gating applied one layer up in `main/window.ts`.
  DISCO_VOADOR_E2E_SCREENSHOT_DISPLAY_NAME: z.string().min(1).max(32).optional(),
  DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_A_NAME: z.string().min(1).optional(),
  DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_A_ADDRESS: z.string().min(1).optional(),
  DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_B_NAME: z.string().min(1).optional(),
  DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_B_ADDRESS: z.string().min(1).optional(),
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
        readonly autoScreenShareAudio: boolean;
        readonly processAudioTargetPid: number | undefined;
        readonly processAudioTargetExe: string | undefined;
        readonly processAudioExpectedHz: number | undefined;
        readonly processAudioRejectedHz: number | undefined;
        readonly processAudioLifecycleScenario: boolean;
        readonly connectUrl: string | undefined;
        readonly redeemToken: string | undefined;
        readonly autoChatSendServerBody: string | undefined;
        readonly autoChatSendChannelBody: string | undefined;
        // T13.2 — see the schema fields' own doc comments above.
        readonly autoJoinPassword: string | undefined;
        readonly channelAdminRetry:
          | {
              readonly channelId: string;
              readonly retry1AfterMs: number;
              readonly retry2AfterMs: number;
            }
          | undefined;
        // T13.1 — see `DesktopE2EVoiceConfig.productShellSmoke`'s doc comment.
        readonly productShellSmoke:
          | {
              readonly bookmarkA: { readonly displayName: string; readonly serverAddress: string };
              readonly bookmarkB: { readonly displayName: string; readonly serverAddress: string };
            }
          | undefined;
      }
    | undefined;
  // T11 — see `DesktopE2ESettingsPersistenceConfig`'s doc comment; `undefined` unless
  // `DISCO_VOADOR_E2E_SETTINGS_PERSISTENCE=1`, mirroring `e2eVoiceAutoJoin`'s own presence-gating
  // shape exactly.
  readonly e2eSettingsPersistence: { readonly write: boolean } | undefined;
  // T13.1 screenshot-capture tooling only — see `DesktopE2EScreenshotConfig`'s doc comment in
  // `shared/ipc-contract.ts`. `undefined` unless all five `DISCO_VOADOR_E2E_SCREENSHOT_*` fields are
  // set, mirroring `productShellSmoke`'s own all-or-nothing presence gate above.
  readonly e2eScreenshot:
    | {
        readonly displayName: string;
        readonly bookmarkA: { readonly displayName: string; readonly serverAddress: string };
        readonly bookmarkB: { readonly displayName: string; readonly serverAddress: string };
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
          autoScreenShareAudio: parsed.DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_AUDIO === '1',
          processAudioTargetPid: parsed.DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_PID,
          processAudioTargetExe: parsed.DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_EXE,
          processAudioExpectedHz: parsed.DISCO_VOADOR_E2E_PROCESS_AUDIO_EXPECTED_HZ,
          processAudioRejectedHz: parsed.DISCO_VOADOR_E2E_PROCESS_AUDIO_REJECTED_HZ,
          processAudioLifecycleScenario:
            parsed.DISCO_VOADOR_E2E_PROCESS_AUDIO_LIFECYCLE_SCENARIO === '1',
          connectUrl: parsed.DISCO_VOADOR_E2E_CONNECT_URL,
          redeemToken: parsed.DISCO_VOADOR_E2E_REDEEM_TOKEN,
          autoChatSendServerBody: parsed.DISCO_VOADOR_E2E_CHAT_SEND_SERVER,
          autoChatSendChannelBody: parsed.DISCO_VOADOR_E2E_CHAT_SEND_CHANNEL,
          autoJoinPassword: parsed.DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_PASSWORD,
          channelAdminRetry:
            parsed.DISCO_VOADOR_E2E_CHANNEL_ADMIN_RETRY_CHANNEL &&
            parsed.DISCO_VOADOR_E2E_CHANNEL_ADMIN_RETRY1_AFTER_MS !== undefined &&
            parsed.DISCO_VOADOR_E2E_CHANNEL_ADMIN_RETRY2_AFTER_MS !== undefined
              ? {
                  channelId: parsed.DISCO_VOADOR_E2E_CHANNEL_ADMIN_RETRY_CHANNEL,
                  retry1AfterMs: parsed.DISCO_VOADOR_E2E_CHANNEL_ADMIN_RETRY1_AFTER_MS,
                  retry2AfterMs: parsed.DISCO_VOADOR_E2E_CHANNEL_ADMIN_RETRY2_AFTER_MS,
                }
              : undefined,
          productShellSmoke:
            parsed.DISCO_VOADOR_E2E_PSS_BOOKMARK_A_NAME &&
            parsed.DISCO_VOADOR_E2E_PSS_BOOKMARK_A_ADDRESS &&
            parsed.DISCO_VOADOR_E2E_PSS_BOOKMARK_B_NAME &&
            parsed.DISCO_VOADOR_E2E_PSS_BOOKMARK_B_ADDRESS
              ? {
                  bookmarkA: {
                    displayName: parsed.DISCO_VOADOR_E2E_PSS_BOOKMARK_A_NAME,
                    serverAddress: parsed.DISCO_VOADOR_E2E_PSS_BOOKMARK_A_ADDRESS,
                  },
                  bookmarkB: {
                    displayName: parsed.DISCO_VOADOR_E2E_PSS_BOOKMARK_B_NAME,
                    serverAddress: parsed.DISCO_VOADOR_E2E_PSS_BOOKMARK_B_ADDRESS,
                  },
                }
              : undefined,
        }
      : undefined,
    e2eSettingsPersistence:
      parsed.DISCO_VOADOR_E2E_SETTINGS_PERSISTENCE === '1'
        ? { write: parsed.DISCO_VOADOR_E2E_SETTINGS_PERSISTENCE_WRITE === '1' }
        : undefined,
    e2eScreenshot:
      parsed.DISCO_VOADOR_E2E_SCREENSHOT_DISPLAY_NAME &&
      parsed.DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_A_NAME &&
      parsed.DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_A_ADDRESS &&
      parsed.DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_B_NAME &&
      parsed.DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_B_ADDRESS
        ? {
            displayName: parsed.DISCO_VOADOR_E2E_SCREENSHOT_DISPLAY_NAME,
            bookmarkA: {
              displayName: parsed.DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_A_NAME,
              serverAddress: parsed.DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_A_ADDRESS,
            },
            bookmarkB: {
              displayName: parsed.DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_B_NAME,
              serverAddress: parsed.DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_B_ADDRESS,
            },
          }
        : undefined,
  };
}
