import { app, BrowserWindow, dialog, globalShortcut, Menu, session } from 'electron';
import { promises as fsPromises } from 'node:fs';
import path from 'node:path';

import { loadDesktopConfig } from './desktop-config.js';
import { allowedRendererOrigins } from './origins.js';
import { installPermissionHandlers } from './permissions.js';
import { disposeProcessAudioSession } from './process-audio.js';
import { initializePttHotkeyFromSettings, stopPttHotkeyListener } from './ptt-hotkey.js';
import { registerAppProtocolHandler, registerAppProtocolPrivileges } from './protocol.js';
import { installScreenShareHandlers } from './screen-share.js';
import { getClientSettings } from './settings/settings-service.js';
import { IPC_CHANNELS } from '../shared/ipc-contract.js';
import { createMainWindow, devServerUrl } from './window.js';

// Must run before `app` becomes ready.
registerAppProtocolPrivileges();

const config = loadDesktopConfig();

/**
 * Chromium's fake-media-device switches, gated so they can never activate accidentally in a real
 * user's packaged install: BOTH the explicit opt-in env var AND `!app.isPackaged` are required.
 * `app.isPackaged` alone is not spoofable by an end user (it reflects how the binary was actually
 * built/launched, not anything read from the environment), so a packaged build can never satisfy
 * this condition regardless of what environment variables surround it. Used only by the T3
 * automated two-Electron-instance WebRTC smoke test — see docs/architecture/WEBRTC_VOICE.md and
 * `apps/desktop/scripts/e2e-voice-smoke.mjs`. Command-line switches must be appended before
 * `app.whenReady()` to take effect.
 */
if (config.e2eFakeMediaRequested && !app.isPackaged) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  // T13.4 — see `desktop-config.ts`'s own doc comment on `DISCO_VOADOR_E2E_FAKE_AUDIO_FILE` for why
  // this exists (the plain fake-device generator produces literal silence on at least one real
  // verified environment) and why it is gated identically to the switches above.
  if (config.e2eFakeAudioFile) {
    app.commandLine.appendSwitch('use-file-for-fake-audio-capture', config.e2eFakeAudioFile);
  }
  console.info('[disco-voador] E2E fake media devices enabled (development/test only)');
}

// `isSmokeTest` deliberately has NO `!app.isPackaged` gate: `apps/desktop/scripts/smoke.mjs`
// specifically exercises the *packaged* `.exe` to prove packaging itself works, so it must be able
// to arm this on a packaged build. `isE2EVoiceSmoke` is gated, matching the fake-media switches
// above, because — unlike the smoke test — it relays the app's own console output to stdout and can
// force it to exit; a packaged/distributed build must never let an environment variable trigger
// that.
const isSmokeTest = process.env['DISCO_VOADOR_SMOKE_TEST'] === '1';
const isE2EVoiceSmoke = process.env['DISCO_VOADOR_E2E_VOICE_SMOKE'] === '1' && !app.isPackaged;
const isE2ECameraSmoke = process.env['DISCO_VOADOR_E2E_CAMERA_SMOKE'] === '1' && !app.isPackaged;
const isE2EScreenSmoke = process.env['DISCO_VOADOR_E2E_SCREEN_SMOKE'] === '1' && !app.isPackaged;
const isE2EScreenAudioSmoke =
  process.env['DISCO_VOADOR_E2E_SCREEN_AUDIO_SMOKE'] === '1' && !app.isPackaged;
const isE2EIdentityPersistence =
  process.env['DISCO_VOADOR_E2E_IDENTITY_PERSISTENCE'] === '1' && !app.isPackaged;
const isE2EConnectionSmoke =
  process.env['DISCO_VOADOR_E2E_CONNECTION_SMOKE'] === '1' && !app.isPackaged;
const isE2EAuthorization = process.env['DISCO_VOADOR_E2E_AUTHORIZATION'] === '1' && !app.isPackaged;
const e2eAuthorizationExitMarker = isE2EAuthorization
  ? process.env['DISCO_VOADOR_E2E_EXIT_ON_MARKER']
  : undefined;
const isE2ETextChat = process.env['DISCO_VOADOR_E2E_TEXT_CHAT'] === '1' && !app.isPackaged;
// T13.4 — `apps/desktop/scripts/e2e-ptt-smoke.mjs` needs the Renderer's own console output relayed
// to this process's stdout (the orchestrating script watches for `E2E_PTT_*` markers there) — mirrors
// `isE2ETextChat`'s own minimal "just relay, no exit logic" pattern (`armE2ETextChatRelay`) rather
// than `isE2EVoiceSmoke`'s bundled exit-on-success behavior, since this scenario's own success
// criteria (three phase-specific audio-level markers) don't match `armE2EVoiceSmokeExit`'s.
const isE2EPttSmoke = process.env['DISCO_VOADOR_E2E_PTT_SMOKE'] === '1' && !app.isPackaged;
// T13.4 — `apps/desktop/scripts/e2e-voice-preference-smoke.mjs` needs both instances' Renderer
// console output relayed to stdout (`disco-voador:voice-joined:...`, `E2E_PEER_CONNECTED:...`, and
// this task's own `disco-voador:voice-preference-applied:...` marker) — mirrors `isE2EPttSmoke`'s
// own minimal "just relay, no exit logic" pattern exactly.
const isE2EVoicePreferenceSmoke =
  process.env['DISCO_VOADOR_E2E_VOICE_PREFERENCE_SMOKE'] === '1' && !app.isPackaged;
// T13.4 — set only on a "verify only" relaunch (no `SET_PERCENT`/`SET_MUTE`): this instance should
// self-exit gracefully once it has reported its own restored preference, rather than staying alive —
// see `armE2EVoicePreferenceAdjust`'s own doc comment for why. Deliberately separate from
// `isE2EVoicePreferenceSmoke` (the base relay flag every instance in this scenario sets, including
// the persistent "B" instance, which must never self-exit early).
const isE2EVoicePreferenceVerify =
  process.env['DISCO_VOADOR_E2E_VOICE_PREFERENCE_VERIFY'] === '1' && !app.isPackaged;
const isE2ESettingsPersistence = config.e2eSettingsPersistence !== undefined && !app.isPackaged;
const isE2EReconnectSmoke =
  process.env['DISCO_VOADOR_E2E_RECONNECT_SMOKE'] === '1' && !app.isPackaged;
// T13.2 — see `armE2EChannelAdminExit`'s own doc comment.
const isE2EChannelAdmin = process.env['DISCO_VOADOR_E2E_CHANNEL_ADMIN'] === '1' && !app.isPackaged;
const e2eChannelAdminExitMarker = isE2EChannelAdmin
  ? process.env['DISCO_VOADOR_E2E_EXIT_ON_MARKER']
  : undefined;
// T12: derived from `config.e2eVoiceAutoJoin` (like `isE2ESettingsPersistence`) rather than its own
// single flag — any of the three process-audio E2E fields being present means
// `e2e-process-audio-smoke.mjs` is driving this instance (publisher, viewer, or both, depending on
// which fields that particular launch set).
const isE2EProcessAudioSmoke =
  (config.e2eVoiceAutoJoin?.processAudioTargetPid !== undefined ||
    config.e2eVoiceAutoJoin?.processAudioTargetExe !== undefined ||
    config.e2eVoiceAutoJoin?.processAudioExpectedHz !== undefined) &&
  !app.isPackaged;
// T13.1: derived from `config.e2eVoiceAutoJoin.productShellSmoke`, mirroring `isE2EProcessAudioSmoke`
// above — see `apps/desktop/scripts/e2e-product-shell-smoke.mjs`.
const isE2EProductShellSmoke =
  config.e2eVoiceAutoJoin?.productShellSmoke !== undefined && !app.isPackaged;

function rendererDirectory(): string {
  return path.join(__dirname, '../renderer', MAIN_WINDOW_VITE_NAME);
}

function armSmokeTestExit(window: BrowserWindow): void {
  if (!isSmokeTest) return;

  const timeout = setTimeout(() => {
    console.error('SMOKE_TIMEOUT: renderer did not finish loading in time');
    app.exit(1);
  }, 15_000);

  window.webContents.once('did-finish-load', () => {
    clearTimeout(timeout);
    console.info('SMOKE_OK');
    setTimeout(() => app.exit(0), 250);
  });

  window.webContents.once('did-fail-load', () => {
    clearTimeout(timeout);
    console.error('SMOKE_LOAD_FAILED');
    app.exit(1);
  });
}

/**
 * Drives `apps/desktop/scripts/e2e-identity-persistence.mjs`: a single Electron instance, launched
 * against a caller-chosen `--user-data-dir`, whose sole job is to load (creating on first run) and
 * report its local identityId, then exit — no realtime service, no voice channel, no media
 * involved. Needs only the unconditional `disco-voador:local-identity-ready` console line
 * `use-identity.ts` already logs; relaying it lets the orchestrating script compare the identityId
 * across repeated launches against the same/different `--user-data-dir` to prove persistence.
 */
function armE2EIdentityPersistenceExit(window: BrowserWindow): void {
  if (!isE2EIdentityPersistence) return;

  const marker = 'disco-voador:local-identity-ready:';

  const timeout = setTimeout(() => {
    console.error('E2E_IDENTITY_PERSISTENCE_TIMEOUT: identity never became ready');
    app.exit(1);
  }, 30_000);

  window.webContents.on('console-message', (_event, _level, message) => {
    console.info(`[renderer] ${message}`);
    if (!message.startsWith(marker)) return;
    clearTimeout(timeout);
    const identityId = message.slice(marker.length);
    console.info(`E2E_IDENTITY_PERSISTENCE_OK:${identityId}`);
    setTimeout(() => app.exit(0), 250);
  });
}

/**
 * Drives `apps/desktop/scripts/e2e-connection-smoke.mjs` (T8 Section 58): a single Electron
 * instance proves the real connection UX — start disconnected, connect (via the E2E auto-connect
 * path since no human is present, see `App.tsx`'s `AutoConnect`), authenticate, and receive the
 * Dedicated Server's own display name — by relaying the unconditional
 * `disco-voador:server-name:<name>` console line `use-voice-channel.ts` already logs once
 * `server:hello` arrives. Exits as soon as that happens; never waits for voice:join to actually
 * complete, since this script cares only about the connection/authentication/metadata path, not
 * media.
 */
function armE2EConnectionSmokeExit(window: BrowserWindow): void {
  if (!isE2EConnectionSmoke) return;

  const marker = 'disco-voador:server-name:';

  const timeout = setTimeout(() => {
    console.error('E2E_CONNECTION_SMOKE_TIMEOUT: server name never received');
    app.exit(1);
  }, 30_000);

  window.webContents.on('console-message', (_event, _level, message) => {
    console.info(`[renderer] ${message}`);
    if (!message.startsWith(marker)) return;
    clearTimeout(timeout);
    const serverName = message.slice(marker.length);
    console.info(`E2E_CONNECTION_SMOKE_OK:${serverName}`);
    setTimeout(() => app.exit(0), 250);
  });
}

/**
 * Drives `apps/desktop/scripts/e2e-authorization.mjs` (T9 Section 78). Unlike every other
 * `armE2E*Exit` watcher, this one's exit condition is not fixed at build time — the orchestrating
 * script relaunches this *same* profile multiple times across a scripted ban/unban cycle, and each
 * launch needs to wait for a *different* marker before exiting (join vs. rejection vs. successful
 * reconnection), so the marker string itself comes from `DISCO_VOADOR_E2E_EXIT_ON_MARKER`.
 *
 * Exits via `app.exit()` — Electron's own orderly shutdown — deliberately, never left to the
 * orchestrating script's external `kill()`: relaunching the same `--user-data-dir` shortly after an
 * externally-killed (not self-exited) instance produced a real, reproducible `safeStorage`/DPAPI
 * `decryptString` failure reading the *same, never-corrupted* `identity.json`, found live while
 * building this script. `e2e-identity-persistence.mjs`'s own relaunch-same-profile pattern was
 * never affected by this because each of its instances already calls `app.exit()` itself.
 */
function armE2EAuthorizationExit(window: BrowserWindow): void {
  if (!isE2EAuthorization) return;

  const timeout = e2eAuthorizationExitMarker
    ? setTimeout(() => {
        console.error('E2E_AUTHORIZATION_TIMEOUT: configured marker never appeared');
        app.exit(1);
      }, 30_000)
    : undefined;

  window.webContents.on('console-message', (_event, _level, message) => {
    console.info(`[renderer] ${message}`);
    if (!e2eAuthorizationExitMarker || !message.includes(e2eAuthorizationExitMarker)) return;
    if (timeout) clearTimeout(timeout);
    setTimeout(() => app.exit(0), 250);
  });
}

/**
 * Drives `apps/desktop/scripts/e2e-channel-admin-smoke.mjs` (T13.2). Mirrors
 * `armE2EAuthorizationExit` exactly, for the identical reason: that script's wrong-password/
 * right-password proof relaunches this *same* `--user-data-dir` twice (so the granted "member"
 * group and the persistent identity survive between attempts — see
 * `docs/architecture/SERVER_AUTHORIZATION.md` — without needing a live in-process retry
 * mechanism), and each launch must wait for a *different* marker (an access-denied/password-
 * required/password-invalid rejection, or a successful join) before exiting — so, like T9's own
 * script, the marker string comes from `DISCO_VOADOR_E2E_EXIT_ON_MARKER` rather than being fixed at
 * build time. Exits via `app.exit()` for the same documented reason `armE2EAuthorizationExit` does:
 * relaunching the same profile shortly after an externally-`kill()`-ed (not self-exited) instance
 * reproduces a real, reproducible `safeStorage`/DPAPI `decryptString` failure on the *next* launch.
 */
