// T13.1 Definition-of-Done screenshot evidence tool — NOT a permanent regression test, and not
// wired to any `e2e:*` npm script. Produces real PNG screenshots of the redesigned Home/workspace
// UI for a human to personally review, exactly per docs/DEFINITION_OF_DONE.md's requirement for
// real screenshots from an actual running Electron instance (never a fabricated mockup).
//
// Reuses this repo's existing E2E conventions exactly (see `e2e-product-shell-smoke.mjs`/
// `e2e-voice-smoke.mjs`): `DISCO_VOADOR_E2E_*` env-var config injection into a real, unpackaged
// Electron instance, real Dedicated Servers (`services/dedicated-server`'s actual built CLI, never
// an internal-only realtime path), and `console.info` marker-driven automation/assertions — no
// DOM-scraping/Playwright dependency. The only genuinely new pieces (both additive, both gated
// `!app.isPackaged` like every other E2E affordance in this codebase — see
// `apps/desktop/src/main/index.ts`'s `armE2EScreenshotHomeCapture`/`armE2EScreenshotWorkspaceCapture`
// and `shared/ipc-contract.ts`'s `DesktopE2EScreenshotConfig`) are:
//   1. A small `DesktopE2EScreenshotConfig` IPC/config path that seeds two real bookmarks via the
//      real `addBookmark` IPC and then deliberately never auto-connects, so `ServerHome` stays
//      rendered indefinitely for a Home-screen capture.
//   2. Main-process `webContents.capturePage()` calls, triggered off real console markers (the
//      existing `disco-voador:voice-joined:<channelId>` join marker plus this task's own
//      `E2E_SCREENSHOT_HOME_READY` marker), driving three already-existing UI buttons (Settings
//      open/close, Member-panel collapse) via `webContents.executeJavaScript` — the exact same
//      buttons/testids a human would click, clicked by script instead of a mouse, purely so the
//      right screenshot lands at the right moment.
//
// Two short-lived Electron instances are launched sequentially:
//   Instance 1 (Home): fresh profile, real nickname submission, two real bookmarks added via the
//     real `addBookmark` IPC, pointing at two real (throwaway) Dedicated Servers — captures
//     `01-server-home.png`.
//   Instance 2 (Workspace): fresh profile, connects to a third real Dedicated Server, real T7
//     identity handshake, real join to the "general" voice channel (fake mic/camera device only —
//     Chromium's own fake-media-device switch, never fabricated application data), alongside a
//     second real Electron instance auto-joining the same channel as a genuine second participant
//     — captures `02-workspace-1920x1080.png`, `03-workspace-1366x768.png`, `04-settings.png`, and
//     `05-member-panel-collapsed.png`.
//
// Prerequisites: `pnpm --filter @disco-voador/dedicated-server run build` and
// `pnpm --filter @disco-voador/desktop exec electron-forge package` must have already been run.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';

import { buildElectronE2EEnvironment } from './lib/electron-e2e-env.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopDir, '.vite', 'build', 'main.cjs');
const OUTPUT_DIR =
  process.argv[2] ??
  'C:\\Users\\mutre\\AppData\\Local\\Temp\\claude\\e--Codigos-projeto-disco-voador\\8a73a95b-6ed7-47d7-9ff6-b6fd2dc4ff54\\scratchpad\\t13-1-screenshots';
