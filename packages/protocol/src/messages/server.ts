import { z } from 'zod';

import { messageIdSchema } from '../envelope.js';
import { errorCodeSchema } from '../errors.js';

/**
 * `server:hello` answers a successful handshake. It carries only what proves negotiation
 * succeeded and lets the client behave correctly (its own connection identity, the server's
 * heartbeat cadence) — no speculative product/presence state.
 */
export const serverHelloMessageSchema = z
  .object({
    type: z.literal('server:hello'),
    id: messageIdSchema,
    protocolVersion: z.number().int().positive(),
    connectionId: z.string().min(1),
    serverTime: z.string().min(1),
    heartbeat: z
      .object({
        intervalMs: z.number().int().positive(),
        timeoutMs: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export type ServerHelloMessage = z.infer<typeof serverHelloMessageSchema>;

/** Answers `client:ping`; `id` echoes the ping's `id`. */
export const serverPongMessageSchema = z
  .object({
    type: z.literal('server:pong'),
    id: messageIdSchema,
  })
  .strict();

export type ServerPongMessage = z.infer<typeof serverPongMessageSchema>;

export const serverErrorMessageSchema = z
  .object({
    type: z.literal('server:error'),
    id: messageIdSchema,
    code: errorCodeSchema,
    message: z.string().min(1).max(256),
    replyTo: messageIdSchema.optional(),
  })
  .strict();

export type ServerErrorMessage = z.infer<typeof serverErrorMessageSchema>;

export const serverMessageSchema = z.discriminatedUnion('type', [
  serverHelloMessageSchema,
  serverPongMessageSchema,
  serverErrorMessageSchema,
]);

export type ServerMessage = z.infer<typeof serverMessageSchema>;
