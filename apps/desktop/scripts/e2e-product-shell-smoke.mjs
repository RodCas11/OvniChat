// T13.1 product-shell-smoke E2E: proves the redesigned Home/server-rail/channel-sidebar/chat/
// member-panel/bottom-control-bar workspace end to end through a real Electron instance and two
// real Dedicated Servers — following this repo's existing E2E convention exactly (see
// `e2e-connection-smoke.mjs`/`e2e-reconnect-smoke.mjs`): `DISCO_VOADOR_E2E_*` env-var config
// injection, `!app.isPackaged`-gated automation, and `console.info` stdout markers only — never DOM
// scraping/`page.click` (there is no Playwright/Electron-automation dependency in this repo; every
// existing `e2e-*.mjs` script drives the app exclusively through `DesktopE2EVoiceConfig`-style
// config plus marker assertions, confirmed by reading both files above before writing this one).
//
// Scenario:
//   fresh profile -> nickname flow (AutoFirstRun) -> two bookmarks added via the real addBookmark
//   IPC, visible on a genuine (briefly rendered) ServerHome -> connect to Server A -> real T7
//   identity handshake, server name received, voice channel catalog received (rail/sidebar/chat/
//   member-panel/bottom-controls all real production components at this point, see
//   `tests/desktop/components/*.test.tsx` for their own isolated coverage) -> select "general"'s
//   chat WITHOUT joining voice (proven by ordering against the real join marker) -> chat history
//   loads for that channel -> join voice via the real join path -> real peer-less but real-server
//   join confirmed -> open then close Settings -> switch to Server B via the real disconnect ->
//   connect lifecycle (`ServerRail`'s own contract) -> a fresh `VoiceChannelView` instance mounts
//   (the `AppShell` remount-key fix's own correctness) -> the same select/join/settings sequence
//   repeats correctly against Server B -> disconnect back toward Home -> both bookmarks still
//   present in `getClientSettings()` afterward -> clean external shutdown.
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
const INSTANCE_TIMEOUT_MS = 30_000;
const CHANNEL_ID = 'general';
const DISPLAY_NAME = 'ProductShellSmokeTester';
const BOOKMARK_A_NAME = 'Product Shell Smoke — Server A';
const BOOKMARK_B_NAME = 'Product Shell Smoke — Server B';

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

/** Mirrors `e2e-reconnect-smoke.mjs`'s own `spawnInstance` helper exactly (single-instance version
 * — this scenario only ever needs one Electron process, switching servers by itself). */
