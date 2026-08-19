// Automated two-Electron-instance camera verification for T4 (see
// docs/architecture/WEBRTC_CAMERA.md). Builds on `e2e-voice-smoke.mjs`'s pattern: starts a real
// realtime service, launches two unpackaged Electron instances that join the same voice channel
// with Chromium's fake microphone AND fake camera device (the same
// `--use-fake-device-for-media-stream` switch provides both), and requires each instance to prove:
//
//   - a real, non-silent decoded remote audio track (voice — same bar as `e2e-voice-smoke.mjs`);
//   - real, non-silent decoded remote video frames (`E2E_REMOTE_VIDEO_OK`, videoWidth/videoHeight
//     both positive, sampled from an offscreen <video> element attached to the actual remote
//     MediaStream — not merely that `ontrack` fired);
//   - that disabling the remote camera (each instance auto-disables its own camera a few seconds
//     after enabling it) does NOT disconnect the peer or break audio — proven by
//     `E2E_REMOTE_VIDEO_ENDED:<id>:peerState=connected` (any other peerState fails the test).
//
// See `apps/desktop/scripts/e2e-voice-smoke.mjs` for the shared launch-mechanics rationale
// (unpackaged app only, `ELECTRON_RUN_AS_NODE` must be genuinely absent, isolated `--user-data-dir`
// per instance) — this script mirrors it rather than duplicating those comments.
//
// Prerequisites: `pnpm --filter @disco-voador/realtime run build` and
// `pnpm --filter @disco-voador/desktop exec electron-forge package` must have already been run.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';

import { buildElectronE2EEnvironment } from './lib/electron-e2e-env.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopDir, '../..');
const mainEntry = path.join(desktopDir, '.vite', 'build', 'main.cjs');
const realtimeEntry = path.join(repoRoot, 'services', 'realtime', 'dist', 'index.js');

const REALTIME_START_TIMEOUT_MS = 15_000;
const INSTANCE_TIMEOUT_MS = 120_000;
// Was 5s. Live-measured regression from T5 stabilization's delta-based video probe (see
// `e2e-video-probe.ts`): that probe now requires observing 2 *additional* decoded frames after
// `ontrack`, not just one, so it needs negotiation time (peer connect + SDP renegotiation to add
// the video track) plus a small decode window before the camera is allowed to turn off again. At
// 5s, a run was observed where the remote track's `E2E_REMOTE_VIDEO_ENDED` fired before the probe
// ever reached 2 frames of delta, so it timed out `SILENT` instead of `OK` even though the camera
// and peer connection both worked correctly — an artifact of the deadline, not a real regression.
// Raised with headroom to give negotiation + delta-proof room to complete before the deliberate
// camera-off.
const AUTO_CAMERA_OFF_AFTER_MS = 10_000;

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

/** Launches one unpackaged Electron instance that auto-joins voice, auto-enables its camera, and
 * auto-disables it again after `AUTO_CAMERA_OFF_AFTER_MS` — both instances do this, so each side
 * independently proves both camera-on (real remote video) and camera-off (peer stays connected). */
function runCameraInstance(label, realtimeUrl, displayName) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-camera-'));

  return new Promise((resolve) => {
    const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
      cwd: desktopDir,
      env: buildElectronE2EEnvironment(process.env, {
        DISCO_VOADOR_REALTIME_URL: realtimeUrl,
        DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
        DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
        DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: displayName,
        DISCO_VOADOR_E2E_VOICE_AUTO_CAMERA: '1',
        DISCO_VOADOR_E2E_VOICE_AUTO_CAMERA_OFF_MS: String(AUTO_CAMERA_OFF_AFTER_MS),
        DISCO_VOADOR_E2E_CAMERA_SMOKE: '1',
      }),
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
        ok: code === 0 && stdout.includes('E2E_CAMERA_SMOKE_OK'),
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
    console.info('Launching two Electron instances with cameras into the same voice channel...');
    const [a, b] = await Promise.all([
      runCameraInstance('instance-a', realtimeUrl, 'Instance-A'),
      runCameraInstance('instance-b', realtimeUrl, 'Instance-B'),
    ]);

    if (a.ok && b.ok) {
      console.info(
        'E2E camera smoke test passed: both instances received real decoded remote video, and disabling the camera did not disconnect the peer or break audio.',
      );
      process.exit(0);
    }

    console.error(
      `E2E camera smoke test failed. instance-a: ${a.ok ? 'ok' : a.reason}, instance-b: ${b.ok ? 'ok' : b.reason}`,
    );
    process.exit(1);
  } finally {
    realtimeChild.kill();
  }
}

main().catch((error) => {
  fail(`E2E camera smoke test crashed: ${error instanceof Error ? error.message : String(error)}`);
});
