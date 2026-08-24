// T13.4 QA-pass screenshot-capture tooling only — produces this task's own QA evidence set, mirroring
// `e2e-screenshot-capture.mjs` (T13.1)/`e2e-screenshot-capture-t13-2.mjs`'s own "two real Electron
// instances against a real Dedicated Server, drive real UI via Main-side hooks, capturePage()"
// technique. Never a permanent regression test; not part of `pnpm check`.
//
// Presenter instance: switches Voice Activity -> Push to Talk, demonstrates a real conflict (Q,
// pre-registered via globalShortcut) and a real registered binding (F9, delivered via a genuine
// `webContents.sendInputEvent` keyboard event), then holds a simulated global-PTT 'down' edge long
// enough for the bottom bar and the paired viewer instance to both observe it.
// Viewer instance: best-effort observes the presenter's speaking ring, then opens the presenter's
// real per-participant "User Volume" modal.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';

import { buildElectronE2EEnvironment } from './lib/electron-e2e-env.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopDir, '.vite', 'build', 'main.cjs');
const repoRoot = path.resolve(desktopDir, '..', '..');
const captureDir = path.join(repoRoot, 'docs', 'tasks', 'screenshots', 't13-4');

const INSTANCE_TIMEOUT_MS = 90_000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(mainEntry)) {
  fail(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first.`,
  );
}

mkdirSync(captureDir, { recursive: true });

function runInstance(label, env, successMarkers) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-t134-shot-'));

  return new Promise((resolve) => {
    const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
      cwd: desktopDir,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ label, ok: false, stdout, reason: 'timeout' });
    }, INSTANCE_TIMEOUT_MS);

    const checkDone = () => {
      if (settled) return;
      if (successMarkers.every((marker) => stdout.includes(marker))) {
        settled = true;
        clearTimeout(timer);
        child.kill();
        resolve({ label, ok: true, stdout, reason: 'ok' });
      }
    };

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(`[${label}] ${text}`);
      checkDone();
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk.toString()}`));

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        label,
        ok: successMarkers.every((marker) => stdout.includes(marker)),
        stdout,
        reason: `exit ${String(code)}`,
      });
    });
  }).finally(() => {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  });
}

async function main() {
  console.info('Starting Dedicated Server...');
  const { child: realtimeChild, host, port } = await startDedicatedServer();
  console.info(`Dedicated Server listening on ${host}:${String(port)}`);
  const realtimeUrl = `ws://${host}:${String(port)}`;

  try {
    const presenterEnv = buildElectronE2EEnvironment(process.env, {
      DISCO_VOADOR_REALTIME_URL: realtimeUrl,
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'T13.4-Presenter',
      DISCO_VOADOR_E2E_T134_SCREENSHOT_DIR: captureDir,
    });

    const viewerEnv = buildElectronE2EEnvironment(process.env, {
      DISCO_VOADOR_REALTIME_URL: realtimeUrl,
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'T13.4-Viewer',
      DISCO_VOADOR_E2E_T134_VIEWER_SCREENSHOT_DIR: captureDir,
    });

    console.info('Launching presenter and viewer instances...');
    const [presenter, viewer] = await Promise.all([
      runInstance('presenter', presenterEnv, ['E2E_T134_SCREENSHOT_CAPTURE_DONE']),
      runInstance('viewer', viewerEnv, ['E2E_T134_VIEWER_SCREENSHOT_CAPTURE_DONE']),
    ]);

    if (presenter.ok && viewer.ok) {
      console.info(`T13.4 screenshot capture complete. Saved to: ${captureDir}`);
      process.exit(0);
    }

    console.error(
      `T13.4 screenshot capture failed. presenter: ${presenter.ok ? 'ok' : presenter.reason}, viewer: ${
        viewer.ok ? 'ok' : viewer.reason
      }`,
    );
    process.exit(1);
  } finally {
    realtimeChild.kill();
  }
}

main().catch((error) => {
  fail(
    `T13.4 screenshot capture crashed: ${error instanceof Error ? error.message : String(error)}`,
  );
});
