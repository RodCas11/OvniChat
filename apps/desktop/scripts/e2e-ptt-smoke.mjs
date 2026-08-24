// T13.4 — automated two-Electron-instance global Push-to-Talk verification. Mirrors
// `e2e-voice-smoke.mjs`'s overall shape (real Dedicated Server, two unpackaged Electron instances,
// Chromium fake media devices) but adds two T13.4-specific mechanisms, both explicitly IPC/config
// driven — never real physical/OS-level key injection, matching this task's own brief:
//
//   1. `armE2EPttSimulation` (`main/index.ts`) pushes simulated `pttState` `'down'`/`'up'` edges on
//      the same IPC channel Main's real `uiohook-napi` listener uses, at fixed delays after launch —
//      indistinguishable from a real edge from the Renderer's point of view, and never touches
//      `main/ptt-hotkey.ts`'s own listener lifecycle at all.
//   2. `--use-file-for-fake-audio-capture=<wav>` backs the publisher's fake microphone with a real,
//      continuous, non-silent tone (see `lib/generate-tone-wav.mjs`) — the plain
//      `--use-fake-device-for-media-stream` generator alone was directly verified (via a temporary
//      diagnostic added and removed during this task) to produce literal 0.0000 RMS energy in at
//      least one real sandboxed environment this task ran in, even with the local mic track forced
//      `enabled = true` from the very start (bypassing every T13.4 gating mechanism) — a pre-existing
//      environment characteristic unrelated to anything this task changed, but one that would
//      otherwise make this scenario indistinguishable from a real PTT-wiring bug.
//
// Verifies, from the *viewer's* own remote-side audio-level analysis (never a local state flag):
//   - Before PTT is held: the publisher's mic is genuinely silent on the wire (`E2E_PTT_PRE_HOLD_SILENT`).
//   - While PTT is held: real, non-silent audio is actually transmitted (`E2E_PTT_DURING_HOLD_OK`).
//   - After PTT is released: the publisher's mic returns to genuine silence
//     (`E2E_PTT_POST_RELEASE_SILENT`) — proving release actually stops transmission, not just that
//     holding started it.
//
// Prerequisites: `pnpm --filter @disco-voador/dedicated-server run build` and
// `pnpm --filter @disco-voador/desktop exec electron-forge package` must have already been run.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';

import { buildElectronE2EEnvironment } from './lib/electron-e2e-env.mjs';
import { writeToneWavFile } from './lib/generate-tone-wav.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopDir, '.vite', 'build', 'main.cjs');

const INSTANCE_TIMEOUT_MS = 120_000;

// Publisher-side scripted PTT edge timings (see `armE2EPttSimulation`), measured from launch. A
// generously long hold window (30s) gives the during-hold probe a wide, timing-jitter-tolerant
// target to land inside.
const PTT_DOWN_AFTER_MS = 20_000;
const PTT_UP_AFTER_MS = 50_000;

// Viewer-side probe timings, measured from when the publisher's mic-audio stream first appears to
// the viewer (typically a few seconds after launch — see `probeRemoteAudioLevel`'s own call site).
// Chosen with generous margin on both sides of the publisher's absolute-since-launch PTT timings
// above so timing jitter in peer-connection setup cannot make a phase probe start on the wrong side
// of the real edge.
const PRE_HOLD_PROBE_DELAY_MS = 0; // starts immediately; a short window, safely done well before 20s.
const DURING_HOLD_PROBE_DELAY_MS = 30_000; // lands comfortably inside [20s, 50s].
const POST_RELEASE_PROBE_DELAY_MS = 55_000; // lands comfortably after 50s.

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(mainEntry)) {
  fail(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first.`,
  );
}

function runInstance(label, env, successMarkers) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-ptt-'));

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

  const toneWavPath = path.join(
    mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-ptt-tone-')),
    'tone.wav',
  );
  writeToneWavFile(toneWavPath, 200);
  console.info(`Generated fake-microphone tone WAV at ${toneWavPath}`);

  try {
    console.info('Launching publisher (Push to Talk, scripted down/up) and viewer instances...');

    const publisherEnv = buildElectronE2EEnvironment(process.env, {
      DISCO_VOADOR_REALTIME_URL: realtimeUrl,
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      DISCO_VOADOR_E2E_FAKE_AUDIO_FILE: toneWavPath,
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'PTT-Publisher',
      DISCO_VOADOR_E2E_VOICE_AUTO_PUSH_TO_TALK: '1',
      DISCO_VOADOR_E2E_PTT_DOWN_AFTER_MS: String(PTT_DOWN_AFTER_MS),
      DISCO_VOADOR_E2E_PTT_UP_AFTER_MS: String(PTT_UP_AFTER_MS),
      // Arms `main/index.ts`'s console-message-to-stdout relay — without this, the orchestrating
      // script (this file) can observe the Main-process-only markers (`E2E_PTT_SIMULATED_*`) but
      // never the Renderer's own console output at all (see `armE2EPttSmokeRelay`'s own doc comment
      // for the real, once-genuinely-mysterious "zero renderer output for the full timeout, no
      // crash, no error" symptom this fixed during this task).
      DISCO_VOADOR_E2E_PTT_SMOKE: '1',
    });

    const viewerEnv = buildElectronE2EEnvironment(process.env, {
      DISCO_VOADOR_REALTIME_URL: realtimeUrl,
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'PTT-Viewer',
      DISCO_VOADOR_E2E_PTT_PRE_HOLD_PROBE_DELAY_MS: String(PRE_HOLD_PROBE_DELAY_MS),
      DISCO_VOADOR_E2E_PTT_DURING_HOLD_PROBE_DELAY_MS: String(DURING_HOLD_PROBE_DELAY_MS),
      DISCO_VOADOR_E2E_PTT_POST_RELEASE_PROBE_DELAY_MS: String(POST_RELEASE_PROBE_DELAY_MS),
      DISCO_VOADOR_E2E_PTT_SMOKE: '1',
    });

    const [publisher, viewer] = await Promise.all([
      runInstance('publisher', publisherEnv, [
        'E2E_PEER_CONNECTED:',
        'E2E_PTT_SIMULATED_DOWN',
        'E2E_PTT_SIMULATED_UP',
      ]),
      runInstance('viewer', viewerEnv, [
        'E2E_PTT_PRE_HOLD_SILENT:',
        'E2E_PTT_DURING_HOLD_OK:',
        'E2E_PTT_POST_RELEASE_SILENT:',
      ]),
    ]);

    if (publisher.ok && viewer.ok) {
      console.info(
        'E2E PTT smoke test passed: the publisher genuinely did not transmit before PTT was held, ' +
          'transmitted real non-silent audio while held, and stopped again on release — all observed ' +
          "from the viewer's own remote-side audio analysis, never a local state flag.",
      );
      process.exit(0);
    }

    console.error(
      `E2E PTT smoke test failed. publisher: ${publisher.ok ? 'ok' : publisher.reason}, viewer: ${
        viewer.ok ? 'ok' : viewer.reason
      }`,
    );
    process.exit(1);
  } finally {
    realtimeChild.kill();
    try {
      rmSync(path.dirname(toneWavPath), { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
}

main().catch((error) => {
  fail(`E2E PTT smoke test crashed: ${error instanceof Error ? error.message : String(error)}`);
});
