// Automated two-Electron-instance voice verification for T3 (see
// docs/architecture/WEBRTC_VOICE.md). Starts a real Disco Voador Dedicated Server (T8's actual
// product entrypoint, not an internal realtime-only path — see
// `apps/desktop/scripts/lib/start-dedicated-server.mjs`), then launches two Electron instances
// that each join the same voice channel with Chromium's fake microphone device and auto-answer
// signaling. The test passes only when *each* instance reports both that its peer connection to
// the other reached `'connected'` and that it received genuinely non-silent audio from it — not
// merely that a track object exists. See `armE2EVoiceSmokeExit` in `apps/desktop/src/main/index.ts`
// and `probeRemoteAudioLevel` in `apps/desktop/src/renderer/voice/e2e-audio-probe.ts` for how each
// instance proves this.
//
// Deliberately launches the *unpackaged* app (the `electron` binary pointed at this directory,
// which resolves `.vite/build/main.cjs` via this package's "main" field) rather than a packaged
// `.exe`: `DISCO_VOADOR_E2E_FAKE_MEDIA`/`DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL` are only ever
// honored when `!app.isPackaged`, by design (see `main/index.ts`, `main/window.ts`) — a packaged
// build can never auto-join anything, on purpose, so it can never be the thing this script drives.
//
// Prerequisites: `pnpm --filter @disco-voador/dedicated-server run build` and
// `pnpm --filter @disco-voador/desktop exec electron-forge package` must have already been run (the
// latter's prePackage hook produces `.vite/build/` even though this script never touches its final
// packaged output).

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';

import { buildElectronE2EEnvironment } from './lib/electron-e2e-env.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopDir, '.vite', 'build', 'main.cjs');

const INSTANCE_TIMEOUT_MS = 90_000;

// T13.4 — real bug found via QA of this exact script: T13.4 made 'voice-activity' the default input
// mode, which gates transmission on Chromium's fake-microphone signal actually clearing the default
// energy threshold after real echoCancellation/noiseSuppression/autoGainControl processing — measured
// (by an independent QA pass) at ~0.016 for the plain fake-device generator, roughly 10x below the
// default threshold, so the mic never transmitted at all and this test regressed to permanent
// silence. This script's own purpose predates T13.4 entirely and has nothing to do with Voice-Activity
// threshold calibration — it exists to prove the P2P audio *delivery* pipeline works, using Chromium's
// fake device as a stand-in for "any audio at all." Decoupled from VAD calibration (a separate, real,
// but different concern — see `voice-activity-detector.ts`'s own doc comment) by forcing Push-to-Talk
// mode; `main/index.ts`'s `armE2EPttHoldOnJoin` then reacts to this instance's own
// `E2E_LOCAL_PUSH_TO_TALK_MODE` marker and simulates a held key — marker-driven rather than a fixed
// delay-since-launch pair, after a first attempt at the latter raced against this script's own
// audio-level probe (which starts sampling immediately on peer-connect, with no relationship to any
// fixed PTT timing) and lost; see that function's own doc comment for the full account.

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(mainEntry)) {
  fail(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first (this also produces .vite/build/).`,
  );
}

/** Launches one unpackaged Electron instance configured to auto-join the smoke-test voice channel. */
function runVoiceInstance(label, realtimeUrl, displayName) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-'));

  return new Promise((resolve) => {
    const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
      cwd: desktopDir,
      env: buildElectronE2EEnvironment(process.env, {
        DISCO_VOADOR_REALTIME_URL: realtimeUrl,
        DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
        DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
        DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: displayName,
        DISCO_VOADOR_E2E_VOICE_SMOKE: '1',
        // See this file's own top-of-file T13.4 comment: decouples this test from Voice-Activity
        // threshold calibration. `main/index.ts`'s `armE2EPttHoldOnJoin` (gated on
        // `DISCO_VOADOR_E2E_VOICE_SMOKE` above) reacts to the resulting join marker itself — no
        // additional timing env vars needed here.
        DISCO_VOADOR_E2E_VOICE_AUTO_PUSH_TO_TALK: '1',
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
  console.info('Starting Dedicated Server...');
  const { child: realtimeChild, host, port } = await startDedicatedServer();
  console.info(`Dedicated Server listening on ${host}:${String(port)}`);
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
