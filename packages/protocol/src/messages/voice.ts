import { z } from 'zod';

import { messageIdSchema } from '../envelope.js';
import { groupBadgeListSchema } from '../authorization.js';
import { channelIdSchema, displayNameSchema, participantIdSchema } from '../identifiers.js';

/**
 * `voice:join` requests membership in a voice channel. A connection belongs to zero or one voice
 * channel; if it is already in a different channel, the server leaves that one first as part of
 * processing this message (see `VoiceRegistry.join` in `services/realtime`). `displayName` is
 * resent on every join (not sticky across channel switches) since T3 has no account/session to
 * persist it against.
 */
export const clientVoiceJoinMessageSchema = z
  .object({
    type: z.literal('voice:join'),
    id: messageIdSchema,
    channelId: channelIdSchema,
    displayName: displayNameSchema,
  })
  .strict();

export type ClientVoiceJoinMessage = z.infer<typeof clientVoiceJoinMessageSchema>;

export const clientVoiceLeaveMessageSchema = z
  .object({
    type: z.literal('voice:leave'),
    id: messageIdSchema,
  })
  .strict();

export type ClientVoiceLeaveMessage = z.infer<typeof clientVoiceLeaveMessageSchema>;

/**
 * A participant as seen by other participants — never includes `connectionId` or `identityId`.
 * T9: `groups` is an optional snapshot of the participant's server-local group badges at the
 * moment they joined (see `authorization.ts`'s `groupBadgeSchema`) — display-only, never a trust
 * signal, and never live-updated to other viewers if the participant's groups change mid-session
 * (see `docs/architecture/SERVER_AUTHORIZATION.md`'s known limitations). Absent/empty for a
 * connection whose authorization port grants no group badges (e.g. `services/realtime`'s own
 * no-op default).
 */
export const voiceParticipantSchema = z
  .object({
    participantId: participantIdSchema,
    displayName: displayNameSchema,
    groups: groupBadgeListSchema.optional(),
  })
  .strict();

export type VoiceParticipant = z.infer<typeof voiceParticipantSchema>;

/**
 * Also the maximum membership `VoiceRegistry.join` enforces per channel (see
 * `services/realtime/src/voice/registry.ts`) — a single source of truth, since a channel that
 * could exceed this could never actually send a valid `voice:joined` snapshot to its own newest
 * member.
 */
export const MAX_CHANNEL_PARTICIPANTS = 64;

/** Confirms a successful `voice:join`; `id` echoes the join request's `id`. */
export const serverVoiceJoinedMessageSchema = z
  .object({
    type: z.literal('voice:joined'),
    id: messageIdSchema,
    channelId: channelIdSchema,
    participantId: participantIdSchema,
    participants: z.array(voiceParticipantSchema).max(MAX_CHANNEL_PARTICIPANTS),
  })
  .strict();

export type ServerVoiceJoinedMessage = z.infer<typeof serverVoiceJoinedMessageSchema>;

/** Confirms a successful `voice:leave`; `id` echoes the leave request's `id`. */
export const serverVoiceLeftMessageSchema = z
  .object({
    type: z.literal('voice:left'),
    id: messageIdSchema,
    channelId: channelIdSchema,
  })
  .strict();

export type ServerVoiceLeftMessage = z.infer<typeof serverVoiceLeftMessageSchema>;

/** Sent to existing channel members when someone new joins. Not a response — fresh `id`. */
export const serverVoiceParticipantJoinedMessageSchema = z
  .object({
    type: z.literal('voice:participant-joined'),
    id: messageIdSchema,
    channelId: channelIdSchema,
    participant: voiceParticipantSchema,
  })
  .strict();

export type ServerVoiceParticipantJoinedMessage = z.infer<
  typeof serverVoiceParticipantJoinedMessageSchema
>;

/**
 * Sent to remaining channel members when a participant leaves — either explicitly (`voice:leave`),
 * by switching channels, or by abrupt disconnect. Not a response — fresh `id`.
 */
export const serverVoiceParticipantLeftMessageSchema = z
  .object({
    type: z.literal('voice:participant-left'),
    id: messageIdSchema,
    channelId: channelIdSchema,
    participantId: participantIdSchema,
  })
  .strict();

export type ServerVoiceParticipantLeftMessage = z.infer<
  typeof serverVoiceParticipantLeftMessageSchema
>;

export const voiceChannelSummarySchema = z
  .object({
    channelId: channelIdSchema,
    name: z.string().min(1).max(64),
  })
  .strict();

export type VoiceChannelSummary = z.infer<typeof voiceChannelSummarySchema>;

/**
 * The server's predefined channel catalog, sent once automatically as soon as the connection
 * reaches `ready` (immediately after `server:hello`) — the client never has to ask for it, and
 * there is no server-management UI to change it at runtime in T3.
 */
export const serverVoiceCatalogMessageSchema = z
  .object({
    type: z.literal('voice:catalog'),
    id: messageIdSchema,
    channels: z.array(voiceChannelSummarySchema).max(64),
  })
  .strict();

export type ServerVoiceCatalogMessage = z.infer<typeof serverVoiceCatalogMessageSchema>;
