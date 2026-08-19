// Automated two-Electron-instance screen-share verification for T5 (see
// docs/architecture/WEBRTC_SCREEN_SHARE.md and docs/tasks/T5_SCREEN_SHARE.md).
//
// Primary scenario (default): ONE PUBLISHER + ONE VIEWER.
//   - Instance A publishes: auto-joins, auto-enables camera, then auto-shares its screen (real
//     `desktopCapturer` capture of its own physical screen, through the exact same production
//     `listScreenShareSources`/`selectScreenShareSource` IPC a real user's picker uses), stops
//     sharing, then re-shares — proving a full share/stop/re-share lifecycle.
//   - Instance B is a pure viewer: auto-joins only, never captures anything of its own. It proves
//     it received and decoded A's camera AND screen-video (correctly distinguished from each
//     other), that A's screen stopping did not disconnect the peer or disrupt voice/camera (with
//     *fresh* post-stop evidence, not a reused earlier proof), and that A's re-share produced real
//     decoded frames again.
//
// This topology deliberately does NOT have both instances performing real screen capture at the
// same time. Earlier investigation (see the architecture doc) found that scenario intermittently
// starved frame/audio delivery under real-time contention — most plausibly two simultaneous
// Windows Desktop Duplication sessions of the same physical display — while camera/screen routing
// itself was always correct, on every run, passing or not. One publisher + one viewer tests the
// actual product requirement (a viewer decoding a publisher's screen) without needing two
// simultaneous local captures at all, and the product itself is not restricted to one sharer at a
// time — that capability is validated separately by rtc-core/protocol-level tests, not by this
// E2E's specific two-party scenario.
//
// Optional stress test: pass `--dual-capture` to run the *original* symmetric scenario instead —
// both instances capture their own screen (and camera) simultaneously. This does not gate T5
// completion; it exists to measure/compare contention behavior against the primary scenario. See
// `runDualCaptureStressTest` below.
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

// Publisher-only timing (primary scenario). Kept short: with only one instance performing real
// screen capture, decode is expected to be fast — these are starting values to be tuned from
// *measured* evidence (see the contention-matrix runs in the task record), not guessed inflation.
const AUTO_SCREEN_SHARE_OFF_AFTER_MS = 6_000;
const AUTO_SCREEN_SHARE_RESHARE_AFTER_MS = 4_000;

// Dual-capture stress test timing (optional, matches the original T5 values).
const DUAL_CAPTURE_AUTO_SCREEN_SHARE_OFF_AFTER_MS = 12_000;

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

/** Launches one unpackaged Electron instance with the given E2E env overrides, relays its stdout
 * with a `[label]` prefix, and resolves once it exits — `ok` requires exit code 0 AND the
 * `successMarker` string somewhere in its stdout (belt-and-suspenders: a clean exit alone doesn't
 * prove the renderer-side state machine actually reported success). */
function runInstance(label, realtimeUrl, envOverrides, successMarker) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-screen-'));

  return new Promise((resolve) => {
    const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
      cwd: desktopDir,
      env: buildElectronE2EEnvironment(process.env, {
        DISCO_VOADOR_REALTIME_URL: realtimeUrl,
        DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
        DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
        DISCO_VOADOR_E2E_SCREEN_SMOKE: '1',
        ...envOverrides,
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
        ok: code === 0 && stdout.includes(successMarker),
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

/** Primary scenario: instance A publishes camera + screen (share, stop, re-share); instance B is a
 * pure viewer with no local capture at all. See this file's header comment for the full rationale. */
async function runPublisherViewerScenario(realtimeUrl) {
  console.info(
    'Launching one publisher (camera + screen share/stop/re-share) and one pure viewer into the same voice channel...',
  );
  const [publisher, viewer] = await Promise.all([
    runInstance(
      'publisher',
      realtimeUrl,
      {
        DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Publisher',
        DISCO_VOADOR_E2E_VOICE_AUTO_CAMERA: '1',
        DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE: '1',
        DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_OFF_MS: String(AUTO_SCREEN_SHARE_OFF_AFTER_MS),
        DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_RESHARE_AFTER_MS: String(
          AUTO_SCREEN_SHARE_RESHARE_AFTER_MS,
        ),
      },
      'E2E_SCREEN_SMOKE_OK',
    ),
    runInstance(
      'viewer',
      realtimeUrl,
      { DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Viewer' },
      'E2E_SCREEN_SMOKE_OK',
    ),
  ]);

  if (publisher.ok && viewer.ok) {
    console.info(
      'E2E screen-share smoke test passed: the viewer received and decoded the publisher’s real camera AND screen-share video (correctly distinguished), proved fresh voice/camera continuity after the screen share ended, and decoded a re-share again.',
    );
    return true;
  }

  console.error(
    `E2E screen-share smoke test failed. publisher: ${publisher.ok ? 'ok' : publisher.reason}, viewer: ${viewer.ok ? 'ok' : viewer.reason}`,
  );
  return false;
}

/** Optional stress test (not gating): the original T5 scenario, both instances performing real
 * screen capture (and camera) simultaneously. Run with `--dual-capture` to compare contention
 * behavior against the primary scenario above — see the task record for measured results. */
async function runDualCaptureStressTest(realtimeUrl) {
  console.info(
    'Launching two Electron instances, BOTH capturing their own screen and camera simultaneously (stress test)...',
  );
  const envFor = (displayName) => ({
    DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: displayName,
    DISCO_VOADOR_E2E_VOICE_AUTO_CAMERA: '1',
    DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE: '1',
    DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_OFF_MS: String(
      DUAL_CAPTURE_AUTO_SCREEN_SHARE_OFF_AFTER_MS,
    ),
  });

  const [a, b] = await Promise.all([
    runInstance('instance-a', realtimeUrl, envFor('Instance-A'), 'E2E_SCREEN_SMOKE_OK'),
    runInstance('instance-b', realtimeUrl, envFor('Instance-B'), 'E2E_SCREEN_SMOKE_OK'),
  ]);

  if (a.ok && b.ok) {
    console.info('E2E dual-capture stress test passed: both instances captured and decoded.');
    return true;
  }

  console.error(
    `E2E dual-capture stress test failed. instance-a: ${a.ok ? 'ok' : a.reason}, instance-b: ${b.ok ? 'ok' : b.reason}`,
  );
  return false;
}

async function main() {
  const dualCapture = process.argv.includes('--dual-capture');

  console.info('Starting realtime service...');
  const { child: realtimeChild, host, port } = await startRealtimeService();
  console.info(`Realtime service listening on ${host}:${String(port)}`);
  const realtimeUrl = `ws://${host}:${String(port)}`;

  try {
    const passed = dualCapture
      ? await runDualCaptureStressTest(realtimeUrl)
      : await runPublisherViewerScenario(realtimeUrl);
    process.exit(passed ? 0 : 1);
  } finally {
    realtimeChild.kill();
  }
}

main().catch((error) => {
  fail(
    `E2E screen-share smoke test crashed: ${error instanceof Error ? error.message : String(error)}`,
  );
});
