// T13.5.1 (final visual polish) — QA-pass screenshot-capture tooling only, producing this task's own
// evidence set (brief Section 47). Never a permanent regression test; not part of `pnpm check`.
// Deliberately never activates a real camera/screen-share (Section 53) — this is a pure Renderer/CSS
// polish task; fake media devices are only ever *available* (required to join voice at all, same
// baseline every non-media E2E in this repo already uses), never turned into an actual camera/screen
// stream.
//
// Reuses `e2e-screenshot-capture.mjs`'s exact two proven Main-process capture mechanisms
// (`armE2EScreenshotHomeCapture`/`armE2EScreenshotWorkspaceCapture`), extended for this task with a
// handful of additional real captures (Home at 1366x768, Screen Share settings, a real context menu,
// a narrow-window size) — see those two functions' own doc comments in `main/index.ts` for exactly
// what was added and why.
//
// Produces (docs/tasks/screenshots/t13-5-1/), each a rename of a real capture from the run below:
//   01-home-1920x1080.png            <- 01-server-home.png
//   02-home-1366x768.png             <- 01b-server-home-1366x768.png
//   03-connected-server-1920x1080.png <- 02-workspace-1920x1080.png
//   04-connected-server-1366x768.png <- 03-workspace-1366x768.png
//   05-settings-profile.png          <- 04-settings.png (Settings opens on its default Profile section)
//   06-settings-voice-video.png      <- 06-settings-voice.png
//   07-settings-screen-share.png     <- 07b-settings-screen-share.png
//   08-settings-advanced-about.png   <- 07-settings-advanced.png (About now sits first under Advanced)
//   09-channel-participants.png      <- 02-workspace-1920x1080.png (real 2-participant roster, no camera/screen)
//   10-member-panel.png              <- 02-workspace-1920x1080.png (same real capture; Member Panel is
//                                        already visible/expanded in it)
//   11-chat-empty-state.png          <- 02-workspace-1920x1080.png (captured before any message was sent)
//   12-context-menu.png              <- 07c-context-menu.png
//   13-modal-focus-visible.png       <- 04-settings.png (Settings' own auto-focused Close button on open)
//   14-narrow-window.png             <- 09b-narrow-window-1024x700.png

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';

import { buildElectronE2EEnvironment } from './lib/electron-e2e-env.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopDir, '.vite', 'build', 'main.cjs');
const repoRoot = path.resolve(desktopDir, '..', '..');
const captureDir = path.join(repoRoot, 'docs', 'tasks', 'screenshots', 't13-5-1');
const CHANNEL_ID = 'general';
const INSTANCE_TIMEOUT_MS = 90_000;

if (!existsSync(mainEntry)) {
  console.error(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first.`,
  );
  process.exit(1);
}
rmSync(captureDir, { recursive: true, force: true });
mkdirSync(captureDir, { recursive: true });

function spawnCaptureInstance(label, extraEnv) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), `disco-voador-e2e-polish-${label}-`));
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
    process.stdout.write(`[${label}] ${text}`);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (stdout.includes(waiters[i].pattern)) {
        waiters[i].resolve();
        waiters.splice(i, 1);
      }
    }
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk.toString()}`));
  function waitFor(pattern, timeoutMs = INSTANCE_TIMEOUT_MS) {
    if (stdout.includes(pattern)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`[${label}] timed out waiting for: ${pattern}`));
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
  console.info('--- Capturing Home (01, 02) ---');
  const server = await startDedicatedServer();
  const instance = spawnCaptureInstance('home', {
    DISCO_VOADOR_E2E_SCREENSHOT_DISPLAY_NAME: 'ScreenshotTester',
    DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_A_NAME: 'Home Server',
    DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_A_ADDRESS: `${server.host}:${String(server.port)}`,
    DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_B_NAME: 'Guild Server',
    DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_B_ADDRESS: `${server.host}:${String(server.port)}`,
  });
  try {
    await instance.waitFor('E2E_SCREENSHOT_SAVED:01-server-home.png');
    await instance.waitFor('E2E_SCREENSHOT_SAVED:01b-server-home-1366x768.png');
  } finally {
    await instance.stop();
    await stopServer(server);
  }
}

