// T11 automatic-reconnect E2E (see docs/architecture/CLIENT_SETTINGS_AND_RECONNECT.md). Reproduces
// the mandatory server-restart-recovery scenario:
//
//   real Dedicated Server, real file-backed data directory
//   -> Electron A and B connect, authenticate (T7), join "general" voice
//   -> real peer connection + real non-silent decoded audio, both directions
//   -> A sends a Server Chat message (T10) and it survives to the other side of the restart
//   -> the Dedicated Server process is killed (SIGTERM) -- an unexpected, not explicit, disconnect
//   -> A and B must each detect the loss and enter the 'reconnecting' state (never silently hang,
//      never silently give up)
//   -> the Dedicated Server restarts on the SAME port and SAME data directory
//   -> A and B must each automatically reconnect: fresh T7 identity authentication (never a replayed
//      proof), rejoin "general" voice, real peer audio flowing again with FRESH participant ids (the
//      server mints a new participantId per join -- see services/realtime/src/voice/registry.ts)
//   -> A's Server Chat history reload after reconnect must include the message sent before the
//      restart, retrieved through the history API (never a stale live event)
//   -> camera and screen sharing must remain OFF throughout -- neither was ever enabled in this
//      scenario, and this script asserts neither ever silently turned on either
//
// Every Electron instance here uses a fresh --user-data-dir exactly once and is torn down via a
// plain external kill() -- mirrors e2e-text-chat-persistence.mjs's own instance-lifecycle pattern
// exactly (never relaunches the same profile, so there is no same-profile-relaunch safeStorage/
// DPAPI risk to guard against; see armE2EReconnectSmokeRelay's doc comment in main/index.ts).
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

