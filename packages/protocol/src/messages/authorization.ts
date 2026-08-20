import { z } from 'zod';

import { messageIdSchema } from '../envelope.js';
import { participantIdSchema } from '../identifiers.js';
import { identityIdSchema } from '../identity.js';
import {
  authorizationExpiresAtSchema,
  banSummaryListSchema,
  groupBadgeListSchema,
  groupBadgeSchema,
  groupIdSchema,
  groupNameSchema,
  groupSummaryListSchema,
  permissionKeysSchema,
  serverTokenSchema,
  tokenKindSchema,
} from '../authorization.js';

/**
 * T9 server-local authorization messages. All client messages here are only ever dispatched from
 * `ready` (the connection already completed T7's identity proof); every mutation is re-validated
 * server-side against the caller's own current permissions — nothing here is a client-asserted
 * capability (T9 Section 35/37). A target is always named by `targetParticipantId` (server-resolved
 * to a connection/identity internally), never a client-supplied `identityId` — the one deliberate
 * exception is `client:authorization-unban`, since an unban target is by definition not an online
 * participant and an administrator managing bans already legitimately sees raw identity ids
 * (`banSummarySchema`).
 */

const MAX_TOKEN_LIFETIME_MS = 1000 * 60 * 60 * 24 * 365; // 1 year — generous but not "forever".

export const clientAuthorizationRedeemTokenMessageSchema = z
  .object({
    type: z.literal('client:authorization-redeem-token'),
    id: messageIdSchema,
    token: serverTokenSchema,
  })
  .strict();
export type ClientAuthorizationRedeemTokenMessage = z.infer<
  typeof clientAuthorizationRedeemTokenMessageSchema
>;

export const clientAuthorizationCreateTokenMessageSchema = z
  .object({
    type: z.literal('client:authorization-create-token'),
    id: messageIdSchema,
    tokenKind: tokenKindSchema,
    groupId: groupIdSchema,
    expiresInMs: z.number().int().positive().max(MAX_TOKEN_LIFETIME_MS).optional(),
  })
  .strict();
export type ClientAuthorizationCreateTokenMessage = z.infer<
  typeof clientAuthorizationCreateTokenMessageSchema
>;

export const clientAuthorizationListGroupsMessageSchema = z
  .object({
    type: z.literal('client:authorization-list-groups'),
    id: messageIdSchema,
  })
  .strict();
export type ClientAuthorizationListGroupsMessage = z.infer<
  typeof clientAuthorizationListGroupsMessageSchema
>;

export const clientAuthorizationCreateGroupMessageSchema = z
  .object({
    type: z.literal('client:authorization-create-group'),
    id: messageIdSchema,
    name: groupNameSchema,
    permissions: permissionKeysSchema,
  })
  .strict();
export type ClientAuthorizationCreateGroupMessage = z.infer<
  typeof clientAuthorizationCreateGroupMessageSchema
>;

export const clientAuthorizationUpdateGroupMessageSchema = z
  .object({
    type: z.literal('client:authorization-update-group'),
    id: messageIdSchema,
    groupId: groupIdSchema,
    name: groupNameSchema.optional(),
    permissions: permissionKeysSchema.optional(),
  })
  .strict();
export type ClientAuthorizationUpdateGroupMessage = z.infer<
  typeof clientAuthorizationUpdateGroupMessageSchema
>;

export const clientAuthorizationDeleteGroupMessageSchema = z
  .object({
    type: z.literal('client:authorization-delete-group'),
    id: messageIdSchema,
    groupId: groupIdSchema,
  })
  .strict();
export type ClientAuthorizationDeleteGroupMessage = z.infer<
  typeof clientAuthorizationDeleteGroupMessageSchema
>;

export const clientAuthorizationGrantGroupMessageSchema = z
  .object({
    type: z.literal('client:authorization-grant-group'),
    id: messageIdSchema,
    targetParticipantId: participantIdSchema,
    groupId: groupIdSchema,
  })
  .strict();
export type ClientAuthorizationGrantGroupMessage = z.infer<
  typeof clientAuthorizationGrantGroupMessageSchema
>;

export const clientAuthorizationRevokeGroupMessageSchema = z
  .object({
    type: z.literal('client:authorization-revoke-group'),
    id: messageIdSchema,
    targetParticipantId: participantIdSchema,
    groupId: groupIdSchema,
  })
  .strict();
export type ClientAuthorizationRevokeGroupMessage = z.infer<
  typeof clientAuthorizationRevokeGroupMessageSchema
>;

export const clientAuthorizationKickMessageSchema = z
  .object({
    type: z.literal('client:authorization-kick'),
    id: messageIdSchema,
    targetParticipantId: participantIdSchema,
  })
  .strict();
export type ClientAuthorizationKickMessage = z.infer<typeof clientAuthorizationKickMessageSchema>;

const MAX_BAN_DURATION_MS = 1000 * 60 * 60 * 24 * 365 * 10; // 10 years — a practical "permanent".

export const clientAuthorizationBanMessageSchema = z
  .object({
    type: z.literal('client:authorization-ban'),
    id: messageIdSchema,
    targetParticipantId: participantIdSchema,
    /** Absent means permanent (T9 Section 22). */
    durationMs: z.number().int().positive().max(MAX_BAN_DURATION_MS).optional(),
    reason: z.string().max(256).optional(),
  })
  .strict();
