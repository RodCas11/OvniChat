import { z } from 'zod';

import { messageIdSchema } from '../envelope.js';
import {
  avatarBase64Schema,
  avatarImageFormatSchema,
  avatarRefSchema,
  customStatusSchema,
  effectivePresenceSchema,
  memberPresenceListSchema,
  memberPresenceSchema,
  memberRefSchema,
  presenceStatusSchema,
} from '../profile.js';

/**
 * T13.3 profile/avatar/presence messages. All client messages here require `ready`; the server
 * always derives the actor's `identityId`/effective permissions from the authenticated connection,
 * never from any client-supplied field (mirrors `client:authorization-*`/`client:channel-*`'s own
 * convention exactly). See `services/realtime/src/presence/registry.ts` and
 * `services/realtime/src/profile-port.ts` for the full design.
 */

// --- Client -> server ------------------------------------------------------------------------

export const profileAvatarTargetSchema = z.enum(['self', 'server']);

export const clientProfileSetAvatarMessageSchema = z
  .object({
    type: z.literal('client:profile-set-avatar'),
    id: messageIdSchema,
    /** `'self'` needs no special permission (self-service); `'server'` requires `server.manage`. */
    target: profileAvatarTargetSchema,
    format: avatarImageFormatSchema,
    imageBase64: avatarBase64Schema,
  })
  .strict();
export type ClientProfileSetAvatarMessage = z.infer<typeof clientProfileSetAvatarMessageSchema>;

export const profileClearAvatarTargetSchema = z.enum(['self', 'server', 'member']);

/** `memberRef` is required iff `target === 'member'`, and must be absent otherwise — enforced with
 * `.refine()`, mirroring `messages/chat.ts`'s own conditionally-required-field precedent exactly. */
export const clientProfileClearAvatarMessageSchema = z
  .object({
    type: z.literal('client:profile-clear-avatar'),
    id: messageIdSchema,
    /** `'self'` needs no special permission; `'server'` requires `server.manage`; `'member'`
     * requires `moderation.profile.clear` and only ever clears (never lets the caller set
     * arbitrary content on someone else's behalf). */
    target: profileClearAvatarTargetSchema,
    memberRef: memberRefSchema.optional(),
  })
  .strict()
  .refine((value) => (value.target === 'member' ? value.memberRef !== undefined : true), {
    message: 'memberRef is required when target is "member"',
    path: ['memberRef'],
  })
  .refine((value) => (value.target !== 'member' ? value.memberRef === undefined : true), {
    message: 'memberRef must be absent unless target is "member"',
    path: ['memberRef'],
  });
export type ClientProfileClearAvatarMessage = z.infer<typeof clientProfileClearAvatarMessageSchema>;

/** Self-service only — sets (or, if omitted/empty, clears) the caller's own custom status text. */
export const clientProfileSetStatusMessageSchema = z
  .object({
    type: z.literal('client:profile-set-status'),
    id: messageIdSchema,
    customStatus: customStatusSchema.optional(),
  })
  .strict();
export type ClientProfileSetStatusMessage = z.infer<typeof clientProfileSetStatusMessageSchema>;

/** Requires `moderation.profile.clear`; clears another member's custom status only — never lets the
 * caller set arbitrary content on someone else's behalf. */
export const clientProfileClearMemberStatusMessageSchema = z
  .object({
    type: z.literal('client:profile-clear-member-status'),
    id: messageIdSchema,
    memberRef: memberRefSchema,
  })
  .strict();
export type ClientProfileClearMemberStatusMessage = z.infer<
  typeof clientProfileClearMemberStatusMessageSchema
>;

/** Self-service only — sets the caller's own manual presence preference. */
export const clientProfileSetPresenceMessageSchema = z
  .object({
    type: z.literal('client:profile-set-presence'),
    id: messageIdSchema,
    presence: presenceStatusSchema,
  })
  .strict();
export type ClientProfileSetPresenceMessage = z.infer<typeof clientProfileSetPresenceMessageSchema>;

export const profileAvatarRequestTargetSchema = z.enum(['self', 'server', 'member']);

/** `memberRef` is required iff `target === 'member'`, and must be absent otherwise. A `memberRef`
 * naming a currently-offline/nonexistent member returns the non-fatal `MEMBER_NOT_FOUND`. */
export const clientProfileRequestAvatarMessageSchema = z
  .object({
    type: z.literal('client:profile-request-avatar'),
    id: messageIdSchema,
    target: profileAvatarRequestTargetSchema,
    memberRef: memberRefSchema.optional(),
  })
  .strict()
  .refine((value) => (value.target === 'member' ? value.memberRef !== undefined : true), {
    message: 'memberRef is required when target is "member"',
    path: ['memberRef'],
  })
  .refine((value) => (value.target !== 'member' ? value.memberRef === undefined : true), {
    message: 'memberRef must be absent unless target is "member"',
    path: ['memberRef'],
  });
