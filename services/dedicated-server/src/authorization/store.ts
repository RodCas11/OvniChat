import { DatabaseSync } from 'node:sqlite';

import type {
  BanSummary,
  GroupBadge,
  GroupSummary,
  PermissionKey,
  TokenKind,
} from '@disco-voador/protocol';
import type {
  AdmissionResult,
  AuthorizationPort,
  AuthorizationSnapshot,
  BanResult,
  CreateGroupResult,
  CreateTokenResult,
  DeleteGroupResult,
  GrantGroupResult,
  RedeemTokenResult,
  RevokeGroupResult,
  UnbanResult,
  UpdateGroupResult,
} from '@disco-voador/realtime';

import { openManagedDatabase, withTransaction } from '../storage/sqlite-store-utils.js';
import { MIGRATIONS } from './migrations.js';
import {
  ALL_PERMISSION_KEYS,
  BUILT_IN_GROUPS,
  GUEST_GROUP_ID,
  PROTECTED_GROUP_IDS,
  SERVER_ADMIN_GROUP_ID,
} from './permissions.js';
import { digestServerToken, generateServerToken } from './token-crypto.js';

/**
 * T9 server-local authorization storage and RBAC evaluator, backed by `node:sqlite`'s
 * `DatabaseSync` (see `docs/adr/0013-authorization-storage-and-rbac.md` for why: zero new
 * dependencies, and a synchronous API that keeps token redemption atomic for free — every method
 * here runs to completion on the single-threaded Node event loop with no `await` in between a read
 * and its dependent write, so two "simultaneous" redemption attempts from different connections
 * are actually serialized by the runtime itself, not by any locking this class implements). See
 * `docs/architecture/SERVER_AUTHORIZATION.md` for the full design.
 *
 * Implements `AuthorizationPort` (`@disco-voador/realtime`) — `services/realtime` only ever calls
 * through that narrow interface, never anything SQLite-specific.
 */

interface GroupRow {
  readonly group_id: string;
  readonly name: string;
  readonly protected: number;
}

interface TokenRow {
  readonly token_digest: string;
  readonly kind: string;
  readonly group_id: string;
  readonly created_at: number;
  readonly expires_at: number | null;
  readonly consumed_at: number | null;
}

interface BanRow {
  readonly identity_id: string;
  readonly created_at: number;
  readonly expires_at: number | null;
  readonly reason: string | null;
}

export type AccessMode = 'open' | 'invite-only';

export interface AuthorizationStoreOptions {
  readonly accessMode: AccessMode;
  readonly now?: () => number;
}

function slugify(name: string): string {
  const base = name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 50);
  return base.length > 0 ? base : 'group';
}

export class AuthorizationStore implements AuthorizationPort {
  private readonly db: DatabaseSync;
  private readonly accessMode: AccessMode;
  private readonly now: () => number;

  private readonly selectGroupStmt;
  private readonly selectAllGroupsStmt;
  private readonly selectGroupPermissionsStmt;
  private readonly insertGroupStmt;
  private readonly insertPermissionStmt;
  private readonly deleteGroupPermissionsStmt;
  private readonly updateGroupNameStmt;
  private readonly deleteGroupStmt;
  private readonly selectMembershipsStmt;
  private readonly grantMembershipStmt;
  private readonly revokeMembershipStmt;
  private readonly countServerAdminsStmt;
  private readonly insertTokenStmt;
  private readonly selectTokenStmt;
  private readonly consumeTokenStmt;
  private readonly selectBanStmt;
  private readonly upsertBanStmt;
  private readonly deleteBanStmt;
  private readonly selectActiveBansStmt;
  private readonly selectGroupMembersStmt;