function armE2EChannelAdminExit(window: BrowserWindow): void {
  if (!isE2EChannelAdmin) return;

  const timeout = e2eChannelAdminExitMarker
    ? setTimeout(() => {
        console.error('E2E_CHANNEL_ADMIN_TIMEOUT: configured marker never appeared');
        app.exit(1);
      }, 30_000)
    : undefined;

  window.webContents.on('console-message', (_event, _level, message) => {
    console.info(`[renderer] ${message}`);
    if (!e2eChannelAdminExitMarker || !message.includes(e2eChannelAdminExitMarker)) return;
    if (timeout) clearTimeout(timeout);
    setTimeout(() => app.exit(0), 250);
  });
}

/**
 * Drives `apps/desktop/scripts/e2e-text-chat-persistence.mjs`: relay-only, deliberately without any
 * exit-forcing logic. Unlike `armE2EAuthorizationExit`, that script never relaunches the same
 * `--user-data-dir` (every instance it spawns uses a fresh profile, exactly once), so there is no
 * same-profile-relaunch `safeStorage`/DPAPI risk to guard against (see that function's own doc
 * comment and `docs/architecture/PERSISTENT_TEXT_CHAT.md`'s E2E notes) — the orchestrating script
 * simply kills each instance externally once it has observed what it needs, which is safe here.
 * This relays the app's own `disco-voador:chat-message:*`/`disco-voador:chat-history:*` console
 * lines (see `use-voice-channel.ts`) to this process's stdout so the orchestrating script can see
 * them.
 */
function armE2ETextChatRelay(window: BrowserWindow): void {
  if (!isE2ETextChat) return;

  window.webContents.on('console-message', (_event, _level, message) => {
    console.info(`[renderer] ${message}`);
  });
}

/** T13.4 — see `isE2EPttSmoke`'s own doc comment for why this is a plain relay (mirroring
 * `armE2ETextChatRelay` exactly) rather than a bundled exit-on-success watcher. */
function armE2EPttSmokeRelay(window: BrowserWindow): void {
  if (!isE2EPttSmoke) return;

  window.webContents.on('console-message', (_event, _level, message) => {
    console.info(`[renderer] ${message}`);
  });
}

/** Drives `apps/desktop/scripts/e2e-voice-preference-smoke.mjs` — relay-only, exactly like
 * `armE2EPttSmokeRelay` above. */
function armE2EVoicePreferenceSmokeRelay(window: BrowserWindow): void {
  if (!isE2EVoicePreferenceSmoke) return;

  window.webContents.on('console-message', (_event, _level, message) => {
    console.info(`[renderer] ${message}`);
  });
}

/**
 * Drives `apps/desktop/scripts/e2e-reconnect-smoke.mjs` (T11): relay-only, exactly like
 * `armE2ETextChatRelay` above and for the identical reason — that script never relaunches the same
 * `--user-data-dir` (one fresh profile per instance, externally `stop()`-ed once the orchestrating
 * script is done with it), so there is no same-profile-relaunch `safeStorage`/DPAPI risk to guard
 * against, and no exit-forcing is needed or wanted: this instance must stay alive and keep relaying
 * console output through an entire unexpected-disconnect -> reconnecting -> reconnected cycle,
 * which the orchestrating script observes via `use-voice-channel.ts`'s
 * `disco-voador:connection-status:*`/`disco-voador:voice-joined:*` markers (plus the existing
 * `E2E_PEER_CONNECTED:*`/`E2E_AUDIO_LEVEL_OK:*` markers, which naturally re-fire with fresh
 * participant ids after a real reconnect+rejoin, since the server mints a new `participantId` per
 * join).
 */
function armE2EReconnectSmokeRelay(window: BrowserWindow): void {
  if (!isE2EReconnectSmoke) return;

  window.webContents.on('console-message', (_event, _level, message) => {
    console.info(`[renderer] ${message}`);
  });
}

/**
 * Drives `apps/desktop/scripts/e2e-process-audio-smoke.mjs` (T12): relay-only, exactly like
 * `armE2ETextChatRelay`/`armE2EReconnectSmokeRelay` above and for the identical reason — that
 * script spawns a fresh `--user-data-dir` per instance and owns its own per-scenario timeouts/
 * kills externally, so there is nothing for this process to force-exit on and no same-profile-
 * relaunch risk to guard against. Without this relay, every `console.info` the Renderer emits
 * (including `E2E_PROCESS_AUDIO_SELECTED:*`, the frequency-probe evidence markers from
 * `e2e-frequency-probe.ts`, `E2E_LOCAL_MIC_MUTED`/`_UNMUTED`, and the generic
 * `E2E_SCREEN_AUDIO_*`/`disco-voador:*` markers every scenario already gets) never reaches this
 * process's own stdout at all — the orchestrating script would see nothing but Main-process-level
 * lines, no matter how correct the Renderer-side logic is.
 */
function armE2EProcessAudioSmokeRelay(window: BrowserWindow): void {
  if (!isE2EProcessAudioSmoke) return;

  window.webContents.on('console-message', (_event, _level, message) => {
    console.info(`[renderer] ${message}`);
  });
}

/**
 * Drives `apps/desktop/scripts/e2e-product-shell-smoke.mjs` (T13.1): relay-only, exactly like
 * `armE2ETextChatRelay`/`armE2EReconnectSmokeRelay`/`armE2EProcessAudioSmokeRelay` above and for
 * the identical reason — this scenario spawns a single fresh `--user-data-dir` instance and the
 * orchestrating script owns its own external `kill()` once it has observed the final
 * `E2E_PRODUCT_SHELL_DONE:*` marker, so there is nothing for this process to force-exit on and no
 * same-profile-relaunch risk to guard against.
 */
function armE2EProductShellSmokeRelay(window: BrowserWindow): void {
  if (!isE2EProductShellSmoke) return;

  window.webContents.on('console-message', (_event, _level, message) => {
    console.info(`[renderer] ${message}`);
  });
}

/**
 * Drives `apps/desktop/scripts/e2e-settings-persistence.mjs` (T11): relays console output and,
 * once the settings snapshot marker (`App.tsx`'s `disco-voador:e2e-settings-snapshot:<json>` line)
 * has been observed, exits via Electron's own orderly `app.exit()` — deliberately, never left to
 * the orchestrating script's external `kill()`. This scenario relaunches the *same*
 * `--user-data-dir` across several instances to prove persistence; an earlier version of this
 * function was relay-only (reasoning: the settings store itself is plain JSON, unlike T9's
 * `safeStorage`/DPAPI-encrypted identity file, so it seemed to have no equivalent relaunch risk).
 * That reasoning was found to be **wrong** during this task's own live E2E run: killing the process
 * externally right after this marker appears still reproduced T9's exact `safeStorage`/DPAPI
 * `decryptString` failure on the *next* launch of the same profile — evidently a property of
 * externally `kill()`-ing *any* Electron instance shortly after startup on this platform/profile
 * combination (this app always creates a local identity on first run, independent of what a given
 * E2E scenario is actually testing), not something specific to which file T9's script happened to
 * be exercising. Self-exiting here, exactly like `armE2EIdentityPersistenceExit`/
 * `armE2EAuthorizationExit` already do, avoids it.
 */
function armE2ESettingsPersistenceExit(window: BrowserWindow): void {
  if (!isE2ESettingsPersistence) return;

  const marker = 'disco-voador:e2e-settings-snapshot:';

  const timeout = setTimeout(() => {
    console.error('E2E_SETTINGS_PERSISTENCE_TIMEOUT: settings snapshot never reported');
    app.exit(1);
  }, 20_000);

  window.webContents.on('console-message', (_event, _level, message) => {
    console.info(`[renderer] ${message}`);
    if (!message.includes(marker)) return;
    clearTimeout(timeout);
    setTimeout(() => app.exit(0), 250);
  });
}

/**
 * Drives `apps/desktop/scripts/e2e-voice-smoke.mjs`: two Electron instances, each launched with
 * `DISCO_VOADOR_E2E_VOICE_SMOKE=1` alongside the fake-media and auto-join flags, must each
 * observe their *remote peer's* connection reach `'connected'` and receive audibly non-silent
 * audio from it (see `voice/e2e-audio-probe.ts`) — not merely that a local track or peer object
 * exists. The Renderer proves this by logging `E2E_PEER_CONNECTED:<id>` and
 * `E2E_AUDIO_LEVEL_OK:<id>` to the console; this relays those lines to this process's own stdout
 * (so the orchestrating script can see them) and exits once both have been observed at least once.
 */
function armE2EVoiceSmokeExit(window: BrowserWindow): void {
  if (!isE2EVoiceSmoke) return;

  const requiredMarkers = ['E2E_PEER_CONNECTED:', 'E2E_AUDIO_LEVEL_OK:'];
  const seen = new Set<string>();

  const timeout = setTimeout(() => {
    console.error(`E2E_VOICE_SMOKE_TIMEOUT: only observed [${[...seen].join(', ')}]`);
    app.exit(1);
  }, 60_000);

  window.webContents.on('console-message', (_event, _level, message) => {
    console.info(`[renderer] ${message}`);
    for (const marker of requiredMarkers) {
      if (message.startsWith(marker)) seen.add(marker);
    }
    if (requiredMarkers.every((marker) => seen.has(marker))) {
      clearTimeout(timeout);
      console.info('E2E_VOICE_SMOKE_OK');
      setTimeout(() => app.exit(0), 250);
    }
  });
}

/**
 * Drives `apps/desktop/scripts/e2e-camera-smoke.mjs`: two Electron instances, each launched with
 * `DISCO_VOADOR_E2E_CAMERA_SMOKE=1` alongside the fake-media, auto-join, and (on at least one
 * instance) auto-camera-on/auto-camera-off flags. Requires everything `armE2EVoiceSmokeExit`
 * requires (a real connected peer, real non-silent audio — voice must keep working) *plus* real
 * decoded remote video (`voice/e2e-video-probe.ts`'s `E2E_REMOTE_VIDEO_OK`) *plus* proof that
 * disabling a remote camera does not disconnect the peer (`E2E_REMOTE_VIDEO_ENDED` carrying
 * `peerState=connected` — see `VoiceChannelView.tsx`). A `E2E_REMOTE_VIDEO_ENDED` line with any
 * other `peerState` is deliberately NOT accepted as satisfying this requirement, so a real
 * disconnect-on-camera-off regression fails this smoke test (via timeout) instead of passing it.
 */
function armE2ECameraSmokeExit(window: BrowserWindow): void {
  if (!isE2ECameraSmoke) return;

  const requiredMarkers = ['E2E_PEER_CONNECTED:', 'E2E_AUDIO_LEVEL_OK:', 'E2E_REMOTE_VIDEO_OK:'];
  const seen = new Set<string>();
  let voiceSurvivedCameraOff = false;

  const timeout = setTimeout(() => {
    console.error(
      `E2E_CAMERA_SMOKE_TIMEOUT: only observed [${[...seen].join(', ')}]` +
        (voiceSurvivedCameraOff ? ' +camera-off-proof' : ' (no camera-off proof)'),
    );
    app.exit(1);
  }, 90_000);

  window.webContents.on('console-message', (_event, _level, message) => {
    console.info(`[renderer] ${message}`);
    for (const marker of requiredMarkers) {
      if (message.startsWith(marker)) seen.add(marker);
    }
    if (message.startsWith('E2E_REMOTE_VIDEO_ENDED:') && message.includes('peerState=connected')) {
      voiceSurvivedCameraOff = true;
    }
    if (requiredMarkers.every((marker) => seen.has(marker)) && voiceSurvivedCameraOff) {
      clearTimeout(timeout);
      console.info('E2E_CAMERA_SMOKE_OK');
      // Both instances' requirements are symmetric (each proves the *other's* video, plus its own
      // camera-off-survives-with-peer-connected). Live-measured: exiting almost immediately (was
      // 250ms) closes this instance's realtime WebSocket, which the server reports to the other
      // instance as a genuine `voice:participant-left` — if that instance hasn't yet reached its
      // own camera-off proof, it then sees `peerState=unknown` (the peer really did leave) and
      // fails, even though nothing was actually broken. A grace delay well past this scenario's
      // fixed `AUTO_CAMERA_OFF_AFTER_MS` timer lets the slower side finish before this side's
      // connection disappears.
      setTimeout(() => app.exit(0), 5_000);
    }
  });
}

/**
 * Drives `apps/desktop/scripts/e2e-screen-smoke.mjs`. T5 stabilization's primary scenario is
 * asymmetric — one Electron instance *publishes* (camera + screen, launched with its own E2E
 * config's `autoScreenShare: true`), the other is a pure *viewer* (voice only, no local capture at
 * all). See `docs/architecture/WEBRTC_SCREEN_SHARE.md`'s "Automated end-to-end verification"
 * section for why: the original symmetric "both instances capture their own screen simultaneously"
 * topology was found to intermittently starve frame/audio delivery under real-time contention
 * (most plausibly two simultaneous Windows Desktop Duplication sessions of the same physical
 * display) while routing/identity were always correct on every run, passing or not — removing the
 * viewer-side capture load tests the actual product requirement (a viewer receiving and decoding a
 * publisher's screen) without needing two simultaneous local captures at all.
 *
 * Role is inferred from this instance's own E2E config (`autoScreenShare`), not a separate flag —
 * the publisher is simply the one instance actually configured to capture and share. Each role's
 * phases are tracked explicitly and in order, so a timeout reports exactly which phases were
 * reached instead of only "timeout" — required for stabilization work to be diagnosable.
 */
