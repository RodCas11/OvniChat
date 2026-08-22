import { z } from 'zod';

import {
  aclPolicyKindSchema,
  channelNodeAdminViewSchema,
  channelNodeListSchema,
  channelNodeNameSchema,
  channelPasswordSchema,
  channelPolicyGroupIdsSchema,
  channelUserLimitSchema,
  managePolicyKindSchema,
} from '../channels.js';
import { messageIdSchema } from '../envelope.js';
import { channelIdSchema } from '../identifiers.js';

/**
 * T13.2 channel/category tree administration messages. All client messages here require `ready`
 * (the connection already completed T7's identity proof) and are permission-gated server-side
 * (`channels.create`/`channels.manage`/`channels.delete`, or the target node's own local Manage
 * ACL via `ChannelPort.hasManageRights`) — mirrors `client:authorization-*`'s shape convention
 * exactly: `.strict()`, an explicit `id`, and a server-resolved `nodeId` never trusted as a
 * client-asserted capability. See `services/realtime/src/channel-port.ts` for the full design.
 */

export const clientChannelCreateCategoryMessageSchema = z
  .object({
    type: z.literal('client:channel-create-category'),
    id: messageIdSchema,
    name: channelNodeNameSchema,
    /** Always `undefined` in practice — a category's parent must always be `NULL` (categories are
     * always top-level) — but the field is present so a malformed client-attempted non-root create
     * fails with `CHANNEL_PARENT_INVALID`, a distinct, specifically-coded rejection, rather than a
     * generic schema violation. */
    parentId: channelIdSchema.optional(),
  })
  .strict();
export type ClientChannelCreateCategoryMessage = z.infer<
  typeof clientChannelCreateCategoryMessageSchema
>;

export const clientChannelCreateVoiceMessageSchema = z
  .object({
    type: z.literal('client:channel-create-voice'),
    id: messageIdSchema,
    name: channelNodeNameSchema,
    parentId: channelIdSchema.optional(),
    /** Omitted/`false` (default) = an ordinary persistent voice channel, created via `ChannelPort`
     * (today's behavior, unchanged). `true` = an in-memory-only "quick channel", created via
     * `TemporaryChannelRegistry` instead — structurally cannot survive a restart, is never
     * reorderable/ACL-overridable, and is destroyed automatically once empty (see
     * `services/realtime/src/voice/temporary-channels.ts`). Creation and joining remain two
     * separate client-issued messages — this message never auto-joins; the client still sends an
     * ordinary `voice:join` for the returned `nodeId` afterward. */
    temporary: z.boolean().optional(),
  })
  .strict();
export type ClientChannelCreateVoiceMessage = z.infer<typeof clientChannelCreateVoiceMessageSchema>;

export const clientChannelUpdateMessageSchema = z
  .object({
    type: z.literal('client:channel-update'),
    id: messageIdSchema,
    nodeId: channelIdSchema,
    name: channelNodeNameSchema.optional(),
    visibilityPolicy: aclPolicyKindSchema.optional(),
    visibilityGroupIds: channelPolicyGroupIdsSchema.optional(),
    joinPolicy: aclPolicyKindSchema.optional(),
    joinGroupIds: channelPolicyGroupIdsSchema.optional(),
    managePolicy: managePolicyKindSchema.optional(),
    manageGroupIds: channelPolicyGroupIdsSchema.optional(),
    /** `undefined` = leave unchanged; a number = set; `null` = clear back to "no explicit limit"
     * (falls back to `MAX_CHANNEL_PARTICIPANTS`). Voice kind only — ignored for a category. */
    userLimit: channelUserLimitSchema.nullable().optional(),
  })
  .strict();
export type ClientChannelUpdateMessage = z.infer<typeof clientChannelUpdateMessageSchema>;

export const clientChannelMoveMessageSchema = z
  .object({
    type: z.literal('client:channel-move'),
    id: messageIdSchema,
    nodeId: channelIdSchema,
    newParentId: channelIdSchema.optional(),
  })
  .strict();
export type ClientChannelMoveMessage = z.infer<typeof clientChannelMoveMessageSchema>;

export const MAX_REORDER_SIBLINGS = 256;

export const clientChannelReorderMessageSchema = z
  .object({
    type: z.literal('client:channel-reorder'),
    id: messageIdSchema,
    parentId: channelIdSchema.optional(),
    orderedNodeIds: z.array(channelIdSchema).max(MAX_REORDER_SIBLINGS),
  })
  .strict();
export type ClientChannelReorderMessage = z.infer<typeof clientChannelReorderMessageSchema>;

export const clientChannelDeleteMessageSchema = z
  .object({
    type: z.literal('client:channel-delete'),
    id: messageIdSchema,
    nodeId: channelIdSchema,
  })
  .strict();
export type ClientChannelDeleteMessage = z.infer<typeof clientChannelDeleteMessageSchema>;