  constructor(path: string, options: AuthorizationStoreOptions) {
    this.accessMode = options.accessMode;
    this.now = options.now ?? (() => Date.now());

    const { db, wasFreshInit } = openManagedDatabase(path, MIGRATIONS, this.now);
    this.db = db;

    this.selectGroupStmt = this.db.prepare('SELECT * FROM groups WHERE group_id = ?');
    this.selectAllGroupsStmt = this.db.prepare('SELECT * FROM groups ORDER BY group_id');
    this.selectGroupPermissionsStmt = this.db.prepare(
      'SELECT permission FROM group_permissions WHERE group_id = ? ORDER BY permission',
    );
    this.insertGroupStmt = this.db.prepare(
      'INSERT INTO groups (group_id, name, protected) VALUES (?, ?, ?)',
    );
    this.insertPermissionStmt = this.db.prepare(
      'INSERT INTO group_permissions (group_id, permission) VALUES (?, ?)',
    );
    this.deleteGroupPermissionsStmt = this.db.prepare(
      'DELETE FROM group_permissions WHERE group_id = ?',
    );
    this.updateGroupNameStmt = this.db.prepare('UPDATE groups SET name = ? WHERE group_id = ?');
    this.deleteGroupStmt = this.db.prepare('DELETE FROM groups WHERE group_id = ?');
    this.selectMembershipsStmt = this.db.prepare(
      'SELECT group_id FROM identity_group_memberships WHERE identity_id = ? ORDER BY group_id',
    );
    this.grantMembershipStmt = this.db.prepare(
      'INSERT OR IGNORE INTO identity_group_memberships (identity_id, group_id, granted_at) VALUES (?, ?, ?)',
    );
    this.revokeMembershipStmt = this.db.prepare(
      'DELETE FROM identity_group_memberships WHERE identity_id = ? AND group_id = ?',
    );
    this.countServerAdminsStmt = this.db.prepare(
      'SELECT COUNT(*) AS count FROM identity_group_memberships WHERE group_id = ?',
    );
    this.insertTokenStmt = this.db.prepare(
      'INSERT INTO tokens (token_digest, kind, group_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
    );
    this.selectTokenStmt = this.db.prepare('SELECT * FROM tokens WHERE token_digest = ?');
    this.consumeTokenStmt = this.db.prepare(
      'UPDATE tokens SET consumed_at = ?, consumed_by_identity_id = ? WHERE token_digest = ? AND consumed_at IS NULL',
    );
    this.selectBanStmt = this.db.prepare('SELECT * FROM bans WHERE identity_id = ?');
    this.upsertBanStmt = this.db.prepare(
      `INSERT INTO bans (identity_id, created_at, expires_at, reason) VALUES (?, ?, ?, ?)
       ON CONFLICT(identity_id) DO UPDATE SET created_at = excluded.created_at,
         expires_at = excluded.expires_at, reason = excluded.reason`,
    );
    this.deleteBanStmt = this.db.prepare('DELETE FROM bans WHERE identity_id = ?');
    this.selectActiveBansStmt = this.db.prepare(
      'SELECT * FROM bans WHERE expires_at IS NULL OR expires_at > ? ORDER BY created_at DESC',
    );
    this.selectGroupMembersStmt = this.db.prepare(
      'SELECT identity_id FROM identity_group_memberships WHERE group_id = ?',
    );

    if (wasFreshInit) {
      this.seedFreshDatabase();
    }
  }

  /** Seeds the three built-in groups — only ever run once, immediately after this exact database
   * file was created for the first time. A fresh store deliberately mints no token and claims no
   * admin (T15 security fix): the one-time 'bootstrap'-kind token this used to also generate here
   * was minted inside the same long-running, supervised server process whose stdout is captured
   * wholesale by systemd/Docker log collectors (`journalctl -u chantivo-server`, `docker compose
   * logs`), so the raw admin-equivalent secret leaked into infrastructure logs on every fresh
   * install. The very first Server Admin credential a server ever has now comes exclusively from an
   * explicit, one-shot `chantivo-server admin-token create` invocation
   * (`cli-admin-token.ts`/`mintServerAdminRecoveryToken`) — a distinct process whose stdout is never
   * captured by the supervised service's log stream — using the exact same `createToken` mechanism
   * as every later recovery call, not a second, parallel minting path. */
  private seedFreshDatabase(): void {
    withTransaction(this.db, () => {
      for (const seed of BUILT_IN_GROUPS) {
        this.insertGroupStmt.run(seed.groupId, seed.name, 1);
        for (const permission of seed.permissions) {
          this.insertPermissionStmt.run(seed.groupId, permission);
        }
      }
    });
  }

