import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  AVATAR_MAX_RAW_BYTES,
  type AvatarImageFormat,
  type AvatarRef,
  type PresenceStatus,
} from '@disco-voador/protocol';
import type {
  AvatarData,
  ProfilePort,
  ProfileSnapshot,
  SetAvatarResult,
} from '@disco-voador/realtime';
import { validateAvatarImage } from '@disco-voador/shared';

import { openManagedDatabase, withTransaction } from '../storage/sqlite-store-utils.js';
import { MIGRATIONS } from './migrations.js';

/**
 * T13.3 persistent profile storage, backed by `node:sqlite`'s `DatabaseSync` — its own physical file
 * (`profiles.sqlite`), entirely separate from `authorization.sqlite`/`chat.sqlite`/`channels.sqlite`
 * (see `migrations.ts`'s own doc comment for why).
 *
 * Implements `ProfilePort` (`@disco-voador/realtime`) — `services/realtime` only ever calls through
 * that narrow interface, never anything SQLite-specific. Image validation
 * (`@disco-voador/shared`'s `validateAvatarImage`) is always run *before* any write — this class
 * never persists bytes that failed sniffing/dimension checks, and a replace is always "validate new,
 * then atomically swap and delete old," never "delete old, then validate new" (which would leave a
 * user with no avatar at all if the new upload turns out to be invalid).
 */

/** Pixel-dimension ceilings differ by target while the byte budget
 * ({@link AVATAR_MAX_RAW_BYTES}) does not — see `packages/protocol/src/profile.ts`'s own doc
 * comment for why. */
const USER_AVATAR_MAX_DIMENSION = 512;
const SERVER_AVATAR_MAX_DIMENSION = 1024;

const SERVER_PROFILE_SINGLETON_ID = 1;

interface IdentityProfileRow {
  readonly identity_id: string;
  readonly presence_preference: string;
  readonly custom_status: string | null;
  readonly avatar_asset_id: string | null;
  readonly avatar_revision: number;
  readonly updated_at: number;
  readonly identity_ref: string | null;
}

interface ServerProfileRow {
  readonly singleton_id: number;
  readonly avatar_asset_id: string | null;
  readonly avatar_revision: number;
  readonly updated_at: number;
}

interface AvatarAssetRow {
  readonly asset_id: string;
  readonly format: string;
  readonly byte_length: number;
  readonly sha256_hex: string;
  readonly image_bytes: Uint8Array;
  readonly created_at: number;
}

function toAvatarRef(
  assetRow: AvatarAssetRow | undefined,
  revision: number,
): AvatarRef | undefined {
  if (!assetRow) return undefined;
  return { revision, hash: assetRow.sha256_hex };
}

function toAvatarData(assetRow: AvatarAssetRow | undefined): AvatarData | undefined {
  if (!assetRow) return undefined;
  return {
    format: assetRow.format as AvatarImageFormat,
    bytes: Buffer.from(assetRow.image_bytes),
    avatarRef: { revision: -1, hash: assetRow.sha256_hex }, // revision overwritten by the caller
  };
}

export interface ProfileStoreOptions {
  readonly now?: () => number;
}

export class SqliteProfileStore implements ProfilePort {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  private readonly selectIdentityProfileStmt;
  private readonly upsertIdentityProfileAvatarStmt;
  private readonly upsertIdentityProfileStatusStmt;
  private readonly upsertIdentityProfilePresenceStmt;
  private readonly selectServerProfileStmt;
  private readonly upsertServerProfileAvatarStmt;
  private readonly insertAvatarAssetStmt;
  private readonly selectAvatarAssetStmt;
  private readonly deleteAvatarAssetStmt;
  private readonly selectIdentityRefStmt;
  private readonly upsertIdentityRefStmt;

  constructor(path: string, options: ProfileStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());

    const { db } = openManagedDatabase(path, MIGRATIONS, this.now);
    this.db = db;

