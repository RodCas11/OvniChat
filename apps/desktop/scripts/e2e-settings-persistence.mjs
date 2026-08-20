// T11 settings-persistence E2E: proves the local client settings store (device preferences and
// server bookmarks — `main/settings/settings-file.ts`) actually persists across real app restarts,
// and does not leak across a different local profile — the two guarantees no unit test can prove,
// since both depend on a real Electron process, a real `--user-data-dir` on disk, and the real
// `addBookmark`/`updateClientSettings`/`getClientSettings` IPC round trip (`main/ipc.ts` <->
// `App.tsx`'s settings-persistence-automation effect), not a hand-crafted `settings.json`.
//
// Needs neither a realtime service nor any media device — settings/bookmarks are entirely local and
// independent of both (see `DesktopE2ESettingsPersistenceConfig`'s own doc comment in
// `shared/ipc-contract.ts` for why this is a separate, narrower flag than the voice-auto-join E2E
// config), mirroring `e2e-identity-persistence.mjs`'s own zero-server design.
//
// Verifies:
//   1. Launching against a fresh `--user-data-dir` with the "write" flag set creates one bookmark
//      and one device preference through the real production IPC.
//   2. Launching again against the *same* `--user-data-dir` (write flag NOT set) reports the same
//      bookmark and device preference — proving they survived a real restart.
//   3. Launching against a *different* `--user-data-dir` (write flag NOT set) reports neither —
//      proving nothing leaked across profiles.
//
// Deliberately launches the unpackaged app — see `e2e-voice-smoke.mjs`'s doc comment for why
// `DISCO_VOADOR_E2E_SETTINGS_PERSISTENCE` (mirroring the other E2E flags) is only ever honored when
// `!app.isPackaged`.
//
// Prerequisite: `pnpm --filter @disco-voador/desktop exec electron-forge package` must have already
// been run (produces `.vite/build/main.cjs`).

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
const TEST_BOOKMARK_NAME = 'E2E Bookmark';
const TEST_BOOKMARK_ADDRESS = '127.0.0.1:9199';
const TEST_DEVICE_ID = 'e2e-settings-test-device';

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(mainEntry)) {
  fail(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first (this also produces .vite/build/).`,
  );
}

/** Launches one unpackaged Electron instance against `userDataDir`, optionally with the write flag
 * armed, and resolves with the parsed settings snapshot it reported, or `undefined` on
 * timeout/failure. */
function runSettingsInstance(label, userDataDir, write) {
  return new Promise((resolve) => {
    const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
      cwd: desktopDir,
      env: buildElectronE2EEnvironment(process.env, {
        DISCO_VOADOR_E2E_SETTINGS_PERSISTENCE: '1',
        ...(write ? { DISCO_VOADOR_E2E_SETTINGS_PERSISTENCE_WRITE: '1' } : {}),
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

    // Deliberately waits for the app to exit *on its own* (`main/index.ts`'s
    // `armE2ESettingsPersistenceExit` calls `app.exit()` itself once it observes the snapshot
    // marker) rather than parsing the marker from `stdout` and `kill()`-ing the child immediately —
    // an earlier version of this script did exactly that, and it reproduced a real, reproducible
    // `safeStorage`/DPAPI `decryptString` failure on the *next* launch of the same profile (see
    // `armE2ESettingsPersistenceExit`'s own doc comment for the full finding). Mirrors
    // `e2e-identity-persistence.mjs`'s `runIdentityInstance` for the identical reason.
    child.on('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const match = /disco-voador:e2e-settings-snapshot:(\{.*\})/.exec(stdout);
      if (!match || code !== 0) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(match[1]));
      } catch (error) {
        console.error(`[${label}] failed to parse settings snapshot`, error);
        resolve(undefined);
      }
    });
  });
}

function hasTestBookmark(settings) {
  return (settings?.bookmarks ?? []).some(
    (b) => b.displayName === TEST_BOOKMARK_NAME && b.serverAddress === TEST_BOOKMARK_ADDRESS,
  );
}

function hasTestDevicePreference(settings) {
  return settings?.audio?.inputDeviceId === TEST_DEVICE_ID;
}

async function main() {
  const dirA = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-settings-a-'));
  const dirB = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-settings-b-'));

  try {
    console.info('Launching instance 1 against a fresh profile (A), writing test settings...');
    const firstA = await runSettingsInstance('a-write', dirA, true);
    if (!firstA) fail('Instance A (write launch) never reported a settings snapshot.');
    if (!hasTestBookmark(firstA))
      fail('Instance A (write launch) did not report the test bookmark.');
    if (!hasTestDevicePreference(firstA)) {
      fail('Instance A (write launch) did not report the test device preference.');
    }
    console.info('Instance A (write launch) wrote and reported the test settings correctly.');

    console.info('Launching instance 2 against the same profile (A) again, read-only...');
    const secondA = await runSettingsInstance('a-read', dirA, false);
    if (!secondA) fail('Instance A (second launch) never reported a settings snapshot.');
    if (!hasTestBookmark(secondA)) {
      fail(
        'Settings did not persist across restart: bookmark missing on second launch of profile A.',
      );
    }
    if (!hasTestDevicePreference(secondA)) {
      fail(
        'Settings did not persist across restart: device preference missing on second launch of profile A.',
      );
    }
    console.info('Instance A (second launch) confirmed both settings persisted across a restart.');

    console.info('Launching instance 3 against a different profile (B), read-only...');
    const firstB = await runSettingsInstance('b-read', dirB, false);
    if (!firstB) fail('Instance B never reported a settings snapshot.');
    if (hasTestBookmark(firstB)) {
      fail('Settings leaked across profiles: profile B reports profile A’s test bookmark.');
    }
    if (hasTestDevicePreference(firstB)) {
      fail(
        'Settings leaked across profiles: profile B reports profile A’s test device preference.',
      );
    }
    console.info('Instance B confirmed neither setting leaked from profile A.');

    console.info(
      'E2E settings persistence test passed: settings written through the real addBookmark/' +
        'updateClientSettings IPC survive a restart of the same profile, and do not leak to a ' +
        'different profile.',
    );
    process.exit(0);
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
}

main().catch((error) => {
  fail(
    `E2E settings persistence test crashed: ${error instanceof Error ? error.message : String(error)}`,
  );
});
