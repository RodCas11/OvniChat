import {
  MAX_CHANNEL_PARTICIPANTS,
  type AclPolicyKind,
  type ChannelNodeAdminView,
  type ChannelNodeView,
  type ManagePolicyKind,
} from '@disco-voador/protocol';

import { DEFAULT_VOICE_CHANNELS } from './voice/catalog.js';

/**
 * T13.2 — the narrow, synchronous seam `services/realtime` depends on for the persistent
 * channel/category tree and its ACLs, mirroring exactly how T9 injected `AuthorizationPort` and
 * T10 injected `ChatPort`: this package defines the contract and a permissive/fixed default;
 * `services/dedicated-server` provides the real, SQLite-backed implementation (`ChannelStore`) via
 * composition.
 *
 * Every method is **synchronous** — `Connection`/`routeClientMessage` are a fully synchronous hot
 * path (see `authorization-port.ts`'s doc comment for the full reasoning, including the accepted
 * ~30-80ms blocking cost of a `scryptSync` password check on the join hot path, mitigated by
 * `channelPasswordRateLimiter`).
 *
 * Three non-negotiable design rules:
 *
 * 1. **`ChannelPort` never talks to `AuthorizationPort` or `VoiceRegistry`.** Every ACL-evaluating
 *    method takes the caller's already-resolved `effectiveGroupIds` as a plain parameter — the
 *    caller gets this from `ctx.authorization.getSnapshot(identityId).groups.map(g => g.groupId)`.
 *    This keeps the two dedicated-server store classes (`AuthorizationStore`/`ChannelStore`)
 *    mutually unaware of each other — no circular import between them.
 * 2. **`ChannelPort` never knows about live connections.** Capacity enforcement is split: this port
 *    reports only the node's *configured* limit (via {@link ChannelNodeView.userLimit} /
 *    `checkJoin`'s `currentMemberCount` parameter, which the caller — `handleVoiceJoin` — supplies
 *    from `VoiceRegistry`'s already-existing live count); the port itself never queries anything
 *    connection-shaped.
 * 3. **Existence and visibility are the same method.** A hidden channel and an absent one are
 *    structurally indistinguishable to every caller — `getVisibleNode`/`getFilteredTree` simply
 *    omit what `effectiveGroupIds` may not see, and every rejection that would otherwise reveal a
 *    hidden node's existence uses the same `CHANNEL_NOT_FOUND` code an unknown id would. This is
 *    the core privacy guarantee this whole design exists to provide.
 *
 * ## ACL resolution algorithm
 *
 * Given node `N` and `effectiveGroupIds`, build the ancestor chain `[N, parent(N), ..., root]`.
 *
 * **Visibility** (bounds all descendants): walk the chain **top-down** (root first). For each
 * ancestor `A`: `'inherit'` keeps walking down; `'everyone'` clears any restriction and continues;
 * `'selected-groups'` checks intersection with `effectiveGroupIds` — failing at *any* ancestor makes
 * `N` invisible, full stop, regardless of `N`'s own setting. An all-`'inherit'` chain resolves the
 * hardcoded root default of `'everyone'`.
 *
 * **Join**: nearest-non-`'inherit'` ancestor, starting at `N` itself and walking up; an all-inherit
 * chain resolves to `'everyone'`. Does **not** bound descendants the way Visibility does. Join is
 * always gated by Visibility passing first — an invisible channel is never joinable regardless of
 * its own join policy (this is why {@link CanJoinResult}'s `NOT_FOUND` must be checked before
 * `ACCESS_DENIED`).
 *
 * **Manage**: the same nearest-non-`'inherit'`-ancestor walk as Join, but only `'inherit'`/
 * `'selected-groups'` are valid values (no `'everyone'` — an ungated "everyone can manage" is
 * structurally inexpressible). Does not bound descendants — a category's Manage restriction does
 * not automatically restrict Manage on a channel beneath it that sets its own Manage policy
 * (delegated administration is the point).
 *
 * Worked example: category "Officers" (`visibility: selected-groups[staff]`) contains voice channel
 * "Raid Planning" (`visibility: inherit`, `join: selected-groups[staff, raid-leaders]`). A
 * `raid-leaders`-only identity: Visibility fails at "Officers" (root ancestor) -> invisible,
 * `NOT_FOUND`, regardless of "Raid Planning"'s own join policy naming `raid-leaders`. A `staff`
 * identity: Visibility passes at "Officers" (member of `staff`), "Raid Planning" is `inherit` for
 * visibility -> visible; Join resolves to `staff`+`raid-leaders`, `staff` intersects -> joinable.
 *
 * ## Permission gating (enforced by the caller, `protocol-handlers.ts`, never by this port)
 *
 * `ChannelPort` performs no permission checks of its own — it has no concept of a `PermissionKey`
 * (rule 1 above). Every mutating handler in `protocol-handlers.ts` checks
 * `ctx.authorization.can(identityId, <global key>) || ctx.channels.hasManageRights(<relevant node>,
 * effectiveGroupIds)` *before* ever calling a mutating method here — `channels.create`/
 * `channels.delete` gate root-level tree operations, `channels.manage` is a global override of any
 * node's Manage, and `hasManageRights` is the local per-subtree override. Deleting a node requires
 * Manage rights on its *parent* (or global `channels.delete`) — never Manage on the node itself
 * (filesystem-directory-permission semantics) — the caller resolves this using
 * `getVisibleNode(nodeId, ...).parentId` plus `hasManageRights(parentId, ...)`; moving/reordering
 * follow the same parent-based pattern for both the source and destination parent. The
 * `actorEffectiveGroupIds` parameter accepted by every mutating method below is threaded through
 * for interface symmetry and potential future internal validation, but the authorization *decision*
 * is made exactly once, in `protocol-handlers.ts`, before the method is ever invoked — see this
 * package's `channels.md`-equivalent design notes for why re-deriving the same decision inside a
 * port that structurally cannot see permission keys would only duplicate, never strengthen, that
 * one boundary.
 *
 * ## Deliberately omitted: "who may speak"
 *
 * No `channels.speak` permission, flag, or control exists anywhere in this design, and none should
 * be added here. The Dedicated Server cannot authoritatively enforce "who may speak" given this
 * app's P2P-mesh WebRTC architecture — media flows client-to-client, never through the realtime
 * service — so any such control would be enforceable only by a cooperating client, which is not a
 * real security boundary. Deferred until an SFU exists (T17).
 */