  // --- Internal helpers ------------------------------------------------------------------------

  private getGroupRow(groupId: string): GroupRow | undefined {
    return this.selectGroupStmt.get(groupId) as GroupRow | undefined;
  }

  private getGroupPermissions(groupId: string): PermissionKey[] {
    const rows = this.selectGroupPermissionsStmt.all(groupId) as { permission: string }[];
    return rows.map((row) => row.permission as PermissionKey);
  }

  private getMembershipGroupIds(identityId: string): string[] {
    const rows = this.selectMembershipsStmt.all(identityId) as { group_id: string }[];
    return rows.map((row) => row.group_id);
  }

  private effectiveGroupIds(identityId: string): string[] {
    const groupIds = this.getMembershipGroupIds(identityId);
    return groupIds.length > 0 ? groupIds : [GUEST_GROUP_ID];
  }

  private snapshotFor(groupIds: readonly string[]): AuthorizationSnapshot {
    const groups: GroupBadge[] = [];
    const permissionSet = new Set<PermissionKey>();
    for (const groupId of groupIds) {
      const group = this.getGroupRow(groupId);
      if (!group) continue;
      groups.push({ groupId: group.group_id, name: group.name });
      for (const permission of this.getGroupPermissions(groupId)) permissionSet.add(permission);
    }
    return { groups, permissions: [...permissionSet] };
  }

  private isBanned(identityId: string): boolean {
    const row = this.selectBanStmt.get(identityId) as BanRow | undefined;
    if (!row) return false;
    if (row.expires_at !== null && row.expires_at <= this.now()) return false;
    return true;
  }

  /** The single atomic step every successful redemption goes through — a SQLite compare-and-swap
   * (`UPDATE ... WHERE consumed_at IS NULL`) followed by granting membership, wrapped in one
   * transaction (T9 Section 47/80: exactly one concurrent redeemer of the same token can ever
   * win). */
  private consumeTokenAndGrant(
    digest: string,
    identityId: string,
    groupId: string,
  ): { readonly ok: true } | { readonly ok: false } {
    return withTransaction(this.db, () => {
      const result = this.consumeTokenStmt.run(this.now(), identityId, digest);
      if (Number(result.changes) !== 1) return { ok: false };
      this.grantMembershipStmt.run(identityId, groupId, this.now());
      return { ok: true };
    });
  }

  private generateGroupId(name: string): string {
    const base = slugify(name);
    let candidate = base;
    let suffix = 1;
    while (this.getGroupRow(candidate)) {
      suffix += 1;
      candidate = `${base}-${String(suffix)}`.slice(0, 64);
    }
    return candidate;
  }

  // --- AuthorizationPort -------------------------------------------------------------------------

