// T13.5 Phase B (media stage) — QA-pass screenshot-capture tooling only, producing this sub-task's
// own evidence set (brief Section 94). Never a permanent regression test; not part of `pnpm check`.
//
// Reuses `armE2EProfileSmoke`'s generic step vocabulary exactly as the T13.4 UI-consistency and
// T13.5 branding screenshot scripts already do — no new Main-process capture code.
//
// Two real Electron instances against one real Dedicated Server:
//   Alice (publisher): auto-joins with a real fake camera AND a real fake auto-screen-share
//     (`DISCO_VOADOR_E2E_VOICE_AUTO_CAMERA`/`_AUTO_SCREEN_SHARE`, the exact mechanism
//     `e2e-camera-smoke.mjs`/`e2e-screen-smoke.mjs` already use), plus a forced Push-to-Talk edge
//     (`armE2EPttSimulation`) so the "speaking" screenshot is deterministic rather than racing the
//     default Voice-Activity mode's own unreliable ambient threshold (see
//     `e2e-screenshot-capture-t13-4-ui-consistency.mjs`'s own doc comment on this exact issue).
//     Drives its own screenshots via `armE2EProfileSmoke`.
//   Bob (viewer): auto-joins with no camera of his own (so Alice's grid/camera-off-avatar-tile
//     screenshots show a real camera-off participant, never a fabricated one), and separately opens
//     the real screen-share source picker (never actually shares) to capture it in isolation.
//
// Produces (docs/tasks/screenshots/t13-5/):
//   03-camera-grid-two-users.png   — Alice (camera on) + Bob (camera off, real avatar tile)
//   04-camera-grid-speaking.png    — same grid, Alice's speaking ring visible
//   05-screen-share-focused.png    — Alice's screen share becomes primary content
//   06-screen-share-with-chat.png  — same moment; chat remains visible alongside (not a separate shot)
//   08-sharing-active-controls.png — the footer's "sharing" active-state control
//   10-media-member-panel.png      — media stage + Member Panel both visible at once
//   11-media-1366x768.png          — the same media-active layout, remains usable at 1366x768
//   07-stream-source-picker.png    — Bob's real (never-shared) screen-share source picker
//   12-camera-off-avatar-tile.png  — a copy of 03 (Bob's real avatar-fallback tile is already the
//                                    clean subject of that shot; no separate capture needed)
//   09-stream-popout-or-pip.png    — a copy of 05 (the PiP button is visible on the focused tile;
//                                    a real triggered PiP opens a genuine separate OS-compositor
//                                    window this capture technique cannot photograph — noted in the
//                                    final report rather than faked)

import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnElectronE2E } from './lib/spawn-electron-e2e.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopDir, '.vite', 'build', 'main.cjs');
const repoRoot = path.resolve(desktopDir, '..', '..');
const captureDir = path.join(repoRoot, 'docs', 'tasks', 'screenshots', 't13-5');
const CHANNEL_ID = 'general';