function spawnBackgroundParticipant(realtimeUrl) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-polish-peer-'));
  const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
    cwd: desktopDir,
    env: buildElectronE2EEnvironment(process.env, {
      DISCO_VOADOR_REALTIME_URL: realtimeUrl,
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'BackgroundParticipant',
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[peer] ${chunk.toString()}`));
  child.stderr.on('data', (chunk) => process.stderr.write(`[peer] ${chunk.toString()}`));
  return {
    async stop() {
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
    },
  };
}

async function captureWorkspace() {
  console.info('--- Capturing connected-workspace/Settings/context-menu/narrow-window shots ---');
  const server = await startDedicatedServer();
  const realtimeUrl = `ws://${server.host}:${String(server.port)}`;
  const peer = spawnBackgroundParticipant(realtimeUrl);

  const instance = spawnCaptureInstance('workspace', {
    DISCO_VOADOR_REALTIME_URL: realtimeUrl,
    DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
    DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
    DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'ScreenshotSubject',
  });

  try {
    for (const marker of [
      '02-workspace-1920x1080.png',
      '03-workspace-1366x768.png',
      '03b-workspace-1600x900.png',
      '04-settings.png',
      '05-member-panel-collapsed.png',
      '06-settings-voice.png',
      '07-settings-advanced.png',
      '07b-settings-screen-share.png',
      '07c-context-menu.png',
      '08-add-server-dialog.png',
      '09-chat-messages-general.png',
      '09b-narrow-window-1024x700.png',
    ]) {
      await instance.waitFor(`E2E_SCREENSHOT_SAVED:${marker}`);
      console.info(`${marker} saved.`);
    }
    await instance.waitFor('E2E_SCREENSHOT_CAPTURE_DONE');
  } finally {
    await instance.stop();
    await peer.stop();
    await stopServer(server);
  }
}

function renameTo(from, to) {
  const src = path.join(captureDir, from);
  const dest = path.join(captureDir, to);
  if (!existsSync(src)) {
    console.error(`MISSING source for rename: ${src}`);
    return false;
  }
  copyFileSync(src, dest);
  return true;
}

function reportFile(name) {
  const filePath = path.join(captureDir, name);
  if (!existsSync(filePath)) {
    console.error(`MISSING: ${filePath}`);
    return false;
  }
  const size = statSync(filePath).size;
  console.info(`${filePath} (${String(size)} bytes)`);
  return size > 1000;
}

async function main() {
  await captureHome();
  await captureWorkspace();

  const renames = [
    ['01-server-home.png', '01-home-1920x1080.png'],
    ['01b-server-home-1366x768.png', '02-home-1366x768.png'],
    ['02-workspace-1920x1080.png', '03-connected-server-1920x1080.png'],
    ['03-workspace-1366x768.png', '04-connected-server-1366x768.png'],
    ['04-settings.png', '05-settings-profile.png'],
    ['06-settings-voice.png', '06-settings-voice-video.png'],
    ['07b-settings-screen-share.png', '07-settings-screen-share.png'],
    ['07-settings-advanced.png', '08-settings-advanced-about.png'],
    ['02-workspace-1920x1080.png', '09-channel-participants.png'],
    ['02-workspace-1920x1080.png', '10-member-panel.png'],
    ['02-workspace-1920x1080.png', '11-chat-empty-state.png'],
    ['07c-context-menu.png', '12-context-menu.png'],
    ['04-settings.png', '13-modal-focus-visible.png'],
    ['09b-narrow-window-1024x700.png', '14-narrow-window.png'],
  ];
  const renameOk = renames.map(([from, to]) => renameTo(from, to)).every(Boolean);

  console.info('\n--- Final T13.5.1 screenshot files ---');
  const finalNames = renames.map(([, to]) => to);
  const allOk = finalNames.map(reportFile).every(Boolean) && renameOk;
  if (!allOk) {
    console.error('One or more screenshots are missing or implausibly small.');
    process.exitCode = 1;
    return;
  }
  console.info(`\nAll ${String(finalNames.length)} screenshots captured successfully.`);
}

main().catch((error) => {
  console.error(
    `T13.5.1 screenshot capture failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exitCode = 1;
});
