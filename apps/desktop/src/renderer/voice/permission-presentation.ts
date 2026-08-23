import { permissionKeySchema, type PermissionKey } from '@disco-voador/protocol';

/**
 * T13.2.1 — the presentation layer for `PermissionKey` (T9/`packages/protocol/src/authorization.ts`)
 * that `GroupsSection.tsx` was missing: T13.2's own handoff notes recorded, as an accepted
 * out-of-scope rough edge, that the Groups & Permissions panel rendered raw permission-key strings
 * (e.g. `authorization.groups.manage, chat.channel.send`) straight from the wire. This module is a
 * pure, Electron/React-free mapping from each of the 13 current `PermissionKey` values to a
 * human-readable label, an optional one-line description, and a coarse category — never a runtime
 * behavior change, never a new wire value, never a new `PermissionKey`.
 *
 * Completeness is enforced two ways: (1) the `Record<PermissionKey, ...>` literal below fails to
 * compile if a key is missing, renamed, or misspelled, since TypeScript checks every key of a
 * `Record` against the key type it is declared with; (2) `tests/desktop/permission-presentation.test.ts`
 * asserts every key in `permissionKeySchema.options` (the actual runtime enum) has a corresponding
 * entry here — this is what fails a future engineer's CI run if they add a new permission key to
 * `packages/protocol` without updating this file, since nothing in *this* file's own type-checking can
 * see that a new key was added to a completely different package's enum.
 */

export type PermissionCategory = 'Voice & Chat' | 'Channels' | 'Moderation' | 'Server Management';

export interface PermissionPresentation {
  readonly label: string;
  readonly description?: string;
  readonly category: PermissionCategory;
}

/**
 * `server.manage` is deliberately described honestly, not aspirationally: as of T13.2.1,
 * `packages/protocol/src/authorization.ts`'s own comment says it is "reserved for future
 * server-level administration," and neither `services/realtime` nor `services/dedicated-server`
 * check it anywhere yet (confirmed by grep at the time this file was written) — its label/description
 * must never claim a capability it does not yet grant.
 */
export const PERMISSION_PRESENTATION: Record<PermissionKey, PermissionPresentation> = {
  'voice.channel.join': {
    label: 'Join voice channels',
    category: 'Voice & Chat',
  },
  'chat.server.send': {
    label: 'Send server-wide chat',
    category: 'Voice & Chat',
  },
  'chat.channel.send': {
    label: 'Send channel chat',
    category: 'Voice & Chat',
  },
  'channels.create': {
    label: 'Create channels and categories',
    category: 'Channels',
  },
  'channels.manage': {
    label: 'Manage all channels',
    description:
      'Edit, move, and configure access for any channel or category on the server — a global override of a node’s own local Manage delegation.',
    category: 'Channels',
  },
  'channels.delete': {
    label: 'Delete channels and categories',
    category: 'Channels',
  },
  'channels.password.bypass': {
    label: 'Bypass channel passwords',
    description: 'Join password-protected channels without entering the password.',
    category: 'Channels',
  },
  'moderation.kick': {
    label: 'Kick participants',
    category: 'Moderation',
  },
  'moderation.ban': {
    label: 'Ban participants',
    category: 'Moderation',
  },
  'moderation.profile.clear': {
    label: 'Clear member profiles',
    description:
      'Clear another member’s avatar or custom status for abuse handling — never set or rewrite it.',
    category: 'Moderation',
  },
  'authorization.groups.manage': {
    label: 'Manage groups',
    description:
      'Create, edit, and delete server-local groups and the permissions each one grants.',
    category: 'Server Management',
  },
  'authorization.memberships.manage': {
    label: 'Manage member groups',
    description: 'Assign and remove server-local groups from members.',
    category: 'Server Management',
  },
  'authorization.tokens.manage': {
    label: 'Manage invite and privilege tokens',
    category: 'Server Management',
  },
  'server.manage': {
    label: 'Server management (reserved)',
    description:
      'Reserved for future server-level administration. Not currently checked by any server action.',
    category: 'Server Management',
  },
};

/** Every current `PermissionKey`, in the closed registry's own declared order — the single source
 * this module derives both "all permissions, grouped" and completeness checks from. */
export const ALL_PERMISSION_KEYS: readonly PermissionKey[] = permissionKeySchema.options;

export const PERMISSION_CATEGORY_ORDER: readonly PermissionCategory[] = [
  'Voice & Chat',
  'Channels',
  'Moderation',
  'Server Management',
];

export interface PermissionCategoryGroup {
  readonly category: PermissionCategory;
  readonly keys: readonly PermissionKey[];
}

/** Every permission key, grouped by category, in category-then-registry order — used to render the
 * Create Group form's checkbox grid (every permission always shown, regardless of what a specific
 * group currently holds). */
export function allPermissionsByCategory(): readonly PermissionCategoryGroup[] {
  return PERMISSION_CATEGORY_ORDER.map((category) => ({
    category,
    keys: ALL_PERMISSION_KEYS.filter((key) => PERMISSION_PRESENTATION[key].category === category),
  }));
}

/** Only the categories that have at least one of `permissions` present — used to render an existing
 * group's own (usually much smaller) permission set compactly, never a raw key. */
export function groupPermissionsByCategory(
  permissions: readonly PermissionKey[],
): readonly PermissionCategoryGroup[] {
  const present = new Set(permissions);
  return allPermissionsByCategory()
    .map((group) => ({
      category: group.category,
      keys: group.keys.filter((key) => present.has(key)),
    }))
    .filter((group) => group.keys.length > 0);
}

/** `true` only if `permissions` holds literally every current registry key — computed by comparison
 * against {@link ALL_PERMISSION_KEYS}, never by checking a group id/name, since a custom group can
 * legitimately hold every permission too (see `GroupsSection.tsx`'s own "Full server administration"
 * summary, which calls this rather than special-casing the built-in `server-admin` group id). */
export function isFullPermissionSet(permissions: readonly PermissionKey[]): boolean {
  const present = new Set(permissions);
  return ALL_PERMISSION_KEYS.every((key) => present.has(key));
}
