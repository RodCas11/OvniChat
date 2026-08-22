import { z } from 'zod';

import { groupIdSchema } from './authorization.js';
import { MAX_CHANNEL_PARTICIPANTS, channelIdSchema } from './identifiers.js';

/**
 * T13.2 — channel/category tree wire schemas: the persistent, operator-managed hierarchy of
 * categories and voice channels a Dedicated Server offers, plus the policy shapes that govern who
 * can see/join/manage each node. Deliberately crypto-free and Node-free, matching every other
 * domain file in this package (`authorization.ts`, `chat.ts`) — the actual tree *storage* (SQLite,
 * migrations, the ACL-resolution algorithm, scrypt password verifiers) lives entirely in
 * `services/dedicated-server/src/channels/`, never here. This file only describes what can be said
 * on the wire. See `services/realtime/src/channel-port.ts` for the full design doc comment (ACL
 * resolution algorithm, password format, temporary-channel lifecycle, live-update strategy).
 *
 * A category and a voice channel share one unified id space (`nodeId`, reusing
 * {@link channelIdSchema} — see that file's own doc comment on `categoryIdSchema`) and one unified
 * wire shape (`kind` is a plain discriminator) because both share the exact same parent/child/order/
 * three-policy structure; only `kind` and the voice-only fields (`userLimit`, `hasPassword`)
 * distinguish them.
 */

export const nodeKindSchema = z.enum(['category', 'voice']);
export type NodeKind = z.infer<typeof nodeKindSchema>;

/** `'manage'` never allows `'everyone'` — an ungated "everyone can manage" must be structurally
 * inexpressible, not just discouraged (see the ACL-resolution algorithm doc in `channel-port.ts`). */
export const aclPolicyKindSchema = z.enum(['inherit', 'everyone', 'selected-groups']);
export type AclPolicyKind = z.infer<typeof aclPolicyKindSchema>;

export const managePolicyKindSchema = z.enum(['inherit', 'selected-groups']);
export type ManagePolicyKind = z.infer<typeof managePolicyKindSchema>;

// ASCII control characters (C0 controls 0x00-0x1F and DEL 0x7F) are rejected — same reasoning as
// every other operator/user-facing display string in this package.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = new RegExp('^[^\\x00-\\x1F\\x7F]*$', 'u');

export const MAX_CHANNEL_NAME_LENGTH = 64;
export const channelNodeNameSchema = z
  .string()
  .trim()
  .min(1, 'channel/category name cannot be blank')
  .max(MAX_CHANNEL_NAME_LENGTH)
  .regex(CONTROL_CHARACTER_PATTERN, 'control characters are not allowed');

/** Active (non-tombstoned) categories + voice channels combined, across the whole server. */
export const MAX_CHANNEL_TREE_NODES = 256;

/** Root = depth 0, up to 3 further nesting levels. */
export const MAX_CHANNEL_DEPTH = 4;

/** A voice channel's configured occupancy ceiling — never above the one hard technical limit,
 * {@link MAX_CHANNEL_PARTICIPANTS} (also the wire-schema array-size bound for a join snapshot). */
export const channelUserLimitSchema = z.number().int().min(1).max(MAX_CHANNEL_PARTICIPANTS);

/**
 * Bounds the CPU cost of a brute-force loop against `checkJoin`'s password step (scrypt's first
 * pass is a PBKDF2-HMAC-SHA256 stretch over the input, so even a small nonzero max length matters) —
 * see `services/dedicated-server/src/channels/store.ts` for the verifier format itself.
 */
export const channelPasswordSchema = z.string().min(1).max(128);

export const MAX_GROUP_IDS_PER_CHANNEL_POLICY = 32;
export const channelPolicyGroupIdsSchema = z
  .array(groupIdSchema)
  .max(MAX_GROUP_IDS_PER_CHANNEL_POLICY);

/**
 * A channel-tree node as seen by an ordinary participant — omits `visibilityGroupIds`/
 * `joinGroupIds`/`manageGroupIds` (mirrors `groupBadgeSchema`'s "no permission set shown to
 * ordinary participants" precedent). `hasPassword` is the *only* signal ever sent for an existing
 * password — never the verifier, never even whether the caller could bypass it.
 */
export const channelNodeSchema = z
  .object({
    nodeId: channelIdSchema,
    kind: nodeKindSchema,
    parentId: channelIdSchema.optional(),
    name: channelNodeNameSchema,
    sortOrder: z.number().int(),
    visibilityPolicy: aclPolicyKindSchema,
    joinPolicy: aclPolicyKindSchema,
    managePolicy: managePolicyKindSchema,
    /** Voice kind only. */
    userLimit: channelUserLimitSchema.optional(),
    /** Voice kind only. */
    hasPassword: z.boolean(),
    /** `true` for an in-memory-only node injected by `services/realtime`'s
     * `TemporaryChannelRegistry` — never persisted, always gone after a server restart. */
    temporary: z.boolean(),
  })
  .strict();
export type ChannelNodeView = z.infer<typeof channelNodeSchema>;

export const channelNodeListSchema = z.array(channelNodeSchema).max(MAX_CHANNEL_TREE_NODES);

/**
 * The admin/manager detail view of a single node — the same fields as {@link channelNodeSchema}
 * plus the three group-id lists, used only by the `client:channel-get-editable-node` /
 * `server:channel-editable-node` pair (gated by `hasManageRights`/`channels.manage`).
 */
export const channelNodeAdminViewSchema = z
  .object({
    nodeId: channelIdSchema,
    kind: nodeKindSchema,
    parentId: channelIdSchema.optional(),
    name: channelNodeNameSchema,
    sortOrder: z.number().int(),
    visibilityPolicy: aclPolicyKindSchema,
    visibilityGroupIds: channelPolicyGroupIdsSchema,
    joinPolicy: aclPolicyKindSchema,
    joinGroupIds: channelPolicyGroupIdsSchema,
    managePolicy: managePolicyKindSchema,
    manageGroupIds: channelPolicyGroupIdsSchema,
    userLimit: channelUserLimitSchema.optional(),
    hasPassword: z.boolean(),
    temporary: z.boolean(),
  })
  .strict();
export type ChannelNodeAdminView = z.infer<typeof channelNodeAdminViewSchema>;