export type CreateNodeResult =
  | { readonly ok: true; readonly node: ChannelNodeAdminView }
  | {
      readonly ok: false;
      readonly code: 'CHANNEL_PARENT_INVALID' | 'CHANNEL_TREE_LIMIT_EXCEEDED';
      readonly message: string;
    };

export type UpdateNodeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'CHANNEL_NOT_FOUND'; readonly message: string };

export type MoveNodeResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code: 'CHANNEL_NOT_FOUND' | 'CHANNEL_PARENT_INVALID';
      readonly message: string;
    };

export type ReorderResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'CHANNEL_NOT_FOUND'; readonly message: string };

export type DeleteNodeResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'CHANNEL_NOT_FOUND'; readonly message: string };

export type SetPasswordResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'CHANNEL_NOT_FOUND'; readonly message: string };

export type ChannelTreeSnapshot = readonly ChannelNodeView[];

export type CanJoinResult =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly code:
        'NOT_FOUND' | 'ACCESS_DENIED' | 'FULL' | 'PASSWORD_REQUIRED' | 'PASSWORD_INVALID';
    };

export interface ChannelPort {
  /** Already filtered to what `effectiveGroupIds` may see — omits `visibilityGroupIds`/
   * `joinGroupIds`/`manageGroupIds` (ordinary participant view). */
  getFilteredTree(effectiveGroupIds: readonly string[]): ChannelTreeSnapshot;

