import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  MAX_CHANNEL_DEPTH,
  MAX_CHANNEL_PARTICIPANTS,
  MAX_CHANNEL_TREE_NODES,
  type AclPolicyKind,
  type ChannelNodeAdminView,
  type ChannelNodeView,
  type ManagePolicyKind,
  type NodeKind,
  type VoiceChannelSummary,
} from '@disco-voador/protocol';
import type {
  CanJoinResult,
  ChannelPort,
  ChannelTreeSnapshot,
  CreateNodeResult,
  DeleteNodeResult,
  MoveNodeResult,
  ReorderResult,
  SetPasswordResult,
  UpdateNodeResult,
} from '@disco-voador/realtime';

import { openManagedDatabase, withTransaction } from '../storage/sqlite-store-utils.js';
import { MIGRATIONS } from './migrations.js';

/**
 * T13.2 channel/category tree storage and ACL evaluator, backed by `node:sqlite`'s `DatabaseSync` —
 * its own physical file (`channels.sqlite`), entirely separate from both `authorization.sqlite` and
 * `chat.sqlite` (see `migrations.ts`'s own doc comment for why).
 *
 * Implements `ChannelPort` (`@disco-voador/realtime`) — `services/realtime` only ever calls through
 * that narrow interface, never anything SQLite-specific. See that interface's own doc comment for
 * the full ACL-resolution algorithm (visibility/join/manage) this class implements exactly, and for
 * why this class never imports `AuthorizationStore` or knows about `PermissionKey`s at all.
 */

interface ChannelNodeRow {
  readonly node_id: string;
  readonly kind: NodeKind;
  readonly parent_id: string | null;
  readonly name: string;
  readonly sort_order: number;
  readonly visibility_policy: AclPolicyKind;
  readonly join_policy: AclPolicyKind;
  readonly manage_policy: ManagePolicyKind;
  readonly user_limit: number | null;
  readonly password_verifier: string | null;
  readonly created_at: number;
  readonly updated_at: number;
  readonly deleted_at: number | null;
  readonly legacy_seed: number;
}

export type ChannelPolicyKind = 'visibility' | 'join' | 'manage';

// --- Password verifier (scrypt) -----------------------------------------------------------------

/**
 * `node:crypto`'s own `scryptSync` defaults, unmodified (`N=16384, r=8, p=1, keyLen=64`) —
 * deliberately the lighter end of OWASP's range, since this is a shared-event-loop, self-hosted
 * small-room server, not a dedicated auth service. Called synchronously, inside the already-
 * synchronous `voice:join` hot path — this preserves this codebase's "no async gap in the
 * connection hot path" invariant (`AuthorizationPort`/`ChatPort`'s own doc comments). The ~30-80ms
 * blocking cost this adds per password attempt is an accepted, deliberate tradeoff, mitigated by
 * `services/realtime`'s `channelPasswordRateLimiter` (a password check is the very last step of
 * `checkJoin`, after visibility/join/capacity, so it is never wasted on a request that was already
 * going to fail).
 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;
const SCRYPT_SALT_BYTES = 16;

/** `scrypt$1$<N>$<r>$<p>$<saltBase64url>$<hashBase64url>` — version + all three cost parameters
 * embedded so a future cost bump never invalidates old verifiers; {@link verifyChannelPassword}
 * reads N/r/p from the string itself, never from the current `SCRYPT_*` constants. */
function hashChannelPassword(password: string): string {
  const salt = randomBytes(SCRYPT_SALT_BYTES);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return `scrypt$1$${String(SCRYPT_N)}$${String(SCRYPT_R)}$${String(SCRYPT_P)}$${salt.toString('base64url')}$${hash.toString('base64url')}`;
}

function verifyChannelPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 7 || parts[0] !== 'scrypt') return false;
  const [, , nRaw, rRaw, pRaw, saltRaw, hashRaw] = parts;
  const n = Number(nRaw);
  const r = Number(rRaw);
  const p = Number(pRaw);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltRaw ?? '', 'base64url');
    expected = Buffer.from(hashRaw ?? '', 'base64url');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length, { N: n, r, p });
  return timingSafeEqual(actual, expected);
}

