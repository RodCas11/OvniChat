import { z } from 'zod';

import { messageIdSchema } from '../envelope.js';
import { channelIdSchema } from '../identifiers.js';
import {
  chatHistoryLimitSchema,
  chatMessageBodySchema,
  chatMessageIdSchema,
  chatMessageViewListSchema,
  chatMessageViewSchema,
  chatScopeSchema,
} from '../chat.js';

/**
 * T10 persistent server-side text chat messages. Both client messages here are only ever dispatched
 * from `ready` (the connection already completed T7's identity proof); the server always derives
 * `senderIdentityId`/nickname-at-send itself and never trusts a client-supplied sender field (T10
 * Section 29/30/74) — neither message type below carries one at all, by construction, so there is
 * nothing to strip or ignore. Sending is authorization-gated (`chat.server.send` /
 * `chat.channel.send`, see `docs/architecture/PERSISTENT_TEXT_CHAT.md`); reading history is not
 * (T10 Section 8: any `ready` connection may request history for a scope it can otherwise see, since
 * this repository has no channel-visibility ACL beyond server admission).
 */

export const clientChatSendMessageSchema = z
  .object({
    type: z.literal('client:chat-send'),
    id: messageIdSchema,
    scope: chatScopeSchema,
    /** Required iff `scope === 'channel'`; must be absent for `scope === 'server'`. */
    channelId: channelIdSchema.optional(),
    body: chatMessageBodySchema,
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
export type ClientChatSendMessage = z.infer<typeof clientChatSendMessageSchema>;

export const clientChatHistoryRequestMessageSchema = z
  .object({
    type: z.literal('client:chat-history-request'),
    id: messageIdSchema,
    scope: chatScopeSchema,
    /** Required iff `scope === 'channel'`; must be absent for `scope === 'server'`. */
    channelId: channelIdSchema.optional(),
    /** Cursor: return messages strictly older than this one (T10 Section 25/27). Absent means "the
     * most recent page." */
    beforeMessageId: chatMessageIdSchema.optional(),
    /** Bounded page size (T10 Section 25/61) — absent defaults server-side to a reasonable page
     * size; a client cannot request an unbounded page (`chatHistoryLimitSchema` caps it). */
    limit: chatHistoryLimitSchema.optional(),
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
export type ClientChatHistoryRequestMessage = z.infer<typeof clientChatHistoryRequestMessageSchema>;

export const clientChatMessageSchema = z.discriminatedUnion('type', [
  clientChatSendMessageSchema,
  clientChatHistoryRequestMessageSchema,
]);
export type ClientChatMessage = z.infer<typeof clientChatMessageSchema>;

// --- Server -> client ------------------------------------------------------------------------

/**
 * A single canonical chat message, pushed live to every current recipient of its scope
 * (`server:chat-message`'s own `id` is a fresh server-generated id, not a reply to the sender's
 * `client:chat-send.id` — the sender receives this exact same broadcast as everyone else, which is
 * itself the send-succeeded confirmation; see T10 Section 40/41's "do not broadcast something that
 * failed to store," implemented by only ever constructing this message from an already-persisted
 * record). Uses {@link chatMessageViewSchema} unmodified — see that schema's own doc comment for why
 * one shape serves both live and historical rendering.
 */
export const serverChatMessageMessageSchema = z
  .object({
    type: z.literal('server:chat-message'),
    id: messageIdSchema,
    message: chatMessageViewSchema,
  })
  .strict();
export type ServerChatMessageMessage = z.infer<typeof serverChatMessageMessageSchema>;

/** Reply to `client:chat-history-request`; `id` echoes the request's `id`. `hasMore`/`nextCursor`
 * drive further pagination — `nextCursor` (when present) is the oldest message's own `messageId`,
 * to be passed back as the next request's `beforeMessageId` (T10 Section 27: a stable id-based
 * cursor, not fragile offset pagination). */
export const serverChatHistoryPageMessageSchema = z
  .object({
    type: z.literal('server:chat-history-page'),
    id: messageIdSchema,
    messages: chatMessageViewListSchema,
    hasMore: z.boolean(),
    nextCursor: chatMessageIdSchema.optional(),
  })
  .strict();
export type ServerChatHistoryPageMessage = z.infer<typeof serverChatHistoryPageMessageSchema>;

export const serverChatMessageSchema = z.discriminatedUnion('type', [
  serverChatMessageMessageSchema,
  serverChatHistoryPageMessageSchema,
]);
export type ServerChatMessage = z.infer<typeof serverChatMessageSchema>;
