// Automated real-Electron/real-Dedicated-Server verification for T10 persistent server-side text
// chat (see docs/architecture/PERSISTENT_TEXT_CHAT.md). Reproduces the exact flow T10's own spec
// requires:
//
//   fresh Dedicated Server (real, file-backed data directory)
//   -> Electron B connects and opens Server Chat (loads its empty initial page)
//   -> Electron A connects, sends a Server Chat message, and joins "general" voice + sends a
//      Channel Chat message
//   -> B observes A's Server Chat message LIVE (not via history)
//   -> A and B exit; the server process exits (SIGTERM)
//   -> the server restarts against the SAME data directory
//   -> Electron C, a genuinely different --user-data-dir (fresh local identity), connects, opens
//      Server Chat, and receives A's earlier message through the HISTORY API, not a live event
//   -> C also joins "general" and receives the earlier Channel Chat message through its own
//      history API
//
// This is the mandatory persistence proof (T10 Section 48/76/77/78): the message did not survive
// because any client cached it — no client here is the one that originally sent it, and C uses a
// completely fresh local identity/profile — it survived because the Dedicated Server actually
// persisted it to disk and restarting the server does not lose it.
//
// Every Electron instance here uses a fresh --user-data-dir exactly once and is torn down via a
// plain external kill() — never the same profile relaunched (contrast
// e2e-authorization.mjs, which needs app.exit()-driven self-termination specifically because it
// does relaunch the same profile; see armE2ETextChatRelay's doc comment in main/index.ts).
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

