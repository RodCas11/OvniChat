import { z } from 'zod';

import { messageIdSchema } from '../envelope.js';
import { groupBadgeListSchema } from '../authorization.js';
import {
  MAX_CHANNEL_PARTICIPANTS,
  channelIdSchema,
  displayNameSchema,
  participantIdSchema,
} from '../identifiers.js';

// Reused here purely so a password may be attached to `voice:join` without an import cycle against
// `channels.ts` (which itself imports `MAX_CHANNEL_PARTICIPANTS` from `identifiers.ts` below) —
// identical shape to `channels.ts`'s own `channelPasswordSchema`.
const channelPasswordSchema = z.string().min(1).max(128);

/**
 * `voice:join` requests membership in a voice channel. A connection belongs to zero or one voice
 * channel; if it is already in a different channel, the server leaves that one first as part of
 * processing this message (see `VoiceRegistry.join` in `services/realtime`). `displayName` is
 * resent on every join (not sticky across channel switches) since T3 has no account/session to
 * persist it against.
 *
 * T13.2: `password` is optional and only meaningful against a channel with
 * `ChannelNodeView.hasPassword === true` — see `ChannelPort.checkJoin`'s check ordering (password
 * is the last check, after visibility/join/capacity, so a Guest denied by group policy never
 * reaches the password step at all).
 */
export const clientVoiceJoinMessageSchema = z
  .object({
    type: z.literal('voice:join'),
    id: messageIdSchema,
    channelId: channelIdSchema,
    displayName: displayNameSchema,
    password: channelPasswordSchema.optional(),
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

// `MAX_CHANNEL_PARTICIPANTS` itself now lives in `identifiers.ts` (see that file's doc comment on
// why — breaking the `channels.ts` <-> `messages/voice.ts` import cycle); re-exported here so every
// existing import site (`services/realtime/src/voice/registry.ts`, this package's own tests, etc.)
// keeps working unchanged.
export { MAX_CHANNEL_PARTICIPANTS } from '../identifiers.js';

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

/**
 * A minimal seed shape (id + display name only) — no longer the wire catalog shape (see
 * `messages/channels.ts`'s `serverVoiceCatalogMessageSchema`/`channelNodeSchema`, which replaced it
 * for T13.2). Retained only as the shape a Dedicated Server operator's config file/`ChannelStore`
 * bootstrap seed (`DEFAULT_VOICE_CHANNELS`) uses to describe the three legacy-preserved channels at
 * first-ever database initialization.
 */
export const voiceChannelSummarySchema = z
  .object({
    channelId: channelIdSchema,
    name: z.string().min(1).max(64),
  })
  .strict();

export type VoiceChannelSummary = z.infer<typeof voiceChannelSummarySchema>;