// --- Store ---------------------------------------------------------------------------------------

export interface ChannelStoreOptions {
  readonly now?: () => number;
  /** Seeds the legacy-preserved channels (`general`/`games`/`afk` by default) at first-ever
   * database initialization only — mirrors `AuthorizationStore`'s own `wasFreshInit` seeding
   * discipline. Never re-applied to an existing database. */
  readonly seed?: readonly VoiceChannelSummary[];
}

export class ChannelStore implements ChannelPort {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  private readonly selectNodeStmt;
  private readonly selectAllActiveStmt;
  private readonly selectActiveChildrenStmt;
  private readonly insertNodeStmt;
  private readonly updateNodeStmt;
  private readonly updateSortOrderStmt;
  private readonly updateParentStmt;
  private readonly updatePasswordStmt;
  private readonly updateDeletedAtStmt;
  private readonly selectAclStmt;
  private readonly deleteAclForPolicyStmt;
  private readonly insertAclStmt;
  private readonly selectAclReferenceStmt;
  private readonly selectMaxSortOrderStmt;

  constructor(path: string, options: ChannelStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());

    const { db, wasFreshInit } = openManagedDatabase(path, MIGRATIONS, this.now);
    this.db = db;

    this.selectNodeStmt = this.db.prepare(
      'SELECT * FROM channel_nodes WHERE node_id = ? AND deleted_at IS NULL',
    );
    this.selectAllActiveStmt = this.db.prepare(
      'SELECT * FROM channel_nodes WHERE deleted_at IS NULL ORDER BY sort_order, node_id',
    );
    this.selectActiveChildrenStmt = this.db.prepare(
      'SELECT node_id FROM channel_nodes WHERE parent_id IS ? AND deleted_at IS NULL',
    );
    this.insertNodeStmt = this.db.prepare(
      `INSERT INTO channel_nodes
         (node_id, kind, parent_id, name, sort_order, visibility_policy, join_policy, manage_policy,
          user_limit, password_verifier, created_at, updated_at, deleted_at, legacy_seed)
       VALUES (?, ?, ?, ?, ?, 'inherit', 'inherit', 'inherit', NULL, NULL, ?, ?, NULL, ?)`,
    );
    this.updateNodeStmt = this.db.prepare(
      `UPDATE channel_nodes SET
         name = COALESCE(?, name),
         visibility_policy = COALESCE(?, visibility_policy),
         join_policy = COALESCE(?, join_policy),
         manage_policy = COALESCE(?, manage_policy),
         user_limit = ?,
         updated_at = ?
       WHERE node_id = ?`,
    );
    this.updateSortOrderStmt = this.db.prepare(
      'UPDATE channel_nodes SET sort_order = ?, updated_at = ? WHERE node_id = ?',
    );
    this.updateParentStmt = this.db.prepare(
      'UPDATE channel_nodes SET parent_id = ?, sort_order = ?, updated_at = ? WHERE node_id = ?',
    );
    this.updatePasswordStmt = this.db.prepare(
      'UPDATE channel_nodes SET password_verifier = ?, updated_at = ? WHERE node_id = ?',
    );
    this.updateDeletedAtStmt = this.db.prepare(
      'UPDATE channel_nodes SET deleted_at = ?, updated_at = ? WHERE node_id = ?',
    );
    this.selectAclStmt = this.db.prepare(
      'SELECT group_id FROM channel_acl_groups WHERE node_id = ? AND policy_kind = ?',
    );
    this.deleteAclForPolicyStmt = this.db.prepare(
      'DELETE FROM channel_acl_groups WHERE node_id = ? AND policy_kind = ?',
    );
    this.insertAclStmt = this.db.prepare(
      'INSERT OR IGNORE INTO channel_acl_groups (node_id, policy_kind, group_id) VALUES (?, ?, ?)',
    );
    this.selectAclReferenceStmt = this.db.prepare(
      `SELECT 1 FROM channel_acl_groups a
         JOIN channel_nodes n ON n.node_id = a.node_id
        WHERE a.group_id = ? AND n.deleted_at IS NULL LIMIT 1`,
    );
    this.selectMaxSortOrderStmt = this.db.prepare(
      'SELECT MAX(sort_order) AS max_sort_order FROM channel_nodes WHERE parent_id IS ? AND deleted_at IS NULL',
    );

