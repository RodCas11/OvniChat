import { z } from 'zod';

import { channelIdSchema, displayNameSchema, participantIdSchema } from './identifiers.js';

/**
 * T10 — persistent server-side text chat wire schemas. Deliberately crypto-free and Node-free,
 * matching every other file in this package: the actual chat *store* (SQLite, migrations, bounded
 * pagination) lives entirely in `services/dedicated-server/src/chat/`, never here. This file only
 * describes what can be said on the wire.
 *
 * Two scopes only (T10 Section 5) — no independent Discord-style text-channel hierarchy yet:
 * `'server'` (one history per Dedicated Server) and `'channel'` (one history per existing
 * server-owned voice channel, keyed by the same `channelId` `voice:*` already uses). A future task
 * may introduce standalone text channels; T10 deliberately does not build toward that shape yet.
 */

/**
 * A server-local, monotonically increasing message identifier (SQLite `INTEGER PRIMARY KEY
 * AUTOINCREMENT` rowid — see `docs/architecture/PERSISTENT_TEXT_CHAT.md`). This is the ordering
 * *and* pagination-cursor authority (T10 Section 18/19/27) — never wall-clock `createdAt`, which
 * two messages can share to the millisecond and which a restarted server's clock could in theory
 * regress. A plain positive integer is sufficient and simpler than a string encoding: SQLite's
 * rowid and JS's `number` both represent every value here exactly (IEEE754 doubles are exact up to
 * 2^53-1, far beyond any realistic self-hosted message volume). Server-local uniqueness only — never
 * required to be globally unique across independently-operated Dedicated Servers (T10 Section 19).
 */
export const chatMessageIdSchema = z.number().int().positive();
export type ChatMessageId = z.infer<typeof chatMessageIdSchema>;

/** `'server'` = server-wide chat; `'channel'` = one existing voice channel's persistent chat. */
export const chatScopeSchema = z.enum(['server', 'channel']);
export type ChatScope = z.infer<typeof chatScopeSchema>;

/**
 * Plain UTF-8 text only (T10 Section 22) — no Markdown, HTML, attachments, or rich embeds. Newlines
 * within an ordinary chat message are expected (multi-line composition), so this is intentionally
 * *not* `identifiers.ts`'s all-control-characters-rejected pattern (that one is for single-line
 * display labels) — tab/LF/CR are allowed, every other C0 control and DEL is rejected. Trimmed:
 * leading/trailing whitespace is not meaningful content. Bounded at {@link CHAT_MESSAGE_BODY_MAX_LENGTH}
 * (T10 Section 21) — chosen with headroom under this package's transport-frame conventions, not
 * arbitrarily; enforced here (schema) *and* independently by the Dedicated Server's rate/size
 * posture, never trusted from a single layer alone.
 */
export const CHAT_MESSAGE_BODY_MAX_LENGTH = 4000;
// Allow tab (0x09), LF (0x0A), CR (0x0D); reject every other C0 control and DEL (0x7F).
// eslint-disable-next-line no-control-regex
const CHAT_BODY_CONTROL_PATTERN = new RegExp('^[^\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F]*$', 'u');
export const chatMessageBodySchema = z
  .string()
  .trim()
  .min(1, 'message body cannot be blank')
  .max(CHAT_MESSAGE_BODY_MAX_LENGTH)
  .regex(CHAT_BODY_CONTROL_PATTERN, 'control characters are not allowed');

/**
 * The one canonical message shape used for both a live broadcast (`server:chat-message`) and a
 * history page (`server:chat-history-page`) — deliberately, so historical messages never render
 * differently from live ones (T10 Section 72). Never carries a stable `identityId` (T10 Section
 * 13/53: ordinary clients see only nickname-at-send, never the sender's stable identity) —
 * `senderNickname` is fixed at send time and never rewritten if the sender later reconnects under a
 * different nickname (T10 Section 12). `senderParticipantId` is a *live-only* nicety: present only
 * when the sender is currently an online voice participant (channel-chat sends always have one,
 * since sending requires current channel membership; server-chat sends have one only if the sender
 * happens to be in a voice channel right now) and always absent on a history replay, since a
 * historical sender's current online status is not reconstructed (T10 Section 11: runtime-only,
 * never persisted, never re-derived after the fact).
 */
export const chatMessageViewSchema = z
  .object({
    messageId: chatMessageIdSchema,
    scope: chatScopeSchema,
    /** Present iff `scope === 'channel'`; absent for `scope === 'server'`. */
    channelId: channelIdSchema.optional(),
    senderNickname: displayNameSchema,
    senderParticipantId: participantIdSchema.optional(),
    body: chatMessageBodySchema,
    /** Server-assigned epoch-milliseconds (UTC) — never a client-supplied timestamp (T10 Section 20). */
    createdAt: z.number().int().positive(),
  })
  .strict()
  .refine((value) => (value.scope === 'channel' ? value.channelId !== undefined : true), {
    message: 'channelId is required when scope is "channel"',
    path: ['channelId'],
  })
  .refine((value) => (value.scope === 'server' ? value.channelId === undefined : true), {
    message: 'channelId must be absent when scope is "server"',
    path: ['channelId'],
  });
export type ChatMessageView = z.infer<typeof chatMessageViewSchema>;

/** Bounded page of messages — never the entire history (T10 Section 25/39, mandatory). */
export const CHAT_HISTORY_DEFAULT_PAGE_SIZE = 50;
export const CHAT_HISTORY_MAX_PAGE_SIZE = 100;
export const chatHistoryLimitSchema = z.number().int().positive().max(CHAT_HISTORY_MAX_PAGE_SIZE);

export const MAX_CHAT_MESSAGES_PER_PAGE = CHAT_HISTORY_MAX_PAGE_SIZE;
export const chatMessageViewListSchema = z
  .array(chatMessageViewSchema)
  .max(MAX_CHAT_MESSAGES_PER_PAGE);
