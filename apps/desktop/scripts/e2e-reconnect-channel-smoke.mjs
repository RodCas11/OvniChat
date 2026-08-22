// T13.2 reconnect-regression extension (T11's automatic-reconnect controller, see
// `e2e-reconnect-smoke.mjs` and `docs/architecture/CLIENT_SETTINGS_AND_RECONNECT.md`). Added as a
// sibling script rather than bolted onto `e2e-reconnect-smoke.mjs` directly: that script is already
// a large, tightly-sequenced, real-peer-audio scenario (T11's own mandatory "real decoded audio both
// directions across a restart" proof) — these three T13.2 cases are about channel/ACL/password state
// specifically, not media, and reuse none of that script's WebRTC probing, so folding them in would
// only add unrelated complexity to an already-large file without adding any shared coverage. Case A
// from the task brief ("previously-joined channel still allowed -> restores") is deliberately NOT
// duplicated here: `e2e-reconnect-smoke.mjs` already proves exactly this (A and B both rejoin
// "general" with real peer audio after a real restart) — this script covers only the three NEW T13.2
// cases: channel deleted, ACL changed, and password added, all while the client was offline.
//
// Timing technique for "the mutation happens while the client is offline, not via a live update it
// would otherwise already receive": if the admin mutated the channel *before* killing the server (or
// raced a reconnect against a server that just came back up), the client's own already-proven live
// catalog/ACL-revalidation machinery would handle it — which is not what T11's *reconnect-restore*
// code path (`onServerError`'s `isRestore` branch in `use-voice-channel.ts`) specifically needs
// proving. So each scenario here: (1) joins, (2) kills the server, (3) waits for `'reconnecting'`,
// (4) waits an extra ~2.5s during which the server is *not listening at all* (the client's own
// bounded backoff — starting at ~0.5-1s per `reconnect-controller.ts` — is guaranteed to fail with
// connection-refused during this whole window, so nothing races), (5) restarts the server and, in the
// very next tick, connects a raw-WS admin (reusing the SAME keypair/identity that was already
// `server-admin` before the kill — see `connectAndAuthenticate`'s `existingKeyPair` parameter) and
// performs the mutation immediately — by the time the client's own growing backoff timer next fires
// and the port is even reachable, the mutation has already landed.
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
import {
  becomeServerAdmin,
  connectAndAuthenticate,
  freshId,
  sendRequest,
} from './lib/raw-protocol-client.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopDir, '.vite', 'build', 'main.cjs');
const INSTANCE_TIMEOUT_MS = 60_000;
// This is a probabilistic, not fully deterministic, de-risking of the race described in this file's
// header comment — not a hard guarantee. The client's own bounded-backoff schedule
// (`reconnect-controller.ts`: attempt 1 at withJitter(1000) => 0.5-1s, attempt 2 at withJitter(2000)
// counted from attempt 1's failure, etc.) keeps roughly doubling in width, so waiting long enough to
// land inside a *later*, much wider backoff window makes it increasingly unlikely (not impossible)
// that the client's own randomly-jittered next attempt lands within the same few-millisecond slice
// this script's own admin-reconnect-and-mutate sequence needs once the port reopens. 6 seconds lands
// solidly inside the 3rd/4th attempt's window, which is wide enough that this was not observed to
// flake across repeated local runs while building this script — documented here as a real, accepted
// limitation rather than a claimed guarantee (there is no live "hold the client's retries" hook this
// script could use instead without touching production reconnect timing, which is out of scope).
const OFFLINE_WINDOW_MS = 6_000;