export const clientChannelSetPasswordMessageSchema = z
  .object({
    type: z.literal('client:channel-set-password'),
    id: messageIdSchema,
    nodeId: channelIdSchema,
    password: channelPasswordSchema,
  })
  .strict();
export type ClientChannelSetPasswordMessage = z.infer<typeof clientChannelSetPasswordMessageSchema>;

export const clientChannelRemovePasswordMessageSchema = z
  .object({
    type: z.literal('client:channel-remove-password'),
    id: messageIdSchema,
    nodeId: channelIdSchema,
  })
  .strict();
export type ClientChannelRemovePasswordMessage = z.infer<
  typeof clientChannelRemovePasswordMessageSchema
>;

export const clientChannelGetEditableNodeMessageSchema = z
  .object({
    type: z.literal('client:channel-get-editable-node'),
    id: messageIdSchema,
    nodeId: channelIdSchema,
  })
  .strict();
export type ClientChannelGetEditableNodeMessage = z.infer<
  typeof clientChannelGetEditableNodeMessageSchema
>;

export const clientChannelMessageSchema = z.discriminatedUnion('type', [
  clientChannelCreateCategoryMessageSchema,
  clientChannelCreateVoiceMessageSchema,
  clientChannelUpdateMessageSchema,
  clientChannelMoveMessageSchema,
  clientChannelReorderMessageSchema,
  clientChannelDeleteMessageSchema,
  clientChannelSetPasswordMessageSchema,
  clientChannelRemovePasswordMessageSchema,
  clientChannelGetEditableNodeMessageSchema,
]);
export type ClientChannelMessage = z.infer<typeof clientChannelMessageSchema>;

// --- Server -> client ------------------------------------------------------------------------

/** Reply to `client:channel-create-category`/`client:channel-create-voice` — gives the actor the
 * newly created node's full admin view (including the server-generated `nodeId`) so they can
 * continue editing it without a second round trip. */
export const serverChannelCreatedMessageSchema = z
  .object({
    type: z.literal('server:channel-created'),
    id: messageIdSchema,
    node: channelNodeAdminViewSchema,
  })
  .strict();
export type ServerChannelCreatedMessage = z.infer<typeof serverChannelCreatedMessageSchema>;

/** Generic success acknowledgement for a mutation that needs no richer payload (update, move,
 * reorder, delete, set-password, remove-password) — `id` echoes the request's `id`, mirroring
 * `server:authorization-ack`. */
export const serverChannelAckMessageSchema = z
  .object({
    type: z.literal('server:channel-ack'),
    id: messageIdSchema,
  })
  .strict();
export type ServerChannelAckMessage = z.infer<typeof serverChannelAckMessageSchema>;

/** Reply to `client:channel-get-editable-node`. */
export const serverChannelEditableNodeMessageSchema = z
  .object({
    type: z.literal('server:channel-editable-node'),
    id: messageIdSchema,
    node: channelNodeAdminViewSchema,
  })
  .strict();
export type ServerChannelEditableNodeMessage = z.infer<
  typeof serverChannelEditableNodeMessageSchema
>;

/** The full, per-connection-filtered channel-tree snapshot — resent in full on every relevant
 * mutation (tree change, or a group-membership/ban change that can alter what this connection may
 * see/join), never a differential/patch protocol (matches this codebase's repeated bias toward
 * "resend the whole small bounded thing": T8's catalog, T9's `server:authorization-state`, T10's
 * chat). **Replaces** the old flat `voice:catalog.channels` shape entirely — see `version.ts`. */
export const serverVoiceCatalogMessageSchema = z
  .object({
    type: z.literal('voice:catalog'),
    id: messageIdSchema,
    nodes: channelNodeListSchema,
  })
  .strict();
export type ServerVoiceCatalogMessage = z.infer<typeof serverVoiceCatalogMessageSchema>;

/** Sent to a participant force-removed from voice because a group/ACL change revoked their join
 * rights — distinct from a self-initiated `voice:left` and a moderation `KICKED`/`BANNED` close, so
 * the client can render an accurate, non-punitive message ("you can no longer access this
 * channel", not "you were kicked"). Never fatal — the connection stays open, only voice membership
 * ends. */
export const serverVoiceRemovedByPolicyMessageSchema = z
  .object({
    type: z.literal('server:voice-removed-by-policy'),
    id: messageIdSchema,
    channelId: channelIdSchema,
    reason: z.literal('access-revoked'),
  })
  .strict();
export type ServerVoiceRemovedByPolicyMessage = z.infer<
  typeof serverVoiceRemovedByPolicyMessageSchema
>;

export const serverChannelMessageSchema = z.discriminatedUnion('type', [
  serverChannelCreatedMessageSchema,
  serverChannelAckMessageSchema,
  serverChannelEditableNodeMessageSchema,
  serverVoiceCatalogMessageSchema,
  serverVoiceRemovedByPolicyMessageSchema,
]);
export type ServerChannelMessage = z.infer<typeof serverChannelMessageSchema>;
