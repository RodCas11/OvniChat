// Automated two-Electron-instance voice verification for T3 (see
// docs/architecture/WEBRTC_VOICE.md). Starts a real realtime service, then launches two Electron
// instances that each join the same voice channel with Chromium's fake microphone device and
// auto-answer signaling. The test passes only when *each* instance reports both that its peer
// connection to the other reached `'connected'` and that it received genuinely non-silent audio
// from it — not merely that a track object exists. See `armE2EVoiceSmokeExit` in
// `apps/desktop/src/main/index.ts` and `probeRemoteAudioLevel` in
// `apps/desktop/src/renderer/voice/e2e-audio-probe.ts` for how each instance proves this.
//
// Deliberately launches the *unpackaged* app (the `electron` binary pointed at this directory,
// which resolves `.vite/build/main.cjs` via this package's "main" field) rather than a packaged
// `.exe`: `DISCO_VOADOR_E2E_FAKE_MEDIA`/`DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL` are only ever
// honored when `!app.isPackaged`, by design (see `main/index.ts`, `main/window.ts`) — a packaged
// build can never auto-join anything, on purpose, so it can never be the thing this script drives.
//
// Prerequisites: `pnpm --filter @disco-voador/realtime run build` and
// `pnpm --filter @disco-voador/desktop exec electron-forge package` must have already been run (the
// latter's prePackage hook produces `.vite/build/` even though this script never touches its final
// packaged output).

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopDir, '../..');
const mainEntry = path.join(desktopDir, '.vite', 'build', 'main.cjs');
const realtimeEntry = path.join(repoRoot, 'services', 'realtime', 'dist', 'index.js');

const REALTIME_START_TIMEOUT_MS = 15_000;
const INSTANCE_TIMEOUT_MS = 90_000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(mainEntry)) {
  fail(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first (this also produces .vite/build/).`,
  );
}
if (!existsSync(realtimeEntry)) {
  fail(
    `Built realtime service not found at ${realtimeEntry}.\nRun "pnpm --filter @disco-voador/realtime run build" first.`,
  );
}

/** Starts the realtime service on an ephemeral port and resolves once it reports it is listening. */
function startRealtimeService() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [realtimeEntry], {
      cwd: path.dirname(realtimeEntry),
      env: { ...process.env, REALTIME_HOST: '127.0.0.1', REALTIME_PORT: '0', LOG_LEVEL: 'error' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(
        new Error(
          `Realtime service did not report "listening" within ${REALTIME_START_TIMEOUT_MS}ms`,
        ),
      );
    }, REALTIME_START_TIMEOUT_MS);

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = /Realtime server listening on ([\d.]+):(\d+)/.exec(stdout);
      if (match && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ child, host: match[1], port: Number(match[2]) });
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[realtime] ${chunk.toString()}`));
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Realtime service exited early (code ${String(code)})`));
      }
    });
  });
}

/** Launches one unpackaged Electron instance configured to auto-join the smoke-test voice channel. */
function runVoiceInstance(label, realtimeUrl, displayName) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-'));

  return new Promise((resolve) => {
    const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
      cwd: desktopDir,
      env: {
        ...process.env,
        // Defensive: some shells/CI runners set this globally, which makes the `electron`
        // binary run as a plain Node process instead of launching the actual app — silently,
        // with no window, no IPC, nothing. This script needs the real app every time.
        ELECTRON_RUN_AS_NODE: '',
        DISCO_VOADOR_REALTIME_URL: realtimeUrl,
        DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
        DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
        DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: displayName,
        DISCO_VOADOR_E2E_VOICE_SMOKE: '1',
      },
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

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(`[${label}] ${text}`);
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk.toString()}`));

    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        label,
        ok: code === 0 && stdout.includes('E2E_VOICE_SMOKE_OK'),
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
  console.info('Starting realtime service...');
  const { child: realtimeChild, host, port } = await startRealtimeService();
  console.info(`Realtime service listening on ${host}:${String(port)}`);
  const realtimeUrl = `ws://${host}:${String(port)}`;

  try {
    console.info('Launching two Electron instances into the same voice channel...');
    const [a, b] = await Promise.all([
      runVoiceInstance('instance-a', realtimeUrl, 'Instance-A'),
      runVoiceInstance('instance-b', realtimeUrl, 'Instance-B'),
    ]);

    if (a.ok && b.ok) {
      console.info(
        'E2E voice smoke test passed: both instances reached a connected peer connection and received non-silent remote audio.',
      );
      process.exit(0);
    }

    console.error(
      `E2E voice smoke test failed. instance-a: ${a.ok ? 'ok' : a.reason}, instance-b: ${b.ok ? 'ok' : b.reason}`,
    );
    process.exit(1);
  } finally {
    realtimeChild.kill();
  }
}

main().catch((error) => {
  fail(`E2E voice smoke test crashed: ${error instanceof Error ? error.message : String(error)}`);
});
