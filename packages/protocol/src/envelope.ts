import { z } from 'zod';

/**
 * Every message (both directions) carries an `id` chosen by whichever side originates it. A
 * direct response to a specific message echoes that message's `id` back rather than minting a
 * `replyTo` field — this gives free request/response correlation for the common case. The one
 * exception is `server:error`: since the rejected input may not have parsed far enough to have a
 * usable `id` (invalid JSON, wrong type), it always carries a fresh server-generated `id` plus an
 * optional `replyTo` when the offending message's `id` could be recovered.
 *
 * There is deliberately no top-level "envelope" wrapper around a generic `payload` field — each
 * message type is its own fully-typed schema discriminated by `type`, so an envelope layer would
 * add indirection without adding safety.
 */
export const MESSAGE_ID_MAX_LENGTH = 64;

export const messageIdSchema = z.string().min(1).max(MESSAGE_ID_MAX_LENGTH);
