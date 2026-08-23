import type { Migration } from '../storage/sqlite-store-utils.js';

/**
 * T13.3 profile/avatar/presence-preference migrations — see `../authorization/migrations.ts`'s own
 * doc comment for why this is a hand-rolled ordered list rather than a migration framework, and
 * `../channels/migrations.ts`'s own doc comment for why this lives in its own physical database file
 * (`profiles.sqlite`), separate from `authorization.sqlite`/`chat.sqlite`/`channels.sqlite` — same
 * reasoning: retention-policy independence, an asymmetric acceptable-loss profile (an avatar/status
 * is cosmetic, unlike a ban record or chat history), and module-boundary consistency (a
 * `SqliteProfileStore` problem can never jeopardize authorization/chat/channel state, and all four
 * stores can be backed up/retained on independent schedules).
 *
 * **Data minimization is mandatory, not optional** (matching T13.2's own explicit precedent of
 * refusing to add a `lastSeen` column): this schema deliberately has **no** nickname column
 * anywhere (nickname is sourced live from the current connection via `PresenceRegistry`, never
 * persisted here — see `profile-port.ts`'s own doc comment) and no email/phone/birthday/real-name/
 * IP/device-fingerprint/geo/game-history/presence-history/`lastSeen` column of any kind. Only
 * genuinely persistent, user-controlled presentation data is stored: avatar bytes/format/hash/
 * revision, a custom status string, and a manual presence preference.
 *
 * `avatar_assets` is a content table, not keyed by identity — `identity_profiles.avatar_asset_id`/
 * `server_profile.avatar_asset_id` reference the *current* asset only; replacing an avatar deletes
 * the old `avatar_assets` row in the same transaction (garbage-collected immediately, no history/
 * rollback — matches T13.2's channel-password precedent exactly, see `store.ts`). `asset_id` is
 * `randomUUID()`, never derived from `identity_id` in any way.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE avatar_assets (
         asset_id     TEXT PRIMARY KEY,
         format       TEXT NOT NULL CHECK (format IN ('png','jpeg','webp')),
         byte_length  INTEGER NOT NULL,
         sha256_hex   TEXT NOT NULL,
         image_bytes  BLOB NOT NULL,
         created_at   INTEGER NOT NULL
       )`,
      `CREATE TABLE identity_profiles (
         identity_id         TEXT PRIMARY KEY,
         presence_preference TEXT NOT NULL DEFAULT 'online'
                              CHECK (presence_preference IN ('online','away','dnd')),
         custom_status       TEXT,
         avatar_asset_id     TEXT REFERENCES avatar_assets(asset_id) ON DELETE SET NULL,
         avatar_revision     INTEGER NOT NULL DEFAULT 0,
         updated_at          INTEGER NOT NULL
       )`,
      `CREATE TABLE server_profile (
         singleton_id     INTEGER PRIMARY KEY CHECK (singleton_id = 1),
         avatar_asset_id  TEXT REFERENCES avatar_assets(asset_id) ON DELETE SET NULL,
         avatar_revision  INTEGER NOT NULL DEFAULT 0,
         updated_at       INTEGER NOT NULL
       )`,
    ],
  },
];
