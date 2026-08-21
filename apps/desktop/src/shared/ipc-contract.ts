import type { RtcIceServerConfig } from '@disco-voador/rtc-core';

/**
 * Canonical, narrow IPC contract shared by Main and Preload. Renderer only ever sees the typed
 * `DesktopApi` shape through the Preload bridge, never a channel name or `ipcRenderer`.
 */

/**
 * T12 — the `window.postMessage` type discriminator `preload/index.ts` uses to relay a transferred
 * process-audio `MessagePort` from the isolated preload world into the Renderer's main world (the
 * officially documented Electron pattern for handing a real `MessagePort` across the contextIsolation
 * boundary — `contextBridge` itself cannot clone a `MessagePort`, but the standard DOM
 * `window.postMessage([port])` transfer mechanism can). Namespaced distinctly from any IPC channel
 * name since this travels over the main-world `window` message bus, not `ipcRenderer` — see
 * `apps/desktop/src/renderer/media/process-audio-bridge.ts`.
 */
export const PROCESS_AUDIO_PORT_WINDOW_MESSAGE_TYPE = 'ovnichat:process-audio-port';

export const IPC_CHANNELS = {
  getVersionInfo: 'app:get-version-info',
  getRealtimeConfig: 'app:get-realtime-config',
  getE2EVoiceConfig: 'app:get-e2e-voice-config',
  getE2ESettingsPersistenceConfig: 'app:get-e2e-settings-persistence-config',
  listScreenShareSources: 'app:list-screen-share-sources',
  selectScreenShareSource: 'app:select-screen-share-source',
  // T12 — Windows per-process/game audio capture. See `main/process-audio.ts`.
  getProcessAudioCapability: 'app:get-process-audio-capability',
  listProcessAudioCandidates: 'app:list-process-audio-candidates',
  cancelProcessAudioEnumeration: 'app:cancel-process-audio-enumeration',
  startProcessAudioCapture: 'app:start-process-audio-capture',
  stopProcessAudioCapture: 'app:stop-process-audio-capture',
  /** Main -> Renderer only, via `WebContents.postMessage`/`ipcRenderer.on` (a `MessagePortMain`
   * transfer, never a request/response `invoke`) — see `main/process-audio.ts` and
   * `preload/index.ts`'s dedicated relay listener for this exact channel. */
  processAudioPort: 'app:process-audio-port',
  /** Main -> Renderer only, via `webContents.send`/`ipcRenderer.on` — a push notification (never
   * Renderer-invoked) that a process-audio session ended on its own (target process exited, the
   * native helper crashed, or a capture error) — see `DesktopProcessAudioEndedInfo`. */
  processAudioEnded: 'app:process-audio-ended',
  getIdentity: 'app:get-identity',
  signIdentityChallenge: 'app:sign-identity-challenge',
  regenerateIdentity: 'app:regenerate-identity',
  getNickname: 'app:get-nickname',
  setNickname: 'app:set-nickname',
  getClientSettings: 'app:get-client-settings',
  updateClientSettings: 'app:update-client-settings',
  addBookmark: 'app:add-bookmark',
  updateBookmark: 'app:update-bookmark',
  removeBookmark: 'app:remove-bookmark',
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
  /**
   * T12: publisher role only — when either is set alongside `autoScreenShare`, the auto-share
   * sequence picks "Application audio" instead of "System audio", targeting a specific enumerated
   * `listProcessAudioCandidates()` candidate. `processAudioTargetPid` (exact match) takes priority
   * over `processAudioTargetExe` (substring match against `exeName`) when both are set — see
   * `desktop-config.ts`'s own doc comment for why PID-exact-matching is what the E2E harness
   * actually needs (its synthetic "tone process" candidates share the same `electron.exe` image name
   * as every other Electron instance in that test topology). `undefined`/`undefined` means the
   * auto-share sequence behaves exactly as it did before T12 (System audio, per
   * `autoScreenShareAudio`). See `apps/desktop/scripts/e2e-process-audio-smoke.mjs`.
   */
  readonly processAudioTargetPid: number | undefined;
  readonly processAudioTargetExe: string | undefined;
  /**
   * T12: viewer role only — both set together arm `e2e-frequency-probe.ts` on the remote
   * screen-audio track, in *addition* to (never instead of) the plain RMS `e2e-audio-probe.ts`
   * check every scenario already gets, expecting `processAudioExpectedHz` strongly present and
   * `processAudioRejectedHz` excluded by a wide margin.
   */
  readonly processAudioExpectedHz: number | undefined;
  readonly processAudioRejectedHz: number | undefined;
  /**
   * T12: publisher role only — arms a scripted post-share lifecycle sequence (mute mic -> unmute ->
   * stop sharing) proving mic-mute independence and clean-stop behavior for process audio,
   * mirroring T6's own scripted sequence. See `apps/desktop/scripts/e2e-process-audio-smoke.mjs`'s
   * "mid-share lifecycle" scenario.
   */
  readonly processAudioLifecycleScenario: boolean;
  /**
   * T8: overrides which server `AutoConnect` connects to, independent of `DesktopRealtimeConfig.url`
   * (the CSP-relevant deployment default). Only `e2e-connection-smoke.mjs` sets this, deliberately to
   * a *different* address than `DISCO_VOADOR_REALTIME_URL` — proving the Renderer can actually reach
   * a server address that was not known at launch, the real product capability T8 added (and the gap
   * a security review found: CSP `connect-src` must permit this, not just the one baked-in origin).
   * `undefined` means "connect to the deployment-default address", the pre-T8 behavior.
   */
  readonly connectUrl: string | undefined;
  /**
   * T9: once connected, automatically redeems this bearer token via
   * `client:authorization-redeem-token` — the same production action the "Use Privilege Key"
   * panel drives, with no human interaction. See `apps/desktop/scripts/e2e-authorization.mjs`.
   */
  readonly redeemToken: string | undefined;
  /**
   * T10: once connected, automatically sends this body to Server Chat via `client:chat-send` — the
   * same production `sendChatMessage` action the chat composer drives, with no human interaction.
   * See `apps/desktop/scripts/e2e-text-chat-persistence.mjs`.
   */
  readonly autoChatSendServerBody: string | undefined;
  /**
   * T10: once joined to `channelId` above, automatically sends this body to that channel's chat.
   * See `apps/desktop/scripts/e2e-text-chat-channel-persistence.mjs`.
   */
  readonly autoChatSendChannelBody: string | undefined;
}