    this.selectIdentityProfileStmt = this.db.prepare(
      'SELECT * FROM identity_profiles WHERE identity_id = ?',
    );
    this.upsertIdentityProfileAvatarStmt = this.db.prepare(
      `INSERT INTO identity_profiles (identity_id, avatar_asset_id, avatar_revision, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(identity_id) DO UPDATE SET
         avatar_asset_id = excluded.avatar_asset_id,
         avatar_revision = excluded.avatar_revision,
         updated_at = excluded.updated_at`,
    );
    this.upsertIdentityProfileStatusStmt = this.db.prepare(
      `INSERT INTO identity_profiles (identity_id, custom_status, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(identity_id) DO UPDATE SET
         custom_status = excluded.custom_status,
         updated_at = excluded.updated_at`,
    );
    this.upsertIdentityProfilePresenceStmt = this.db.prepare(
      `INSERT INTO identity_profiles (identity_id, presence_preference, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(identity_id) DO UPDATE SET
         presence_preference = excluded.presence_preference,
         updated_at = excluded.updated_at`,
    );
    this.selectServerProfileStmt = this.db.prepare(
      'SELECT * FROM server_profile WHERE singleton_id = ?',
    );
    this.upsertServerProfileAvatarStmt = this.db.prepare(
      `INSERT INTO server_profile (singleton_id, avatar_asset_id, avatar_revision, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(singleton_id) DO UPDATE SET
         avatar_asset_id = excluded.avatar_asset_id,
         avatar_revision = excluded.avatar_revision,
         updated_at = excluded.updated_at`,
    );
    this.insertAvatarAssetStmt = this.db.prepare(
      `INSERT INTO avatar_assets (asset_id, format, byte_length, sha256_hex, image_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    this.selectAvatarAssetStmt = this.db.prepare('SELECT * FROM avatar_assets WHERE asset_id = ?');
    this.deleteAvatarAssetStmt = this.db.prepare('DELETE FROM avatar_assets WHERE asset_id = ?');
    this.selectIdentityRefStmt = this.db.prepare(
      'SELECT identity_ref FROM identity_profiles WHERE identity_id = ?',
    );
    // `WHERE identity_profiles.identity_ref IS NULL` is defense-in-depth against a genuine race
    // (never actually reachable given `services/realtime`'s fully synchronous handler model — see
    // `profile-port.ts`'s own doc comment — but correct regardless): if a row already has a non-null
    // `identity_ref` by the time this runs, this upsert must never clobber it with a second, different
    // `randomUUID()`, since that would break the very reconnect-stability this column exists for.
    this.upsertIdentityRefStmt = this.db.prepare(
      `INSERT INTO identity_profiles (identity_id, identity_ref, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(identity_id) DO UPDATE SET
         identity_ref = excluded.identity_ref,
         updated_at = excluded.updated_at
       WHERE identity_profiles.identity_ref IS NULL`,
    );
  }

  // --- internal helpers --------------------------------------------------------------------

  private getIdentityProfileRow(identityId: string): IdentityProfileRow | undefined {
    return this.selectIdentityProfileStmt.get(identityId) as IdentityProfileRow | undefined;
  }

  private getServerProfileRow(): ServerProfileRow | undefined {
    return this.selectServerProfileStmt.get(SERVER_PROFILE_SINGLETON_ID) as
      ServerProfileRow | undefined;
  }

  private getAvatarAssetRow(assetId: string | null): AvatarAssetRow | undefined {
    if (assetId === null) return undefined;
    return this.selectAvatarAssetStmt.get(assetId) as AvatarAssetRow | undefined;
  }

  /** Validates and persists a new avatar asset, replacing (and garbage-collecting) `oldAssetId` in
   * the same transaction — shared by {@link setUserAvatar}/{@link setServerAvatar}. Never persists
   * anything if validation fails. */
  private replaceAvatarAsset(
    format: AvatarImageFormat,
    rawBytes: Buffer,
    maxDimension: number,
    oldAssetId: string | null,
    persistReference: (newAssetId: string, newRevision: number, now: number) => void,
    oldRevision: number,
  ): SetAvatarResult {
    if (rawBytes.length > AVATAR_MAX_RAW_BYTES) {
      return {
        ok: false,
        code: 'AVATAR_TOO_LARGE',
        message: `Avatar image is ${String(rawBytes.length)} bytes, exceeding the maximum of ${String(AVATAR_MAX_RAW_BYTES)}`,
      };
    }

    const validation = validateAvatarImage(rawBytes, format, maxDimension);
    if (!validation.ok) {
      return { ok: false, code: validation.code, message: validation.message };
    }

    const sha256Hex = createHash('sha256').update(rawBytes).digest('hex');
    const newAssetId = randomUUID();
    const newRevision = oldRevision + 1;
    const now = this.now();

    withTransaction(this.db, () => {
      this.insertAvatarAssetStmt.run(newAssetId, format, rawBytes.length, sha256Hex, rawBytes, now);
      persistReference(newAssetId, newRevision, now);
      if (oldAssetId !== null) this.deleteAvatarAssetStmt.run(oldAssetId);
    });

    return { ok: true, avatarRef: { revision: newRevision, hash: sha256Hex } };
  }

  // --- ProfilePort ---------------------------------------------------------------------------

  getUserProfile(identityId: string): ProfileSnapshot {
    const row = this.getIdentityProfileRow(identityId);
    if (!row) {
      return { presencePreference: 'online', customStatus: undefined, avatarRef: undefined };
    }
    const assetRow = this.getAvatarAssetRow(row.avatar_asset_id);
    return {
      presencePreference: row.presence_preference as PresenceStatus,
      customStatus: row.custom_status ?? undefined,
      avatarRef: toAvatarRef(assetRow, row.avatar_revision),
    };
  }

  getServerProfile(): { readonly avatarRef: AvatarRef | undefined } {
    const row = this.getServerProfileRow();
    if (!row) return { avatarRef: undefined };
    const assetRow = this.getAvatarAssetRow(row.avatar_asset_id);
    return { avatarRef: toAvatarRef(assetRow, row.avatar_revision) };
  }

  setUserAvatar(identityId: string, format: AvatarImageFormat, rawBytes: Buffer): SetAvatarResult {
    const existing = this.getIdentityProfileRow(identityId);
    return this.replaceAvatarAsset(
      format,
      rawBytes,
      USER_AVATAR_MAX_DIMENSION,
      existing?.avatar_asset_id ?? null,
      (newAssetId, newRevision, now) => {
        this.upsertIdentityProfileAvatarStmt.run(identityId, newAssetId, newRevision, now);
      },
      existing?.avatar_revision ?? 0,
    );
  }

  clearUserAvatar(identityId: string): void {
    const existing = this.getIdentityProfileRow(identityId);
    if (!existing?.avatar_asset_id) return;
    const oldAssetId = existing.avatar_asset_id;
    const now = this.now();
    withTransaction(this.db, () => {
      this.upsertIdentityProfileAvatarStmt.run(identityId, null, existing.avatar_revision, now);
      this.deleteAvatarAssetStmt.run(oldAssetId);
    });
  }

  setServerAvatar(format: AvatarImageFormat, rawBytes: Buffer): SetAvatarResult {
    const existing = this.getServerProfileRow();
    return this.replaceAvatarAsset(
      format,
      rawBytes,
      SERVER_AVATAR_MAX_DIMENSION,
      existing?.avatar_asset_id ?? null,
      (newAssetId, newRevision, now) => {
        this.upsertServerProfileAvatarStmt.run(
          SERVER_PROFILE_SINGLETON_ID,
          newAssetId,
          newRevision,
          now,
        );
      },
      existing?.avatar_revision ?? 0,
    );
  }

  clearServerAvatar(): void {
    const existing = this.getServerProfileRow();
    if (!existing?.avatar_asset_id) return;
    const oldAssetId = existing.avatar_asset_id;
    const now = this.now();
    withTransaction(this.db, () => {
      this.upsertServerProfileAvatarStmt.run(
        SERVER_PROFILE_SINGLETON_ID,
        null,
        existing.avatar_revision,
        now,
      );
      this.deleteAvatarAssetStmt.run(oldAssetId);
    });
  }

  setCustomStatus(identityId: string, customStatus: string | undefined): void {
    this.upsertIdentityProfileStatusStmt.run(identityId, customStatus ?? null, this.now());
  }

  setPresencePreference(identityId: string, preference: PresenceStatus): void {
    this.upsertIdentityProfilePresenceStmt.run(identityId, preference, this.now());
  }

  getUserAvatarData(identityId: string): AvatarData | undefined {
    const row = this.getIdentityProfileRow(identityId);
    const assetRow = this.getAvatarAssetRow(row?.avatar_asset_id ?? null);
    const data = toAvatarData(assetRow);
    if (!data || !row) return undefined;
    return { ...data, avatarRef: { revision: row.avatar_revision, hash: data.avatarRef.hash } };
  }

  getServerAvatarData(): AvatarData | undefined {
    const row = this.getServerProfileRow();
    const assetRow = this.getAvatarAssetRow(row?.avatar_asset_id ?? null);
    const data = toAvatarData(assetRow);
    if (!data || !row) return undefined;
    return { ...data, avatarRef: { revision: row.avatar_revision, hash: data.avatarRef.hash } };
  }

  getOrCreateIdentityRef(identityId: string): string {
    const row = this.selectIdentityRefStmt.get(identityId) as
      { readonly identity_ref: string | null } | undefined;
    if (row?.identity_ref) return row.identity_ref;

    const identityRef = randomUUID();
    this.upsertIdentityRefStmt.run(identityId, identityRef, this.now());
    // The `WHERE ... IS NULL` guard above means a genuine concurrent winner (never reachable today,
    // see that statement's own doc comment) could leave this call's own `identityRef` unpersisted —
    // re-reading is what makes the *return value* correct regardless, not just the row.
    const persisted = this.selectIdentityRefStmt.get(identityId) as
      { readonly identity_ref: string | null } | undefined;
    return persisted?.identity_ref ?? identityRef;
  }

  close(): void {
    this.db.close();
  }
}