function armE2EScreenSmokeExit(window: BrowserWindow): void {
  if (!isE2EScreenSmoke) return;

  if (config.e2eVoiceAutoJoin?.autoScreenShare === true) {
    armE2EScreenSmokePublisherExit(window);
  } else {
    armE2EScreenSmokeViewerExit(window);
  }
}

/**
 * Publisher role: proves this instance's own local lifecycle actually progressed through
 * connecting, enabling camera, and a full share/stop/re-share cycle — see
 * `VoiceChannelView.tsx`'s `E2E_LOCAL_CAMERA_ON`/`E2E_LOCAL_SCREEN_ON`/`E2E_LOCAL_SCREEN_OFF`
 * markers. The *remote* proof (did the viewer actually decode this instance's tracks) is the
 * viewer's own responsibility (`armE2EScreenSmokeViewerExit`) — each instance only asserts what it
 * can observe about itself, so no cross-process log correlation is needed.
 */
function armE2EScreenSmokePublisherExit(window: BrowserWindow): void {
  const requiresReshare = config.e2eVoiceAutoJoin?.autoScreenShareReshareAfterMs !== undefined;
  const phases: {
    readonly name: string;
    seen: boolean;
    readonly match: (message: string) => boolean;
  }[] = [
    { name: 'peer-connected', seen: false, match: (m) => m.startsWith('E2E_PEER_CONNECTED:') },
    { name: 'audio-baseline', seen: false, match: (m) => m.startsWith('E2E_AUDIO_LEVEL_OK:') },
    { name: 'camera-on', seen: false, match: (m) => m === 'E2E_LOCAL_CAMERA_ON' },
    { name: 'screen-on-1', seen: false, match: (m) => m.startsWith('E2E_LOCAL_SCREEN_ON:1') },
    { name: 'screen-off-1', seen: false, match: (m) => m.startsWith('E2E_LOCAL_SCREEN_OFF:1') },
  ];
  if (requiresReshare) {
    phases.push({
      name: 'screen-on-2-reshare',
      seen: false,
      match: (m) => m.startsWith('E2E_LOCAL_SCREEN_ON:2'),
    });
  }

  const timeout = setTimeout(() => {
    const reached = phases.filter((p) => p.seen).map((p) => p.name);
    console.error(
      `E2E_SCREEN_SMOKE_TIMEOUT (publisher): reached [${reached.join(', ')}] of [${phases.map((p) => p.name).join(', ')}]`,
    );
    app.exit(1);
  }, 90_000);

  window.webContents.on('console-message', (_event, _level, message) => {
    console.info(`[renderer] ${message}`);
    for (const phase of phases) {
      if (!phase.seen && phase.match(message)) phase.seen = true;
    }
    if (phases.every((p) => p.seen)) {
      clearTimeout(timeout);
      console.info('E2E_SCREEN_SMOKE_OK');
      // See `armE2ECameraSmokeExit`'s comment on the same pattern: the publisher's own phases can
      // complete (including the reshare) slightly before the viewer has finished decoding that
      // reshare's frames. Exiting immediately would close this instance's connection — which the
      // viewer would observe as the publisher genuinely leaving — before the viewer's own proof
      // has a chance to complete. A grace delay avoids the publisher racing the viewer's proof.
      setTimeout(() => app.exit(0), 5_000);
    }
  });
}

/**
 * Viewer role: proves this instance actually received and decoded the publisher's tracks —
 * connected, non-silent audio, real decoded camera frames, real decoded screen frames (twice, with
 * a clean stop and a healthy-peer proof in between — the re-share requirement), plus fresh
 * audio/camera continuity evidence taken specifically *after* the screen share ends (not reused
 * from the original one-shot proof — see `VoiceChannelView.tsx`'s `E2E_AUDIO_LEVEL_POST_SCREEN`/
 * `E2E_REMOTE_VIDEO_POST_SCREEN` markers). Requiring camera's own marker alongside screen's is
 * deliberate: this is also the semantic-identity proof — one client's camera and screen-video both
 * reach the peer and are correctly routed to their own distinct remote-stream maps, not merely "a
 * second video track exists." Requiring a *second* `E2E_REMOTE_SCREEN_OK` after the ended marker is
 * the re-share proof — guards against stale mid/transceiver/sender state from the first cycle.
 */
function armE2EScreenSmokeViewerExit(window: BrowserWindow): void {
  const requiredOnceMarkers = [
    'E2E_PEER_CONNECTED:',
    'E2E_AUDIO_LEVEL_OK:',
    'E2E_REMOTE_VIDEO_OK:',
  ];
  const seenOnce = new Set<string>();
  let screenOkCount = 0;
  let screenShareEndedWithHealthyPeer = false;
  let audioPostScreenOk = false;
  let cameraPostScreenOk = false;

  function describeProgress(): string {
    return [
      ...requiredOnceMarkers.map((m) => `${m}${seenOnce.has(m) ? 'seen' : 'missing'}`),
      `screenOkCount=${String(screenOkCount)}(need >=2)`,
      `screenEndedHealthy=${String(screenShareEndedWithHealthyPeer)}`,
      `audioPostScreenOk=${String(audioPostScreenOk)}`,
      `cameraPostScreenOk=${String(cameraPostScreenOk)}`,
    ].join(', ');
  }

  const timeout = setTimeout(() => {
    console.error(`E2E_SCREEN_SMOKE_TIMEOUT (viewer): ${describeProgress()}`);
    app.exit(1);
  }, 90_000);

  window.webContents.on('console-message', (_event, _level, message) => {
    console.info(`[renderer] ${message}`);
    for (const marker of requiredOnceMarkers) {
      if (message.startsWith(marker)) seenOnce.add(marker);
    }
    if (message.startsWith('E2E_REMOTE_SCREEN_OK:')) screenOkCount += 1;
    if (message.startsWith('E2E_SCREEN_SHARE_ENDED:') && message.includes('peerState=connected')) {
      screenShareEndedWithHealthyPeer = true;
    }
    if (message.startsWith('E2E_AUDIO_LEVEL_POST_SCREEN_OK:')) audioPostScreenOk = true;
    if (message.startsWith('E2E_REMOTE_VIDEO_POST_SCREEN_OK:')) cameraPostScreenOk = true;

    const allDone =
      requiredOnceMarkers.every((m) => seenOnce.has(m)) &&
      screenOkCount >= 2 &&
      screenShareEndedWithHealthyPeer &&
      audioPostScreenOk &&
      cameraPostScreenOk;

    if (allDone) {
      clearTimeout(timeout);
      console.info('E2E_SCREEN_SMOKE_OK');
      setTimeout(() => app.exit(0), 250);
    }
  });
}

/**
 * Drives `apps/desktop/scripts/e2e-screen-audio-smoke.mjs` (T6). Mirrors
 * `armE2EScreenSmokeExit`'s publisher/viewer split exactly — role inferred from this instance's own
 * `autoScreenShare` config, one publisher (real screen *and* system-audio-loopback capture, no
 * camera — this scenario is screen(+audio)-only) plus one pure viewer. See
 * `docs/architecture/WEBRTC_SCREEN_AUDIO.md`'s "E2E strategy" section for the full scenario and the
 * same-machine-feedback handling (both roles auto-deafen; see `VoiceChannelView.tsx`).
 */
function armE2EScreenAudioSmokeExit(window: BrowserWindow): void {
  if (!isE2EScreenAudioSmoke) return;

  if (config.e2eVoiceAutoJoin?.autoScreenShare === true) {
    armE2EScreenAudioSmokePublisherExit(window);
  } else {
    armE2EScreenAudioSmokeViewerExit(window);
  }
}

/**
 * Publisher role: proves this instance's own local lifecycle progressed through the full scripted
 * sequence — share (audio off) -> stop -> share (audio on) -> mute mic -> unmute mic -> stop ->
 * re-share (audio on). `screen-on-2-audio`/`screen-on-3-reshare-audio` specifically require the
 * *audio* marker (`E2E_LOCAL_SCREEN_AUDIO_ON:<n>`), not just the screen-on marker, so a run where
 * video shared but audio silently failed to publish is reported as a distinct, diagnosable phase
 * failure rather than passing on video alone.
 */
function armE2EScreenAudioSmokePublisherExit(window: BrowserWindow): void {
  const phases: {
    readonly name: string;
    seen: boolean;
    readonly match: (message: string) => boolean;
  }[] = [
    { name: 'peer-connected', seen: false, match: (m) => m.startsWith('E2E_PEER_CONNECTED:') },
    { name: 'audio-baseline', seen: false, match: (m) => m.startsWith('E2E_AUDIO_LEVEL_OK:') },
    { name: 'screen-on-1', seen: false, match: (m) => m.startsWith('E2E_LOCAL_SCREEN_ON:1') },
    { name: 'screen-off-1', seen: false, match: (m) => m.startsWith('E2E_LOCAL_SCREEN_OFF:1') },
    {
      name: 'screen-on-2-audio',
      seen: false,
      match: (m) => m.startsWith('E2E_LOCAL_SCREEN_AUDIO_ON:2'),
    },
    { name: 'mic-muted', seen: false, match: (m) => m === 'E2E_LOCAL_MIC_MUTED' },
    { name: 'mic-unmuted', seen: false, match: (m) => m === 'E2E_LOCAL_MIC_UNMUTED' },
    { name: 'screen-off-2', seen: false, match: (m) => m.startsWith('E2E_LOCAL_SCREEN_OFF:2') },
    {
      name: 'screen-on-3-reshare-audio',
      seen: false,
      match: (m) => m.startsWith('E2E_LOCAL_SCREEN_AUDIO_ON:3'),
    },
  ];

  const timeout = setTimeout(() => {
    const reached = phases.filter((p) => p.seen).map((p) => p.name);
    console.error(
      `E2E_SCREEN_AUDIO_SMOKE_TIMEOUT (publisher): reached [${reached.join(', ')}] of [${phases.map((p) => p.name).join(', ')}]`,
    );
    app.exit(1);
  }, 120_000);

  window.webContents.on('console-message', (_event, _level, message) => {
    console.info(`[renderer] ${message}`);
    for (const phase of phases) {
      if (!phase.seen && phase.match(message)) phase.seen = true;
    }
    if (phases.every((p) => p.seen)) {
      clearTimeout(timeout);
      console.info('E2E_SCREEN_AUDIO_SMOKE_OK');
      // See `armE2ECameraSmokeExit`'s comment on the same pattern: avoid this side's connection
      // disappearing before the viewer has finished proving the final reshare cycle.
      setTimeout(() => app.exit(0), 5_000);
    }
  });
}

/**
 * Viewer role: proves it actually received and decoded the publisher's screen-video *and*
 * screen-audio (correctly distinguished from microphone and from each other), that screen-audio was
 * genuinely absent during the audio-off cycle (not merely "never checked"), that microphone mute
 * does not affect screen-audio (`screenAudioPostMuteOk`, sampled during the publisher's scripted
 * mute window), that stopping screen removes both tracks without disconnecting the peer or breaking
 * microphone continuity, and that a re-share produces real decoded screen-video *and* screen-audio
 * again (`screenAudioOkCount >= 2`). No camera marker is required — this scenario never enables one.
 */
function armE2EScreenAudioSmokeViewerExit(window: BrowserWindow): void {
  const requiredOnceMarkers = ['E2E_PEER_CONNECTED:', 'E2E_AUDIO_LEVEL_OK:'];
  const seenOnce = new Set<string>();
  let screenOkCount = 0;
  let screenAudioOkCount = 0;
  let screenAudioAbsentSeen = false;
  let screenAudioPostMuteOk = false;
  let screenShareEndedWithHealthyPeer = false;
  let screenAudioEndedWithHealthyPeer = false;
  let audioPostScreenOk = false;

  function describeProgress(): string {
    return [
      ...requiredOnceMarkers.map((m) => `${m}${seenOnce.has(m) ? 'seen' : 'missing'}`),
      `screenOkCount=${String(screenOkCount)}(need >=3)`,
      `screenAudioOkCount=${String(screenAudioOkCount)}(need >=2)`,
      `screenAudioAbsentSeen=${String(screenAudioAbsentSeen)}`,
      `screenAudioPostMuteOk=${String(screenAudioPostMuteOk)}`,
      `screenShareEndedHealthy=${String(screenShareEndedWithHealthyPeer)}`,
      `screenAudioEndedHealthy=${String(screenAudioEndedWithHealthyPeer)}`,
      `audioPostScreenOk=${String(audioPostScreenOk)}`,
    ].join(', ');
  }

  const timeout = setTimeout(() => {
    console.error(`E2E_SCREEN_AUDIO_SMOKE_TIMEOUT (viewer): ${describeProgress()}`);
    app.exit(1);
  }, 120_000);

  window.webContents.on('console-message', (_event, _level, message) => {
    console.info(`[renderer] ${message}`);
    for (const marker of requiredOnceMarkers) {
      if (message.startsWith(marker)) seenOnce.add(marker);
    }
    if (message.startsWith('E2E_REMOTE_SCREEN_OK:')) screenOkCount += 1;
    if (message.startsWith('E2E_SCREEN_AUDIO_OK:')) screenAudioOkCount += 1;
    // Requires cycle 1 specifically (the audio-off cycle) — a QA review noted that this marker can
    // also fire harmlessly during a later audio-on cycle if video settles a render tick before
    // audio does, which would be ambiguous evidence for "audio was genuinely off" if accepted from
    // any cycle. See `VoiceChannelView.tsx`'s `viewerScreenCycleCount`.
    if (message.startsWith('E2E_SCREEN_AUDIO_ABSENT:') && message.includes(':cycle=1')) {
      screenAudioAbsentSeen = true;
    }
    if (message.startsWith('E2E_SCREEN_AUDIO_POST_MUTE_OK:')) screenAudioPostMuteOk = true;
    if (message.startsWith('E2E_SCREEN_SHARE_ENDED:') && message.includes('peerState=connected')) {
      screenShareEndedWithHealthyPeer = true;
    }
    if (message.startsWith('E2E_SCREEN_AUDIO_ENDED:') && message.includes('peerState=connected')) {
      screenAudioEndedWithHealthyPeer = true;
    }
    if (message.startsWith('E2E_AUDIO_LEVEL_POST_SCREEN_OK:')) audioPostScreenOk = true;

    const allDone =
      requiredOnceMarkers.every((m) => seenOnce.has(m)) &&
      screenOkCount >= 3 &&
      screenAudioOkCount >= 2 &&
      screenAudioAbsentSeen &&
      screenAudioPostMuteOk &&
      screenShareEndedWithHealthyPeer &&
      screenAudioEndedWithHealthyPeer &&
      audioPostScreenOk;

    if (allDone) {
      clearTimeout(timeout);
      console.info('E2E_SCREEN_AUDIO_SMOKE_OK');
      setTimeout(() => app.exit(0), 250);
    }
  });
}

