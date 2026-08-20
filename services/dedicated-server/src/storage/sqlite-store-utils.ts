import { DatabaseSync } from 'node:sqlite';

/**
 * Shared `node:sqlite` plumbing for this package's independent, per-concern stores (T9's
 * `authorization/store.ts`, T10's `chat/store.ts`, and any future one) — each store still owns its
 * own physical database file, its own `Migration[]` list, and its own `schema_migrations` table;
 * this module only factors out the *shape* every one of them repeats (open + pragmas + migration
 * runner), never shared state between stores. Kept inside `services/dedicated-server` rather than a
 * new `packages/` workspace for the same reason ADR 0013 gave for not extracting the authorization
 * store itself: no cross-workspace consumer exists, and both stores only ever run in this one
 * process (see `docs/adr/0014-persistent-server-owned-chat-history.md`).
 */

export interface Migration {
  readonly version: number;
  readonly statements: readonly string[];
}

/** `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK` around `fn` — used for every multi-statement write so a
 * partial failure never leaves a store's file in an inconsistent state. */
export function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

/**
 * Opens `path` as a `DatabaseSync`, sets the pragmas every store here wants (`journal_mode = WAL`
 * for concurrent-read/single-writer durability, `foreign_keys = ON` so each store's own internal
 * `ON DELETE CASCADE` constraints are actually enforced), and applies every not-yet-applied
 * migration from `migrations` in order, inside one transaction per migration, tracked in this
 * database's own `schema_migrations` table. Returns whether this open found a genuinely fresh
 * database (no `schema_migrations` rows before this call) — the same signal
 * `AuthorizationStore` already used to decide whether to seed built-in groups and mint a bootstrap
 * token; `ChatStore` currently has no fresh-init behavior of its own, but the signal is returned
 * uniformly in case a future store needs it.
 */
export function openManagedDatabase(
  path: string,
  migrations: readonly Migration[],
  now: () => number,
): { readonly db: DatabaseSync; readonly wasFreshInit: boolean } {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  db.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)',
  );
  const appliedRows = db.prepare('SELECT version FROM schema_migrations').all() as {
    version: number;
  }[];
  const applied = new Set(appliedRows.map((row) => row.version));
  const wasFreshInit = applied.size === 0;

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    withTransaction(db, () => {
      for (const statement of migration.statements) db.exec(statement);
      db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(
        migration.version,
        now(),
      );
    });
  }

  return { db, wasFreshInit };
}
