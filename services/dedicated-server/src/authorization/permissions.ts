import { permissionKeySchema, type PermissionKey } from '@disco-voador/protocol';

/**
 * The three built-in, protected groups (T9 Section 7) — reserved, stable ids distinct from their
 * editable display names. `GUEST_GROUP_ID` is never persisted as a membership row (T9 Section 8):
 * it is the *virtual* baseline applied to any admitted identity with no persistent membership at
 * all, but its own row in the `groups`/`group_permissions` tables still exists so an operator can
 * see and adjust what a Guest can do by default.
 */
export const GUEST_GROUP_ID = 'guest';
export const MEMBER_GROUP_ID = 'member';
export const SERVER_ADMIN_GROUP_ID = 'server-admin';

export const PROTECTED_GROUP_IDS: ReadonlySet<string> = new Set([
  GUEST_GROUP_ID,
  MEMBER_GROUP_ID,
  SERVER_ADMIN_GROUP_ID,
]);

/** The closed permission registry, in the same order surfaced anywhere permissions are listed. */
export const ALL_PERMISSION_KEYS: readonly PermissionKey[] = permissionKeySchema.options;

export interface BuiltInGroupSeed {
  readonly groupId: string;
  readonly name: string;
  readonly permissions: readonly PermissionKey[];
}

/**
 * Seeded once, at first-ever database initialization (`migrations.ts`). `server-admin`'s
 * permission set is always the *complete* registry and is the one group whose permissions can
 * never be edited (`store.ts`'s `updateGroup` rejects a `permissions` change for this one group
 * id with `PROTECTED_GROUP`) — this is what makes "last admin cannot be edited into uselessness"
 * (T9 Section 32) structurally true rather than an app-level check with a race window. `guest`/
 * `member` are protected from *deletion* only; their permission sets remain operator-editable
 * (T9 Section 65 explicitly expects a restrictive custom setup to be able to remove
 * `voice.channel.join` from Guest).
 *
 * T10 — Guest/Member both default to holding `chat.server.send`/`chat.channel.send` too, alongside
 * `voice.channel.join`: an ordinary self-hosted community server where anyone admitted can talk is
 * the expected default UX (T10 Section 32: "Guest/Member defaults should be useful"), not a
 * lockdown posture an operator has to opt into. Only a genuinely *fresh* database is seeded this
 * way — an existing server upgraded from a pre-T10 build keeps its operator's already-customized
 * Guest/Member permissions unchanged (seeding only ever runs once, at first-ever initialization;
 * see `store.ts`'s `wasFreshInit`), which is the same non-retroactive behavior every other seeded
 * default in this registry already has.
 */
export const BUILT_IN_GROUPS: readonly BuiltInGroupSeed[] = [
  {
    groupId: GUEST_GROUP_ID,
    name: 'Guest',
    permissions: ['voice.channel.join', 'chat.server.send', 'chat.channel.send'],
  },
  {
    groupId: MEMBER_GROUP_ID,
    name: 'Member',
    permissions: ['voice.channel.join', 'chat.server.send', 'chat.channel.send'],
  },
  { groupId: SERVER_ADMIN_GROUP_ID, name: 'Server Admin', permissions: ALL_PERMISSION_KEYS },
];