/**
 * T13.1 screenshot-capture tooling only — throwaway automation added solely to produce this task's
 * Definition-of-Done screenshot evidence (`apps/desktop/scripts/e2e-screenshot-capture.mjs`), never
 * a permanent regression test and never reachable in a packaged build (`!app.isPackaged`, same as
 * every other `armE2E*` function here). Captures the real `ServerHome` (with two real, IPC-seeded
 * bookmarks) once `App.tsx`'s `E2E_SCREENSHOT_HOME_READY` marker lands, at a fixed 1920x1080 window
 * size, then exits.
 */
function armE2EScreenshotHomeCapture(window: BrowserWindow): void {
  const captureDir = process.env['DISCO_VOADOR_E2E_SCREENSHOT_CAPTURE_DIR'];
  if (!captureDir || !config.e2eScreenshot || app.isPackaged) return;

  let started = false;
  window.webContents.on('console-message', (_event, _level, message) => {
    if (started || !message.includes('E2E_SCREENSHOT_HOME_READY')) return;
    started = true;

    void (async () => {
      try {
        window.setBounds({ width: 1920, height: 1080 });
        await new Promise((resolve) => setTimeout(resolve, 800));
        const image = await window.webContents.capturePage();
        await fsPromises.writeFile(path.join(captureDir, '01-server-home.png'), image.toPNG());
        console.info('E2E_SCREENSHOT_SAVED:01-server-home.png');
        setTimeout(() => app.exit(0), 250);
      } catch (error) {
        console.error('E2E screenshot Home capture failed', error);
        setTimeout(() => app.exit(1), 250);
      }
    })();
  });
}

/**
 * T13.1 screenshot-capture tooling only — see `armE2EScreenshotHomeCapture`'s doc comment for the
 * overall rationale; this half covers the connected-workspace shots. Waits for the real join
 * (`disco-voador:voice-joined:<channelId>`) and, best-effort, a real second participant
 * (`E2E_PEER_CONNECTED:` — proceeds after a bounded wait even if none appears, since a missing
 * screenshot subject is a worse failure mode than a less-populated Members panel) before driving
 * three already-existing, real UI affordances via `webContents.executeJavaScript` — opening/closing
 * Settings and collapsing the Member panel, the exact same buttons (found by their existing
 * `data-testid`/`aria-label`) a human would click — while resizing the real `BrowserWindow` and
 * calling `webContents.capturePage()` between shots. Saves PNGs to
 * `DISCO_VOADOR_E2E_SCREENSHOT_CAPTURE_DIR` and exits when done.
 */
function armE2EScreenshotWorkspaceCapture(window: BrowserWindow): void {
  const captureDirEnv = process.env['DISCO_VOADOR_E2E_SCREENSHOT_CAPTURE_DIR'];
  const channelId = config.e2eVoiceAutoJoin?.channelId;
  if (!captureDirEnv || !channelId || app.isPackaged) return;
  // Never simultaneously active with the Home capture above — each is driven by a distinct,
  // mutually-exclusive config (`e2eScreenshot` has no realtime connection at all).
  if (config.e2eScreenshot) return;
  const captureDir = captureDirEnv;

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  async function saveCapture(name: string): Promise<void> {
    const image = await window.webContents.capturePage();
    await fsPromises.writeFile(path.join(captureDir, name), image.toPNG());
    console.info(`E2E_SCREENSHOT_SAVED:${name}`);
  }

  let started = false;
  let peerSeen = false;
  const joinedMarker = `disco-voador:voice-joined:${channelId}`;

  window.webContents.on('console-message', (_event, _level, message) => {
    if (message.startsWith('E2E_PEER_CONNECTED:')) peerSeen = true;
    if (started || !message.includes(joinedMarker)) return;
    started = true;

    void (async () => {
      try {
        // Bounded best-effort wait for a real second participant to actually appear in the Members
        // panel before the first capture — see this function's own doc comment.
        for (let i = 0; i < 40 && !peerSeen; i += 1) {
          await wait(250);
        }
        await wait(1000); // let the just-joined UI settle (channel list, own member row, etc.)

        window.setBounds({ width: 1920, height: 1080 });
        await wait(400);
        await saveCapture('02-workspace-1920x1080.png');

        window.setBounds({ width: 1366, height: 768 });
        await wait(400);
        await saveCapture('03-workspace-1366x768.png');

        // T13.1.1 — one intermediate desktop resolution, per the task's own "do not tune solely
        // for two screenshots" requirement.
        window.setBounds({ width: 1600, height: 900 });
        await wait(400);
        await saveCapture('03b-workspace-1600x900.png');

        window.setBounds({ width: 1920, height: 1080 });
        await wait(400);

        await window.webContents.executeJavaScript(
          `document.querySelector('[data-testid="user-control-settings"]')?.click();`,
        );
        await wait(500);
        await saveCapture('04-settings.png');

        await window.webContents.executeJavaScript(
          `document.querySelector('[aria-label="Close"]')?.click();`,
        );
        await wait(300);

        await window.webContents.executeJavaScript(
          `document.querySelector('[data-testid="member-panel-collapse-toggle"]')?.click();`,
        );
        await wait(400);
        await saveCapture('05-member-panel-collapsed.png');

        // T13.1.1 screenshot-capture extension — same real-button-click technique as above, adding
        // the Settings sub-tabs, the Add Server dialog, and a genuinely different-channel chat
        // selection (proving "select ≠ join" survives the redesign) to the evidence set.
        await window.webContents.executeJavaScript(
          `document.querySelector('[data-testid="member-panel-expand-toggle"]')?.click();`,
        );
        await wait(300);

        await window.webContents.executeJavaScript(
          `document.querySelector('[data-testid="user-control-settings"]')?.click();`,
        );
        await wait(500);
        await window.webContents.executeJavaScript(
          `document.querySelector('[data-testid="settings-nav-voice"]')?.click();`,
        );
        await wait(400);
        await saveCapture('06-settings-voice.png');

        await window.webContents.executeJavaScript(
          `document.querySelector('[data-testid="settings-nav-advanced"]')?.click();`,
        );
        await wait(400);
        await saveCapture('07-settings-advanced.png');

        await window.webContents.executeJavaScript(
          `document.querySelector('[aria-label="Close"]')?.click();`,
        );
        await wait(300);

        await window.webContents.executeJavaScript(
          `document.querySelector('[data-testid="server-rail-add"]')?.click();`,
        );
        await wait(400);
        await saveCapture('08-add-server-dialog.png');

        await window.webContents.executeJavaScript(
          `document.querySelector('[data-testid="add-server-dialog"] [aria-label="Close"]')?.click();`,
        );
        await wait(300);

        // Select "games" (a different channel from the one we're actually joined to, "general") —
        // proves the redesigned row still only *views* a channel's chat on click, never joins it —
        // then switch back to General's own chat (the channel we're actually joined to) to send
        // real representative messages via the real composer/production `sendChatMessage` action,
        // never a fixture: this is genuine message density/grouping evidence, sent exactly the way
        // a human would type it.
        await window.webContents.executeJavaScript(
          `document.querySelector('[data-testid="channel-row-select-games"]')?.click();`,
        );
        await wait(400);
        await window.webContents.executeJavaScript(
          `document.querySelector('[data-testid="channel-row-select-general"]')?.click();`,
        );
        await wait(400);

        async function sendRealMessage(body: string): Promise<void> {
          await window.webContents.executeJavaScript(`
            (function () {
              const input = document.querySelector('input[placeholder="Message…"]');
              if (!input) return;
              const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              setter.call(input, ${JSON.stringify(body)});
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.closest('form')?.requestSubmit();
            })();
          `);
          await wait(350);
        }

        await sendRealMessage('Bora jogar?');
        await sendRealMessage('Tô entrando no mapa');
        await sendRealMessage(
          'Esse mapa novo tá bem maior que o anterior, precisa upar a sensibilidade do mouse pra não ficar lento girando a câmera toda hora',
        );
        await sendRealMessage('😄🔥 boa!');
        await wait(600);
        await saveCapture('09-chat-messages-general.png');

        console.info('E2E_SCREENSHOT_CAPTURE_DONE');
        setTimeout(() => app.exit(0), 250);
      } catch (error) {
        console.error('E2E screenshot workspace capture failed', error);
        setTimeout(() => app.exit(1), 250);
      }
    })();
  });
}

/**
 * T13.2 Definition-of-Done screenshot evidence tool only — throwaway automation added solely to
 * produce `apps/desktop/scripts/e2e-screenshot-capture-t13-2.mjs`'s evidence, never a permanent
 * regression test and never reachable in a packaged build (`!app.isPackaged`, same as every other
 * `armE2E*` function here). Mirrors `armE2EScreenshotWorkspaceCapture`'s own
 * `webContents.executeJavaScript`-drives-real-testids technique exactly, but for the T13.2 Channels
 * & Server Administration surfaces (context menu, Create/Edit Channel/Category, Move Channel, the
 * password-join prompt, and the Server Settings "Channels"/"Groups & Permissions" pages) rather than
 * T13.1's workspace chrome.
 *
 * Deliberately independent of `armE2EScreenshotHomeCapture`/`armE2EScreenshotWorkspaceCapture`'s own
 * env vars (`DISCO_VOADOR_E2E_SCREENSHOT_CAPTURE_DIR`) — this reads its own, distinctly-named
 * `DISCO_VOADOR_E2E_T132_SCREENSHOT_ADMIN_DIR`/`_ADMIN_GROUP_ID`/`_POE_ENDGAME_ID`/`_BOSSING_ID`/
 * `_MAPPING_ID`/`_VIP_LOUNGE_ID` variables directly (never through the shared zod-validated
 * `desktop-config.ts` schema, matching that function's own precedent for a capture-directory path),
 * so the two tools can never accidentally arm each other. The node-id/group-id variables identify
 * real nodes/groups the orchestrating script already created via a raw-WS admin connection
 * (`scripts/lib/raw-protocol-client.mjs`) before this instance ever launches — Main has no way to
 * know a server-generated id any other way.
 *
 * This instance is expected to auto-join a real, already-populated voice channel
 * (`config.e2eVoiceAutoJoin`, e.g. "Lobby") as an ordinary participant with no special rights at
 * connect time, then have the orchestrating script's raw-WS admin connection observe its
 * `voice:participant-joined` and grant it a real, custom, near-omnipotent group
 * (`DISCO_VOADOR_E2E_T132_SCREENSHOT_ADMIN_GROUP_ID`, e.g. "Owner" — deliberately *not* the built-in
 * `server-admin` group, whose permission set always includes `channels.password.bypass`, which would
 * make this instance's own attempt to join the password-protected "VIP Lounge" succeed silently
 * instead of producing the real password prompt screenshot 08 needs) live — proving (like
 * `e2e-channel-admin-smoke.mjs`'s own live-grant scenario) that a real, already-connected UI session
 * picks up full admin rights with no reconnect. This function therefore waits for BOTH the real join
 * marker (`disco-voador:voice-joined:<channelId>`) AND the unconditional
 * `disco-voador:my-groups:<...>` marker (already logged by `use-voice-channel.ts` on every
 * `server:authorization-state`) actually containing that group id before driving any admin UI —
 * never a blind timeout guessing when the live grant has landed.
 */