export type ClientProfileRequestAvatarMessage = z.infer<
  typeof clientProfileRequestAvatarMessageSchema
>;

export const clientProfileMessageSchema = z.discriminatedUnion('type', [
  clientProfileSetAvatarMessageSchema,
  clientProfileClearAvatarMessageSchema,
  clientProfileSetStatusMessageSchema,
  clientProfileClearMemberStatusMessageSchema,
  clientProfileSetPresenceMessageSchema,
  clientProfileRequestAvatarMessageSchema,
]);
export type ClientProfileMessage = z.infer<typeof clientProfileMessageSchema>;

// --- Server -> client ------------------------------------------------------------------------

/** Confirms a successful self-service mutation (avatar/status/presence) to the actor themselves —
 * `id` echoes the request's `id`. The corresponding live update to every *other* connection is the
 * separate `server:presence-updated` broadcast below. */
export const serverProfileSelfUpdatedMessageSchema = z
  .object({
    type: z.literal('server:profile-self-updated'),
    id: messageIdSchema,
    presence: effectivePresenceSchema,
    customStatus: customStatusSchema.optional(),
    avatarRef: avatarRefSchema.optional(),
  })
  .strict();
export type ServerProfileSelfUpdatedMessage = z.infer<typeof serverProfileSelfUpdatedMessageSchema>;

/** Reply to `client:profile-request-avatar`; `id` echoes the request's `id`. */
export const serverProfileAvatarDataMessageSchema = z
  .object({
    type: z.literal('server:profile-avatar-data'),
    id: messageIdSchema,
    format: avatarImageFormatSchema,
    imageBase64: avatarBase64Schema,
    avatarRef: avatarRefSchema,
  })
  .strict();
export type ServerProfileAvatarDataMessage = z.infer<typeof serverProfileAvatarDataMessageSchema>;

/** The full online-member presence snapshot, sent once to a connection that just became `ready`
 * (T13.3's admission-time push, mirroring `voice:catalog`'s own "resend the whole small bounded
 * thing" convention) — every other already-online member's current state, never including the
 * recipient's own entry in `members`. `selfMemberRef` is this connection's own identity's
 * `memberRef` (always defined in practice — `registerConnection` always runs before this message is
 * built — but optional here rather than widening `memberRefSchema` itself, matching this schema
 * family's existing "describe the real shape, degrade gracefully" convention). It exists solely so
 * the recipient can recognize and filter out its own identity from any *later* `server:presence-
 * updated` naming it (e.g. a moderator clearing this identity's own avatar/status) — without it, a
 * client has no way to tell "this update is about me" from "this is really another member," and
 * would otherwise render a duplicate of itself. */
export const serverPresenceSnapshotMessageSchema = z
  .object({
    type: z.literal('server:presence-snapshot'),
    id: messageIdSchema,
    members: memberPresenceListSchema,
    selfMemberRef: memberRefSchema.optional(),
  })
  .strict();
export type ServerPresenceSnapshotMessage = z.infer<typeof serverPresenceSnapshotMessageSchema>;

/** Pushed to every other `ready` connection whenever a member's presence-relevant state changes:
 * newly online (0->=1 live connections), or any successful avatar/status/presence
 * mutation (self-service or moderator-clear) while already online. Not a response — fresh `id`. */
export const serverPresenceUpdatedMessageSchema = z
  .object({
    type: z.literal('server:presence-updated'),
    id: messageIdSchema,
    member: memberPresenceSchema,
  })
  .strict();
export type ServerPresenceUpdatedMessage = z.infer<typeof serverPresenceUpdatedMessageSchema>;

/** Pushed to every remaining `ready` connection when an identity's live-connection count drops to
 * zero (its *last* connection closed) — never sent for a connection closing while the same identity
 * still has another live connection elsewhere. */
export const serverPresenceRemovedMessageSchema = z
  .object({
    type: z.literal('server:presence-removed'),
    id: messageIdSchema,
    memberRef: memberRefSchema,
  })
  .strict();
export type ServerPresenceRemovedMessage = z.infer<typeof serverPresenceRemovedMessageSchema>;

export const serverProfileMessageSchema = z.discriminatedUnion('type', [
  serverProfileSelfUpdatedMessageSchema,
  serverProfileAvatarDataMessageSchema,
  serverPresenceSnapshotMessageSchema,
  serverPresenceUpdatedMessageSchema,
  serverPresenceRemovedMessageSchema,
]);
export type ServerProfileMessage = z.infer<typeof serverProfileMessageSchema>;
