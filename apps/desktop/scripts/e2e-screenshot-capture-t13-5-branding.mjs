// T13.5 Phase A (Chantivo branding) — QA-pass screenshot-capture tooling only, producing this
// sub-task's own evidence set (brief Section 16). Never a permanent regression test; not part of
// `pnpm check`.
//
// Reuses two already-proven real-Electron capture mechanisms, never new Main-process capture code:
//   1. `armE2EScreenshotHomeCapture`/`DesktopE2EScreenshotConfig` (established by
//      `e2e-screenshot-capture.mjs`, T13.1) — a fresh profile, real nickname submission, two real
//      bookmarks added via the real `addBookmark` IPC, deliberately never auto-connecting so
//      `ServerHome` stays rendered — for the pre-connection Home screenshot.
//   2. `armE2EProfileSmoke`'s generic step vocabulary (established by the T13.4 UI-consistency
//      screenshot script) — auto-joins a real voice channel against a real Dedicated Server, then
//      drives real DOM clicks/resizes/screenshots — for every post-connection screenshot.
//
// Produces (docs/tasks/screenshots/t13-5-branding/):
//   01-chantivo-home.png            — ServerHome, pre-connection, real bookmarks
//   02-chantivo-connected-server.png — connected workspace, chat primary (no active media)
//   03-chantivo-settings.png        — Settings panel (Voice & Video section)
//   04-chantivo-about.png           — Settings > Advanced > About subsection
//   05-chantivo-1366x768.png        — connected workspace at 1366x768

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';

import { buildElectronE2EEnvironment } from './lib/electron-e2e-env.mjs';
import { spawnElectronE2E } from './lib/spawn-electron-e2e.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopDir, '.vite', 'build', 'main.cjs');
const repoRoot = path.resolve(desktopDir, '..', '..');
const captureDir = path.join(repoRoot, 'docs', 'tasks', 'screenshots', 't13-5-branding');
const CHANNEL_ID = 'general';
const INSTANCE_TIMEOUT_MS = 60_000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(mainEntry)) {
  fail(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first.`,
  );
}

rmSync(captureDir, { recursive: true, force: true });
mkdirSync(captureDir, { recursive: true });

function spawnHomeCaptureInstance(extraEnv) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-branding-home-'));
  const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
    cwd: desktopDir,
    env: buildElectronE2EEnvironment(process.env, {
      DISCO_VOADOR_E2E_SCREENSHOT_CAPTURE_DIR: captureDir,
      ...extraEnv,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  const waiters = [];
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(`[home] ${text}`);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (stdout.includes(waiters[i].pattern)) {
        waiters[i].resolve();
        waiters.splice(i, 1);
      }
    }
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[home] ${chunk.toString()}`));

  function waitFor(pattern, timeoutMs = INSTANCE_TIMEOUT_MS) {
    if (stdout.includes(pattern)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`[home] timed out waiting for: ${pattern}`));
      }, timeoutMs);
      waiters.push({
        pattern,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolve) => {
        child.once('exit', () => resolve());
      });
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }

  return { waitFor, stop };
}

async function stopServer(server) {
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGTERM');
    await new Promise((resolve) => {
      server.child.once('exit', () => resolve());
    });
  }
}

async function captureHome() {
  console.info('--- Capturing 01-chantivo-home.png ---');
  const serverA = await startDedicatedServer();
  const serverB = await startDedicatedServer();

  const instance = spawnHomeCaptureInstance({
    DISCO_VOADOR_E2E_SCREENSHOT_DISPLAY_NAME: 'ScreenshotTester',
    DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_A_NAME: 'Home Server',
    DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_A_ADDRESS: `${serverA.host}:${String(serverA.port)}`,
    DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_B_NAME: 'Guild Server',
    DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_B_ADDRESS: `${serverB.host}:${String(serverB.port)}`,
  });

  try {
    await instance.waitFor('E2E_SCREENSHOT_SAVED:01-server-home.png');
    renameSync(
      path.join(captureDir, '01-server-home.png'),
      path.join(captureDir, '01-chantivo-home.png'),
    );
    console.info('01-chantivo-home.png saved.');
  } finally {
    await instance.stop();
    await stopServer(serverA);
    await stopServer(serverB);
  }
}

async function captureWorkspace() {
  console.info(
    '--- Capturing 02-chantivo-connected-server.png / 03-chantivo-settings.png / 04-chantivo-about.png / 05-chantivo-1366x768.png ---',
  );
  const server = await startDedicatedServer();
  const url = `ws://${server.host}:${String(server.port)}`;

  let instance;
  try {
    instance = spawnElectronE2E('workspace', {
      DISCO_VOADOR_REALTIME_URL: url,
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'ScreenshotTester',
      DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
      DISCO_VOADOR_E2E_PROFILE_SCREENSHOT_DIR: captureDir,
      DISCO_VOADOR_E2E_PROFILE_EXIT_AFTER_STEPS: '1',
      DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify([
        { action: 'resize', width: 1920, height: 1080 },
        { action: 'wait', ms: 1000 },
        { action: 'screenshot', name: '02-chantivo-connected-server.png' },

        { action: 'click', selector: '[data-testid="user-control-settings"]' },
        { action: 'wait', ms: 500 },
        { action: 'click', selector: '[data-testid="settings-nav-voice"]' },
        { action: 'wait', ms: 400 },
        { action: 'screenshot', name: '03-chantivo-settings.png' },

        { action: 'click', selector: '[data-testid="settings-nav-advanced"]' },
        { action: 'wait', ms: 400 },
        { action: 'screenshot', name: '04-chantivo-about.png' },
        { action: 'click', selector: '[aria-label="Close"]' },
        { action: 'wait', ms: 300 },

        { action: 'resize', width: 1366, height: 768 },
        { action: 'wait', ms: 400 },
        { action: 'screenshot', name: '05-chantivo-1366x768.png' },
      ]),
    });
    await instance.waitFor('E2E_PROFILE_SMOKE_STEPS_DONE', INSTANCE_TIMEOUT_MS);
    console.info(
      '02-chantivo-connected-server.png / 03-chantivo-settings.png / 04-chantivo-about.png / 05-chantivo-1366x768.png saved.',
    );
  } finally {
    await instance?.stop();
    await stopServer(server);
  }
}

async function main() {
  await captureHome();
  await captureWorkspace();
  console.info(`T13.5 branding screenshot capture complete. Saved to: ${captureDir}`);
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(
      `T13.5 branding screenshot capture failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