const INSTANCE_TIMEOUT_MS = 60_000;
const CHANNEL_ID = 'general';

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(mainEntry)) {
  fail(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first.`,
  );
}

mkdirSync(OUTPUT_DIR, { recursive: true });

function spawnCaptureInstance(label, extraEnv) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), `disco-voador-e2e-screenshot-${label}-`));
  const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
    cwd: desktopDir,
    env: buildElectronE2EEnvironment(process.env, {
      DISCO_VOADOR_E2E_SCREENSHOT_CAPTURE_DIR: OUTPUT_DIR,
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
      if (waiters[i].check(stdout)) {
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
        check: (s) => s.includes(pattern),
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  function waitForExit(timeoutMs = INSTANCE_TIMEOUT_MS) {
    if (child.exitCode !== null) return Promise.resolve(child.exitCode);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve(code);
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

  return { waitFor, waitForExit, stop };
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
  console.info('--- Capturing 01-server-home.png ---');
  console.info("Starting two real Dedicated Servers for the Home screen's two bookmarks...");
  const serverA = await startDedicatedServer();
  const serverB = await startDedicatedServer();
  console.info(`Server A: ${serverA.host}:${String(serverA.port)}`);
  console.info(`Server B: ${serverB.host}:${String(serverB.port)}`);

  const instance = spawnCaptureInstance('home', {
    DISCO_VOADOR_E2E_SCREENSHOT_DISPLAY_NAME: 'ScreenshotTester',
    DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_A_NAME: 'Home Server',
    DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_A_ADDRESS: `${serverA.host}:${String(serverA.port)}`,
    DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_B_NAME: 'Guild Server',
    DISCO_VOADOR_E2E_SCREENSHOT_BOOKMARK_B_ADDRESS: `${serverB.host}:${String(serverB.port)}`,
  });

  try {
    await instance.waitFor('E2E_SCREENSHOT_SAVED:01-server-home.png');
    console.info('01-server-home.png saved.');
    await instance.waitForExit(10_000);
  } finally {
    await instance.stop();
    await stopServer(serverA);
    await stopServer(serverB);
  }
}

/** Second, plain (non-capturing) Electron instance that auto-joins the same voice channel as a
 * genuine second participant — mirrors `e2e-voice-smoke.mjs`'s two-instance topology exactly, so
 * the captured Members panel shows a real second person rather than only the screenshot subject. */
function spawnBackgroundParticipant(realtimeUrl) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-screenshot-peer-'));
  const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
    cwd: desktopDir,
    env: buildElectronE2EEnvironment(process.env, {
      DISCO_VOADOR_REALTIME_URL: realtimeUrl,
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'BackgroundParticipant',
      // Real second-sender message (via the existing T10 auto-chat-send E2E hook, not a fixture)
      // so the 09-chat-messages-general.png capture shows genuine multi-sender grouping.
      DISCO_VOADOR_E2E_CHAT_SEND_CHANNEL: 'bora',
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
  console.info(
    '--- Capturing 02-workspace-1920x1080.png, 03-workspace-1366x768.png, 04-settings.png, ' +
      '05-member-panel-collapsed.png ---',
  );
  console.info('Starting a real Dedicated Server for the connected workspace...');
  const server = await startDedicatedServer();
  const realtimeUrl = `ws://${server.host}:${String(server.port)}`;
  console.info(`Server: ${server.host}:${String(server.port)}`);

  const peer = spawnBackgroundParticipant(realtimeUrl);

  const instance = spawnCaptureInstance('workspace', {
    DISCO_VOADOR_REALTIME_URL: realtimeUrl,
    DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
    DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
    DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'ScreenshotSubject',
    DISCO_VOADOR_E2E_CONNECT_URL: realtimeUrl,
  });

  try {
    await instance.waitFor('E2E_SCREENSHOT_SAVED:02-workspace-1920x1080.png');
    console.info('02-workspace-1920x1080.png saved.');
    await instance.waitFor('E2E_SCREENSHOT_SAVED:03-workspace-1366x768.png');
    console.info('03-workspace-1366x768.png saved.');
    await instance.waitFor('E2E_SCREENSHOT_SAVED:03b-workspace-1600x900.png');
    console.info('03b-workspace-1600x900.png saved.');
    await instance.waitFor('E2E_SCREENSHOT_SAVED:04-settings.png');
    console.info('04-settings.png saved.');
    await instance.waitFor('E2E_SCREENSHOT_SAVED:05-member-panel-collapsed.png');
    console.info('05-member-panel-collapsed.png saved.');
    await instance.waitFor('E2E_SCREENSHOT_SAVED:06-settings-voice.png');
    console.info('06-settings-voice.png saved.');
    await instance.waitFor('E2E_SCREENSHOT_SAVED:07-settings-advanced.png');
    console.info('07-settings-advanced.png saved.');
    await instance.waitFor('E2E_SCREENSHOT_SAVED:08-add-server-dialog.png');
    console.info('08-add-server-dialog.png saved.');
    await instance.waitFor('E2E_SCREENSHOT_SAVED:09-chat-messages-general.png');
    console.info('09-chat-messages-general.png saved.');
    await instance.waitFor('E2E_SCREENSHOT_CAPTURE_DONE');
    await instance.waitForExit(10_000);
  } finally {
    await instance.stop();
    await peer.stop();
    await stopServer(server);
  }
}

function reportFile(name) {
  const filePath = path.join(OUTPUT_DIR, name);
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

  console.info('\n--- Screenshot files ---');
  const names = [
    '01-server-home.png',
    '02-workspace-1920x1080.png',
    '03-workspace-1366x768.png',
    '03b-workspace-1600x900.png',
    '04-settings.png',
    '05-member-panel-collapsed.png',
    '06-settings-voice.png',
    '07-settings-advanced.png',
    '08-add-server-dialog.png',
    '09-chat-messages-general.png',
  ];
  const allOk = names.map(reportFile).every(Boolean);
  if (!allOk) {
    fail('One or more screenshots are missing or implausibly small.');
  }
  console.info(`\nAll ${String(names.length)} screenshots captured successfully.`);
  process.exit(0);
}

main().catch((error) => {
  fail(`Screenshot capture crashed: ${error instanceof Error ? error.stack : String(error)}`);
});