  admit(request: {
    readonly identityId: string;
    readonly nickname: string;
    readonly serverToken: string | undefined;
  }): AdmissionResult {
    if (this.isBanned(request.identityId)) {
      return { ok: false, code: 'BANNED', message: 'This identity is banned from this server' };
    }

    const existingGroupIds = this.getMembershipGroupIds(request.identityId);
    if (existingGroupIds.length > 0) {
      const snapshot = this.snapshotFor(existingGroupIds);
      return { ok: true, ...snapshot };
    }

    if (this.accessMode === 'open') {
      const snapshot = this.snapshotFor([GUEST_GROUP_ID]);
      return { ok: true, ...snapshot };
    }

    // accessMode === 'invite-only', no persistent membership: an invite token is mandatory.
    // Deliberately coarse (T9 Section 53/73): whether the token is absent, malformed, wrong kind,
    // expired, or already used, the admission-time rejection is always INVITE_REQUIRED — the more
    // specific TOKEN_* codes are reserved for the post-connection `redeemToken` path, where a
    // wrong guess should not disconnect an already-`ready` Guest (see `authorization-port.ts`).
    if (!request.serverToken) {
      return {
        ok: false,
        code: 'INVITE_REQUIRED',
        message: 'This server requires an invite token to connect',
      };
    }

    const digest = digestServerToken(request.serverToken);
    const row = this.selectTokenStmt.get(digest) as TokenRow | undefined;
    // A 'privilege'-kind token also satisfies admission, not only 'invite' (T9 Section 10, revised
    // T15) — otherwise a server started directly in `invite-only` mode would permanently lock its
    // own operator out: with no persistent membership and no invite yet issued, the token minted by
    // `chantivo-server admin-token create` (the sole initial-claim mechanism since T15's removal of
    // the one-time 'bootstrap'-kind token — see `seedFreshDatabase`'s doc comment) is the *only*
    // credential that could ever get them connected in the first place to redeem it. This is
    // deliberately no broader than before: 'privilege' tokens are already admin-issued-or-explicitly-
    // minted-by-an-operator-with-shell-access, never something an ordinary participant can generate
    // for themselves, so accepting them here (in addition to their existing role as post-connection
    // redeemable credentials) does not hand out any capability a 'privilege' token didn't already
    // carry.
    const usable =
      row !== undefined &&
      (row.kind === 'invite' || row.kind === 'privilege') &&
      row.consumed_at === null &&
      (row.expires_at === null || row.expires_at > this.now());
    if (!row || !usable) {
      return {
        ok: false,
        code: 'INVITE_REQUIRED',
        message: 'The supplied invite token is not valid',
      };
    }

    const consumed = this.consumeTokenAndGrant(digest, request.identityId, row.group_id);
    if (!consumed.ok) {
      // Lost an extremely unlikely race against another redemption of the same invite between the
      // read above and the atomic consume — still a defined, non-crashing outcome.
      return {
        ok: false,
        code: 'INVITE_REQUIRED',
        message: 'The supplied invite token is not valid',
      };
    }

    const snapshot = this.snapshotFor([row.group_id]);
    return { ok: true, ...snapshot };
  }

  can(identityId: string, permission: PermissionKey): boolean {
    const groupIds = this.effectiveGroupIds(identityId);
    return groupIds.some((groupId) => this.getGroupPermissions(groupId).includes(permission));
  }

  getSnapshot(identityId: string): AuthorizationSnapshot {
    return this.snapshotFor(this.effectiveGroupIds(identityId));
  }

  getPublicBadges(identityId: string): readonly GroupBadge[] {
    return this.snapshotFor(this.effectiveGroupIds(identityId)).groups;
  }

  /** T15 — whether any identity currently holds the built-in Server Admin group, i.e. whether this
   * server has ever had its initial admin claim completed (`chantivo-server admin-token create` +
   * a real redemption). Used by `cli.ts`'s startup banner to show the "run admin-token create" hint
   * only while genuinely unclaimed, never on every restart of an already-claimed server. Reuses the
   * same prepared statement `revokeGroup`'s last-admin protection already relies on. */
  hasAnyServerAdmin(): boolean {
    const row = this.countServerAdminsStmt.get(SERVER_ADMIN_GROUP_ID) as { count: number };
    return row.count > 0;
  }

