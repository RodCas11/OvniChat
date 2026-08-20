import type { Migration } from '../storage/sqlite-store-utils.js';

/**
 * T9 authorization store migrations. No migration framework was introduced — this repository has
 * none, and the table count/query shapes here are small and fixed by this task's own spec, so a
 * hand-rolled ordered list is simpler and more legible than adopting a dependency for it (see
 * `docs/adr/0013-authorization-storage-and-rbac.md`). Each entry is applied exactly once, in
 * order, inside one transaction, tracked in this store's own `schema_migrations` table (see
 * `../storage/sqlite-store-utils.js`, shared plumbing — never shared state — with T10's `chat/`
 * store). Never edit an already-shipped migration's SQL after it has been released — add a new one
 * instead, the same discipline any real migration tool would enforce.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE groups (
         group_id TEXT PRIMARY KEY,
         name TEXT NOT NULL,
         protected INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE TABLE group_permissions (
         group_id TEXT NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
         permission TEXT NOT NULL,
         PRIMARY KEY (group_id, permission)
       )`,
      `CREATE TABLE identity_group_memberships (
         identity_id TEXT NOT NULL,
         group_id TEXT NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
         granted_at INTEGER NOT NULL,
         PRIMARY KEY (identity_id, group_id)
       )`,
      `CREATE INDEX idx_memberships_identity ON identity_group_memberships(identity_id)`,
      `CREATE TABLE tokens (
         token_digest TEXT PRIMARY KEY,
         kind TEXT NOT NULL,
         group_id TEXT NOT NULL REFERENCES groups(group_id) ON DELETE CASCADE,
         created_at INTEGER NOT NULL,
         expires_at INTEGER,
         consumed_at INTEGER,
         consumed_by_identity_id TEXT
       )`,
      `CREATE TABLE bans (
         identity_id TEXT PRIMARY KEY,
         created_at INTEGER NOT NULL,
         expires_at INTEGER,
         reason TEXT
       )`,
    ],
  },
];
