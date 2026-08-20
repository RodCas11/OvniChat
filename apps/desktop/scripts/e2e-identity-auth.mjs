// T7 identity-authentication E2E: two Electron instances, each with its own local identity (own
// `--user-data-dir`), connect to a real Disco Voador Dedicated Server (T8's actual product
// entrypoint) and complete the full T7 handshake (`client:hello` -> `server:identity-challenge` ->
// `client:identity-proof` -> `server:hello`) before joining the same voice channel — exactly
// `e2e-voice-smoke.mjs`'s proven harness, reused as-is (it already relays every renderer console
// line, including the two identity markers `use-identity.ts`/`realtime-client.ts` log), plus
// identity-specific assertions on top:
//
//   1. Each instance's locally-generated identityId matches the identityId the server reports
//      back in `server:hello` (proving the server independently re-derived the same id from the
//      verified public key, not merely echoed a client-supplied value).
//   2. The two instances (two distinct local profiles) get two different identityIds.
//   3. Voice/media continues to work: both instances still reach a connected peer connection and
//      exchange genuinely non-silent audio (the same `E2E_PEER_CONNECTED`/`E2E_AUDIO_LEVEL_OK`
//      markers `e2e-voice-smoke.mjs` requires) — proving identity auth is not a regression on the
//      existing voice path, only an additional gate before it.
//
// Prerequisites: identical to `e2e-voice-smoke.mjs` — `pnpm --filter @disco-voador/dedicated-server
// run build` and `pnpm --filter @disco-voador/desktop exec electron-forge package`.

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

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(mainEntry)) {
  fail(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first (this also produces .vite/build/).`,
  );
}

/** Launches one unpackaged Electron instance configured to auto-join the smoke-test voice channel
 * — identical to `e2e-voice-smoke.mjs`'s `runVoiceInstance` — and additionally extracts this
 * instance's local and server-authenticated identityId markers from its stdout. */
function runVoiceInstance(label, realtimeUrl, displayName) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-identity-'));

  return new Promise((resolve) => {
    const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
      cwd: desktopDir,
      env: buildElectronE2EEnvironment(process.env, {
        DISCO_VOADOR_REALTIME_URL: realtimeUrl,
        DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
        DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
        DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: displayName,
        DISCO_VOADOR_E2E_VOICE_SMOKE: '1',
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
      const localIdentityMatch = /disco-voador:local-identity-ready:(\S+)/.exec(stdout);
      const serverIdentityMatch = /disco-voador:server-authenticated-identity:(\S+)/.exec(stdout);
      resolve({
        label,
        ok: code === 0 && stdout.includes('E2E_VOICE_SMOKE_OK'),
        stdout,
        reason: `exit ${String(code)}`,
        localIdentityId: localIdentityMatch?.[1],
        serverIdentityId: serverIdentityMatch?.[1],
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
    console.info('Launching two Electron instances, each with its own local identity...');
    const [a, b] = await Promise.all([
      runVoiceInstance('instance-a', realtimeUrl, 'Instance-A'),
      runVoiceInstance('instance-b', realtimeUrl, 'Instance-B'),
    ]);

    if (!a.ok || !b.ok) {
      fail(
        `Voice/media path failed. instance-a: ${a.ok ? 'ok' : a.reason}, instance-b: ${b.ok ? 'ok' : b.reason}`,
      );
    }

    for (const instance of [a, b]) {
      if (!instance.localIdentityId) {
        fail(`${instance.label} never reported a local identityId.`);
      }
      if (!instance.serverIdentityId) {
        fail(`${instance.label} never reported a server-authenticated identityId.`);
      }
      if (instance.localIdentityId !== instance.serverIdentityId) {
        fail(
          `${instance.label}: local identityId (${instance.localIdentityId}) does not match the ` +
            `server-authenticated identityId (${instance.serverIdentityId}).`,
        );
      }
    }

    if (a.localIdentityId === b.localIdentityId) {
      fail(
        `Two different local profiles reported the same identityId: ${a.localIdentityId}. Each ` +
          `instance's --user-data-dir must produce its own distinct identity.`,
      );
    }

    console.info(
      `E2E identity authentication test passed: instance-a identityId ${a.localIdentityId} and ` +
        `instance-b identityId ${b.localIdentityId} each matched their server-authenticated ` +
        `identityId, the two are distinct, and voice/media continued to work.`,
    );
    process.exit(0);
  } finally {
    realtimeChild.kill();
  }
}

main().catch((error) => {
  fail(
    `E2E identity authentication test crashed: ${error instanceof Error ? error.message : String(error)}`,
  );
});