/**
 * T11 — present only for `apps/desktop/scripts/e2e-settings-persistence.mjs`, and only when
 * `!app.isPackaged` (see `main/window.ts`), the same double gate every other `DesktopE2E*Config`
 * field in this file already uses. `undefined` for every real user, always. Deliberately its own
 * small config/channel, independent of `DesktopE2EVoiceConfig` — that one's very presence forces
 * `App.tsx`'s E2E `AutoFirstRun`/`AutoConnect` path (auto-connecting to a real realtime service),
 * which this settings-only scenario must not require (mirrors `e2e-identity-persistence.mjs`'s own
 * zero-server design).
 */
export interface DesktopE2ESettingsPersistenceConfig {
  /** `true` only on the orchestrating script's first launch of a given `--user-data-dir` — see
   * `App.tsx`'s settings-persistence-automation effect for the full read/write scenario. */
  readonly write: boolean;
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

/**
 * T12 — the result of `Main`'s pure, non-native, no-helper-spawn feature test
 * (`@disco-voador/windows-media`'s `detectProcessAudioCapability()`) for whether Windows
 * per-process/game audio capture is even possible on this machine. Cheap and side-effect-free —
 * `ScreenSourcePicker` calls this to decide whether to show/enable the "Application audio" choice
 * at all, without spawning the native helper the way `listProcessAudioCandidates` does.
 */
export type DesktopProcessAudioCapabilityResult =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: 'not-windows' | 'build-too-old' };