  redeemToken(identityId: string, token: string): RedeemTokenResult {
    const digest = digestServerToken(token);
    const row = this.selectTokenStmt.get(digest) as TokenRow | undefined;
    if (!row) {
      return { ok: false, code: 'TOKEN_INVALID', message: 'This token is not recognized' };
    }
    if (row.consumed_at !== null) {
      return {
        ok: false,
        code: 'TOKEN_ALREADY_USED',
        message: 'This token has already been used',
      };
    }
    if (row.expires_at !== null && row.expires_at <= this.now()) {
      return { ok: false, code: 'TOKEN_EXPIRED', message: 'This token has expired' };
    }

    const consumed = this.consumeTokenAndGrant(digest, identityId, row.group_id);
    if (!consumed.ok) {
      return {
        ok: false,
        code: 'TOKEN_ALREADY_USED',
        message: 'This token has already been used',
      };
    }

    const group = this.getGroupRow(row.group_id);
    if (!group) {
      return { ok: false, code: 'TOKEN_INVALID', message: 'This token is not recognized' };
    }
    return { ok: true, group: { groupId: group.group_id, name: group.name } };
  }

  createToken(params: {
    readonly tokenKind: TokenKind;
    readonly groupId: string;
    readonly expiresInMs: number | undefined;
  }): CreateTokenResult {
    const group = this.getGroupRow(params.groupId);
    if (!group) {
      return { ok: false, code: 'GROUP_NOT_FOUND', message: `Unknown group "${params.groupId}"` };
    }

    const prefix = params.tokenKind === 'privilege' ? 'PRIV' : 'INVITE';
    const token = generateServerToken(prefix);
    const digest = digestServerToken(token);
    const now = this.now();
    const expiresAt = params.expiresInMs !== undefined ? now + params.expiresInMs : undefined;

    this.insertTokenStmt.run(digest, params.tokenKind, params.groupId, now, expiresAt ?? null);

    return { ok: true, token, tokenKind: params.tokenKind, groupId: params.groupId, expiresAt };
  }

  listGroups(): readonly GroupSummary[] {
    const rows = this.selectAllGroupsStmt.all() as unknown as GroupRow[];
    return rows.map((row) => ({
      groupId: row.group_id,
      name: row.name,
      permissions: this.getGroupPermissions(row.group_id),
      protectedGroup: row.protected === 1,
    }));
  }

  createGroup(params: {
    readonly name: string;
    readonly permissions: readonly PermissionKey[];
  }): CreateGroupResult {
    const groupId = this.generateGroupId(params.name);
    withTransaction(this.db, () => {
      this.insertGroupStmt.run(groupId, params.name, 0);
      for (const permission of params.permissions)
        this.insertPermissionStmt.run(groupId, permission);
    });
    return {
      ok: true,
      group: {
        groupId,
        name: params.name,
        permissions: [...params.permissions],
        protectedGroup: false,
      },
    };
  }

  updateGroup(params: {
    readonly groupId: string;
    readonly name: string | undefined;
    readonly permissions: readonly PermissionKey[] | undefined;
  }): UpdateGroupResult {
    const group = this.getGroupRow(params.groupId);
    if (!group) {
      return { ok: false, code: 'GROUP_NOT_FOUND', message: `Unknown group "${params.groupId}"` };
    }
    if (params.permissions !== undefined && params.groupId === SERVER_ADMIN_GROUP_ID) {
      return {
        ok: false,
        code: 'PROTECTED_GROUP',
        message: 'Server Admin permissions cannot be edited',
      };
    }

    withTransaction(this.db, () => {
      if (params.name !== undefined) this.updateGroupNameStmt.run(params.name, params.groupId);
      if (params.permissions !== undefined) {
        this.deleteGroupPermissionsStmt.run(params.groupId);
        for (const permission of params.permissions) {
          this.insertPermissionStmt.run(params.groupId, permission);
        }
      }
    });

    return {
      ok: true,
      group: {
        groupId: params.groupId,
        name: params.name ?? group.name,
        permissions: params.permissions
          ? [...params.permissions]
          : this.getGroupPermissions(params.groupId),
        protectedGroup: group.protected === 1,
      },
    };
  }

