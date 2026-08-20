// T8 desktop connection E2E (Section 58): proves the real client connection UX end to end through
// a real Electron instance — start disconnected (no server baked into a packaged build), connect
// to a real, distinctively-configured Dedicated Server, authenticate via T7's identity handshake,
// and receive/render that server's own display name. Uses the same `!app.isPackaged` +
// explicit-E2E-flag automation pattern every other E2E script in this project uses
// (`DISCO_VOADOR_E2E_CONNECTION_SMOKE`, see `armE2EConnectionSmokeExit` in
// `apps/desktop/src/main/index.ts`) rather than adding any auto-connect behavior a real packaged
// build could ever reach.
//
// Deliberately connects to an address DIFFERENT from `DISCO_VOADOR_REALTIME_URL` (the
// CSP-irrelevant-since-T8 deployment default — see `DISCO_VOADOR_E2E_CONNECT_URL` in
// `desktop-config.ts`), pointing the "default" at an address nothing is listening on. This is the
// scenario a security review found the pre-fix CSP would have silently blocked: through T7, CSP
// `connect-src` only ever allowlisted the one origin baked in at launch, so a real user typing any
// other address would never have actually connected. Proving this script still reaches
// `E2E_CONNECTION_SMOKE_OK` is what confirms `content-security-policy.ts`'s `ws:`/`wss:`-scheme fix
// actually restores the T8 "connect to whichever address your operator gives you" capability.
//
// Prerequisites: `pnpm --filter @disco-voador/dedicated-server run build` and
// `pnpm --filter @disco-voador/desktop exec electron-forge package` must have already been run.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';

import { buildElectronE2EEnvironment } from './lib/electron-e2e-env.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopDir, '.vite', 'build', 'main.cjs');
const INSTANCE_TIMEOUT_MS = 30_000;
const DISTINCTIVE_SERVER_NAME = 'Connection Smoke Test Server';

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(mainEntry)) {
  fail(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first (this also produces .vite/build/).`,
  );
}

async function main() {
  const configDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-connection-'));
  const configPath = path.join(configDir, 'server.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      name: DISTINCTIVE_SERVER_NAME,
      voiceChannels: [{ channelId: 'lobby', name: 'Lobby' }],
    }),
  );

  console.info('Starting Dedicated Server...');
  const {
    child: serverChild,
    host,
    port,
  } = await startDedicatedServer({
    DISCO_VOADOR_SERVER_CONFIG_PATH: configPath,
  });
  console.info(`Dedicated Server listening on ${host}:${String(port)}`);

  const userDataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-connection-client-'));

  try {
    const result = await new Promise((resolve) => {
      const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
        cwd: desktopDir,
        env: buildElectronE2EEnvironment(process.env, {
          // Deliberately mismatched from the real server's address (see the file-level comment
          // above) — a reserved, always-refused port, never actually dialed since
          // `DISCO_VOADOR_E2E_CONNECT_URL` below overrides AutoConnect's real target.
          DISCO_VOADOR_REALTIME_URL: 'ws://127.0.0.1:1',
          DISCO_VOADOR_E2E_CONNECT_URL: `ws://${host}:${String(port)}`,
          DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
          DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'lobby',
          DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Connection-Smoke-Tester',
          DISCO_VOADOR_E2E_CONNECTION_SMOKE: '1',
        }),
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdout = '';
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        resolve({ ok: false, stdout, reason: 'timeout' });
      }, INSTANCE_TIMEOUT_MS);

      child.stdout.on('data', (chunk) => {
        const text = chunk.toString();
        stdout += text;
        process.stdout.write(`[client] ${text}`);
      });
      child.stderr.on('data', (chunk) => process.stderr.write(`[client] ${chunk.toString()}`));

      child.on('exit', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          ok: code === 0 && stdout.includes('E2E_CONNECTION_SMOKE_OK'),
          stdout,
          reason: `exit ${String(code)}`,
        });
      });
    });

    if (!result.ok) {
      fail(`Client did not reach E2E_CONNECTION_SMOKE_OK (${result.reason}).`);
    }

    const match = /E2E_CONNECTION_SMOKE_OK:(.+)/.exec(result.stdout);
    const receivedServerName = match?.[1]?.trim();
    if (receivedServerName !== DISTINCTIVE_SERVER_NAME) {
      fail(
        `Expected the client to render server name "${DISTINCTIVE_SERVER_NAME}", got ` +
          `"${String(receivedServerName)}" — the connection screen did not actually reach the ` +
          'configured Dedicated Server.',
      );
    }

    console.info(
      `E2E connection smoke test passed: the client started disconnected, connected to a real ` +
        `Dedicated Server, authenticated via T7 identity, and rendered its configured name ` +
        `("${receivedServerName}").`,
    );
    process.exit(0);
  } finally {
    serverChild.kill();
    rmSync(configDir, { recursive: true, force: true });
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  fail(
    `E2E connection smoke test crashed: ${error instanceof Error ? error.message : String(error)}`,
  );
});