function armE2EChannelAdminScreenshotCapture(window: BrowserWindow): void {
  const captureDirEnv = process.env['DISCO_VOADOR_E2E_T132_SCREENSHOT_ADMIN_DIR'];
  const channelIdEnv = config.e2eVoiceAutoJoin?.channelId;
  const adminGroupIdEnv = process.env['DISCO_VOADOR_E2E_T132_SCREENSHOT_ADMIN_GROUP_ID'];
  const poeEndgameIdEnv = process.env['DISCO_VOADOR_E2E_T132_SCREENSHOT_POE_ENDGAME_ID'];
  const bossingIdEnv = process.env['DISCO_VOADOR_E2E_T132_SCREENSHOT_BOSSING_ID'];
  const mappingIdEnv = process.env['DISCO_VOADOR_E2E_T132_SCREENSHOT_MAPPING_ID'];
  const vipLoungeIdEnv = process.env['DISCO_VOADOR_E2E_T132_SCREENSHOT_VIP_LOUNGE_ID'];
  if (
    !captureDirEnv ||
    !channelIdEnv ||
    !adminGroupIdEnv ||
    !poeEndgameIdEnv ||
    !bossingIdEnv ||
    !mappingIdEnv ||
    !vipLoungeIdEnv ||
    app.isPackaged
  ) {
    return;
  }
  // Re-bound to fresh, non-optional `const`s: TypeScript's control-flow narrowing from the guard
  // clause above does not persist into the closures defined below (they may run long after this
  // function returns), so every closure here captures these instead of the `Env`-suffixed originals.
  const captureDir = captureDirEnv;
  const channelId = channelIdEnv;
  const adminGroupId = adminGroupIdEnv;
  const poeEndgameId = poeEndgameIdEnv;
  const bossingId = bossingIdEnv;
  const mappingId = mappingIdEnv;
  const vipLoungeId = vipLoungeIdEnv;

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  /** Polls a boolean JS expression (evaluated in the Renderer) until it is truthy — used throughout
   * this function instead of a blind `setTimeout` wherever a real, observable DOM condition exists
   * (a modal actually finished loading, a checkbox actually rendered once `state.groups` arrived,
   * etc.), matching this task's own "real, observable signal, never a blind setTimeout" rule. */
  async function waitForCondition(expression: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ok = (await window.webContents.executeJavaScript(`Boolean(${expression})`)) as boolean;
      if (ok) return;
      if (Date.now() >= deadline) {
        throw new Error(`E2E channel-admin screenshot: timed out waiting for: ${expression}`);
      }
      await wait(100);
    }
  }

  async function click(selector: string): Promise<void> {
    await window.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)})?.click();`,
    );
  }

  /** Sets a real, controlled React input/select's value the same way `e2e-screenshot-capture.mjs`'s
   * own `sendRealMessage` helper does — the native prototype value setter, then a real `input`
   * event — so React actually observes the change rather than silently ignoring a bare `.value =`
   * assignment. */
  async function setValue(selector: string, value: string): Promise<void> {
    await window.webContents.executeJavaScript(`
      (function () {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return;
        const proto = el.tagName === 'SELECT' ? window.HTMLSelectElement.prototype
          : el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype
          : window.HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })();
    `);
  }

  /** Picks a `<select>` option by its real, visible label text (exactly what a human reads before
   * picking one) rather than a guessed internal id. */
  async function selectOptionByLabel(selector: string, optionLabel: string): Promise<void> {
    await window.webContents.executeJavaScript(`
      (function () {
        const select = document.querySelector(${JSON.stringify(selector)});
        if (!select) return;
        const option = Array.from(select.options).find(
          (o) => o.textContent && o.textContent.trim() === ${JSON.stringify(optionLabel)},
        );
        if (!option) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype, 'value').set;
        setter.call(select, option.value);
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })();
    `);
  }

  /** `ChannelAclEditor`'s `GroupCheckboxList` renders one real `<label>` per real server group with
   * no per-checkbox testid — this finds it by the same real, visible group name a human reads. */
  async function clickGroupCheckboxByName(scopeSelector: string, groupName: string): Promise<void> {
    await window.webContents.executeJavaScript(`
      (function () {
        const scope = document.querySelector(${JSON.stringify(scopeSelector)});
        if (!scope) return;
        const label = Array.from(scope.querySelectorAll('label')).find(
          (el) => el.textContent && el.textContent.includes(${JSON.stringify(groupName)}),
        );
        label?.querySelector('input[type="checkbox"]')?.click();
      })();
    `);
  }

  async function dispatchContextMenu(selector: string): Promise<void> {
    await window.webContents.executeJavaScript(`
      (function () {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return;
        const rect = el.getBoundingClientRect();
        el.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true,
          clientX: rect.left + 24,
          clientY: rect.top + rect.height / 2,
        }));
      })();
    `);
  }

  /** `ContextMenu.tsx` closes on an outside `pointerdown` (see its own `handlePointerDown`) — a real
   * dispatch of that same event on `document.body`, never a synthetic `onClose()` call. */
  async function dismissContextMenu(): Promise<void> {
    await window.webContents.executeJavaScript(
      `document.body.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));`,
    );
  }

  /** Closes exactly one open `<Modal>`, scoped by its own `testId` — never a bare
   * `[aria-label="Close"]` query, which would match whichever `Modal` happens to appear first in DOM
   * order when more than one is stacked (e.g. `ChannelModal` opened from inside `ServerSettingsModal`)
   * and could close the wrong one. */
  async function closeModal(testId: string): Promise<void> {
    await click(`[data-testid="${testId}"] [aria-label="Close"]`);
  }

  async function saveCapture(name: string): Promise<void> {
    const image = await window.webContents.capturePage();
    await fsPromises.writeFile(path.join(captureDir, name), image.toPNG());
    console.info(`E2E_SCREENSHOT_SAVED:${name}`);
  }

  let joinedChannel = false;
  let grantedAdmin = false;
  let started = false;
  const joinedMarker = `disco-voador:voice-joined:${channelId}`;

  window.webContents.on('console-message', (_event, _level, message) => {
    if (message.startsWith(joinedMarker)) joinedChannel = true;
    if (message.startsWith('disco-voador:my-groups:') && message.includes(adminGroupId)) {
      grantedAdmin = true;
    }
    if (started || !joinedChannel || !grantedAdmin) return;
    started = true;

    void (async () => {
      try {
        // Let the live-granted admin UI chrome (Server Settings gear, context-menu admin items) and
        // the joined roster actually render before the first capture — including the orchestrating
        // script's own transient "Setup" participant leaving Lobby again right after granting (see
        // `e2e-screenshot-capture-t13-2.mjs`), so this capture shows only the real participants.
        await wait(1500);
        window.setBounds({ width: 1920, height: 1080 });
        await wait(500);

        await saveCapture('01-channel-hierarchy-admin-1920x1080.png');
        // Same real, already-rendered frame — the temporary channel's timer badge is already
        // visible in it (see this task's own "don't over-engineer forcing a tooltip" guidance).
        await saveCapture('09-temporary-channel.png');

        await dispatchContextMenu(`[data-testid="channel-row-${poeEndgameId}"]`);
        await waitForCondition('document.querySelector(\'[role="menu"]\')');
        await wait(200);
        await saveCapture('02-channel-context-menu-admin.png');
        await dismissContextMenu();
        await wait(300);

        await click(`[data-testid="channel-row-join-${vipLoungeId}"]`);
        await waitForCondition('document.querySelector(\'[data-testid="password-join-input"]\')');
        await wait(300);
        await saveCapture('08-channel-password-prompt.png');
        await closeModal('password-join-dialog');
        await wait(300);

        await click('[data-testid="open-server-settings"]');
        await waitForCondition(
          'document.querySelector(\'[data-testid="channels-admin-create-category"]\')',
        );
        await wait(400);
        await saveCapture('10-server-settings-channels.png');

        await click('[data-testid="channels-admin-create-category"]');
        await waitForCondition('document.querySelector(\'[data-testid="category-modal-name"]\')');
        await setValue('[data-testid="category-modal-name"]', 'EVENTS');
        await wait(200);
        await saveCapture('04-create-category.png');
        await closeModal('category-modal');
        await wait(300);

        await click('[data-testid="channels-admin-create-channel"]');
        await waitForCondition('document.querySelector(\'[data-testid="channel-modal-name"]\')');
        await setValue('[data-testid="channel-modal-name"]', 'Arena PvP');
        await selectOptionByLabel('[data-testid="channel-modal-parent"]', 'GAMES');
        await click('[data-testid="channel-modal-password-enable"]');
        await setValue('[data-testid="channel-modal-password"]', 'arena-secret-99');
        await setValue('[data-testid="channel-modal-password-confirm"]', 'arena-secret-99');
        await wait(300);
        await saveCapture('03-create-channel.png');
        await closeModal('channel-modal');
        await wait(300);

        await click(`[data-testid="channels-admin-edit-${bossingId}"]`);
        await waitForCondition(
          `document.querySelector('[data-testid="channel-modal-name"]')?.value === 'Bossing'`,
        );
        await wait(400);
        await saveCapture('05-edit-channel.png');

        await click('input[name="managePolicy"][value="selected-groups"]');
        await waitForCondition(
          `Array.from(document.querySelectorAll('[data-testid="channel-modal"] label')).some(
            (el) => el.textContent && el.textContent.includes('Moderator'),
          )`,
        );
        await clickGroupCheckboxByName('[data-testid="channel-modal"]', 'Moderator');
        await wait(200);
        await window.webContents.executeJavaScript(`
          document
            .querySelector('[data-testid="channel-modal"] input[name="managePolicy"]')
            ?.closest('fieldset')
            ?.scrollIntoView({ block: 'center' });
        `);
        await wait(300);
        await saveCapture('07-channel-permissions.png');
        // Never submitted — this is a live, in-progress edit shown for evidence only (matches
        // screenshot 03/04's own "populated but unsubmitted" framing).
        await closeModal('channel-modal');
        await wait(300);

        await click(`[data-testid="channels-admin-move-${mappingId}"]`);
        await waitForCondition('document.querySelector(\'[data-testid="move-channel-target"]\')');
        await wait(300);
        await saveCapture('06-move-channel.png');
        await closeModal('move-channel-dialog');
        await wait(300);

        await click('[data-testid="server-settings-nav-groups"]');
        await wait(500);
        await saveCapture('11-server-settings-permissions.png');

        // T13.2.1 — T13.2's own DoD named a 1366x768 admin screenshot showing "Groups & Permissions
        // or Category ACL" specifically (never satisfied: the prior `13-admin-1366x768.png` below
        // resizes only after the Server Settings modal is already closed, so it never actually shows
        // this surface at this resolution). Captured here, before the modal closes, at the same
        // Groups & Permissions state screenshot 11 already captured at 1920x1080 — proving the
        // "Owner" group's long, categorized permission summary line wraps rather than overflows at
        // the smaller width.
        window.setBounds({ width: 1366, height: 768 });
        await wait(500);
        await saveCapture('14-server-settings-permissions-1366x768.png');
        window.setBounds({ width: 1920, height: 1080 });
        await wait(300);

        await closeModal('server-settings-modal');
        await wait(400);

        window.setBounds({ width: 1366, height: 768 });
        await wait(600);
        await saveCapture('13-admin-1366x768.png');

        console.info('E2E_CHANNEL_ADMIN_SCREENSHOT_CAPTURE_DONE');
        setTimeout(() => app.exit(0), 250);
      } catch (error) {
        console.error('E2E channel-admin screenshot capture failed', error);
        setTimeout(() => app.exit(1), 250);
      }
    })();
  });
}

/**
 * T13.2 screenshot-capture tooling only — the second, independent Electron instance
 * `e2e-screenshot-capture-t13-2.mjs` launches: a genuine Guest (no token ever redeemed, no special
 * group), auto-joining a real, already-populated open channel (e.g. "AFK") purely to reach a
 * connected, catalog-populated state — capturing the one screenshot proving zero admin chrome leaks
 * to a Guest (`12-channel-sidebar-normal-user.png`). See `armE2EChannelAdminScreenshotCapture`'s own
 * doc comment for why this reads its own env vars directly rather than through `desktop-config.ts`.
 */
function armE2EChannelGuestScreenshotCapture(window: BrowserWindow): void {
  const captureDirEnv = process.env['DISCO_VOADOR_E2E_T132_SCREENSHOT_GUEST_DIR'];
  const channelIdEnv = config.e2eVoiceAutoJoin?.channelId;
  if (!captureDirEnv || !channelIdEnv || app.isPackaged) return;
  // See `armE2EChannelAdminScreenshotCapture`'s identical comment: re-bound so the closures below
  // capture a `string`, not `string | undefined`.
  const captureDir = captureDirEnv;
  const channelId = channelIdEnv;

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  let started = false;
  const joinedMarker = `disco-voador:voice-joined:${channelId}`;

  window.webContents.on('console-message', (_event, _level, message) => {
    if (started || !message.startsWith(joinedMarker)) return;
    started = true;

    void (async () => {
      try {
        await wait(1000);
        window.setBounds({ width: 1920, height: 1080 });
        await wait(500);
        const image = await window.webContents.capturePage();
        await fsPromises.writeFile(
          path.join(captureDir, '12-channel-sidebar-normal-user.png'),
          image.toPNG(),
        );
        console.info('E2E_SCREENSHOT_SAVED:12-channel-sidebar-normal-user.png');
        console.info('E2E_CHANNEL_GUEST_SCREENSHOT_CAPTURE_DONE');
        setTimeout(() => app.exit(0), 250);
      } catch (error) {
        console.error('E2E channel-guest screenshot capture failed', error);
        setTimeout(() => app.exit(1), 250);
      }
    })();
  });
}

/** One step of a `DISCO_VOADOR_E2E_PROFILE_STEPS` script — see `armE2EProfileSmoke`'s own doc
 * comment. A loose, throwaway shape (not a discriminated union) deliberately: this is QA-pass-only
 * test scaffolding, never reachable in a packaged build, and every field is optional/action-specific
 * by design (mirrors this file's own existing `DISCO_VOADOR_E2E_T132_SCREENSHOT_*` env vars, which
 * are also read as raw strings with no schema). */
interface ProfileSmokeStep {
  readonly action: string;
  readonly ms?: number;
  readonly groupId?: string;
  readonly selector?: string;
  readonly value?: string;
  readonly text?: string;
  readonly name?: string;
  readonly marker?: string;
  readonly expression?: string;
  readonly timeoutMs?: number;
  readonly width?: number;
  readonly height?: number;
  /** `screenshot` only, optional: when `x`/`y` are set alongside `width`/`height`, crops the capture
   * to that rectangle (`webContents.capturePage(rect)`) instead of the whole page — used for a tight,
   * high-relative-detail close-up during manual visual QA (e.g. confirming a small ring/badge renders
   * correctly) without needing a separate image-processing tool. */
  readonly x?: number;
  readonly y?: number;
}

function parseProfileSmokeSteps(raw: string): readonly ProfileSmokeStep[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed))
    throw new Error('DISCO_VOADOR_E2E_PROFILE_STEPS must be a JSON array');
  return parsed.map((entry) => {
    if (
      typeof entry !== 'object' ||
      entry === null ||
      typeof (entry as { action?: unknown }).action !== 'string'
    ) {
      throw new Error('Each DISCO_VOADOR_E2E_PROFILE_STEPS entry needs a string "action"');
    }
    return entry as ProfileSmokeStep;
  });
}

/**
 * T13.3 QA-pass E2E driver — added, like `armE2EChannelAdminScreenshotCapture`, solely to produce
 * real evidence for the T13.3 profile/avatar/members/presence feature without ever touching Renderer
 * product code. Two small, narrowly-scoped test-only capabilities, both gated on
 * `DISCO_VOADOR_E2E_PROFILE_SMOKE=1` and `!app.isPackaged` (unreachable in any packaged build
 * regardless of environment, mirroring `config.e2eFakeMediaRequested`'s own double-gate precedent
 * exactly):
 *
 * 1. `DISCO_VOADOR_E2E_PROFILE_AVATAR_FILE_PATH`, when set, replaces `dialog.showOpenDialog` with a
 *    fake that immediately resolves to that one fixed path — this is the ONLY thing it fakes; every
 *    byte is still read from a real file on disk by the real `avatar-images.ts` and re-validated for
 *    real by `@disco-voador/shared`'s `validateAvatarImage`. Needed because no E2E script can click
 *    through a native OS "choose a file" dialog.
 * 2. `DISCO_VOADOR_E2E_PROFILE_STEPS`, a JSON array of small steps run in order against the real,
 *    already-rendered DOM via `webContents.executeJavaScript` — the exact same technique
 *    `armE2EChannelAdminScreenshotCapture` already established for T13.2, generalized into a small
 *    reusable vocabulary (open/close the Profile Editor or Server Settings, upload/remove an avatar,
 *    set status/presence, open a member's popover, read back real rendered state, and save a
 *    screenshot) instead of one bespoke function per scenario. Every observation this logs
 *    (`disco-voador:e2e-profile-*`) is a real, freshly-read DOM condition, never a fabricated value —
 *    the whole point of using a real Electron instance instead of relying solely on the protocol-level
 *    coverage `tests/dedicated-server/profile-integration.test.ts` already has.
 */
function armE2EProfileSmoke(window: BrowserWindow): void {
  const isArmed = process.env['DISCO_VOADOR_E2E_PROFILE_SMOKE'] === '1' && !app.isPackaged;
  if (!isArmed) return;

  const avatarFilePath = process.env['DISCO_VOADOR_E2E_PROFILE_AVATAR_FILE_PATH'];
  if (avatarFilePath) {
    dialog.showOpenDialog = ((): Promise<Electron.OpenDialogReturnValue> =>
      Promise.resolve({
        canceled: false,
        filePaths: [avatarFilePath],
      })) as typeof dialog.showOpenDialog;
  }

  const stepsRaw = process.env['DISCO_VOADOR_E2E_PROFILE_STEPS'];
  const screenshotDir = process.env['DISCO_VOADOR_E2E_PROFILE_SCREENSHOT_DIR'];
  if (!stepsRaw) return;

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  async function evalJs<T>(expression: string): Promise<T> {
    return (await window.webContents.executeJavaScript(expression)) as T;
  }

  async function waitForCondition(expression: string, timeoutMs = 5000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const ok = await evalJs<boolean>(`Boolean(${expression})`);
      if (ok) return;
      if (Date.now() >= deadline) {
        throw new Error(`E2E profile smoke: timed out waiting for: ${expression}`);
      }
      await wait(100);
    }
  }

  async function click(selector: string): Promise<void> {
    await window.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)})?.click();`,
    );
  }

  async function setValue(selector: string, value: string): Promise<void> {
    await window.webContents.executeJavaScript(`
      (function () {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(value)});
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })();
    `);
  }

  async function clickMemberRowByName(name: string): Promise<void> {
    await window.webContents.executeJavaScript(`
      (function () {
        const rows = Array.from(document.querySelectorAll('[data-testid^="member-row-"]'));
        const row = rows.find((el) => el.textContent && el.textContent.includes(${JSON.stringify(name)}));
        row?.click();
      })();
    `);
  }

  async function closeModal(testId: string): Promise<void> {
    await click(`[data-testid="${testId}"] [aria-label="Close"]`);
  }

  async function saveScreenshot(
    name: string,
    rect?: { x: number; y: number; width: number; height: number },
  ): Promise<void> {
    if (!screenshotDir) throw new Error('DISCO_VOADOR_E2E_PROFILE_SCREENSHOT_DIR is not set');
    const image = rect
      ? await window.webContents.capturePage(rect)
      : await window.webContents.capturePage();
    await fsPromises.writeFile(path.join(screenshotDir, name), image.toPNG());
    console.info(`E2E_SCREENSHOT_SAVED:${name}`);
  }

  async function runSteps(steps: readonly ProfileSmokeStep[]): Promise<void> {
    for (const step of steps) {
      switch (step.action) {
        case 'wait':
          await wait(step.ms ?? 0);
          break;
        case 'wait-group': {
          const groupId = step.groupId;
          if (!groupId) throw new Error('"wait-group" needs a groupId');
          await waitForCondition(
            `window.__e2eMyGroups && window.__e2eMyGroups.includes(${JSON.stringify(groupId)})`,
            step.timeoutMs ?? 15000,
          );
          break;
        }
        case 'wait-condition':
          if (!step.expression) throw new Error('"wait-condition" needs an expression');
          await waitForCondition(step.expression, step.timeoutMs ?? 5000);
          break;
        case 'click':
          if (!step.selector) throw new Error('"click" needs a selector');
          await click(step.selector);
          break;
        case 'set-value':
          if (!step.selector || step.value === undefined) {
            throw new Error('"set-value" needs a selector and a value');
          }
          await setValue(step.selector, step.value);
          break;
        case 'open-profile-editor':
          await click('[data-testid="user-control-open-profile"]');
          await waitForCondition(
            'document.querySelector(\'[data-testid="profile-editor-change-avatar"]\')',
          );
          break;
        case 'close-profile-editor':
          await closeModal('profile-editor-modal');
          break;
        case 'open-server-settings':
          await click('[data-testid="open-server-settings"]');
          // Waits on the "Channels" nav tab specifically because it is the one section
          // `ServerSettingsModal.tsx` always renders unconditionally (unlike "Server Profile",
          // gated on `server.manage`) — correct regardless of which admin permissions this caller
          // actually holds, unlike waiting on a permission-gated Channels-page control.
          await waitForCondition(
            'document.querySelector(\'[data-testid="server-settings-nav-channels"]\')',
          );
          break;
        case 'close-server-settings':
          await closeModal('server-settings-modal');
          break;
        case 'open-member-popover':
          if (!step.name) throw new Error('"open-member-popover" needs a name');
          await clickMemberRowByName(step.name);
          await waitForCondition('document.querySelector(\'[data-testid="member-popover-name"]\')');
          break;
        case 'close-member-popover':
          await closeModal('member-profile-modal');
          break;
        case 'upload-self-avatar':
          await click('[data-testid="profile-editor-change-avatar"]');
          await waitForCondition(
            'document.querySelector(\'[data-testid="profile-editor-remove-avatar"]\')',
            10000,
          );
          break;
        case 'attempt-upload-self-avatar':
          // Unlike `upload-self-avatar`, does not wait for the "Remove" button — used for a rejected
          // upload (invalid format/animated/oversized), which never makes one appear.
          await click('[data-testid="profile-editor-change-avatar"]');
          await wait(step.ms ?? 500);
          break;
        case 'remove-self-avatar':
          await click('[data-testid="profile-editor-remove-avatar"]');
          await waitForCondition(
            '!document.querySelector(\'[data-testid="profile-editor-remove-avatar"]\')',
            10000,
          );
          break;
        case 'upload-server-avatar':
          await click('[data-testid="server-profile-change-avatar"]');
          await waitForCondition(
            'document.querySelector(\'[data-testid="server-profile-remove-avatar"]\')',
            10000,
          );
          break;
        case 'set-status':
          if (step.text === undefined) throw new Error('"set-status" needs text');
          await setValue('[data-testid="profile-editor-status-input"]', step.text);
          await click('[data-testid="profile-editor-save-status"]');
          await wait(300);
          break;
        case 'set-presence':
          if (!step.value) throw new Error('"set-presence" needs a value');
          await click(`[data-testid="profile-editor-presence-${step.value}"]`);
          await wait(300);
          break;
        case 'read-self-snapshot': {
          const marker = step.marker ?? 'default';
          const snapshot = await evalJs<{
            hasAvatar: boolean;
            status: string;
            presence: string;
          }>(`
            (function () {
              const opts = ['online', 'away', 'dnd'];
              let presence = 'unknown';
              for (const o of opts) {
                const el = document.querySelector('[data-testid="profile-editor-presence-' + o + '"]');
                if (el && el.checked) { presence = o; break; }
              }
              return {
                hasAvatar: Boolean(document.querySelector('[data-testid="profile-editor-remove-avatar"]')),
                status: document.querySelector('[data-testid="profile-editor-status-input"]')?.value ?? '',
                presence,
              };
            })();
          `);
          console.info(
            `disco-voador:e2e-profile-self-snapshot:${marker}:${JSON.stringify(snapshot)}`,
          );
          break;
        }
        case 'read-member-avatar': {
          if (!step.name) throw new Error('"read-member-avatar" needs a name');
          const marker = step.marker ?? step.name;
          const hasAvatar = await evalJs<boolean>(`
            Array.from(document.querySelectorAll('[data-testid^="member-row-"]')).some((el) =>
              el.textContent && el.textContent.includes(${JSON.stringify(step.name)}) && el.querySelector('img')
            )
          `);
          console.info(`disco-voador:e2e-profile-member-avatar:${marker}:${String(hasAvatar)}`);
          break;
        }
        case 'read-member-row-count': {
          // Counts every real `member-row-*` element whose text mentions `step.name` — the direct
          // regression check for the T13.3 "duplicate self row" defect (a caller who just mutated
          // their own profile briefly saw themselves listed twice: once as `MemberPanel`'s manually
          // synthesized self entry, once as a phantom `state.members` entry from the
          // then-unfiltered `server:presence-updated` broadcast the actor's own self-service
          // mutation incorrectly triggered back to itself — see
          // `services/realtime/src/protocol-handlers.ts`'s `pushPresenceUpdate` doc comment for the
          // fix). Exactly `1` is the only ever-correct count for a caller's own real display name.
          if (!step.name) throw new Error('"read-member-row-count" needs a name');
          const marker = step.marker ?? step.name;
          const count = await evalJs<number>(`
            Array.from(document.querySelectorAll('[data-testid^="member-row-"]')).filter((el) =>
              el.textContent && el.textContent.includes(${JSON.stringify(step.name)})
            ).length
          `);
          console.info(`disco-voador:e2e-profile-member-row-count:${marker}:${String(count)}`);
          break;
        }
        case 'read-member-row-text': {
          // The full, real rendered text of a member's row (name, custom status, role badge) — used
          // by a long-running third-party observer to confirm real, per-server-stored content (e.g.
          // a custom status string) on another identity's row, without depending on that identity's
          // own client-side self-view (which `read-self-snapshot`'s own doc comment elsewhere notes
          // does not restore itself after a plain reconnect — a real, verified T13.3 finding, not
          // fixed here since this is QA-only). An absent row (e.g. the member is currently offline)
          // returns an empty string, never throws.
          if (!step.name) throw new Error('"read-member-row-text" needs a name');
          const marker = step.marker ?? step.name;
          const text = await evalJs<string>(`
            (function () {
              const rows = Array.from(document.querySelectorAll('[data-testid^="member-row-"]'));
              const row = rows.find((el) => el.textContent && el.textContent.includes(${JSON.stringify(step.name)}));
              return row ? row.textContent : '';
            })();
          `);
          console.info(`disco-voador:e2e-profile-member-row-text:${marker}:${text}`);
          break;
        }
        case 'read-server-nav-profile-visible': {
          const marker = step.marker ?? 'default';
          const visible = await evalJs<boolean>(
            'Boolean(document.querySelector(\'[data-testid="server-settings-nav-profile"]\'))',
          );
          console.info(`disco-voador:e2e-profile-server-nav-visible:${marker}:${String(visible)}`);
          break;
        }
        case 'read-server-avatar-visible': {
          const marker = step.marker ?? 'default';
          const visible = await evalJs<boolean>(`
            Boolean(
              document
                .querySelector('[data-testid="server-profile-change-avatar"]')
                ?.parentElement?.parentElement?.querySelector('img'),
            )
          `);
          console.info(
            `disco-voador:e2e-profile-server-avatar-visible:${marker}:${String(visible)}`,
          );
          break;
        }
        case 'read-avatar-image-state': {
          // Diagnostic-only: reads the REAL DOM state of a rendered avatar `<img>` (never a static
          // screenshot's own compression artifacts) — `complete`/`naturalWidth`/`naturalHeight` are
          // the standard way to distinguish a genuinely successfully-decoded image (`naturalWidth`
          // > 0) from the browser's own "broken image" placeholder (`complete: true`,
          // `naturalWidth: 0`) from one still mid-fetch (`complete: false`). `scope` narrows which
          // `<img>` — `'profile-editor'` for the large self-avatar slot, `'member-popover'` for the
          // member-profile-popover's avatar slot — since both reuse the same generic `Avatar`
          // component with no distinguishing testid of its own.
          const marker = step.marker ?? 'default';
          const scopeSelector =
            step.name === 'member-popover'
              ? '[data-testid="member-profile-modal"]'
              : '[data-testid="profile-editor-modal"]';
          const state = await evalJs<{
            found: boolean;
            complete?: boolean;
            naturalWidth?: number;
            naturalHeight?: number;
            srcLength?: number;
          }>(`
            (function () {
              const img = document.querySelector('${scopeSelector} img');
              if (!img) return { found: false };
              return {
                found: true,
                complete: img.complete,
                naturalWidth: img.naturalWidth,
                naturalHeight: img.naturalHeight,
                srcLength: img.src ? img.src.length : 0,
              };
            })();
          `);
          console.info(`disco-voador:e2e-avatar-image-state:${marker}:${JSON.stringify(state)}`);
          break;
        }
        case 'assert-text-contains': {
          if (step.text === undefined) throw new Error('"assert-text-contains" needs text');
          const marker = step.marker ?? 'default';
          const found = await evalJs<boolean>(
            `document.body.textContent.includes(${JSON.stringify(step.text)})`,
          );
          console.info(`disco-voador:e2e-profile-assert:${marker}:${String(found)}`);
          break;
        }
        case 'screenshot':
          if (!step.name) throw new Error('"screenshot" needs a name');
          if (
            step.x !== undefined &&
            step.y !== undefined &&
            step.width !== undefined &&
            step.height !== undefined
          ) {
            await saveScreenshot(step.name, {
              x: step.x,
              y: step.y,
              width: step.width,
              height: step.height,
            });
          } else {
            await saveScreenshot(step.name);
          }
          break;
        case 'resize':
          if (!step.width || !step.height) throw new Error('"resize" needs width and height');
          window.setBounds({ width: step.width, height: step.height });
          await wait(300);
          break;
        case 'log':
          console.info(`disco-voador:e2e-profile-log:${step.marker ?? ''}`);
          break;
        default:
          throw new Error(`Unknown DISCO_VOADOR_E2E_PROFILE_STEPS action: "${step.action}"`);
      }
    }
  }

  const channelId = config.e2eVoiceAutoJoin?.channelId;
  if (!channelId) {
    console.error('E2E_PROFILE_SMOKE_MISCONFIGURED: no e2eVoiceAutoJoin channel configured');
    setTimeout(() => app.exit(1), 250);
    return;
  }
  const joinedMarker = `disco-voador:voice-joined:${channelId}`;
  const myGroupsPrefix = 'disco-voador:my-groups:';
  let started = false;

  window.webContents.on('console-message', (_event, _level, message) => {
    // Relays every Renderer console line to this process's own stdout, exactly like every other
    // `armE2E*` relay in this file — without this, the orchestrating Node script (which only reads
    // THIS process's stdout, never the Renderer's console directly) could never observe
    // `use-voice-channel.ts`'s own unconditional markers (`disco-voador:voice-joined:*`,
    // `disco-voador:my-groups:*`) at all, only the ones this function itself emits below.
    console.info(`[renderer] ${message}`);
    if (message.startsWith(myGroupsPrefix)) {
      void window.webContents.executeJavaScript(
        `window.__e2eMyGroups = ${JSON.stringify(message.slice(myGroupsPrefix.length).split(',').filter(Boolean))};`,
      );
    }
    if (started || !message.startsWith(joinedMarker)) return;
    started = true;

    void (async () => {
      try {
        await wait(500);
        const steps = parseProfileSmokeSteps(stepsRaw);
        await runSteps(steps);
        console.info('E2E_PROFILE_SMOKE_STEPS_DONE');
        // Self-exits directly (never via the Renderer-console-relay marker mechanism every other
        // `armE2E*Exit` function here depends on — this function's own "done" marker is logged from
        // Main itself, which never fires a `console-message` event, so no other function's listener
        // could ever observe it anyway) when the orchestrating script asks for it; a long-running
        // observer instance (e.g. a second party watching a member's avatar/status live) omits this
        // and is instead stopped externally once the orchestrating script is done with it.
        if (process.env['DISCO_VOADOR_E2E_PROFILE_EXIT_AFTER_STEPS'] === '1') {
          setTimeout(() => app.exit(0), 250);
        }
      } catch (error) {
        console.error('E2E profile smoke steps failed', error);
        setTimeout(() => app.exit(1), 250);
      }
    })();
  });
}