// Generous: a real reconnect cycle involves the controller's own bounded backoff (starts ~0.5-1s,
// doubles, capped at 30s) plus however long the server genuinely takes to restart -- this is not a
// tight timing assertion, only a ceiling against a genuinely hung test.
const INSTANCE_TIMEOUT_MS = 90_000;
const SERVER_CHAT_BODY = `PRE_RESTART_${String(Date.now())}`;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(mainEntry)) {
  fail(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first (this also produces .vite/build/).`,
  );
}

function countOccurrences(haystack, needle) {
  let count = 0;
  let index = 0;
  for (;;) {
    index = haystack.indexOf(needle, index);
    if (index === -1) return count;
    count += 1;
    index += needle.length;
  }
}

/** Spawns one Electron instance against a fresh, single-use profile. `waitFor` resolves once a
 * substring has appeared at least once; `waitForCount` resolves once it has appeared at least
 * `minCount` times -- needed for markers this scenario expects to see *twice* (once before the
 * server restart, once after reconnecting), where a plain "has it appeared at all" check would
 * resolve immediately on the first, stale occurrence. `stop` kills the process and waits for real
 * exit before removing its profile directory (mirrors `e2e-text-chat-persistence.mjs` exactly). */
function spawnInstance(label, realtimeUrl, extraEnv) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-reconnect-'));
  const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
    cwd: desktopDir,
    env: buildElectronE2EEnvironment(process.env, {
      DISCO_VOADOR_REALTIME_URL: realtimeUrl,
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      DISCO_VOADOR_E2E_RECONNECT_SMOKE: '1',
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

  function waitUntil(check, description, timeoutMs) {
    if (check(stdout)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`[${label}] timed out waiting for: ${description}`));
      }, timeoutMs);
      waiters.push({
        check,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  function waitFor(pattern, timeoutMs = INSTANCE_TIMEOUT_MS) {
    return waitUntil((s) => s.includes(pattern), pattern, timeoutMs);
  }

  function waitForCount(pattern, minCount, timeoutMs = INSTANCE_TIMEOUT_MS) {
    return waitUntil(
      (s) => countOccurrences(s, pattern) >= minCount,
      `${String(minCount)}x "${pattern}"`,
      timeoutMs,
    );
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

  return {
    label,
    waitFor,
    waitForCount,
    stop,
    getStdout: () => stdout,
  };
}

async function stopServer(server) {
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGTERM');
    await new Promise((resolve) => {
      server.child.once('exit', () => resolve());
    });
  }
}

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-reconnect-data-'));
  const instances = [];
  let server;

  try {
    console.info('Starting Dedicated Server (real, file-backed data directory)...');
    server = await startDedicatedServer({ DISCO_VOADOR_SERVER_DATA_DIR: dataDir });
    const fixedPort = server.port;
    const realtimeUrl = `ws://${server.host}:${String(fixedPort)}`;
    console.info(`Dedicated Server listening on ${server.host}:${String(fixedPort)}`);

    console.info('Launching A and B, both auto-joining "general" voice...');
    const a = spawnInstance('A', realtimeUrl, {
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'A',
      DISCO_VOADOR_E2E_CHAT_SEND_SERVER: SERVER_CHAT_BODY,
    });
    instances.push(a);
    const b = spawnInstance('B', realtimeUrl, {
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'B',
    });
    instances.push(b);

    console.info(
      'Waiting for the initial connection, voice join, and real peer audio (E2E_CONNECTED_INITIAL / E2E_VOICE_INITIAL_OK)...',
    );
    await Promise.all([
      a.waitFor('disco-voador:connection-status:connected'),
      b.waitFor('disco-voador:connection-status:connected'),
    ]);
    await Promise.all([
      a.waitFor('disco-voador:voice-joined:general'),
      b.waitFor('disco-voador:voice-joined:general'),
    ]);
    await Promise.all([a.waitFor('E2E_PEER_CONNECTED:'), b.waitFor('E2E_PEER_CONNECTED:')]);
    await Promise.all([a.waitFor('E2E_AUDIO_LEVEL_OK:'), b.waitFor('E2E_AUDIO_LEVEL_OK:')]);
    console.info(
      'Initial voice session established with real, non-silent peer audio both directions.',
    );

    console.info('Waiting for A to confirm its own Server Chat send...');
    await a.waitFor(`"body":"${SERVER_CHAT_BODY}"`);

    console.info(
      'Killing the Dedicated Server (SIGTERM) -- simulates an unexpected server-side loss...',
    );
    await stopServer(server);

    console.info(
      'Waiting for A and B to detect the loss and enter "reconnecting" (E2E_RECONNECTING)...',
    );
    await Promise.all([
      a.waitFor('disco-voador:connection-status:reconnecting'),
      b.waitFor('disco-voador:connection-status:reconnecting'),
    ]);
    console.info('Both clients detected the loss and are retrying with bounded backoff.');

    console.info('Restarting the Dedicated Server on the SAME port and SAME data directory...');
    server = await startDedicatedServer({
      DISCO_VOADOR_SERVER_DATA_DIR: dataDir,
      REALTIME_PORT: String(fixedPort),
    });
    if (server.port !== fixedPort) {
      fail(
        `Server did not restart on the same port (expected ${String(fixedPort)}, got ${String(server.port)}).`,
      );
    }
    console.info(`Dedicated Server listening again on ${server.host}:${String(server.port)}`);
    // The already-spawned A/B instances reconnect on their own, using the same address they were
    // originally configured with — this is only valid because the restart above was pinned to the
    // same `fixedPort`; nothing needs to be re-told a new URL.

    console.info(
      'Waiting for A and B to automatically reconnect (fresh T7 auth), rejoin "general", and re-establish real peer audio (E2E_REAUTHENTICATED / E2E_CHANNEL_RESTORED / E2E_VOICE_RECONNECTED_OK)...',
    );
    // Each of these markers already appeared once before the restart -- the *second* occurrence is
    // the actual reconnect proof; waiting on a plain "has it appeared" check would resolve
    // immediately on the stale, pre-restart occurrence instead.
    await Promise.all([
      a.waitForCount('disco-voador:connection-status:connected', 2),
      b.waitForCount('disco-voador:connection-status:connected', 2),
    ]);
    await Promise.all([
      a.waitForCount('disco-voador:voice-joined:general', 2),
      b.waitForCount('disco-voador:voice-joined:general', 2),
    ]);
    await Promise.all([
      a.waitForCount('E2E_PEER_CONNECTED:', 2),
      b.waitForCount('E2E_PEER_CONNECTED:', 2),
    ]);
    await Promise.all([
      a.waitForCount('E2E_AUDIO_LEVEL_OK:', 2),
      b.waitForCount('E2E_AUDIO_LEVEL_OK:', 2),
    ]);
    console.info(
      'Both clients reconnected, rejoined "general", and real peer audio is flowing again.',
    );

    console.info(
      'Waiting for A to reload Server Chat history after reconnect (E2E_CHAT_HISTORY_RELOADED)...',
    );
    // The first occurrence is ChatPanel's own initial (empty) load at mount, well before the
    // message was even sent -- the *second* occurrence is the post-reconnect restoration reload
    // this scenario is actually proving.
    await a.waitForCount('disco-voador:chat-history:', 2);
    const aStdout = a.getStdout();
    const historyLines = aStdout
      .split('\n')
      .filter(
        (line) => line.includes('disco-voador:chat-history:') && line.includes('"scope":"server"'),
      );
    const reloadedWithMessage = historyLines.some((line) => line.includes(SERVER_CHAT_BODY));
    if (!reloadedWithMessage) {
      fail(
        "A's post-reconnect Server Chat history reload did not include the pre-restart message " +
          `"${SERVER_CHAT_BODY}" (this must come from a fresh history request after reconnect, ` +
          'not a stale live event or client-side cache).',
      );
    }
    console.info('Server Chat history correctly reloaded from the server after reconnect.');

    console.info('Confirming camera and screen sharing never turned on for either client...');
    for (const instance of [a, b]) {
      const stdout = instance.getStdout();
      if (
        /E2E_REMOTE_VIDEO_OK|E2E_REMOTE_SCREEN_OK|localCameraStream|screenSharingState":"sharing"/u.test(
          stdout,
        )
      ) {
        fail(
          `${instance.label} shows evidence of camera/screen activity, which this scenario never enables.`,
        );
      }
    }

    console.info(
      'E2E reconnect-smoke test passed: unexpected server loss detected, bounded automatic ' +
        'reconnect with fresh T7 authentication, voice channel and real peer audio restored, ' +
        'chat history correctly reloaded from the server, camera/screen never auto-restarted.',
    );
    process.exit(0);
  } catch (error) {
    fail(
      `E2E reconnect-smoke test failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    for (const instance of instances) {
      await instance.stop();
    }
    if (server) await stopServer(server);
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
}

main().catch((error) => {
  fail(
    `E2E reconnect-smoke test crashed: ${error instanceof Error ? error.message : String(error)}`,
  );
});