export type ClientAuthorizationBanMessage = z.infer<typeof clientAuthorizationBanMessageSchema>;

export const clientAuthorizationUnbanMessageSchema = z
  .object({
    type: z.literal('client:authorization-unban'),
    id: messageIdSchema,
    identityId: identityIdSchema,
  })
  .strict();
export type ClientAuthorizationUnbanMessage = z.infer<typeof clientAuthorizationUnbanMessageSchema>;

export const clientAuthorizationListBansMessageSchema = z
  .object({
    type: z.literal('client:authorization-list-bans'),
    id: messageIdSchema,
  })
  .strict();
export type ClientAuthorizationListBansMessage = z.infer<
  typeof clientAuthorizationListBansMessageSchema
>;

export const clientAuthorizationMessageSchema = z.discriminatedUnion('type', [
  clientAuthorizationRedeemTokenMessageSchema,
  clientAuthorizationCreateTokenMessageSchema,
  clientAuthorizationListGroupsMessageSchema,
  clientAuthorizationCreateGroupMessageSchema,
  clientAuthorizationUpdateGroupMessageSchema,
  clientAuthorizationDeleteGroupMessageSchema,
  clientAuthorizationGrantGroupMessageSchema,
  clientAuthorizationRevokeGroupMessageSchema,
  clientAuthorizationKickMessageSchema,
  clientAuthorizationBanMessageSchema,
  clientAuthorizationUnbanMessageSchema,
  clientAuthorizationListBansMessageSchema,
]);
export type ClientAuthorizationMessage = z.infer<typeof clientAuthorizationMessageSchema>;

// --- Server -> client ------------------------------------------------------------------------

/**
 * The connecting identity's own authorization snapshot — sent once at `ready` (alongside
 * `voice:catalog`) and re-sent (targeted, never broadcast) whenever an admin action changes this
 * connection's own groups, so an already-connected client's authority updates promptly (T9 Section
 * 61) without requiring a reconnect.
 */
export const serverAuthorizationStateMessageSchema = z
  .object({
    type: z.literal('server:authorization-state'),
    id: messageIdSchema,
    groups: groupBadgeListSchema,
    permissions: permissionKeysSchema,
  })
  .strict();
export type ServerAuthorizationStateMessage = z.infer<typeof serverAuthorizationStateMessageSchema>;

/** Reply to `client:authorization-list-groups`. Group definitions/permission sets are not secret —
 * any `ready` connection may request this list; only mutating it is permission-gated. */
export const serverAuthorizationGroupsMessageSchema = z
  .object({
    type: z.literal('server:authorization-groups'),
    id: messageIdSchema,
    groups: groupSummaryListSchema,
  })
  .strict();
export type ServerAuthorizationGroupsMessage = z.infer<
  typeof serverAuthorizationGroupsMessageSchema
>;

/** Generic success acknowledgement for a mutation that needs no richer payload (create/update/
 * delete-group, grant/revoke-group, kick, ban, unban) — `id` echoes the request's `id`. */
export const serverAuthorizationAckMessageSchema = z
  .object({
    type: z.literal('server:authorization-ack'),
    id: messageIdSchema,
  })
  .strict();
export type ServerAuthorizationAckMessage = z.infer<typeof serverAuthorizationAckMessageSchema>;

/** Reply to `client:authorization-create-token`. The raw `token` is shown here exactly once — the
 * server never stores it and can never redisplay it later (T9 Section 12/48). */
export const serverAuthorizationTokenCreatedMessageSchema = z
  .object({
    type: z.literal('server:authorization-token-created'),
    id: messageIdSchema,
    token: serverTokenSchema,
    tokenKind: tokenKindSchema,
    groupId: groupIdSchema,
    expiresAt: authorizationExpiresAtSchema.optional(),
  })
  .strict();
export type ServerAuthorizationTokenCreatedMessage = z.infer<
  typeof serverAuthorizationTokenCreatedMessageSchema
>;

/** Reply to `client:authorization-redeem-token`. */
export const serverAuthorizationTokenRedeemedMessageSchema = z
  .object({
    type: z.literal('server:authorization-token-redeemed'),
    id: messageIdSchema,
    group: groupBadgeSchema,
  })
  .strict();
export type ServerAuthorizationTokenRedeemedMessage = z.infer<
  typeof serverAuthorizationTokenRedeemedMessageSchema
>;

/** Reply to `client:authorization-list-bans`. Never sent unprompted, and never to a connection
 * without `moderation.ban` (T9 Section 25: the ban list is not shown to ordinary users). */
export const serverAuthorizationBansMessageSchema = z
  .object({
    type: z.literal('server:authorization-bans'),
    id: messageIdSchema,
    bans: banSummaryListSchema,
  })
  .strict();
export type ServerAuthorizationBansMessage = z.infer<typeof serverAuthorizationBansMessageSchema>;

export const serverAuthorizationMessageSchema = z.discriminatedUnion('type', [
  serverAuthorizationStateMessageSchema,
  serverAuthorizationGroupsMessageSchema,
  serverAuthorizationAckMessageSchema,
  serverAuthorizationTokenCreatedMessageSchema,
  serverAuthorizationTokenRedeemedMessageSchema,
  serverAuthorizationBansMessageSchema,
]);
export type ServerAuthorizationMessage = z.infer<typeof serverAuthorizationMessageSchema>;