/**
 * T12 — one audio-capable running process, as `main/process-audio.ts` re-exposes it from
 * `@disco-voador/windows-media`'s `ProcessCandidate` — already sanitized/bounded upstream by the
 * native helper (see that package's `protocol.ts`), nothing further stripped here. `pid` is only
 * ever accepted by `startProcessAudioCapture` when it was returned by the *most recent*
 * `listProcessAudioCandidates()` call from this same trusted window — mirrors
 * `DesktopScreenSource.id`'s own validate-against-last-enumeration contract exactly.
 */
export interface DesktopProcessAudioCandidate {
  readonly pid: number;
  /** Executable basename only (e.g. `"Game.exe"`), never a full path. */
  readonly exeName: string;
  /** A friendly window/session title where the platform provides one; empty string if unavailable. */
  readonly displayTitle: string;
}

/**
 * `supported: false` here means the same thing `DesktopProcessAudioCapabilityResult` does — surfaced
 * again on this call specifically because a picker may call `listProcessAudioCandidates` without
 * having first checked capability separately; `candidates` is always `[]` in that case, never a
 * partial/best-effort list (T12's "no silent broadening" rule applies to enumeration honesty too:
 * an unsupported system reports honestly empty, never fabricated).
 */
export type DesktopProcessAudioCandidatesResult =
  | { readonly supported: true; readonly candidates: readonly DesktopProcessAudioCandidate[] }
  | { readonly supported: false; readonly reason: 'not-windows' | 'build-too-old' };

/**
 * `accepted: false` covers every reason a capture could not be armed (capability unsupported, `pid`
 * not present in the last enumerated set, a capture already in progress, or the enumeration
 * supervisor this `pid` came from is no longer alive) — deliberately undifferentiated, mirroring
 * `selectScreenShareSource`'s own "never leak which specific reason" discipline. `sessionId` is an
 * opaque, monotonically-increasing Main-process-local session identifier (never meaningful outside
 * this process) — used only so a later `DesktopProcessAudioEndedInfo` push can be matched back to
 * *this* specific session, never a stale/superseded one.
 */
export type DesktopProcessAudioStartResult =
  { readonly accepted: true; readonly sessionId: number } | { readonly accepted: false };

/**
 * Pushed by Main (never invoked/requested by the Renderer) exactly when a process-audio session ends
 * on its own — the captured process exited (`target-ended`), the native helper reported a capture
 * error (`error`), or the helper process itself exited unexpectedly (`helper-exit`). Never sent for a
 * caller-initiated `stopProcessAudioCapture()` — the Renderer already knows about that one, since it
 * asked for it. The Renderer must compare `sessionId` against whichever session it currently
 * considers live before acting on this — see `use-voice-channel.ts`.
 */
export interface DesktopProcessAudioEndedInfo {
  readonly sessionId: number;
  readonly reason: 'target-ended' | 'error' | 'helper-exit';
}

/**
 * The connection's local cryptographic identity, as the Renderer is allowed to know it — a public
 * key and its server-derived id, never the private key (see `main/identity/identity-service.ts`
 * and `docs/architecture/CLIENT_IDENTITY.md`). `identityId` is computed the same way the realtime
 * server independently re-derives it from the public key it verifies (`dv1_<...>`), so a client
 * can display/compare it with confidence it matches what a server will report back.
 */
export interface DesktopIdentity {
  readonly identityId: string;
  readonly publicKey: string;
}

/**
 * Structured, bounded parameters for one identity-challenge signature — never raw bytes to sign.
 * Main reconstructs the exact canonical payload itself from these fields plus its own stored
 * public key (see `buildIdentityAuthPayload` in `@disco-voador/protocol`), so this call can never
 * be used as a generic "sign anything" oracle even by a fully compromised Renderer.
 */
