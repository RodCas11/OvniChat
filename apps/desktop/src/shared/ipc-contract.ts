import type { RtcIceServerConfig } from '@disco-voador/rtc-core';

/**
 * Canonical, narrow IPC contract shared by Main and Preload. Renderer only ever sees the typed
 * `DesktopApi` shape through the Preload bridge, never a channel name or `ipcRenderer`.
 */

export const IPC_CHANNELS = {
  getVersionInfo: 'app:get-version-info',
  getRealtimeConfig: 'app:get-realtime-config',
  getE2EVoiceConfig: 'app:get-e2e-voice-config',
  listScreenShareSources: 'app:list-screen-share-sources',
  selectScreenShareSource: 'app:select-screen-share-source',
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
 * Present only for the automated two-Electron-instance voice/camera/screen-share smoke tests (see
 * `apps/desktop/scripts/e2e-voice-smoke.mjs`, `e2e-camera-smoke.mjs`, and the future
 * `e2e-screen-smoke.mjs`), and only when `!app.isPackaged` — a packaged build always resolves this
 * to `undefined`, so it can never auto-join anything (or auto-enable a camera/screen share) for a
 * real user. `autoCamera` additionally requires `channelId` to be meaningful — it enables the
 * camera only after the auto-join completes. `autoScreenShare` follows the exact same shape as
 * `autoCamera`, but its actual enumerate → pick-first-screen → `selectScreenShareSource` →
 * start-capture sequence is Renderer orchestration this config field only enables — it goes through
 * the same generic `listScreenShareSources`/`selectScreenShareSource` IPC any real user's picker
 * uses, never a special auto-select channel.
 */
export interface DesktopE2EVoiceConfig {
  readonly channelId: string;
  readonly displayName: string;
  readonly autoCamera: boolean;
  /** Milliseconds after camera turns on before it's automatically disabled again; `undefined` means
   * never auto-disable. Meaningless unless `autoCamera` is also `true`. */
  readonly autoCameraOffAfterMs: number | undefined;
  readonly autoScreenShare: boolean;
  /** Milliseconds after screen share turns on before it's automatically disabled again;
   * `undefined` means never auto-disable. Meaningless unless `autoScreenShare` is also `true`. */
  readonly autoScreenShareOffAfterMs: number | undefined;
  /**
   * Milliseconds after screen share auto-*disables* (per `autoScreenShareOffAfterMs`) before it is
   * automatically re-enabled — proves a second share cycle produces real decoded remote frames
   * again (guards against stale `mid` mappings/transceivers/senders left over from the first
   * cycle). `undefined` means never re-share. Meaningless unless both `autoScreenShare` and
   * `autoScreenShareOffAfterMs` are also set.
   */
  readonly autoScreenShareReshareAfterMs: number | undefined;
  /**
   * T6: arms the publisher-role scripted audio-on/off/mute sequence (see `VoiceChannelView.tsx`)
   * and, on both roles, auto-deafens immediately after voice connects — same-machine feedback
   * avoidance for `e2e:screen-audio-smoke` (see `docs/architecture/WEBRTC_SCREEN_AUDIO.md`).
   * Meaningless unless `autoScreenShare` is also `true`.
   */
  readonly autoScreenShareAudio: boolean;
}

/**
 * A single sanitized screen/window capture candidate returned by `listScreenShareSources`. Plain,
 * bounded, serializable data only — never a native `DesktopCapturerSource`/`NativeImage` (see
 * `main/screen-share.ts`, which is the only place a native `DesktopCapturerSource` ever exists).
 *
 * `id` is privileged-ish (see `docs/tasks/T5_SCREEN_SHARE.md`): it is only ever accepted by
 * `selectScreenShareSource` when it was returned by the *most recent* `listScreenShareSources()`
 * call from this same trusted window, and a successful selection is single-use — see
 * `selectScreenShareSource` below.
 */
export interface DesktopScreenSource {
  readonly id: string;
  readonly name: string;
  readonly type: 'screen' | 'window';
  /** Bounded-size thumbnail (see `main/screen-share.ts`'s fixed `thumbnailSize`) as a `data:` URL —
   * never a raw `NativeImage`. Empty string if Electron returned no thumbnail for this source. */
  readonly thumbnailDataUrl: string;
  /** Bounded-size application icon as a `data:` URL; `undefined` for screen sources (which never
   * have one) and for windows Electron could not resolve an icon for. */
  readonly appIconDataUrl: string | undefined;
  /** Corresponds to the `Display.id` this source belongs to when Electron can resolve one;
   * `undefined` when unavailable (see `DesktopCapturerSource.display_id`'s own documented "empty
   * string if not available" case). */
  readonly displayId: string | undefined;
}

export interface DesktopApi {
  getVersionInfo: () => Promise<DesktopVersionInfo>;
  getRealtimeConfig: () => Promise<DesktopRealtimeConfig>;
  getE2EVoiceConfig: () => Promise<DesktopE2EVoiceConfig | undefined>;
  /**
   * Enumerates current screen/window capture candidates as sanitized plain data. Calling this
   * again replaces the set of ids `selectScreenShareSource` will accept — an id from a previous
   * call is no longer valid once a newer enumeration has happened, even if it was never selected.
   */
  listScreenShareSources: () => Promise<readonly DesktopScreenSource[]>;
  /**
   * Arms exactly one single-use pending selection that the *next* `getDisplayMedia()` call from
   * this window will consume — never more than one, and never a stale one (see
   * `main/screen-share.ts`). Returns `false` (never throws) for an unknown, stale, or invalid
   * `sourceId` instead of leaking a detailed error. Does not itself start capture — the caller
   * still has to invoke `getDisplayMedia()` (via `@disco-voador/media-core`'s `acquireScreen()`)
   * afterward for the selection to take effect.
   *
   * `shareAudio` (T6) is the user's explicit "Share audio" choice, armed alongside the source so
   * `main/screen-share.ts`'s `setDisplayMediaRequestHandler` callback knows whether to also resolve
   * with Windows system-audio loopback for this specific share — it is never inferred or defaulted
   * to `true`. The caller's own subsequent `acquireScreen()` call must request the same value
   * (`getDisplayMedia({ audio: shareAudio })`); Main additionally cross-checks this against the
   * platform's own `request.audioRequested` before ever granting audio (see
   * `docs/architecture/WEBRTC_SCREEN_AUDIO.md`).
   */
  selectScreenShareSource: (sourceId: string, shareAudio: boolean) => Promise<boolean>;
}
