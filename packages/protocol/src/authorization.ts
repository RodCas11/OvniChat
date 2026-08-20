import { z } from 'zod';

/**
 * T9 — server-local authorization wire schemas: groups, permissions, and bearer tokens (privilege
 * keys, invite tokens, the one-time Server Admin bootstrap token). Deliberately crypto-free and
 * Node-free, matching every other file in this package (see `identity.ts`'s doc comment) — the
 * actual authorization *store* (SQLite, digests, migrations) lives entirely in
 * `services/dedicated-server/src/authorization/`, never here. This file only describes what can be
 * said on the wire, never how it is enforced or persisted.
 *
 * Authentication (T7, `identity.ts`) answers "which cryptographic identity is this?" Authorization
 * (this file) answers "what is that identity allowed to do on *this* server?" The two are layered,
 * not merged: nothing here ever substitutes for or weakens the T7 identity proof.
 */

// ASCII control characters (C0 controls 0x00-0x1F and DEL 0x7F) are rejected in group names — same
// reasoning as every other operator/user-facing display string in this package.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = new RegExp('^[^\\x00-\\x1F\\x7F]*$', 'u');

/**
 * A small, closed set of server-enforceable capabilities. Deliberately not an open string: an
 * unrecognized permission key can never become "executable behavior" by construction, and every
 * key here corresponds to something the Dedicated Server can actually, authoritatively enforce
 * itself (never a client-side-only restriction like "camera forbidden," which the current P2P
 * architecture cannot police). Adding a new key is additive and does not require a protocol version
 * bump, matching `version.ts`'s evolution policy — as long as a client treats an unrecognized key as
 * simply absent, never fatal.
 */
export const permissionKeySchema = z.enum([
  'voice.channel.join',
  'moderation.kick',
  'moderation.ban',
  'authorization.groups.manage',
  'authorization.memberships.manage',
  'authorization.tokens.manage',
  'server.manage',
  // T10 — persistent server-side text chat. Reading history requires no permission (any `ready`
  // connection may request it; see `docs/architecture/PERSISTENT_TEXT_CHAT.md`), only sending does.
  'chat.server.send',
  'chat.channel.send',
]);
export type PermissionKey = z.infer<typeof permissionKeySchema>;

export const MAX_PERMISSIONS_PER_GROUP = 32;
export const permissionKeysSchema = z.array(permissionKeySchema).max(MAX_PERMISSIONS_PER_GROUP);

/**
 * A stable, machine-readable group identifier — distinct from its display name, same shape as
 * `channelIdSchema` (`identifiers.ts`). The three built-in group ids (`guest`, `member`,
 * `server-admin`) are ordinary values of this same schema, not a separate type — a custom group's
 * id looks exactly like a built-in one on the wire; only the server-side store knows which ids are
 * protected.
 */
export const GROUP_ID_PATTERN = /^[a-z0-9-]{1,64}$/u;
export const groupIdSchema = z
  .string()
  .regex(GROUP_ID_PATTERN, 'group id must be lowercase alphanumeric/hyphen, 1-64 chars');

export const GROUP_NAME_MAX_LENGTH = 64;
export const groupNameSchema = z
  .string()
  .trim()
  .min(1, 'group name cannot be blank')
  .max(GROUP_NAME_MAX_LENGTH)
  .regex(CONTROL_CHARACTER_PATTERN, 'control characters are not allowed');

/**
 * A group as seen by an administrator managing the server's authorization model — includes its
 * full permission set. Contrast {@link groupBadgeSchema}, the much smaller shape shown to ordinary
 * participants as a badge next to another participant's name.
 */
export const groupSummarySchema = z
  .object({
    groupId: groupIdSchema,
    name: groupNameSchema,
    permissions: permissionKeysSchema,
    /** `true` for the three built-in groups (`guest`, `member`, `server-admin`) — cannot be
     * deleted, and `server-admin`'s permission set cannot be edited down to nothing (see
     * `docs/architecture/SERVER_AUTHORIZATION.md`'s last-admin protection section). */
    protectedGroup: z.boolean(),
  })
  .strict();
export type GroupSummary = z.infer<typeof groupSummarySchema>;

export const MAX_GROUPS = 64;
export const groupSummaryListSchema = z.array(groupSummarySchema).max(MAX_GROUPS);

/**
 * A minimal, non-sensitive group label shown next to a participant's name (T9 Section 39/84) — name
 * only, deliberately never the group's permission set (an ordinary participant does not need to
 * know exactly what a "Moderator" badge can technically do) and never any identity-correlating
 * data. Also used for the connecting client's own `myGroups` snapshot
 * (`server:authorization-state`), where the recipient already knows its own permissions separately.
 */
export const groupBadgeSchema = z
  .object({
    groupId: groupIdSchema,
    name: groupNameSchema,
  })
  .strict();
export type GroupBadge = z.infer<typeof groupBadgeSchema>;

export const MAX_BADGES_PER_PARTICIPANT = 8;
export const groupBadgeListSchema = z.array(groupBadgeSchema).max(MAX_BADGES_PER_PARTICIPANT);

/**
 * Bearer capability tokens (privilege keys, invite tokens, the bootstrap Server Admin token) —
 * opaque, high-entropy random secrets the server never encodes any claim into (T9 Section 12: no
 * identityId/permissions/group-name encoded in a client-trusted unsigned token). Bounded and
 * charset-restricted so a garbage value fails schema validation before ever reaching the server's
 * digest lookup. The `DV-<KIND>-` prefix (`server-token-crypto.ts` in `services/dedicated-server`
 * generates it) is a UX/diagnostic convenience only — this schema does not require or parse it
 * structurally, since the actual kind is metadata the server stores server-side, never derived from
 * the token string itself.
 */
export const SERVER_TOKEN_MIN_LENGTH = 8;
export const SERVER_TOKEN_MAX_LENGTH = 100;
export const serverTokenSchema = z
  .string()
  .min(SERVER_TOKEN_MIN_LENGTH)
  .max(SERVER_TOKEN_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/u, 'token must be alphanumeric/hyphen/underscore only');

export const tokenKindSchema = z.enum(['privilege', 'invite']);
export type TokenKind = z.infer<typeof tokenKindSchema>;

/** Positive integer epoch-milliseconds timestamp, or absent for "never expires" / "permanent." */
export const authorizationExpiresAtSchema = z.number().int().positive();

/**
 * A ban as seen by an administrator (T9 Section 25) — the one place a raw `identityId` is
 * deliberately sent to a client, since a moderator managing bans genuinely needs it and this view
 * is never shown to an ordinary participant. `reason` is operator-optional free text, never
 * required or collected automatically (T9 Section 21).
 */
export const BAN_REASON_MAX_LENGTH = 256;
export const banSummarySchema = z
  .object({
    identityId: z.string().min(1).max(128),
    createdAt: z.number().int().positive(),
    expiresAt: authorizationExpiresAtSchema.optional(),
    reason: z.string().max(BAN_REASON_MAX_LENGTH).optional(),
  })
  .strict();
export type BanSummary = z.infer<typeof banSummarySchema>;

export const MAX_BANS = 1024;
export const banSummaryListSchema = z.array(banSummarySchema).max(MAX_BANS);