export interface DesktopIdentityChallenge {
  readonly protocolVersion: number;
  readonly connectionId: string;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly nickname: string;
}

/**
 * T11 local client settings — device/UI preferences the Client owns for itself, entirely separate
 * from server-local authorization/chat data (T9/T10) and from identity/nickname (T7). Never sent to
 * any Dedicated Server. See `main/settings/settings-file.ts` and
 * `docs/architecture/CLIENT_SETTINGS_AND_RECONNECT.md`. `null` for a device id means "use the
 * platform's current system default," distinct from "no preference recorded yet" (which also
 * resolves to `null` — there is no third state, since the UX is identical either way).
 */
export interface DesktopClientSettings {
  readonly audio: {
    readonly inputDeviceId: string | null;
    readonly outputDeviceId: string | null;
  };
  readonly video: {
    readonly cameraDeviceId: string | null;
  };
  readonly screenShare: {
    readonly qualityPreset: 'standard' | 'high' | 'smooth' | 'smooth720';
  };
  readonly voice: {
    readonly startMuted: boolean;
    readonly startDeafened: boolean;
  };
  readonly bookmarks: readonly DesktopServerBookmark[];
  /** The last address a user actually connected to (manually or via a bookmark) — pre-fills
   * `ConnectionScreen`, never auto-connects by itself unless `connectOnStartup` is also `true`. */
  readonly lastServerAddress: string | null;
  /** Explicit opt-in only (T11 Section 15) — never enabled by default. */
  readonly connectOnStartup: boolean;
}

/** A narrow, explicitly-named patch — never a whole-object replacement — mirroring this file's
 * existing "one capability, one purpose" IPC discipline. Bookmarks are mutated through their own
 * dedicated `addBookmark`/`updateBookmark`/`removeBookmark` operations, never through this patch. */
export interface DesktopClientSettingsPatch {
  readonly audio?:
    | {
        readonly inputDeviceId?: string | null | undefined;
        readonly outputDeviceId?: string | null | undefined;
      }
    | undefined;
  readonly video?: { readonly cameraDeviceId?: string | null | undefined } | undefined;
  readonly screenShare?:
    | { readonly qualityPreset?: DesktopClientSettings['screenShare']['qualityPreset'] | undefined }
    | undefined;
  readonly voice?:
    | { readonly startMuted?: boolean | undefined; readonly startDeafened?: boolean | undefined }
    | undefined;
  readonly lastServerAddress?: string | null | undefined;
  readonly connectOnStartup?: boolean | undefined;
}

/**
 * A local, client-only server bookmark (T11 Section 9-11) — `displayName`/`serverAddress` only.
 * **Never** carries an invite/privilege token or any other bearer credential; a
 * `ConnectionScreen`-entered token is used for one connection attempt and discarded, exactly as it
 * is for a manually-typed address, never persisted here or anywhere else.
 */
export interface DesktopServerBookmark {
  readonly bookmarkId: string;
  readonly displayName: string;
  readonly serverAddress: string;
}

export interface DesktopBookmarkInput {
  readonly displayName: string;
  readonly serverAddress: string;
}