/**
 * T13.4 — automated `e2e:ptt-smoke` only: pushes a simulated global PTT `'down'`/`'up'` edge on the
 * exact same `pttState` IPC channel Main's real `uiohook-napi` listener uses (see
 * `main/ptt-hotkey.ts`), at fixed delays after app launch — deliberately IPC-driven, never real
 * physical/OS-level key injection. This function never touches `main/ptt-hotkey.ts`'s own listener
 * lifecycle (no real hook is started, stopped, or interfered with) — from the Renderer's point of
 * view, this push is indistinguishable from a real edge the native hook would have produced.
 * `undefined` (`config.e2ePttSimulation`) for every real user and every other scenario, always.
 *
 * **Security-review finding, fixed here**: `config.e2ePttSimulation` (`desktop-config.ts`) is
 * derived purely from two environment variables, with no `app.isPackaged` check of its own — unlike
 * every sibling `armE2E*` gate in this file (e.g. `armE2EProfileSmoke`'s `isArmed = ... &&
 * !app.isPackaged`), this function was the one place that forgot to add it at the consuming end
 * either, so a real packaged build launched with those two environment variables set (a malicious
 * shortcut, a compromised launcher, a persistent machine-level env var) could have a fake PTT
 * down-then-up edge injected with no user interaction. `app.isPackaged` reflects how the binary was
 * actually built/launched, not anything an environment variable can spoof, so gating on it here
 * makes this structurally inert in a packaged build regardless of environment state, matching this
 * file's own established, non-negotiable convention (see `docs/SECURITY.md`).
 */
