import { closeSync, constants, openSync, readFileSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';

/**
 * T14 — a same-machine instance lock for `config.dataDir`: two Dedicated Server processes pointed
 * at the same real data directory (e.g. a duplicated launch, a stuck previous process, or a
 * misconfigured second instance) would otherwise both open the same `authorization.sqlite`/
 * `chat.sqlite`/`channels.sqlite`/`profiles.sqlite` files concurrently — `node:sqlite`'s WAL mode
 * tolerates concurrent readers, but two independent `AuthorizationStore`/`ChatStore`/etc. instances
 * each running their own in-process rate limiters, caches, and migration bookkeeping against the
 * same files is a real correctness hazard this lock exists to fail loudly against, rather than
 * leave as silent, hard-to-diagnose corruption risk.
 *
 * Uses `O_CREAT | O_EXCL` — atomic "create only if it doesn't already exist" at the filesystem
 * level, the same primitive every standard PID-file lock implementation relies on; there is no
 * separate check-then-create race window. `:memory:` (T9's documented ephemeral-store escape
 * hatch — see `create-dedicated-server.ts`) is a deliberate no-op: an in-memory store has no shared
 * file for two processes to collide on in the first place.
 */

export class DataDirLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DataDirLockError';
  }
}

export interface DataDirLock {
  /** Removes the lock file. Safe to call more than once (e.g. once from an explicit shutdown path
   * and once more defensively) — a already-removed lock file is not an error. */
  release(): void;
}

/**
 * Acquires the instance lock for `dataDir`, writing the current process's pid into `<dataDir>/.lock`
 * for operator diagnosability (visible in the thrown error if a second process collides). Throws
 * {@link DataDirLockError} if the lock is already held; every other filesystem failure (e.g. the
 * directory not existing yet) propagates as-is, matching this codebase's existing "only the
 * specific, anticipated failure gets a friendly wrapper" discipline (see `server-config-file.ts`'s
 * own `ENOENT`-only special case).
 */
export function acquireDataDirLock(dataDir: string): DataDirLock {
  if (dataDir === ':memory:') return { release: () => {} };

  const lockPath = path.join(dataDir, '.lock');
  let fd: number;
  try {
    fd = openSync(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      let existingPid = 'unknown';
      try {
        existingPid = readFileSync(lockPath, 'utf8').trim();
      } catch {
        // The lock file may have been removed between the EEXIST failure above and this read —
        // "unknown" is still an accurate, honest description of the pid in that case.
      }
      throw new DataDirLockError(
        `Data directory "${dataDir}" is already in use by another running server (pid ${existingPid}). ` +
          `If that process is not actually running, delete "${lockPath}" and try again.`,
      );
    }
    throw error;
  }

  writeSync(fd, String(process.pid));
  closeSync(fd);

  return {
    release: () => {
      try {
        unlinkSync(lockPath);
      } catch {
        // Already gone — fine on a double-release, and not this process's problem if something
        // else removed it first.
      }
    },
  };
}
