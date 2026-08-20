// Automated two-Electron-instance screen-*audio* verification for T6 (see
// docs/architecture/WEBRTC_SCREEN_AUDIO.md and docs/tasks/T6_SCREEN_AUDIO.md).
//
// Topology mirrors T5 stabilization's proven screen-smoke pattern: ONE PUBLISHER + ONE VIEWER, not
// two simultaneous local capturers (see e2e-screen-smoke.mjs's header comment for why).
//
//   - Instance A (publisher) auto-joins, plays a deterministic 440Hz tone through its own real OS
//     audio output (see VoiceChannelView.tsx's oscillator effect — never an injected
//     MediaStreamTrack), then runs a scripted phase sequence: share screen (audio OFF) -> stop ->
//     share screen (audio ON) -> mute microphone -> unmute microphone -> stop -> re-share (audio
//     ON). This exercises real Windows system-audio-loopback capture
//     (`session.setDisplayMediaRequestHandler`'s `audio: 'loopback'`, see main/screen-share.ts)
//     through the exact same production IPC a real user's "Share audio" checkbox drives.
//   - Instance B (viewer) auto-joins only and never captures anything of its own. It proves:
//     screen-video decodes; screen-audio is genuinely absent during the audio-off cycle; screen-
//     audio decodes as real, non-silent, correctly-identified audio once requested (twice — the
//     initial audio-on cycle and the final re-share, guarding against stale mid/transceiver state);
//     screen-audio survives the publisher's microphone mute unaffected; stopping cleans up both
//     screen tracks without disconnecting the peer or breaking microphone continuity.
//
// Both instances auto-deafen immediately after voice connects (same-machine feedback avoidance —
// this machine's own remote-audio playback must never re-enter the publisher's system-audio
// loopback capture; deafen is local-playback-only, so every proof below still taps the real,
// live MediaStream regardless — see docs/architecture/WEBRTC_SCREEN_AUDIO.md).
//
// See apps/desktop/scripts/e2e-voice-smoke.mjs for the shared launch-mechanics rationale
// (unpackaged app only, ELECTRON_RUN_AS_NODE must be genuinely absent, isolated --user-data-dir per
// instance) — this script mirrors it rather than duplicating those comments.
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
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopDir, '.vite', 'build', 'main.cjs');

// The publisher's own scripted sequence is 7 phases, each with an internal wait — see
// VoiceChannelView.tsx's `screenAudioScenarioStarted` effect. This external timeout only needs to
// exceed that sequence's own total (starting budget, not yet independently measured against a live
// run) plus the exit-watcher's internal 120s ceiling with margin.
const INSTANCE_TIMEOUT_MS = 180_000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(mainEntry)) {
  fail(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first (this also produces .vite/build/).`,
  );
}

/** Launches one unpackaged Electron instance with the given E2E env overrides, relays its stdout
 * with a `[label]` prefix, and resolves once it exits — `ok` requires exit code 0 AND the
 * `successMarker` string somewhere in its stdout. */
function runInstance(label, realtimeUrl, envOverrides, successMarker) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-screen-audio-'));

  return new Promise((resolve) => {
    const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
      cwd: desktopDir,
      env: buildElectronE2EEnvironment(process.env, {
        DISCO_VOADOR_REALTIME_URL: realtimeUrl,
        DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
        DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
        DISCO_VOADOR_E2E_SCREEN_AUDIO_SMOKE: '1',
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

async function main() {
  console.info('Starting Dedicated Server...');
  const { child: realtimeChild, host, port } = await startDedicatedServer();
  console.info(`Dedicated Server listening on ${host}:${String(port)}`);
  const realtimeUrl = `ws://${host}:${String(port)}`;

  try {
    console.info(
      'Launching one publisher (real system-audio-loopback screen share, scripted phase sequence) and one pure viewer into the same voice channel...',
    );
    const [publisher, viewer] = await Promise.all([
      runInstance(
        'publisher',
        realtimeUrl,
        {
          DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Publisher',
          DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE: '1',
          DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_AUDIO: '1',
        },
        'E2E_SCREEN_AUDIO_SMOKE_OK',
      ),
      runInstance(
        'viewer',
        realtimeUrl,
        {
          DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Viewer',
          DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_AUDIO: '1',
        },
        'E2E_SCREEN_AUDIO_SMOKE_OK',
      ),
    ]);

    if (publisher.ok && viewer.ok) {
      console.info(
        'E2E screen-audio smoke test passed: the viewer received and decoded the publisher’s real screen-video and system-audio (correctly distinguished from microphone), proved audio absence when unrequested, proved microphone-mute independence, and decoded a re-share again.',
      );
      process.exit(0);
    }

    console.error(
      `E2E screen-audio smoke test failed. publisher: ${publisher.ok ? 'ok' : publisher.reason}, viewer: ${viewer.ok ? 'ok' : viewer.reason}`,
    );
    process.exit(1);
  } finally {
    realtimeChild.kill();
  }
}

main().catch((error) => {
  fail(
    `E2E screen-audio smoke test crashed: ${error instanceof Error ? error.message : String(error)}`,
  );
});
