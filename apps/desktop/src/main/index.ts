import { app, BrowserWindow, Menu, session } from 'electron';
import path from 'node:path';

import { loadDesktopConfig } from './desktop-config.js';
import { allowedRendererOrigins } from './origins.js';
import { installPermissionHandlers } from './permissions.js';
import { registerAppProtocolHandler, registerAppProtocolPrivileges } from './protocol.js';
import { installScreenShareHandlers } from './screen-share.js';
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
const isE2EScreenSmoke = process.env['DISCO_VOADOR_E2E_SCREEN_SMOKE'] === '1' && !app.isPackaged;
const isE2EScreenAudioSmoke =
  process.env['DISCO_VOADOR_E2E_SCREEN_AUDIO_SMOKE'] === '1' && !app.isPackaged;

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

async function bootstrap(): Promise<void> {
  await app.whenReady();

  // T1 has no product use for a native menu, and `autoHideMenuBar` only hides it visually — Alt
  // would still reveal Electron's default menu (including reload/DevTools items) without this.
  Menu.setApplicationMenu(null);

  const realtimeOrigin = new URL(config.realtimeUrl).origin;
  const allowedOrigins = allowedRendererOrigins(devServerUrl());

  registerAppProtocolHandler(rendererDirectory(), realtimeOrigin);
  installPermissionHandlers(session.defaultSession, allowedOrigins);
  installScreenShareHandlers(session.defaultSession, allowedOrigins);

  const window = createMainWindow(config, realtimeOrigin, allowedOrigins);
  armSmokeTestExit(window);
  armE2EVoiceSmokeExit(window);
  armE2ECameraSmokeExit(window);
  armE2EScreenSmokeExit(window);
  armE2EScreenAudioSmokeExit(window);

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
