import type { MemberRoleBucket, PermissionKey } from '@disco-voador/protocol';

/**
 * T13.3 — pure derivation of {@link MemberRoleBucket} from an identity's *current* effective
 * permissions, recomputed fresh on every presence broadcast (never cached, never a join-time
 * snapshot — see `packages/protocol/src/profile.ts`'s `memberRoleBucketSchema` doc comment for why
 * this is an intentional improvement over `voiceParticipantSchema.groups`'s known staleness
 * limitation). Deliberately derived from *permissions*, never from which specific group grants
 * them — a custom group's name/existence must never leak through this classification.
 */

/** Global permission keys that render an identity with the `'admin'` bucket — holding *any* one of
 * these, via *any* group (built-in or custom), is sufficient. */
const ADMIN_BUCKET_PERMISSION_KEYS: readonly PermissionKey[] = [
  'channels.manage',
  'authorization.groups.manage',
  'authorization.memberships.manage',
  'authorization.tokens.manage',
  'server.manage',
  'channels.create',
  'channels.delete',
];

/** Global permission keys that render an identity with the `'moderator'` bucket (only checked once
 * {@link ADMIN_BUCKET_PERMISSION_KEYS} has already failed to match). */
const MODERATOR_BUCKET_PERMISSION_KEYS: readonly PermissionKey[] = [
  'moderation.kick',
  'moderation.ban',
];

/**
 * Mirrors `services/dedicated-server/src/authorization/permissions.ts`'s `SERVER_ADMIN_GROUP_ID`
 * constant by value. Deliberately **not** imported from there: the dependency direction in this
 * codebase always runs `services/dedicated-server` -> `services/realtime` (see
 * `channel-port.ts`/`authorization-port.ts`'s own "the port defines the contract, the dedicated
 * server supplies the implementation" pattern), never the reverse, so this module cannot import a
 * dedicated-server-owned constant. Kept in sync manually — the same unshared-literal convention
 * this exact string already appears as in this codebase's own integration tests (e.g.
 * `tests/dedicated-server/channels-integration.test.ts`'s `groupId: 'staff'`-style literals).
 * `server-admin`'s permission set is always the complete registry and can never be edited down (see
 * `permissions.ts`'s own doc comment), so in practice this check is redundant with the permission
 * checks below for that one built-in group — kept anyway per this task's explicit design, as
 * defense in depth against `server-admin`'s protection invariant ever changing.
 */
const SERVER_ADMIN_GROUP_ID = 'server-admin';

/**
 * `can` is the caller's already-resolved permission check for one specific identity (typically
 * `(permission) => ctx.authorization.can(identityId, permission)`) — this function itself never
 * touches `AuthorizationPort` directly, mirroring `ChannelPort`'s own "never talks to
 * `AuthorizationPort`" design rule.
 */
export function deriveMemberRoleBucket(
  effectiveGroupIds: readonly string[],
  can: (permission: PermissionKey) => boolean,
): MemberRoleBucket | undefined {
  if (
    effectiveGroupIds.includes(SERVER_ADMIN_GROUP_ID) ||
    ADMIN_BUCKET_PERMISSION_KEYS.some((key) => can(key))
  ) {
    return 'admin';
  }
  if (MODERATOR_BUCKET_PERMISSION_KEYS.some((key) => can(key))) {
    return 'moderator';
  }
  return undefined;
}
