// T7 identity-persistence E2E: proves the local cryptographic identity actually persists across
// real app restarts, and is genuinely distinct per profile — the two guarantees no unit test can
// prove, since both depend on a real Electron process, real `safeStorage` (Windows DPAPI), and a
// real `--user-data-dir` on disk. Needs neither a realtime service nor any media device: identity
// loads (creating on first run) before the app ever reaches the voice UI at all.
//
// Verifies:
//   1. Launching against a fresh `--user-data-dir` creates an identity.
//   2. Launching again against the *same* `--user-data-dir` reports the *same* identityId.
//   3. Launching against a *different* `--user-data-dir` reports a *different* identityId.
//
// Deliberately launches the unpackaged app — see `e2e-voice-smoke.mjs`'s doc comment for why
// `DISCO_VOADOR_E2E_IDENTITY_PERSISTENCE` (mirroring the other E2E flags) is only ever honored
// when `!app.isPackaged`.
//
// Prerequisite: `pnpm --filter @disco-voador/desktop exec electron-forge package` must have
// already been run (produces `.vite/build/main.cjs`).

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';

import { buildElectronE2EEnvironment } from './lib/electron-e2e-env.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopDir, '.vite', 'build', 'main.cjs');

const INSTANCE_TIMEOUT_MS = 30_000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(mainEntry)) {
  fail(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first (this also produces .vite/build/).`,
  );
}

/** Launches one unpackaged Electron instance against `userDataDir` and resolves with the
 * identityId it reported, or `undefined` on timeout/failure. */
function runIdentityInstance(label, userDataDir) {
  return new Promise((resolve) => {
    const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
      cwd: desktopDir,
      env: buildElectronE2EEnvironment(process.env, {
        DISCO_VOADOR_E2E_IDENTITY_PERSISTENCE: '1',
      }),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve(undefined);
    }, INSTANCE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(`[${label}] ${text}`);
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk.toString()}`));

    child.on('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const match = /E2E_IDENTITY_PERSISTENCE_OK:(\S+)/.exec(stdout);
      resolve(match?.[1]);
    });
  });
}

async function main() {
  const dirA = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-identity-a-'));
  const dirB = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-identity-b-'));

  try {
    console.info('Launching instance 1 against a fresh profile (A)...');
    const firstA = await runIdentityInstance('a-first', dirA);
    if (!firstA) fail('Instance A (first launch) never reported an identityId.');
    console.info(`Instance A (first launch) identityId: ${firstA}`);

    console.info('Launching instance 2 against the same profile (A) again...');
    const secondA = await runIdentityInstance('a-second', dirA);
    if (!secondA) fail('Instance A (second launch) never reported an identityId.');
    console.info(`Instance A (second launch) identityId: ${secondA}`);

    console.info('Launching instance 3 against a different profile (B)...');
    const firstB = await runIdentityInstance('b-first', dirB);
    if (!firstB) fail('Instance B never reported an identityId.');
    console.info(`Instance B identityId: ${firstB}`);

    if (firstA !== secondA) {
      fail(
        `Identity did not persist across restarts of the same profile: ${firstA} !== ${secondA}`,
      );
    }
    if (firstA === firstB) {
      fail(`Two different profiles reported the same identityId: ${firstA} === ${firstB}`);
    }

    console.info(
      'E2E identity persistence test passed: same profile persists its identityId across restarts; different profiles get different identityIds.',
    );
    process.exit(0);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
}

main().catch((error) => {
  fail(
    `E2E identity persistence test crashed: ${error instanceof Error ? error.message : String(error)}`,
  );
});
