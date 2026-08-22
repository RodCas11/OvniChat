import type { Migration } from '../storage/sqlite-store-utils.js';

/**
 * T13.2 channel/category tree migrations — see `../authorization/migrations.ts`'s own doc comment
 * for why this is a hand-rolled ordered list rather than a migration framework, and this task's
 * design notes for why this lives in its own physical database file (`channels.sqlite`), separate
 * from both `authorization.sqlite` and `chat.sqlite` — same reasoning ADR 0014 already gave for
 * `chat.sqlite`: retention-policy independence, an asymmetric acceptable-loss profile, and
 * module-boundary consistency (a `ChannelStore` problem can never jeopardize authorization or chat
 * state, and all three stores can be backed up/retained on independent schedules).
 *
 * `channel_acl_groups.group_id` is deliberately **not** a `FOREIGN KEY` into any table in
 * `authorization.sqlite` — that is a different SQLite file entirely (cross-database foreign keys do
 * not exist in SQLite), and even if it were the same file, `ChannelStore` must remain structurally
 * unaware of `AuthorizationStore` (see `services/realtime/src/channel-port.ts`'s design rule 1: no
 * circular import between the two dedicated-server store classes). This is exactly what dissolves
 * the cross-file-delete hazard: tombstoning a channel needs zero corresponding write in
 * `chat.sqlite`, and deleting a group needs zero corresponding write here (see
 * `handleAuthorizationDeleteGroup`'s `isGroupReferenced` guard in `services/realtime`, which runs
 * *before* a group can be deleted at all, rather than relying on a cascade).
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE channel_nodes (
         node_id            TEXT PRIMARY KEY,
         kind               TEXT NOT NULL CHECK (kind IN ('category','voice')),
         parent_id          TEXT REFERENCES channel_nodes(node_id) ON DELETE RESTRICT,
         name               TEXT NOT NULL,
         sort_order         INTEGER NOT NULL,
         visibility_policy  TEXT NOT NULL DEFAULT 'inherit' CHECK (visibility_policy IN ('inherit','everyone','selected-groups')),
         join_policy        TEXT NOT NULL DEFAULT 'inherit' CHECK (join_policy IN ('inherit','everyone','selected-groups')),
         manage_policy      TEXT NOT NULL DEFAULT 'inherit' CHECK (manage_policy IN ('inherit','selected-groups')),
         user_limit         INTEGER,
         password_verifier  TEXT,
         created_at         INTEGER NOT NULL,
         updated_at         INTEGER NOT NULL,
         deleted_at         INTEGER,
         legacy_seed        INTEGER NOT NULL DEFAULT 0
       )`,
      `CREATE INDEX idx_channel_nodes_parent ON channel_nodes(parent_id)`,
      `CREATE INDEX idx_channel_nodes_active ON channel_nodes(deleted_at)`,
      `CREATE TABLE channel_acl_groups (
         node_id     TEXT NOT NULL REFERENCES channel_nodes(node_id) ON DELETE CASCADE,
         policy_kind TEXT NOT NULL CHECK (policy_kind IN ('visibility','join','manage')),
         group_id    TEXT NOT NULL,
         PRIMARY KEY (node_id, policy_kind, group_id)
       )`,
    ],
  },
];