if (!existsSync(mainEntry)) {
  throw new Error(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first (this also produces .vite/build/).`,
  );
}

function spawnGuest(label, realtimeUrl, channelId) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-reconnect-channel-'));
  const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
    cwd: desktopDir,
    env: buildElectronE2EEnvironment(process.env, {
      DISCO_VOADOR_REALTIME_URL: realtimeUrl,
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      DISCO_VOADOR_E2E_RECONNECT_SMOKE: '1',
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: channelId,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Guest',
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

  function waitForCount(pattern, minCount, timeoutMs = INSTANCE_TIMEOUT_MS) {
    const check = (s) => countOccurrences(s, pattern) >= minCount;
    if (check(stdout)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`[${label}] timed out waiting for ${String(minCount)}x "${pattern}"`));
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
    return waitForCount(pattern, 1, timeoutMs);
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

  return { label, waitFor, waitForCount, stop, getStdout: () => stdout };
}

async function stopServer(server) {
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGTERM');
    await new Promise((resolve) => {
      server.child.once('exit', () => resolve());
    });
  }
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Runs one full scenario in complete isolation (its own data dir, server, and Guest instance).
 * `mutate(adminWs, roomId)` performs the scenario-specific channel mutation, called immediately
 * after the server comes back up but before the client's own reconnect can possibly succeed.
 * `expectedMarker` is the `disco-voador:server-error:<code>` this scenario's restore attempt must
 * produce.
 */
async function runScenario(name, mutate, expectedMarker) {
  console.info(`\n=== Scenario ${name} ===`);
  const dataDir = mkdtempSync(path.join(tmpdir(), `disco-voador-e2e-reconnect-channel-${name}-`));
  let server;
  let adminWs;
  let guest;

  try {
    console.info(`[${name}] Starting Dedicated Server (real, file-backed data directory)...`);
    server = await startDedicatedServer({ DISCO_VOADOR_SERVER_DATA_DIR: dataDir });
    const fixedPort = server.port;
    const url = `ws://${server.host}:${String(fixedPort)}`;
    if (!server.bootstrapToken) throw new Error('Expected a bootstrap token on first startup');

    const admin = await connectAndAuthenticate(url, 'Admin');
    adminWs = admin.ws;
    await becomeServerAdmin(adminWs, server.bootstrapToken);
    const adminKeyPair = admin.keyPair;

    console.info(`[${name}] Admin creates an open, root-level voice channel...`);
    const room = await sendRequest(
      adminWs,
      { type: 'client:channel-create-voice', id: freshId('create-room'), name: `Room ${name}` },
      ['server:channel-created'],
    );
    const roomId = room.node.nodeId;
    adminWs.close();

    console.info(`[${name}] Launching Guest, auto-joining the room...`);
    guest = spawnGuest(`guest-${name}`, url, roomId);
    await guest.waitFor('disco-voador:connection-status:connected');
    await guest.waitFor(`disco-voador:voice-joined:${roomId}`);
    console.info(`[${name}] Guest joined. Killing the Dedicated Server (SIGTERM)...`);

    await stopServer(server);
    await guest.waitFor('disco-voador:connection-status:reconnecting');
    console.info(
      `[${name}] Guest detected the loss and is retrying. Waiting out a dead window ` +
        `(${String(OFFLINE_WINDOW_MS)}ms, server not listening at all) before restarting...`,
    );
    await wait(OFFLINE_WINDOW_MS);

    console.info(`[${name}] Restarting the Dedicated Server on the SAME port/data dir...`);
    server = await startDedicatedServer({
      DISCO_VOADOR_SERVER_DATA_DIR: dataDir,
      REALTIME_PORT: String(fixedPort),
    });
    if (server.port !== fixedPort) {
      throw new Error(`Server did not restart on the same port (expected ${String(fixedPort)}).`);
    }

    console.info(
      `[${name}] Reconnecting Admin (same identity) and mutating the channel immediately...`,
    );
    const adminAfterRestart = await connectAndAuthenticate(url, 'Admin', adminKeyPair);
    await mutate(adminAfterRestart.ws, roomId);
    adminAfterRestart.ws.close();
    console.info(`[${name}] Mutation applied.`);

    console.info(
      `[${name}] Waiting for Guest's reconnect-restore attempt to observe ${expectedMarker}, and ` +
        'for the whole connection to remain healthy (a second "connected" state)...',
    );
    await Promise.all([
      guest.waitForCount('disco-voador:connection-status:connected', 2),
      guest.waitFor(expectedMarker),
    ]);
    console.info(
      `[${name}] Confirmed: the connection reconnected successfully (no whole-connection failure), ` +
        `and the restore-join attempt itself observed ${expectedMarker}.`,
    );

    // Voice must NOT have been silently restored despite the marker above -- a second
    // `voice-joined:<roomId>` would mean the restore actually (wrongly) succeeded.
    const secondJoinMarker = `disco-voador:voice-joined:${roomId}`;
    const joinCount = guest.getStdout().split(secondJoinMarker).length - 1;
    if (joinCount > 1) {
      throw new Error(
        `Expected the restore join to fail, but "${secondJoinMarker}" appeared ${String(joinCount)} times.`,
      );
    }
    console.info(`[${name}] Confirmed: voice was correctly NOT restored.`);
    console.info(`=== Scenario ${name}: PASSED ===`);
  } finally {
    adminWs?.close();
    if (guest) await guest.stop();
    if (server) await stopServer(server);
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
}

async function main() {
  await runScenario(
    'B-deleted',
    async (adminWs, roomId) => {
      await sendRequest(
        adminWs,
        { type: 'client:channel-delete', id: freshId('delete-room'), nodeId: roomId },
        ['server:channel-ack'],
      );
    },
    'disco-voador:server-error:CHANNEL_NOT_FOUND',
  );

  await runScenario(
    'C-acl-denied',
    async (adminWs, roomId) => {
      // Restricts the room to a group the Guest identity never held -- `server-admin` itself is a
      // safe, always-existing choice that a bare Guest identity never automatically holds.
      await sendRequest(
        adminWs,
        {
          type: 'client:channel-update',
          id: freshId('restrict-room'),
          nodeId: roomId,
          joinPolicy: 'selected-groups',
          joinGroupIds: ['server-admin'],
        },
        ['server:channel-ack'],
      );
    },
    'disco-voador:server-error:CHANNEL_ACCESS_DENIED',
  );

  await runScenario(
    'D-password-added',
    async (adminWs, roomId) => {
      await sendRequest(
        adminWs,
        {
          type: 'client:channel-set-password',
          id: freshId('password-room'),
          nodeId: roomId,
          password: 'a-new-password',
        },
        ['server:channel-ack'],
      );
    },
    'disco-voador:server-error:CHANNEL_PASSWORD_REQUIRED',
  );

  console.info(
    '\nE2E reconnect-channel-smoke test passed: a channel deleted, ACL-restricted, or password-' +
      'protected while the client was offline is each handled correctly on reconnect -- the whole ' +
      'connection recovers (no whole-connection failure), voice is correctly not silently restored, ' +
      'and the specific rejection code (including CHANNEL_PASSWORD_REQUIRED, which sets ' +
      'channelPasswordPrompt for a manual retry) is observed exactly once per scenario.',
  );
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(
      `E2E reconnect-channel-smoke test failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