function armE2EPttSimulation(window: BrowserWindow): void {
  const simulation = app.isPackaged ? undefined : config.e2ePttSimulation;
  if (!simulation) return;

  setTimeout(() => {
    if (window.isDestroyed()) return;
    window.webContents.send(IPC_CHANNELS.pttState, { type: 'down' });
    console.info('E2E_PTT_SIMULATED_DOWN');
  }, simulation.downAfterMs);

  setTimeout(() => {
    if (window.isDestroyed()) return;
    window.webContents.send(IPC_CHANNELS.pttState, { type: 'up' });
    console.info('E2E_PTT_SIMULATED_UP');
  }, simulation.upAfterMs);
}

/**
 * `e2e-voice-smoke.mjs` and `e2e-reconnect-smoke.mjs` only (gated on their own already-existing
 * `isE2EVoiceSmoke`/`isE2EReconnectSmoke` flags, both already `!app.isPackaged`-gated — no new env
 * var needed). Real bug found via QA of these exact scripts: T13.4 made `'voice-activity'` the
 * default input mode, gating transmission on Chromium's fake-microphone signal clearing a real
 * energy threshold after real noise-suppression/AGC processing — measured by an independent QA pass
 * at roughly 10x below the default threshold, so the mic never transmitted at all and these
 * pre-existing regression tests (unrelated to Voice-Activity calibration) broke.
 *
 * **Deliberately marker-driven, not a fixed delay-since-launch pair like `armE2EPttSimulation`
 * above — a real timing bug found while fixing this.** A first attempt used a fixed
 * `PTT_DOWN_AFTER_MS` for `e2e-voice-smoke.mjs`, sized by analogy to `e2e:ptt-smoke`'s own 20s
 * margin — but that script's own audio probe (`probeRemoteAudioLevel`) starts sampling immediately
 * once the peer connection reaches `'connected'` and gives up after its own fixed sample window,
 * with no relationship to any PTT timing at all; a fixed delay picked by analogy raced against that
 * independent window and lost in practice. Listening for `VoiceChannelView.tsx`'s own
 * `E2E_LOCAL_PUSH_TO_TALK_MODE` console marker instead — logged immediately after each successful
 * join, once the microphone is already acquired and this connection's `TransmitGate` already exists
 * — and pushing one simulated `'down'` edge shortly after each occurrence removes the race entirely:
 * it reacts to what actually happened instead of guessing when it would happen. `e2e-reconnect-smoke.mjs`
 * additionally needs this to repeat: its own audio proof must succeed *twice* (once before an
 * unexpected server loss, once after a real reconnect), and a reconnect constructs a brand-new
 * `TransmitGate` (`pttHeld` always restarts `false`, by design) with no knowledge of an earlier
 * simulated press — the marker itself now correctly re-fires on every distinct (re)join, including
 * the post-reconnect rejoin, after a related fix to that effect's one-shot guard.
 *
 * No matching `'up'` is ever pushed — held for the rest of that join, which is exactly what an
 * audio-*delivery* proof needs (neither script has any interest in proving press/release semantics;
 * `e2e:ptt-smoke` already owns that). This is simulation only, identical in kind to
 * `armE2EPttSimulation` above (never touches `main/ptt-hotkey.ts`'s real listener lifecycle).
 */
function armE2EPttHoldOnJoin(window: BrowserWindow): void {
  if (!isE2EReconnectSmoke && !isE2EVoiceSmoke) return;

  window.webContents.on('console-message', (_event, _level, message) => {
    if (!message.includes('E2E_LOCAL_PUSH_TO_TALK_MODE')) return;
    setTimeout(() => {
      if (window.isDestroyed()) return;
      window.webContents.send(IPC_CHANNELS.pttState, { type: 'down' });
      console.info('E2E_PTT_SIMULATED_DOWN');
    }, 300);
  });
}

/**
 * `e2e-voice-preference-smoke.mjs` only — throwaway automation, never reachable in a packaged build
 * (`!app.isPackaged`, same as every other `armE2E*` function here). Once this instance's first real
 * peer connection is observed (`E2E_PEER_CONNECTED`, the same marker `e2e-ptt-smoke.mjs`/
 * `e2e-voice-smoke.mjs` already rely on), drives the actual "User Volume"/"Mute for Me" UI via real
 * DOM clicks and a real `input` event on the real production controls — never a direct action/IPC
 * call — so the resulting persisted preference is genuine end-to-end product behavior, not a
 * fabricated shortcut. `percent`/`mute` are independently optional so a later relaunch can toggle
 * mute alone without re-touching (and risking resetting) an already-persisted volume — see
 * `DesktopConfig.e2eVoicePreferenceAdjust`'s own doc comment. With no adjustment configured at all
 * (a "verify only" relaunch — this instance's job is only to prove a previously-set preference
 * restored on its own), this instead just waits for the normal, unconditional
 * `disco-voador:voice-preference-applied:` marker every attach already emits.
 *
 * Either way, this instance self-exits gracefully (`app.exit()`) once its job is done — found live,
 * not guessed: an earlier version of this scenario had the orchestrating script externally
 * `child.kill()` each instance instead, which corrupted this profile's `safeStorage`-encrypted
 * identity file badly enough that the *next* relaunch of the same `--user-data-dir` failed to decrypt
 * it at all (reproduced independent of this task's own changes, and confirmed absent when using this
 * same self-exit technique `armE2EIdentityPersistenceExit` already relies on) — an abrupt external
 * kill mid-session is not a safe way to end an Electron instance that is about to be relaunched
 * against the same profile.
 */
function armE2EVoicePreferenceAdjust(window: BrowserWindow): void {
  if (!isE2EVoicePreferenceSmoke) return;
  const adjust = config.e2eVoicePreferenceAdjust;

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  let exited = false;
  function exitGracefully(): void {
    if (exited) return;
    exited = true;
    setTimeout(() => app.exit(0), 250);
  }

  if (!adjust) {
    if (!isE2EVoicePreferenceVerify) return;
    window.webContents.on('console-message', (_event, _level, message) => {
      if (message.includes('disco-voador:voice-preference-applied:')) exitGracefully();
    });
    return;
  }

  let started = false;
  window.webContents.on('console-message', (_event, _level, message) => {
    const match = /E2E_PEER_CONNECTED:(.+)/.exec(message);
    if (started || !match) return;
    started = true;
    const peerId = match[1]?.trim();
    if (!peerId) return;

    void (async () => {
      try {
        await wait(500); // let the participant row actually render before clicking it.
        await window.webContents.executeJavaScript(
          `document.querySelector('[data-testid="participant-row-voice-controls-${peerId}"]')?.click();`,
        );
        await wait(300);

        if (adjust.percent !== undefined) {
          await window.webContents.executeJavaScript(`
            (function () {
              const el = document.querySelector('[data-testid="participant-user-volume-slider"]');
              if (!el) return;
              const setter = Object.getOwnPropertyDescriptor(
                window.HTMLInputElement.prototype,
                'value',
              ).set;
              setter.call(el, ${JSON.stringify(String(adjust.percent))});
              el.dispatchEvent(new Event('input', { bubbles: true }));
            })();
          `);
          await wait(200);
        }

        if (adjust.mute) {
          await window.webContents.executeJavaScript(
            `document.querySelector('[data-testid="participant-local-mute-toggle"]')?.click();`,
          );
          await wait(200);
        }

        // Past the 400ms volume-persist debounce (see `use-voice-channel.ts`'s
        // `VOICE_PREFERENCE_PERSIST_DEBOUNCE_MS`) so the real IPC write actually fires before this
        // instance exits.
        await wait(700);
        await window.webContents.executeJavaScript(
          `document.querySelector('[aria-label="Close"]')?.click();`,
        );
        console.info('E2E_VOICE_PREFERENCE_ADJUSTED');
        exitGracefully();
      } catch (error) {
        console.error('E2E voice-preference adjust failed', error);
      }
    })();
  });
}