const INSTANCE_TIMEOUT_MS = 60_000;
const SERVER_BODY = 'PERSIST_A_1';
const CHANNEL_BODY = 'GAME_HISTORY_1';

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(mainEntry)) {
  fail(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first (this also produces .vite/build/).`,
  );
}

/** Extracts every `disco-voador:<prefix>:<json>` marker's parsed JSON payload from accumulated
 * stdout, in the order they appeared. Markers are single console lines; this splits by line so a
 * marker's own JSON (which never itself contains a raw newline — message bodies used in this
 * script are single-line) is never accidentally merged with surrounding output. */
function extractMarkerPayloads(stdout, prefix) {
  const payloads = [];
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf(prefix);
    if (idx === -1) continue;
    try {
      payloads.push(JSON.parse(line.slice(idx + prefix.length)));
    } catch {
      // A partial/interleaved line — ignore; the marker will also appear intact on its own line
      // in practice, since Node's stdout 'data' handler below writes whole lines through.
    }
  }
  return payloads;
}

/** Spawns one Electron instance against a fresh, single-use profile. Returns `waitFor` (resolves
 * once a given substring has appeared anywhere in accumulated stdout, or already has) and `stop`
 * (kills the process and waits for real exit before removing its profile directory). */
function spawnInstance(label, realtimeUrl, extraEnv) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-chat-'));
  const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
    cwd: desktopDir,
    env: buildElectronE2EEnvironment(process.env, {
      DISCO_VOADOR_REALTIME_URL: realtimeUrl,
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      DISCO_VOADOR_E2E_TEXT_CHAT: '1',
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
        reject(new Error(`[${label}] timed out waiting for marker: ${pattern}`));
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

  return {
    label,
    waitFor,
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
  const dataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-chat-data-'));
  const instances = [];
  let server;

  try {
    console.info('Starting Dedicated Server (real, file-backed data directory)...');
    server = await startDedicatedServer({ DISCO_VOADOR_SERVER_DATA_DIR: dataDir });
    const realtimeUrl = `ws://${server.host}:${String(server.port)}`;
    console.info(`Dedicated Server listening on ${server.host}:${String(server.port)}`);

    console.info('Launching B (listener) and waiting for it to open Server Chat...');
    // `DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL` is required to reach the non-interactive
    // `AutoConnect` path at all (see `App.tsx`/`desktop-config.ts`) — B does not need to actually
    // use its voice channel membership for this test, but there is no other way to get a fresh
    // Electron instance past the real, interactive `ConnectionScreen` without human input.
    const b = spawnInstance('B', realtimeUrl, {
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'B',
    });
    instances.push(b);
    // B's ChatPanel auto-loads the (empty) Server Chat page as soon as it mounts, right after
    // connecting — this confirms B is actually ready to observe a *live* message next, not merely
    // connected.
    await b.waitFor('disco-voador:chat-history:{"scope":"server"');

    console.info(
      'Launching A: sends Server Chat live, then joins "general" and sends Channel Chat...',
    );
    const a = spawnInstance('A', realtimeUrl, {
      DISCO_VOADOR_E2E_CHAT_SEND_SERVER: SERVER_BODY,
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'A',
      DISCO_VOADOR_E2E_CHAT_SEND_CHANNEL: CHANNEL_BODY,
    });
    instances.push(a);

    await a.waitFor(`"body":"${SERVER_BODY}"`);
    console.info('A confirmed its own Server Chat send.');
    await a.waitFor(`"body":"${CHANNEL_BODY}"`);
    console.info('A confirmed its own Channel Chat send.');

    console.info("Waiting for B to observe A's Server Chat message LIVE...");
    await b.waitFor(`"body":"${SERVER_BODY}"`);
    console.info('B received the live Server Chat message.');

    console.info('Stopping A and B...');
    await a.stop();
    await b.stop();
    instances.length = 0;

    console.info('Stopping the Dedicated Server (SIGTERM)...');
    await stopServer(server);

    console.info('Restarting the Dedicated Server against the SAME data directory...');
    server = await startDedicatedServer({ DISCO_VOADOR_SERVER_DATA_DIR: dataDir });
    const restartedUrl = `ws://${server.host}:${String(server.port)}`;
    console.info(`Dedicated Server listening on ${server.host}:${String(server.port)}`);

    console.info(
      'Launching C: a genuinely fresh profile/local identity, no relationship to A or B...',
    );
    const c = spawnInstance('C', restartedUrl, {
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'C',
    });
    instances.push(c);

    console.info('Waiting for C to receive the Server Chat message through the HISTORY API...');
    await c.waitFor('disco-voador:chat-history:{"scope":"server"');
    console.info('Waiting for C to receive the Channel Chat message through the HISTORY API...');
    await c.waitFor('disco-voador:chat-history:{"scope":"channel","channelId":"general"');

    const cStdout = c.getStdout();
    const historyPages = extractMarkerPayloads(cStdout, 'disco-voador:chat-history:');
    const serverPage = historyPages.find((p) => p.scope === 'server');
    const channelPage = historyPages.find((p) => p.scope === 'channel');

    const serverBodies = (serverPage?.messages ?? []).map((m) => m.body);
    const channelBodies = (channelPage?.messages ?? []).map((m) => m.body);

    if (!serverBodies.includes(SERVER_BODY)) {
      fail(
        `C's Server Chat history did not include "${SERVER_BODY}" (got: ${JSON.stringify(serverBodies)}). ` +
          'This means the message did not actually survive the server restart.',
      );
    }
    if (!channelBodies.includes(CHANNEL_BODY)) {
      fail(
        `C's Channel Chat history did not include "${CHANNEL_BODY}" (got: ${JSON.stringify(channelBodies)}). ` +
          'This means the message did not actually survive the server restart.',
      );
    }

    // C never received these as *live* messages (it connected after A and B were long gone) —
    // confirms this arrived through the history API specifically, not a stale live event.
    const liveMessages = extractMarkerPayloads(cStdout, 'disco-voador:chat-message:');
    if (liveMessages.some((m) => m.body === SERVER_BODY || m.body === CHANNEL_BODY)) {
      fail(
        'C observed the persisted messages as live broadcasts, not only through history — ' +
          'this would mean the test setup is wrong (A/B were not actually gone), not that ' +
          'persistence itself failed.',
      );
    }

    console.info(
      'E2E persistent text-chat test passed: Server Chat delivered live to B; both Server Chat ' +
        'and Channel Chat messages survived a real server restart and were retrieved by a ' +
        "genuinely new client (fresh profile/identity) through the history API, never a client's " +
        'own cache.',
    );
    process.exit(0);
  } catch (error) {
    fail(
      `E2E persistent text-chat test failed: ${error instanceof Error ? error.message : String(error)}`,
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
    `E2E persistent text-chat test crashed: ${error instanceof Error ? error.message : String(error)}`,
  );
});