if (!existsSync(mainEntry)) {
  console.error(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first.`,
  );
  process.exit(1);
}
mkdirSync(captureDir, { recursive: true });

async function stopServer(server) {
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGTERM');
    await new Promise((resolve) => {
      server.child.once('exit', () => resolve());
    });
  }
}

async function main() {
  console.info('Starting Dedicated Server (real, open access, ephemeral)...');
  const server = await startDedicatedServer();
  const url = `ws://${server.host}:${String(server.port)}`;

  let bob;
  let alice;
  try {
    console.info('Launching Bob (viewer, no camera) — the real second grid participant...');
    bob = spawnElectronE2E('bob', {
      DISCO_VOADOR_REALTIME_URL: url,
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Bob',
    });
    await bob.waitFor(`disco-voador:voice-joined:${CHANNEL_ID}`);

    console.info(
      'Launching Alice (publisher: camera + auto screen-share + forced PTT speaking)...',
    );
    alice = spawnElectronE2E('alice', {
      DISCO_VOADOR_REALTIME_URL: url,
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Alice',
      DISCO_VOADOR_E2E_VOICE_AUTO_CAMERA: '1',
      DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE: '1',
      DISCO_VOADOR_E2E_PTT_DOWN_AFTER_MS: '9000',
      DISCO_VOADOR_E2E_PTT_UP_AFTER_MS: '60000',
      DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
      DISCO_VOADOR_E2E_PROFILE_SCREENSHOT_DIR: captureDir,
      DISCO_VOADOR_E2E_PROFILE_EXIT_AFTER_STEPS: '1',
      DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify([
        { action: 'wait', ms: 500 },
        { action: 'click', selector: '[data-testid="user-control-settings"]' },
        { action: 'wait', ms: 400 },
        { action: 'click', selector: '[data-testid="settings-nav-voice"]' },
        { action: 'wait', ms: 300 },
        { action: 'click', selector: '[data-testid="voice-input-mode-push-to-talk"]' },
        { action: 'wait', ms: 300 },
        { action: 'click', selector: '[aria-label="Close"]' },
        { action: 'wait', ms: 500 },
        { action: 'resize', width: 1920, height: 1080 },

        // Camera-only phase (before auto screen-share kicks in): the grid with Alice's real camera
        // and Bob's real camera-off avatar tile.
        {
          action: 'wait-condition',
          expression: 'document.querySelectorAll(\'[data-role="media-tile-camera"]\').length >= 2',
          timeoutMs: 30000,
        },
        { action: 'wait', ms: 500 },
        { action: 'screenshot', name: '03-camera-grid-two-users.png' },

        // Forced-PTT speaking ring, still in grid mode.
        {
          action: 'wait-condition',
          expression:
            "Array.from(document.querySelectorAll('[data-role=\"media-tile-camera\"]')).some((el) => el.getAttribute('data-speaking') === 'true')",
          timeoutMs: 15000,
        },
        { action: 'wait', ms: 300 },
        { action: 'screenshot', name: '04-camera-grid-speaking.png' },

        // Auto screen-share kicks in — becomes primary content.
        {
          action: 'wait-condition',
          expression: 'document.querySelector(\'[data-role="media-tile-screen"]\')',
          timeoutMs: 20000,
        },
        { action: 'wait', ms: 800 },
        { action: 'screenshot', name: '05-screen-share-focused.png' },
        { action: 'screenshot', name: '06-screen-share-with-chat.png' },
        { action: 'screenshot', name: '08-sharing-active-controls.png' },
        { action: 'screenshot', name: '10-media-member-panel.png' },

        { action: 'resize', width: 1366, height: 768 },
        { action: 'wait', ms: 400 },
        { action: 'screenshot', name: '11-media-1366x768.png' },
      ]),
    });

    await alice.waitFor('E2E_PROFILE_SMOKE_STEPS_DONE', 90000);
    console.info('Alice-side captures complete.');
  } finally {
    await alice?.stop();
    await bob?.stop();
    await stopServer(server);
  }

  // Bob's picker capture: a fresh short-lived instance, deliberately sequential (never sharing
  // resources with the two-instance voice session above) — opens the real picker via a real click,
  // never auto-selects/starts a share.
  console.info('Launching a fresh instance to capture 07-stream-source-picker.png...');
  const server2 = await startDedicatedServer();
  const url2 = `ws://${server2.host}:${String(server2.port)}`;
  let picker;
  try {
    picker = spawnElectronE2E('picker', {
      DISCO_VOADOR_REALTIME_URL: url2,
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'ScreenshotTester',
      DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
      DISCO_VOADOR_E2E_PROFILE_SCREENSHOT_DIR: captureDir,
      DISCO_VOADOR_E2E_PROFILE_EXIT_AFTER_STEPS: '1',
      DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify([
        { action: 'resize', width: 1920, height: 1080 },
        { action: 'wait', ms: 500 },
        { action: 'click', selector: '[data-testid="user-control-screen"]' },
        {
          action: 'wait-condition',
          expression: 'document.querySelector(\'[data-role="screen-source-picker"]\')',
          timeoutMs: 10000,
        },
        { action: 'wait', ms: 800 },
        { action: 'screenshot', name: '07-stream-source-picker.png' },
      ]),
    });
    await picker.waitFor('E2E_PROFILE_SMOKE_STEPS_DONE', 30000);
  } finally {
    await picker?.stop();
    await stopServer(server2);
  }

  copyFileSync(
    path.join(captureDir, '03-camera-grid-two-users.png'),
    path.join(captureDir, '12-camera-off-avatar-tile.png'),
  );
  copyFileSync(
    path.join(captureDir, '05-screen-share-focused.png'),
    path.join(captureDir, '09-stream-popout-or-pip.png'),
  );

  console.info(`T13.5 media screenshot capture complete. Saved to: ${captureDir}`);
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(
      `T13.5 media screenshot capture failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