/**
 * QA-pass (T13.4) screenshot-capture tooling only — throwaway automation added solely to produce
 * this task's QA evidence set, never a permanent regression test and never reachable in a packaged
 * build (`!app.isPackaged`, same as every other `armE2E*` function here). Mirrors
 * `armE2EScreenshotWorkspaceCapture`'s own "drive real testids via `webContents.executeJavaScript`,
 * resize the real `BrowserWindow`, `capturePage()` between shots" technique exactly, extended with
 * `webContents.sendInputEvent` for the two screenshots that need a genuine native keyboard event
 * (the PTT shortcut capture control only ever listens for real `keydown`, never a synthetic
 * `dispatchEvent`) and a real, momentary `globalShortcut.register()` call (the same mechanism
 * `main/ptt-hotkey.ts`'s own conflict probe uses) to produce a deterministic, real conflict rather
 * than a fabricated one.
 */
function armE2ET134PresenterScreenshotCapture(window: BrowserWindow): void {
  const captureDirEnv = process.env['DISCO_VOADOR_E2E_T134_SCREENSHOT_DIR'];
  const channelId = config.e2eVoiceAutoJoin?.channelId;
  if (!captureDirEnv || !channelId || app.isPackaged) return;
  const captureDir = captureDirEnv;

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  async function saveCapture(name: string): Promise<void> {
    const image = await window.webContents.capturePage();
    await fsPromises.writeFile(path.join(captureDir, name), image.toPNG());
    console.info(`E2E_SCREENSHOT_SAVED:${name}`);
  }

  async function click(selector: string): Promise<void> {
    await window.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(selector)})?.click();`,
    );
  }

  async function clickByText(tag: string, text: string): Promise<void> {
    await window.webContents.executeJavaScript(`
      (function () {
        const el = Array.from(document.querySelectorAll(${JSON.stringify(tag)}))
          .find((n) => n.textContent && n.textContent.trim() === ${JSON.stringify(text)});
        el?.click();
      })();
    `);
  }

  async function setRangeValue(selector: string, value: number): Promise<void> {
    await window.webContents.executeJavaScript(`
      (function () {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, ${JSON.stringify(String(value))});
        el.dispatchEvent(new Event('input', { bubbles: true }));
      })();
    `);
  }

  async function waitForText(
    selector: string,
    includes: string,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const text: string = await window.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(selector)})?.textContent ?? '';`,
      );
      if (text.includes(includes)) return true;
      await wait(200);
    }
    return false;
  }

  function sendKeyTap(keyCode: string): void {
    window.webContents.sendInputEvent({ type: 'keyDown', keyCode });
    window.webContents.sendInputEvent({ type: 'keyUp', keyCode });
  }

  let started = false;
  const joinedMarker = `disco-voador:voice-joined:${channelId}`;

  window.webContents.on('console-message', (_event, _level, message) => {
    if (started || !message.includes(joinedMarker)) return;
    started = true;

    void (async () => {
      try {
        await wait(1500); // let the just-joined UI settle.
        window.setBounds({ width: 1920, height: 1080 });
        await wait(400);

        await click('[data-testid="user-control-settings"]');
        await wait(500);
        await click('[data-testid="settings-nav-voice"]');
        await wait(400);

        // --- Voice Activity: meter + sensitivity ---
        await clickByText('button', 'Test microphone');
        await setRangeValue('#voice-activity-sensitivity', 0.8);
        await wait(1200); // let the live meter animate a few frames.
        await saveCapture('01-settings-voice-activity.png');
        await clickByText('button', 'Stop microphone test');
        await wait(300);

        // --- Push to Talk: unbound state ---
        await click('[data-testid="voice-input-mode-push-to-talk"]');
        await wait(400);
        await saveCapture('02-settings-ptt-unbound.png');

        // --- Push to Talk: a real, deterministic conflict (momentary globalShortcut.register, the
        // same mechanism main/ptt-hotkey.ts's own conflict probe uses) ---
        const conflictAccelerator = 'Q';
        const registered = globalShortcut.register(conflictAccelerator, () => {
          // Intentionally empty — this only exists to make Q report "already in use".
        });
        if (registered) {
          await click('[data-testid="ptt-shortcut-capture-button"]');
          await wait(200);
          sendKeyTap('Q');
          const gotConflict = await waitForText(
            '[data-testid="ptt-shortcut-status"]',
            'already in use',
            4000,
          );
          if (gotConflict) await saveCapture('03-settings-ptt-conflict.png');
          else console.error('E2E_T134_SCREENSHOT_WARNING: conflict state never appeared');
          globalShortcut.unregister(conflictAccelerator);
        } else {
          console.error(
            'E2E_T134_SCREENSHOT_WARNING: could not pre-register Q for the conflict demo',
          );
        }

        // --- Push to Talk: real registered binding (F9) ---
        await click('[data-testid="ptt-shortcut-capture-button"]');
        await wait(200);
        sendKeyTap('F9');
        await waitForText('[data-testid="ptt-shortcut-status"]', 'registered', 4000);
        await wait(300);
        await saveCapture('04-settings-ptt-registered.png');

        // --- User control bar with PTT actively held ---
        await click('[aria-label="Close"]');
        await wait(400);
        window.webContents.send(IPC_CHANNELS.pttState, { type: 'down' });
        console.info('E2E_T134_PTT_HELD_FOR_SCREENSHOT');
        await wait(600);
        await saveCapture('05-user-control-bar-ptt-held.png');
        await wait(19_000); // stay held long enough for the paired viewer instance to observe it.
        window.webContents.send(IPC_CHANNELS.pttState, { type: 'up' });

        // --- Settings at 1366x768 ---
        window.setBounds({ width: 1366, height: 768 });
        await wait(400);
        await click('[data-testid="user-control-settings"]');
        await wait(500);
        await click('[data-testid="settings-nav-voice"]');
        await wait(400);
        await saveCapture('07-settings-1366x768.png');

        console.info('E2E_T134_SCREENSHOT_CAPTURE_DONE');
        setTimeout(() => app.exit(0), 250);
      } catch (error) {
        console.error('E2E T13.4 presenter screenshot capture failed', error);
        setTimeout(() => app.exit(1), 250);
      }
    })();
  });
}

/**
 * QA-pass (T13.4) screenshot-capture tooling only — the paired "viewer" half of
 * `armE2ET134PresenterScreenshotCapture`: waits for a real peer connection, then best-effort polls
 * for the *presenter's own* speaking ring (`[data-testid="participant-row-avatar-wrap-<peerId>"]
 * [data-speaking="true"]`, `ParticipantRow.tsx`) before capturing the participant list regardless of
 * whether it ever appeared (a missing subject is reported via a console marker, never silently
 * hidden), then opens that same participant's real "User Volume" modal for the final shot.
 *
 * Found and fixed live during this task's own screenshot review: an earlier version of this poll used
 * an unscoped `document.querySelector('[data-speaking="true"]')`, which matches *any* speaking
 * participant on the page — including the viewer's own self-row (this harness's fake microphone
 * device emits real audio energy, so a viewer left in the default Voice Activity mode legitimately
 * speaks locally). That self-row match resolved the poll near-immediately, well before the
 * presenter's remotely transmitted audio could register, so the captured screenshot showed the
 * viewer's own ring rather than the intended remote subject — the marker said "observed" without
 * actually proving cross-peer speaking detection. Scoping the selector to the presenter's own
 * `peerId` (already captured from `E2E_PEER_CONNECTED`) makes this prove what it claims.
 */
function armE2ET134ViewerScreenshotCapture(window: BrowserWindow): void {
  const captureDirEnv = process.env['DISCO_VOADOR_E2E_T134_VIEWER_SCREENSHOT_DIR'];
  const channelId = config.e2eVoiceAutoJoin?.channelId;
  if (!captureDirEnv || !channelId || app.isPackaged) return;
  const captureDir = captureDirEnv;

  const wait = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  async function saveCapture(name: string): Promise<void> {
    const image = await window.webContents.capturePage();
    await fsPromises.writeFile(path.join(captureDir, name), image.toPNG());
    console.info(`E2E_SCREENSHOT_SAVED:${name}`);
  }

  let peerId: string | undefined;
  let started = false;

  window.webContents.on('console-message', (_event, _level, message) => {
    const peerMatch = /E2E_PEER_CONNECTED:(.+)/.exec(message);
    if (peerMatch) peerId = peerMatch[1]?.trim();
    if (started || !peerId) return;
    started = true;

    void (async () => {
      try {
        window.setBounds({ width: 1920, height: 1080 });
        await wait(1000);

        const deadline = Date.now() + 25_000;
        let speaking = false;
        while (Date.now() < deadline) {
          speaking = await window.webContents.executeJavaScript(
            `document.querySelector('[data-testid="participant-row-avatar-wrap-${String(peerId)}"][data-speaking="true"]') !== null;`,
          );
          if (speaking) break;
          await wait(300);
        }
        console.info(
          speaking ? 'E2E_T134_SPEAKING_RING_OBSERVED' : 'E2E_T134_SPEAKING_RING_NOT_OBSERVED',
        );
        await saveCapture('06-participant-list-speaking.png');

        await window.webContents.executeJavaScript(
          `document.querySelector('[data-testid="participant-row-voice-controls-${String(peerId)}"]')?.click();`,
        );
        await wait(500);
        await saveCapture('06b-participant-volume-modal.png');

        console.info('E2E_T134_VIEWER_SCREENSHOT_CAPTURE_DONE');
        setTimeout(() => app.exit(0), 250);
      } catch (error) {
        console.error('E2E T13.4 viewer screenshot capture failed', error);
        setTimeout(() => app.exit(1), 250);
      }
    })();
  });
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  // T1 has no product use for a native menu, and `autoHideMenuBar` only hides it visually — Alt
  // would still reveal Electron's default menu (including reload/DevTools items) without this.
  Menu.setApplicationMenu(null);

  const allowedOrigins = allowedRendererOrigins(devServerUrl());

  registerAppProtocolHandler(rendererDirectory());
  installPermissionHandlers(session.defaultSession, allowedOrigins);
  installScreenShareHandlers(session.defaultSession, allowedOrigins);

  const window = createMainWindow(config, allowedOrigins);

  // T13.4 — starts the global PTT hook from whatever binding was persisted last session, if any.
  // Deliberately independent of window/connection lifecycle from here on (ADR 0021) — only an
  // explicit `setPttShortcut`/`clearPttShortcut` IPC call or app quit (`stopPttHotkeyListener` below)
  // ever changes it again. A failure here is logged, never thrown — must not block app startup.
  void getClientSettings()
    .then((settings) => initializePttHotkeyFromSettings(settings.voice.pttBinding))
    .catch((error: unknown) => {
      console.error('ptt-hotkey: failed to read persisted settings at startup', error);
    });

  armSmokeTestExit(window);
  armE2EVoiceSmokeExit(window);
  armE2ECameraSmokeExit(window);
  armE2EScreenSmokeExit(window);
  armE2EScreenAudioSmokeExit(window);
  armE2EIdentityPersistenceExit(window);
  armE2EConnectionSmokeExit(window);
  armE2EAuthorizationExit(window);
  armE2EChannelAdminExit(window);
  armE2ETextChatRelay(window);
  armE2EReconnectSmokeRelay(window);
  armE2EProcessAudioSmokeRelay(window);
  armE2ESettingsPersistenceExit(window);
  armE2EProductShellSmokeRelay(window);
  armE2EScreenshotHomeCapture(window);
  armE2EScreenshotWorkspaceCapture(window);
  armE2EChannelAdminScreenshotCapture(window);
  armE2EChannelGuestScreenshotCapture(window);
  armE2EProfileSmoke(window);
  armE2EPttSmokeRelay(window);
  armE2EVoicePreferenceSmokeRelay(window);
  armE2EPttSimulation(window);
  armE2EPttHoldOnJoin(window);
  armE2EVoicePreferenceAdjust(window);
  armE2ET134PresenterScreenshotCapture(window);
  armE2ET134ViewerScreenshotCapture(window);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(config, allowedOrigins);
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// T12 — never leave a native process-loopback helper (or a live capture session) running once the
// app itself is quitting; mirrors this app's existing "privacy-sensitive sources never outlive what
// they were started for" discipline (T11's camera/screen non-restoration policy) applied to the one
// source in this app backed by an actual OS child process.
app.on('before-quit', () => {
  disposeProcessAudioSession();
  // T13.4 — never leave a native `uiohook-napi` keyboard/mouse hook running after the app itself has
  // exited (mirrors `disposeProcessAudioSession`'s own "no lingering native resource" discipline).
  stopPttHotkeyListener();
});

bootstrap().catch((error: unknown) => {
  console.error('OvniChat desktop shell failed to start', error);
  app.exit(1);
});
