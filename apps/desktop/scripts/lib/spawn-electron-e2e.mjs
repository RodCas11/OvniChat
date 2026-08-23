// Shared real-Electron-instance spawn helper for the T13.3 profile/avatar/presence E2E scripts
// (`e2e-profile-avatar-smoke.mjs`, `e2e-server-avatar-smoke.mjs`,
// `e2e-profile-server-isolation-smoke.mjs`). Extracted here rather than re-inlined a third time —
// mirrors `e2e-channel-admin-smoke.mjs`'s own local `spawnGuestInstance` helper almost exactly
// (buffered stdout, `waitFor(pattern)`, `stop()`), generalized into a shared module since these three
// new scripts all need the identical shape with no scenario-specific behavior baked in.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';

import { buildElectronE2EEnvironment } from './electron-e2e-env.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const mainEntry = path.join(desktopDir, '.vite', 'build', 'main.cjs');
const DEFAULT_TIMEOUT_MS = 40_000;

export function assertDesktopBuilt() {
  if (!existsSync(mainEntry)) {
    throw new Error(
      `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first (this also produces .vite/build/).`,
    );
  }
}

/**
 * Spawns one real Electron instance. `userDataDir`, if omitted, is a fresh temp directory this
 * helper creates and removes on `stop()` — pass an explicit one (reused across calls) to relaunch
 * the SAME persistent identity/profile, mirroring `e2e-channel-admin-smoke.mjs`'s own
 * `guestUserDataDir` reuse technique.
 */
export function spawnElectronE2E(label, env, userDataDir) {
  assertDesktopBuilt();
  const ownsDir = userDataDir === undefined;
  const dir = userDataDir ?? mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-profile-'));

  const child = spawn(electronPath, [desktopDir, `--user-data-dir=${dir}`], {
    cwd: desktopDir,
    env: buildElectronE2EEnvironment(process.env, {
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      ...env,
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

  const exitedPromise = new Promise((resolve) => {
    child.once('exit', () => resolve());
  });

  function waitFor(pattern, timeoutMs = DEFAULT_TIMEOUT_MS) {
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

  /** Extracts the value of the last `<prefix><value>` line seen so far (newline-delimited), or
   * `undefined` if none arrived yet — used to read this instance's own
   * `disco-voador:e2e-profile-*` marker lines back out. */
  function lastMarkerValue(prefix) {
    let found;
    for (const line of stdout.split('\n')) {
      const idx = line.indexOf(prefix);
      if (idx === -1) continue;
      found = line.slice(idx + prefix.length).trim();
    }
    return found;
  }

  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exitedPromise;
    }
    if (ownsDir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup only
      }
    }
  }

  return { label, dir, waitFor, stop, exitedPromise, lastMarkerValue, getStdout: () => stdout };
}