  /** `undefined` for a tombstoned, nonexistent, *or invisible* node — the same three cases are
   * indistinguishable by design (rule 3 above). */
  getVisibleNode(nodeId: string, effectiveGroupIds: readonly string[]): ChannelNodeView | undefined;

  /** Full evaluation order: visibility -> join policy -> capacity -> password (password last, so a
   * Guest denied by group policy never reaches the `scryptSync` call at all). */
  checkJoin(params: {
    readonly nodeId: string;
    readonly effectiveGroupIds: readonly string[];
    readonly currentMemberCount: number;
    readonly password: string | undefined;
    readonly bypassPassword: boolean;
  }): CanJoinResult;

  /** Nearest-non-`'inherit'`-ancestor Manage evaluation (see this file's doc comment) — used both
   * by `protocol-handlers.ts`'s permission gating and by this port's own admin-detail-view gating. */
  hasManageRights(nodeId: string, effectiveGroupIds: readonly string[]): boolean;

  /** `true` iff `groupId` is currently named in any node's visibility/join/manage ACL — used by
   * `handleAuthorizationDeleteGroup` to reject with `GROUP_IN_USE_BY_CHANNEL_POLICY` before ever
   * calling into `AuthorizationStore.deleteGroup`. */
  isGroupReferenced(groupId: string): boolean;

  createCategory(params: {
    readonly name: string;
    readonly parentId: string | undefined;
    readonly actorEffectiveGroupIds: readonly string[];
  }): CreateNodeResult;

  createVoiceChannel(params: {
    readonly name: string;
    readonly parentId: string | undefined;
    readonly actorEffectiveGroupIds: readonly string[];
  }): CreateNodeResult;

  updateNode(params: {
    readonly nodeId: string;
    readonly actorEffectiveGroupIds: readonly string[];
    // Required-but-possibly-`undefined` (never `?:`) throughout, matching this codebase's own
    // `exactOptionalPropertyTypes: true` convention (see `AuthorizationPort.updateGroup`'s params
    // for the same pattern) — `undefined` means "leave unchanged" for every field except
    // `userLimit`, where `null` (not `undefined`) means "clear back to no explicit limit".
    readonly name: string | undefined;
    readonly visibilityPolicy: AclPolicyKind | undefined;
    readonly visibilityGroupIds: readonly string[] | undefined;
    readonly joinPolicy: AclPolicyKind | undefined;
    readonly joinGroupIds: readonly string[] | undefined;
    readonly managePolicy: ManagePolicyKind | undefined;
    readonly manageGroupIds: readonly string[] | undefined;
    readonly userLimit: number | null | undefined;
  }): UpdateNodeResult;

  moveNode(params: {
    readonly nodeId: string;
    readonly newParentId: string | undefined;
    readonly actorEffectiveGroupIds: readonly string[];
  }): MoveNodeResult;

  reorderChildren(params: {
    readonly parentId: string | undefined;
    readonly orderedNodeIds: readonly string[];
    readonly actorEffectiveGroupIds: readonly string[];
  }): ReorderResult;

  /** Soft-delete (tombstone) — cascades to the entire subtree in one transaction. Never touches
   * `chat.sqlite`; a deleted node's chat history persists forever, reachable by nothing (see
   * `docs/architecture` design notes for T13.2). */
  deleteNode(params: {
    readonly nodeId: string;
    readonly actorEffectiveGroupIds: readonly string[];
  }): DeleteNodeResult;

  setPassword(params: {
    readonly nodeId: string;
    readonly password: string;
    readonly actorEffectiveGroupIds: readonly string[];
  }): SetPasswordResult;

  removePassword(params: {
    readonly nodeId: string;
    readonly actorEffectiveGroupIds: readonly string[];
  }): SetPasswordResult;

