import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const dedicatedServerCliEntry = path.join(
  repoRoot,
  'services',
  'dedicated-server',
  'dist',
  'cli.js',
);

const START_TIMEOUT_MS = 15_000;

/**
 * Starts the real Disco Voador Dedicated Server product entrypoint (`@disco-voador/dedicated-server`'s
 * built `cli.js`) — shared by every desktop E2E script (T8 Section 55-56: the client's E2E suite
 * must exercise the actual product boundary a real operator would run, never a separate "internal
 * realtime-only" path that only tests use). Resolves once the server's own startup banner reports
 * it is listening.
 */
export function startDedicatedServer(overrideEnv = {}) {
  if (!existsSync(dedicatedServerCliEntry)) {
    throw new Error(
      `Built Dedicated Server CLI entry not found at ${dedicatedServerCliEntry}.\n` +
        'Run "pnpm --filter @disco-voador/dedicated-server run build" first.',
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [dedicatedServerCliEntry], {
      cwd: path.dirname(dedicatedServerCliEntry),
      env: {
        ...process.env,
        REALTIME_HOST: '127.0.0.1',
        REALTIME_PORT: '0',
        LOG_LEVEL: 'error',
        // No config file by default — each E2E scenario that needs specific channels passes its
        // own DISCO_VOADOR_SERVER_CONFIG_PATH via `overrideEnv`; otherwise the server runs on
        // built-in defaults, matching a first-run operator who hasn't written one yet.
        DISCO_VOADOR_SERVER_CONFIG_PATH: path.join(repoRoot, 'does-not-exist.json'),
        // T9: an in-memory authorization store by default — these E2E scripts test media/identity
        // paths, not authorization persistence, so there is no reason for a normal run to leave a
        // SQLite file anywhere on disk. A scenario that specifically needs a real file-backed store
        // overrides this via `overrideEnv`.
        DISCO_VOADOR_SERVER_DATA_DIR: ':memory:',
        ...overrideEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`Dedicated Server did not report "Ready." within ${START_TIMEOUT_MS}ms`));
    }, START_TIMEOUT_MS);

    let stdout = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const match = /Listening:\s+([\d.]+):(\d+)/.exec(stdout);
      if (match && stdout.includes('Ready.') && !settled) {
        settled = true;
        clearTimeout(timer);
        // T9: present only on a genuinely fresh authorization store (see `cli.ts`'s
        // `printStartupBanner`) — both banner blocks are one atomic `console.info` write, so if
        // "Ready." has arrived, a trailing bootstrap block (if any) has too.
        const bootstrapMatch =
          /Initial Server Admin privilege key:\s*\n\s*\n\s*(DV-ADMIN-\S+)/u.exec(stdout);
        resolve({
          child,
          host: match[1],
          port: Number(match[2]),
          bootstrapToken: bootstrapMatch?.[1],
        });
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk.toString()}`));
    child.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`Dedicated Server exited early (code ${String(code)})`));
      }
    });
  });
}