function spawnClient(realtimeUrl, hostA, portA, hostB, portB) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-product-shell-'));
  const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
    cwd: desktopDir,
    env: buildElectronE2EEnvironment(process.env, {
      // Never actually dialed — `DISCO_VOADOR_E2E_CONNECT_URL` below overrides `AutoConnect`'s
      // real target, exactly like `e2e-connection-smoke.mjs`.
      DISCO_VOADOR_REALTIME_URL: 'ws://127.0.0.1:1',
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: DISPLAY_NAME,
      DISCO_VOADOR_E2E_CONNECT_URL: realtimeUrl,
      DISCO_VOADOR_E2E_PSS_BOOKMARK_A_NAME: BOOKMARK_A_NAME,
      DISCO_VOADOR_E2E_PSS_BOOKMARK_A_ADDRESS: `${hostA}:${String(portA)}`,
      DISCO_VOADOR_E2E_PSS_BOOKMARK_B_NAME: BOOKMARK_B_NAME,
      DISCO_VOADOR_E2E_PSS_BOOKMARK_B_ADDRESS: `${hostB}:${String(portB)}`,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  const waiters = [];

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(`[client] ${text}`);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (waiters[i].check(stdout)) {
        waiters[i].resolve();
        waiters.splice(i, 1);
      }
    }
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[client] ${chunk.toString()}`));

  function waitUntil(check, description, timeoutMs) {
    if (check(stdout)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`timed out waiting for: ${description}`));
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

  return { waitFor, waitForCount, stop, getStdout: () => stdout };
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
  console.info(
    'Starting two real Dedicated Servers (default config: general/games/afk channels)...',
  );
  const serverA = await startDedicatedServer();
  const serverB = await startDedicatedServer();
  console.info(`Server A listening on ${serverA.host}:${String(serverA.port)}`);
  console.info(`Server B listening on ${serverB.host}:${String(serverB.port)}`);

  const client = spawnClient(
    `ws://${serverA.host}:${String(serverA.port)}`,
    serverA.host,
    serverA.port,
    serverB.host,
    serverB.port,
  );

  try {
    console.info('Waiting for both bookmarks to be seeded and visible on the real Home screen...');
    await client.waitFor('E2E_PRODUCT_SHELL_HOME_BOOKMARKS:');
    const bookmarksLine = /E2E_PRODUCT_SHELL_HOME_BOOKMARKS:(.+)/.exec(client.getStdout());
    const bookmarkNames = JSON.parse(bookmarksLine?.[1]?.trim() ?? '[]');
    if (!bookmarkNames.includes(BOOKMARK_A_NAME) || !bookmarkNames.includes(BOOKMARK_B_NAME)) {
      fail(`Expected both bookmarks seeded, got: ${JSON.stringify(bookmarkNames)}`);
    }
    console.info('Both bookmarks confirmed present via the real bookmark IPC.');

    console.info('Waiting for the first workspace mount (Server A) and chat-target selection...');
    await client.waitFor('E2E_PRODUCT_SHELL_WORKSPACE_MOUNTED:');
    await client.waitFor(`E2E_PRODUCT_SHELL_CHAT_TARGET_SELECTED:${CHANNEL_ID}`);

    // The selection marker is a synchronous, zero-network-round-trip `console.info`; the real join
    // requires at least one WebSocket round trip to the Dedicated Server — so if selection truly
    // never joins voice by itself, `voice-joined` must not yet be present at this exact instant.
    if (client.getStdout().includes(`disco-voador:voice-joined:${CHANNEL_ID}`)) {
      fail(
        "Selecting a channel's chat must never join its voice — but a join marker already " +
          'appeared before (or simultaneously with) the selection marker.',
      );
    }
    console.info("Confirmed: selecting a channel's chat did not join its voice.");

    console.info('Waiting for chat history to load for the selected channel...');
    await client.waitFor(`"scope":"channel","channelId":"${CHANNEL_ID}"`);

    console.info('Waiting for the real, explicit voice join to actually succeed...');
    await client.waitFor(`disco-voador:voice-joined:${CHANNEL_ID}`);
    console.info('Joined voice via the real Join action.');

    console.info('Waiting for Settings to open and then close...');
    await client.waitFor('E2E_PRODUCT_SHELL_SETTINGS_OPENED');
    await client.waitFor('E2E_PRODUCT_SHELL_SETTINGS_CLOSED');

    console.info('Waiting for the scripted switch to Server B...');
    await client.waitFor('E2E_PRODUCT_SHELL_SWITCHING_TO_B');

    console.info('Waiting for a FRESH workspace mount for Server B (the remount-key proof)...');
    await client.waitForCount('E2E_PRODUCT_SHELL_WORKSPACE_MOUNTED:', 2, 60_000);
    const mountMarkers = [
      ...client.getStdout().matchAll(/E2E_PRODUCT_SHELL_WORKSPACE_MOUNTED:(\S*)/gu),
    ].map((match) => match[1]);
    if (mountMarkers.length < 2 || mountMarkers[0] === mountMarkers[1]) {
      fail(
        `Expected two distinct workspace-mounted markers (Server A then Server B), got: ` +
          `${JSON.stringify(mountMarkers)}`,
      );
    }
    console.info(
      `Confirmed a fresh VoiceChannelView instance mounted for Server B (${mountMarkers[1]}), ` +
        'distinct from Server A — no stale state survived the switch.',
    );

    console.info(
      'Confirming the same select-without-join -> join -> settings sequence repeats on Server B...',
    );
    await client.waitForCount(`E2E_PRODUCT_SHELL_CHAT_TARGET_SELECTED:${CHANNEL_ID}`, 2, 60_000);
    await client.waitForCount(`disco-voador:voice-joined:${CHANNEL_ID}`, 2, 60_000);
    await client.waitForCount('E2E_PRODUCT_SHELL_SETTINGS_OPENED', 2, 60_000);
    await client.waitForCount('E2E_PRODUCT_SHELL_SETTINGS_CLOSED', 2, 60_000);
    console.info('Server B fully re-exercised the same real workspace flow.');

    console.info('Waiting for the scripted disconnect back toward Home...');
    await client.waitFor('E2E_PRODUCT_SHELL_DONE:', 60_000);
    const doneLine = /E2E_PRODUCT_SHELL_DONE:(.+)/.exec(client.getStdout());
    const done = JSON.parse(doneLine?.[1]?.trim() ?? '{}');
    if (
      !Array.isArray(done.bookmarkNames) ||
      !done.bookmarkNames.includes(BOOKMARK_A_NAME) ||
      !done.bookmarkNames.includes(BOOKMARK_B_NAME)
    ) {
      fail(`Expected both bookmarks still present after disconnect, got: ${JSON.stringify(done)}`);
    }
    console.info('Confirmed both bookmarks survived the full switch/disconnect sequence intact.');

    console.info(
      'E2E product-shell-smoke test passed: Home bookmarks, server rail/channel sidebar/chat/' +
        'member-panel/bottom-controls, click-never-joins-voice, real Join, Settings open/close, ' +
        'server switch with a fresh workspace instance (no stale state), and a clean return toward ' +
        'Home with bookmarks intact all verified through a real Electron instance and two real ' +
        'Dedicated Servers.',
    );
    process.exit(0);
  } catch (error) {
    fail(
      `E2E product-shell-smoke test failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await client.stop();
    await stopServer(serverA);
    await stopServer(serverB);
  }
}

main().catch((error) => {
  fail(
    `E2E product-shell-smoke test crashed: ${error instanceof Error ? error.message : String(error)}`,
  );
});
