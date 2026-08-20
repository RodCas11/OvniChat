import type { Migration } from '../storage/sqlite-store-utils.js';

/**
 * T10 chat store migrations — see `authorization/migrations.ts`'s own doc comment for why this is a
 * hand-rolled ordered list rather than a migration framework, and
 * `docs/adr/0014-persistent-server-owned-chat-history.md` for why this lives in its own physical
 * database file (`chat.sqlite`) rather than sharing `authorization.sqlite`.
 *
 * `message_id` is `INTEGER PRIMARY KEY AUTOINCREMENT` — SQLite's own monotonically-increasing rowid
 * is the ordering *and* pagination-cursor authority (never `created_at` alone, which two messages
 * can share to the millisecond — T10 Section 18/19). `channel_id` is `NULL` for `scope = 'server'`
 * rows; two indexes cover the two read patterns this store's queries actually use (T10 Section 17):
 * "most recent/paginated server-scope messages" and "most recent/paginated messages for one
 * channel." No `FOREIGN KEY` to any table in `authorization.sqlite` — that is a *different SQLite
 * file* (cross-database foreign keys do not exist in SQLite), and even if it were the same file, a
 * Guest with zero authorization rows must still be able to send and have their message persisted
 * (T10 Section 52: chat authorship is never gated on having a persistent authorization record).
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE chat_messages (
         message_id INTEGER PRIMARY KEY AUTOINCREMENT,
         scope TEXT NOT NULL,
         channel_id TEXT,
         sender_identity_id TEXT NOT NULL,
         sender_nickname_at_send TEXT NOT NULL,
         body TEXT NOT NULL,
         created_at INTEGER NOT NULL
       )`,
      `CREATE INDEX idx_chat_messages_server_order ON chat_messages(scope, message_id)`,
      `CREATE INDEX idx_chat_messages_channel_order ON chat_messages(scope, channel_id, message_id)`,
    ],
  },
];