    if (wasFreshInit) {
      this.seedFreshDatabase(options.seed ?? []);
    }
  }

  private seedFreshDatabase(seed: readonly VoiceChannelSummary[]): void {
    withTransaction(this.db, () => {
      seed.forEach((channel, index) => {
        const now = this.now();
        this.insertNodeStmt.run(channel.channelId, 'voice', null, channel.name, index, now, now, 1);
      });
    });
  }

  // --- Internal helpers ------------------------------------------------------------------------

  private getRow(nodeId: string): ChannelNodeRow | undefined {
    return this.selectNodeStmt.get(nodeId) as ChannelNodeRow | undefined;
  }

  private getAllActive(): ChannelNodeRow[] {
    return this.selectAllActiveStmt.all() as unknown as ChannelNodeRow[];
  }

  private getAclGroupIds(nodeId: string, policyKind: ChannelPolicyKind): string[] {
    const rows = this.selectAclStmt.all(nodeId, policyKind) as { group_id: string }[];
    return rows.map((row) => row.group_id);
  }

  private setAclGroupIds(
    nodeId: string,
    policyKind: ChannelPolicyKind,
    groupIds: readonly string[],
  ): void {
    this.deleteAclForPolicyStmt.run(nodeId, policyKind);
    for (const groupId of groupIds) this.insertAclStmt.run(nodeId, policyKind, groupId);
  }

  /** The ancestor chain **root-first** (`[root, ..., parent(N), N]`) — used by visibility
   * resolution, which walks top-down. Built from an in-memory row map so the whole tree (bounded at
   * {@link MAX_CHANNEL_TREE_NODES}) never needs more than one query per call site. */
  private chainRootFirst(
    nodeId: string,
    byId: ReadonlyMap<string, ChannelNodeRow>,
  ): ChannelNodeRow[] {
    const chain: ChannelNodeRow[] = [];
    let current: ChannelNodeRow | undefined = byId.get(nodeId);
    const seen = new Set<string>();
    while (current && !seen.has(current.node_id)) {
      seen.add(current.node_id);
      chain.push(current);
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    return chain.reverse();
  }

  private intersects(a: readonly string[], b: readonly string[]): boolean {
    if (a.length === 0 || b.length === 0) return false;
    const set = new Set(a);
    return b.some((value) => set.has(value));
  }

  /**
   * Visibility bounds all descendants (see `ChannelPort`'s ACL-resolution doc comment): walk the
   * chain top-down; any ancestor with `visibilityPolicy === 'selected-groups'` whose group list
   * does not intersect `effectiveGroupIds` makes every node below it (including itself) invisible.
   * `'everyone'`/`'inherit'` never add a restriction. An all-`'inherit'` chain is visible to
   * everyone (the hardcoded root default).
   */
  private isVisible(
    chainRootFirst: readonly ChannelNodeRow[],
    effectiveGroupIds: readonly string[],
  ): boolean {
    for (const node of chainRootFirst) {
      if (node.visibility_policy === 'selected-groups') {
        const groupIds = this.getAclGroupIds(node.node_id, 'visibility');
        if (!this.intersects(groupIds, effectiveGroupIds)) return false;
      }
    }
    return true;
  }

  /** Nearest-non-`'inherit'`-ancestor evaluation for Join, walking bottom-up (`N` first). An
   * all-`'inherit'` chain resolves to `'everyone'` (always allowed). Does not bound descendants. */
  private isJoinable(nodeId: string, effectiveGroupIds: readonly string[]): boolean {
    const byId = new Map(this.getAllActive().map((row) => [row.node_id, row]));
    let current = byId.get(nodeId);
    while (current) {
      if (current.join_policy === 'everyone') return true;
      if (current.join_policy === 'selected-groups') {
        return this.intersects(this.getAclGroupIds(current.node_id, 'join'), effectiveGroupIds);
      }
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    return true;
  }

  /** Same nearest-non-`'inherit'`-ancestor walk as Join, but only `'inherit'`/`'selected-groups'`
   * are valid manage-policy values — an all-`'inherit'` chain has no local Manage holder at all
   * (only a global `channels.manage` override, evaluated entirely outside this class, can still
   * authorize such a node). Does not bound descendants (delegated administration is the point). */
  private resolveManage(nodeId: string, effectiveGroupIds: readonly string[]): boolean {
    const byId = new Map(this.getAllActive().map((row) => [row.node_id, row]));
    let current = byId.get(nodeId);
    while (current) {
      if (current.manage_policy === 'selected-groups') {
        return this.intersects(this.getAclGroupIds(current.node_id, 'manage'), effectiveGroupIds);
      }
      current = current.parent_id ? byId.get(current.parent_id) : undefined;
    }
    return false;
  }

  private depthOf(nodeId: string | undefined, byId: ReadonlyMap<string, ChannelNodeRow>): number {
    if (nodeId === undefined) return -1;
    return this.chainRootFirst(nodeId, byId).length - 1;
  }

  /** The maximum relative depth of `nodeId`'s own subtree (0 for a leaf) — used by `moveNode` to
   * ensure moving a subtree deeper never pushes any descendant past `MAX_CHANNEL_DEPTH`. */
  private subtreeMaxRelativeDepth(
    nodeId: string,
    byId: ReadonlyMap<string, ChannelNodeRow>,
  ): number {
    let max = 0;
    for (const row of byId.values()) {
      if (row.parent_id !== nodeId) continue;
      max = Math.max(max, 1 + this.subtreeMaxRelativeDepth(row.node_id, byId));
    }
    return max;
  }

  private toWireView(row: ChannelNodeRow): ChannelNodeView {
    return {
      nodeId: row.node_id,
      kind: row.kind,
      ...(row.parent_id ? { parentId: row.parent_id } : {}),
      name: row.name,
      sortOrder: row.sort_order,
      visibilityPolicy: row.visibility_policy,
      joinPolicy: row.join_policy,
      managePolicy: row.manage_policy,
      ...(row.user_limit !== null ? { userLimit: row.user_limit } : {}),
      hasPassword: row.password_verifier !== null,
      temporary: false,
    };
  }

  private toAdminView(row: ChannelNodeRow): ChannelNodeAdminView {
    return {
      ...this.toWireView(row),
      visibilityGroupIds: this.getAclGroupIds(row.node_id, 'visibility'),
      joinGroupIds: this.getAclGroupIds(row.node_id, 'join'),
      manageGroupIds: this.getAclGroupIds(row.node_id, 'manage'),
    };
  }

  private nextSortOrder(parentId: string | undefined): number {
    const row = this.selectMaxSortOrderStmt.get(parentId ?? null) as {
      max_sort_order: number | null;
    };
    return row.max_sort_order === null ? 0 : row.max_sort_order + 1;
  }

  private createNode(
    kind: NodeKind,
    params: { readonly name: string; readonly parentId: string | undefined },
  ): CreateNodeResult {
    if (kind === 'category' && params.parentId !== undefined) {
      return {
        ok: false,
        code: 'CHANNEL_PARENT_INVALID',
        message: 'A category can never have a parent',
      };
    }

    const byId = new Map(this.getAllActive().map((row) => [row.node_id, row]));
    if (byId.size >= MAX_CHANNEL_TREE_NODES) {
      return {
        ok: false,
        code: 'CHANNEL_TREE_LIMIT_EXCEEDED',
        message: `The channel tree is at its maximum of ${String(MAX_CHANNEL_TREE_NODES)} nodes`,
      };
    }

    if (params.parentId !== undefined) {
      const parent = byId.get(params.parentId);
      if (!parent) {
        return {
          ok: false,
          code: 'CHANNEL_PARENT_INVALID',
          message: `Unknown or deleted parent "${params.parentId}"`,
        };
      }
      const parentDepth = this.depthOf(params.parentId, byId);
      if (parentDepth + 1 > MAX_CHANNEL_DEPTH - 1) {
        return {
          ok: false,
          code: 'CHANNEL_PARENT_INVALID',
          message: 'Maximum channel nesting depth exceeded',
        };
      }
    }

    const nodeId = randomUUID();
    const now = this.now();
    const sortOrder = this.nextSortOrder(params.parentId);
    withTransaction(this.db, () => {
      this.insertNodeStmt.run(
        nodeId,
        kind,
        params.parentId ?? null,
        params.name,
        sortOrder,
        now,
        now,
        0,
      );
    });

    const row = this.getRow(nodeId);
    if (!row) throw new Error('Invariant violated: node vanished immediately after insert');
    return { ok: true, node: this.toAdminView(row) };
  }

  // --- ChannelPort ---------------------------------------------------------------------------

  getFilteredTree(effectiveGroupIds: readonly string[]): ChannelTreeSnapshot {
    const rows = this.getAllActive();
    const byId = new Map(rows.map((row) => [row.node_id, row]));
    return rows
      .filter((row) => this.isVisible(this.chainRootFirst(row.node_id, byId), effectiveGroupIds))
      .map((row) => this.toWireView(row));
  }

  getVisibleNode(
    nodeId: string,
    effectiveGroupIds: readonly string[],
  ): ChannelNodeView | undefined {
    const row = this.getRow(nodeId);
    if (!row) return undefined;
    const byId = new Map(this.getAllActive().map((r) => [r.node_id, r]));
    if (!this.isVisible(this.chainRootFirst(nodeId, byId), effectiveGroupIds)) return undefined;
    return this.toWireView(row);
  }

  getEditableNode(nodeId: string): ChannelNodeAdminView | undefined {
    const row = this.getRow(nodeId);
    return row ? this.toAdminView(row) : undefined;
  }

  hasManageRights(nodeId: string, effectiveGroupIds: readonly string[]): boolean {
    if (!this.getRow(nodeId)) return false;
    return this.resolveManage(nodeId, effectiveGroupIds);
  }

  isGroupReferenced(groupId: string): boolean {
    return this.selectAclReferenceStmt.get(groupId) !== undefined;
  }

  checkJoin(params: {
    readonly nodeId: string;
    readonly effectiveGroupIds: readonly string[];
    readonly currentMemberCount: number;
    readonly password: string | undefined;
    readonly bypassPassword: boolean;
  }): CanJoinResult {
    const row = this.getRow(params.nodeId);
    if (!row) return { ok: false, code: 'NOT_FOUND' };

    const byId = new Map(this.getAllActive().map((r) => [r.node_id, r]));
    if (!this.isVisible(this.chainRootFirst(params.nodeId, byId), params.effectiveGroupIds)) {
      return { ok: false, code: 'NOT_FOUND' };
    }

    // Categories are never joinable, regardless of join policy — structurally enforced here, not
    // just by convention.
    if (row.kind === 'category') return { ok: false, code: 'ACCESS_DENIED' };

    if (!this.isJoinable(params.nodeId, params.effectiveGroupIds)) {
      return { ok: false, code: 'ACCESS_DENIED' };
    }

    const limit = row.user_limit ?? MAX_CHANNEL_PARTICIPANTS;
    if (params.currentMemberCount >= limit) {
      return { ok: false, code: 'FULL' };
    }

    if (row.password_verifier !== null && !params.bypassPassword) {
      if (params.password === undefined) return { ok: false, code: 'PASSWORD_REQUIRED' };
      if (!verifyChannelPassword(params.password, row.password_verifier)) {
        return { ok: false, code: 'PASSWORD_INVALID' };
      }
    }

    return { ok: true };
  }

  // Every mutation method below accepts `actorEffectiveGroupIds` purely for interface-shape parity
  // with `ChannelPort` (see that interface's own doc comment on why the authorization *decision* is
  // made exactly once, in `protocol-handlers.ts`, before any of these are ever called — this class
  // never re-derives it, but keeping the field in each method's own declared type, not just the
  // interface's, means any caller constructing an object literal against `ChannelStore` directly
  // (e.g. this file's own unit tests) sees an identical, non-surprising shape either way).

  createCategory(params: {
    readonly name: string;
    readonly parentId: string | undefined;
    readonly actorEffectiveGroupIds?: readonly string[];
  }): CreateNodeResult {
    return this.createNode('category', params);
  }

  createVoiceChannel(params: {
    readonly name: string;
    readonly parentId: string | undefined;
    readonly actorEffectiveGroupIds?: readonly string[];
  }): CreateNodeResult {
    return this.createNode('voice', params);
  }

  updateNode(params: {
    readonly nodeId: string;
    readonly name: string | undefined;
    readonly visibilityPolicy: AclPolicyKind | undefined;
    readonly visibilityGroupIds: readonly string[] | undefined;
    readonly joinPolicy: AclPolicyKind | undefined;
    readonly joinGroupIds: readonly string[] | undefined;
    readonly managePolicy: ManagePolicyKind | undefined;
    readonly manageGroupIds: readonly string[] | undefined;
    readonly userLimit: number | null | undefined;
    readonly actorEffectiveGroupIds?: readonly string[];
  }): UpdateNodeResult {
    const row = this.getRow(params.nodeId);
    if (!row) {
      return {
        ok: false,
        code: 'CHANNEL_NOT_FOUND',
        message: `Unknown channel "${params.nodeId}"`,
      };
    }

    withTransaction(this.db, () => {
      const nextUserLimit =
        params.userLimit === undefined
          ? row.user_limit
          : row.kind === 'category'
            ? row.user_limit
            : params.userLimit;

      this.updateNodeStmt.run(
        params.name ?? null,
        params.visibilityPolicy ?? null,
        params.joinPolicy ?? null,
        params.managePolicy ?? null,
        nextUserLimit,
        this.now(),
        params.nodeId,
      );
      if (params.visibilityGroupIds !== undefined) {
        this.setAclGroupIds(params.nodeId, 'visibility', params.visibilityGroupIds);
      }
      if (params.joinGroupIds !== undefined) {
        this.setAclGroupIds(params.nodeId, 'join', params.joinGroupIds);
      }
      if (params.manageGroupIds !== undefined) {
        this.setAclGroupIds(params.nodeId, 'manage', params.manageGroupIds);
      }
    });

    return { ok: true };
  }

  moveNode(params: {
    readonly nodeId: string;
    readonly newParentId: string | undefined;
    readonly actorEffectiveGroupIds?: readonly string[];
  }): MoveNodeResult {
    const row = this.getRow(params.nodeId);
    if (!row) {
      return {
        ok: false,
        code: 'CHANNEL_NOT_FOUND',
        message: `Unknown channel "${params.nodeId}"`,
      };
    }
    if (row.kind === 'category' && params.newParentId !== undefined) {
      return {
        ok: false,
        code: 'CHANNEL_PARENT_INVALID',
        message: 'A category can never have a parent',
      };
    }
    if (params.newParentId === params.nodeId) {
      return {
        ok: false,
        code: 'CHANNEL_PARENT_INVALID',
        message: 'A node cannot be its own parent',
      };
    }

    const byId = new Map(this.getAllActive().map((r) => [r.node_id, r]));
    if (params.newParentId !== undefined) {
      const newParent = byId.get(params.newParentId);
      if (!newParent) {
        return {
          ok: false,
          code: 'CHANNEL_PARENT_INVALID',
          message: `Unknown or deleted parent "${params.newParentId}"`,
        };
      }
      // Cycle check: walk from the proposed new parent up to root; if `nodeId` appears, reject.
      const ancestorChain = this.chainRootFirst(params.newParentId, byId).map((r) => r.node_id);
      if (ancestorChain.includes(params.nodeId)) {
        return {
          ok: false,
          code: 'CHANNEL_PARENT_INVALID',
          message: 'That move would create a cycle',
        };
      }
      const newDepth = this.depthOf(params.newParentId, byId) + 1;
      const subtreeDepth = this.subtreeMaxRelativeDepth(params.nodeId, byId);
      if (newDepth + subtreeDepth > MAX_CHANNEL_DEPTH - 1) {
        return {
          ok: false,
          code: 'CHANNEL_PARENT_INVALID',
          message: 'Maximum channel nesting depth exceeded',
        };
      }
    }

    const sortOrder = this.nextSortOrder(params.newParentId);
    withTransaction(this.db, () => {
      this.updateParentStmt.run(params.newParentId ?? null, sortOrder, this.now(), params.nodeId);
    });
    return { ok: true };
  }

  reorderChildren(params: {
    readonly parentId: string | undefined;
    readonly orderedNodeIds: readonly string[];
    readonly actorEffectiveGroupIds?: readonly string[];
  }): ReorderResult {
    const actualChildren = new Set(
      (this.selectActiveChildrenStmt.all(params.parentId ?? null) as { node_id: string }[]).map(
        (row) => row.node_id,
      ),
    );
    const providedIds = new Set(params.orderedNodeIds);
    if (
      actualChildren.size !== providedIds.size ||
      [...actualChildren].some((id) => !providedIds.has(id))
    ) {
      return {
        ok: false,
        code: 'CHANNEL_NOT_FOUND',
        message: "orderedNodeIds must be exactly this parent's current active children",
      };
    }

    withTransaction(this.db, () => {
      params.orderedNodeIds.forEach((nodeId, index) => {
        this.updateSortOrderStmt.run(index, this.now(), nodeId);
      });
    });
    return { ok: true };
  }

  deleteNode(params: {
    readonly nodeId: string;
    readonly actorEffectiveGroupIds?: readonly string[];
  }): DeleteNodeResult {
    const row = this.getRow(params.nodeId);
    if (!row) {
      return {
        ok: false,
        code: 'CHANNEL_NOT_FOUND',
        message: `Unknown channel "${params.nodeId}"`,
      };
    }

    const byId = new Map(this.getAllActive().map((r) => [r.node_id, r]));
    const toTombstone: string[] = [];
    const collect = (id: string): void => {
      toTombstone.push(id);
      for (const candidate of byId.values()) {
        if (candidate.parent_id === id) collect(candidate.node_id);
      }
    };
    collect(params.nodeId);

    const now = this.now();
    withTransaction(this.db, () => {
      for (const id of toTombstone) this.updateDeletedAtStmt.run(now, now, id);
    });
    return { ok: true };
  }

  setPassword(params: {
    readonly nodeId: string;
    readonly password: string;
    readonly actorEffectiveGroupIds?: readonly string[];
  }): SetPasswordResult {
    const row = this.getRow(params.nodeId);
    if (!row) {
      return {
        ok: false,
        code: 'CHANNEL_NOT_FOUND',
        message: `Unknown channel "${params.nodeId}"`,
      };
    }
    if (row.kind === 'voice') {
      this.updatePasswordStmt.run(hashChannelPassword(params.password), this.now(), params.nodeId);
    }
    return { ok: true };
  }

  removePassword(params: {
    readonly nodeId: string;
    readonly actorEffectiveGroupIds?: readonly string[];
  }): SetPasswordResult {
    const row = this.getRow(params.nodeId);
    if (!row) {
      return {
        ok: false,
        code: 'CHANNEL_NOT_FOUND',
        message: `Unknown channel "${params.nodeId}"`,
      };
    }
    this.updatePasswordStmt.run(null, this.now(), params.nodeId);
    return { ok: true };
  }

  listActiveNodeIds(): readonly string[] {
    return this.getAllActive().map((row) => row.node_id);
  }

  close(): void {
    this.db.close();
  }
}