  deleteGroup(groupId: string): DeleteGroupResult {
    if (PROTECTED_GROUP_IDS.has(groupId)) {
      return { ok: false, code: 'PROTECTED_GROUP', message: 'Built-in groups cannot be deleted' };
    }
    const group = this.getGroupRow(groupId);
    if (!group) {
      return { ok: false, code: 'GROUP_NOT_FOUND', message: `Unknown group "${groupId}"` };
    }

    // T9 follow-up (security review): mirrors `revokeGroup`'s `stillAdmitted` symmetry — a custom
    // group is never protected from deletion, so deleting one that was an `invite-only` identity's
    // *sole* persistent membership must be detected the same way revocation detects it, not left to
    // silently fall back to the Guest baseline for the rest of that identity's live session.
    const memberRows = this.selectGroupMembersStmt.all(groupId) as { identity_id: string }[];
    const noLongerAdmitted = withTransaction(this.db, (): readonly string[] => {
      this.deleteGroupStmt.run(groupId);
      if (this.accessMode !== 'invite-only') return [];
      const affected: string[] = [];
      for (const row of memberRows) {
        if (this.getMembershipGroupIds(row.identity_id).length === 0)
          affected.push(row.identity_id);
      }
      return affected;
    });

    return { ok: true, noLongerAdmitted };
  }

  grantGroup(targetIdentityId: string, groupId: string): GrantGroupResult {
    const group = this.getGroupRow(groupId);
    if (!group) {
      return { ok: false, code: 'GROUP_NOT_FOUND', message: `Unknown group "${groupId}"` };
    }
    this.grantMembershipStmt.run(targetIdentityId, groupId, this.now());
    return { ok: true, snapshot: this.getSnapshot(targetIdentityId) };
  }

  revokeGroup(targetIdentityId: string, groupId: string): RevokeGroupResult {
    const group = this.getGroupRow(groupId);
    if (!group) {
      return { ok: false, code: 'GROUP_NOT_FOUND', message: `Unknown group "${groupId}"` };
    }

    const result = withTransaction(this.db, (): { readonly ok: true } | { readonly ok: false } => {
      if (groupId === SERVER_ADMIN_GROUP_ID) {
        const targetIsAdmin =
          this.getMembershipGroupIds(targetIdentityId).includes(SERVER_ADMIN_GROUP_ID);
        const adminCountRow = this.countServerAdminsStmt.get(SERVER_ADMIN_GROUP_ID) as {
          count: number;
        };
        if (targetIsAdmin && adminCountRow.count <= 1) {
          return { ok: false };
        }
      }
      this.revokeMembershipStmt.run(targetIdentityId, groupId);
      return { ok: true };
    });

    if (!result.ok) {
      return {
        ok: false,
        code: 'LAST_ADMIN',
        message: 'Cannot remove the last Server Admin from this server',
      };
    }

    const remainingGroupIds = this.getMembershipGroupIds(targetIdentityId);
    const stillAdmitted = this.accessMode === 'open' || remainingGroupIds.length > 0;
    return { ok: true, snapshot: this.getSnapshot(targetIdentityId), stillAdmitted };
  }

  ban(
    targetIdentityId: string,
    durationMs: number | undefined,
    reason: string | undefined,
  ): BanResult {
    const now = this.now();
    const expiresAt = durationMs !== undefined ? now + durationMs : null;
    this.upsertBanStmt.run(targetIdentityId, now, expiresAt, reason ?? null);
    return { ok: true };
  }

  unban(identityId: string): UnbanResult {
    const wasBanned = this.selectBanStmt.get(identityId) !== undefined;
    this.deleteBanStmt.run(identityId);
    return { ok: true, wasBanned };
  }

  listBans(): readonly BanSummary[] {
    const rows = this.selectActiveBansStmt.all(this.now()) as unknown as BanRow[];
    return rows.map((row) => ({
      identityId: row.identity_id,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? undefined,
      reason: row.reason ?? undefined,
    }));
  }

  close(): void {
    this.db.close();
  }
}

/** Re-exported for callers that need the closed permission registry without constructing a store
 * (e.g. the Dedicated Server CLI's future admin tooling). */
export { ALL_PERMISSION_KEYS };
