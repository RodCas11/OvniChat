import { app, BrowserWindow, Menu, session } from 'electron';
import path from 'node:path';

import { loadDesktopConfig } from './desktop-config.js';
import { allowedRendererOrigins } from './origins.js';
import { installPermissionHandlers } from './permissions.js';
import { registerAppProtocolHandler, registerAppProtocolPrivileges } from './protocol.js';
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
      setTimeout(() => app.exit(0), 250);
    }
  });
}

async function bootstrap(): Promise<void> {
  await app.whenReady();

  // T1 has no product use for a native menu, and `autoHideMenuBar` only hides it visually — Alt
  // would still reveal Electron's default menu (including reload/DevTools items) without this.
  Menu.setApplicationMenu(null);

  const realtimeOrigin = new URL(config.realtimeUrl).origin;
  const allowedOrigins = allowedRendererOrigins(devServerUrl());

  registerAppProtocolHandler(rendererDirectory(), realtimeOrigin);
  installPermissionHandlers(session.defaultSession, allowedOrigins);

  const window = createMainWindow(config, realtimeOrigin, allowedOrigins);
  armSmokeTestExit(window);
  armE2EVoiceSmokeExit(window);
  armE2ECameraSmokeExit(window);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow(config, realtimeOrigin, allowedOrigins);
    }
  });
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

bootstrap().catch((error: unknown) => {
  console.error('Disco Voador desktop shell failed to start', error);
  app.exit(1);
});