export interface DesktopApi {
  getVersionInfo: () => Promise<DesktopVersionInfo>;
  getRealtimeConfig: () => Promise<DesktopRealtimeConfig>;
  getE2EVoiceConfig: () => Promise<DesktopE2EVoiceConfig | undefined>;
  /** See {@link DesktopE2ESettingsPersistenceConfig}. */
  getE2ESettingsPersistenceConfig: () => Promise<DesktopE2ESettingsPersistenceConfig | undefined>;
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
  /** T12 — cheap, side-effect-free (never spawns the native helper) feature test for whether
   * Windows per-process/game audio capture is even possible on this machine. */
  getProcessAudioCapability: () => Promise<DesktopProcessAudioCapabilityResult>;
  /**
   * T12 — enumerates current audio-capable processes as sanitized plain data, lazily starting (or
   * reusing an already-running) native helper for enumeration. Calling this again replaces the set
   * of `pid`s `startProcessAudioCapture` will accept, mirroring `listScreenShareSources`.
   */
  listProcessAudioCandidates: () => Promise<DesktopProcessAudioCandidatesResult>;
  /**
   * T12 — tears down an enumeration-only helper (one not yet converted into an active capture) if
   * one is currently running. A no-op if no such helper exists, and never affects an active capture
   * — call when a picker UI is dismissed without starting a share, so a helper process spawned only
   * to populate a dropdown does not linger for the rest of the app's lifetime.
   */
  cancelProcessAudioEnumeration: () => Promise<void>;
  /**
   * T12 — validates `pid` against the most recently enumerated set (see
   * `listProcessAudioCandidates`) and, if valid, starts real native process-loopback capture for it
   * and arms a `MessageChannelMain` PCM bridge. On success, the transferred `MessagePort` arrives
   * separately (see `processAudioPort`/`onProcessAudioEnded` and
   * `apps/desktop/src/renderer/media/process-audio-bridge.ts`), not as part of this call's result.
   */
  startProcessAudioCapture: (pid: number) => Promise<DesktopProcessAudioStartResult>;
  /** T12 — stops the currently-active process-audio capture (if any), releasing the native helper.
   * Idempotent; a no-op if no capture is currently active. */
  stopProcessAudioCapture: () => Promise<void>;
  /**
   * T12 — subscribes to `processAudioEnded` push notifications (see
   * {@link DesktopProcessAudioEndedInfo}); returns an unsubscribe function. Never fires for a
   * caller-initiated `stopProcessAudioCapture()`.
   */
  onProcessAudioEnded: (listener: (info: DesktopProcessAudioEndedInfo) => void) => () => void;
  /**
   * Loads (creating on first run) and returns the public half of this profile's local
   * cryptographic identity. Rejects with an actionable error message if the identity cannot be
   * loaded (e.g. OS secure storage unavailable, or the identity file is corrupted) — never falls
   * back to a plaintext or throwaway identity.
   */
  getIdentity: () => Promise<DesktopIdentity>;
  /** Signs one identity-challenge on the current local identity's behalf; see
   * {@link DesktopIdentityChallenge}. */
  signIdentityChallenge: (challenge: DesktopIdentityChallenge) => Promise<string>;
  /**
   * Destructive: mints and persists a brand-new local identity, replacing the current one for all
   * *future* connections. Never call this without explicit, confirmation-gated user intent — the
   * Renderer's settings UI is the only caller.
   */
  regenerateIdentity: () => Promise<DesktopIdentity>;
  /** Empty string means no nickname has been chosen yet (first run). */
  getNickname: () => Promise<string>;
  /** Returns `false` (never throws) for an invalid nickname. */
  setNickname: (nickname: string) => Promise<boolean>;
  /** Loads (creating defaults on first run, salvaging what it can from a corrupted file) the local
   * client settings. See {@link DesktopClientSettings}. */
  getClientSettings: () => Promise<DesktopClientSettings>;
  /** Merges a narrow patch into the current settings and persists the result. */
  updateClientSettings: (patch: DesktopClientSettingsPatch) => Promise<DesktopClientSettings>;
  addBookmark: (input: DesktopBookmarkInput) => Promise<DesktopServerBookmark>;
  /** Returns `false` (never throws) if `bookmark.bookmarkId` does not match an existing bookmark. */
  updateBookmark: (bookmark: DesktopServerBookmark) => Promise<boolean>;
  /** Returns `false` (never throws) if `bookmarkId` does not match an existing bookmark. */
  removeBookmark: (bookmarkId: string) => Promise<boolean>;
}