  /** The full admin/manager detail view (including group-id lists) for `nodeId`, regardless of the
   * caller's own visibility — the caller (`protocol-handlers.ts`'s `handleChannelGetEditableNode`)
   * has already established Manage authorization (local or global `channels.manage`) before ever
   * calling this, so this method does not re-derive visibility from `effectiveGroupIds` the way
   * {@link getVisibleNode} does; it returns `undefined` only for a tombstoned/nonexistent id. */
  getEditableNode(nodeId: string): ChannelNodeAdminView | undefined;

  /** Every currently-active (non-tombstoned) node id, regardless of visibility — used only for the
   * best-effort `ChatPort.pruneOrphanedChannelHistory` startup hygiene step, never for anything
   * client-facing. */
  listActiveNodeIds(): readonly string[];

  /** Releases any held resources (e.g. closes the underlying database handle). */
  close(): void;
}

/**
 * The default `ChannelPort` for any `@disco-voador/realtime` consumer that doesn't compose its own
 * (this package's own dev CLI, `tests/realtime/*`) — a fixed, flat, ACL-free three-channel tree
 * built from {@link DEFAULT_VOICE_CHANNELS}, preserving pre-T13.2 behavior exactly (every channel
 * visible/joinable to everyone, no categories, no passwords). Rejects every mutation with a
 * generic "not configured" error. `services/dedicated-server` always supplies the real
 * `ChannelStore` instead; this is never used in a real product deployment.
 */
export function createNoopChannelPort(): ChannelPort {
  const nodes: ChannelNodeView[] = DEFAULT_VOICE_CHANNELS.map((channel, index) => ({
    nodeId: channel.channelId,
    kind: 'voice',
    parentId: undefined,
    name: channel.name,
    sortOrder: index,
    visibilityPolicy: 'everyone',
    joinPolicy: 'everyone',
    managePolicy: 'inherit',
    userLimit: undefined,
    hasPassword: false,
    temporary: false,
  }));
  const nodesById = new Map(nodes.map((node) => [node.nodeId, node]));

  const notConfiguredMessage = 'No channel store configured';

  return {
    getFilteredTree: () => nodes,
    getVisibleNode: (nodeId) => nodesById.get(nodeId),
    checkJoin: ({ nodeId, currentMemberCount }) => {
      const node = nodesById.get(nodeId);
      if (!node) return { ok: false, code: 'NOT_FOUND' };
      if (currentMemberCount >= MAX_CHANNEL_PARTICIPANTS) return { ok: false, code: 'FULL' };
      return { ok: true };
    },
    hasManageRights: () => false,
    isGroupReferenced: () => false,
    getEditableNode: () => undefined,
    createCategory: () => ({
      ok: false,
      code: 'CHANNEL_PARENT_INVALID',
      message: notConfiguredMessage,
    }),
    createVoiceChannel: () => ({
      ok: false,
      code: 'CHANNEL_PARENT_INVALID',
      message: notConfiguredMessage,
    }),
    updateNode: () => ({ ok: false, code: 'CHANNEL_NOT_FOUND', message: notConfiguredMessage }),
    moveNode: () => ({ ok: false, code: 'CHANNEL_NOT_FOUND', message: notConfiguredMessage }),
    reorderChildren: () => ({
      ok: false,
      code: 'CHANNEL_NOT_FOUND',
      message: notConfiguredMessage,
    }),
    deleteNode: () => ({ ok: false, code: 'CHANNEL_NOT_FOUND', message: notConfiguredMessage }),
    setPassword: () => ({ ok: false, code: 'CHANNEL_NOT_FOUND', message: notConfiguredMessage }),
    removePassword: () => ({ ok: false, code: 'CHANNEL_NOT_FOUND', message: notConfiguredMessage }),
    listActiveNodeIds: () => nodes.map((node) => node.nodeId),
    close: () => {},
  };
}
