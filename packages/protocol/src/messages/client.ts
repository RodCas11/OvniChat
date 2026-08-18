import { z } from 'zod';

import { messageIdSchema } from '../envelope.js';

/**
 * `client:hello` opens the handshake. `protocolVersion` is intentionally `z.number().int()`
 * rather than a literal/enum of supported values: structurally *any* positive integer is a valid
 * hello, so an unrecognized version is a distinct, specifically-coded `UNSUPPORTED_PROTOCOL`
 * failure (checked by the caller against `SUPPORTED_PROTOCOL_VERSIONS`), not a generic
 * `INVALID_MESSAGE` schema failure. `client.name`/`client.version` are free-form, bounded,
 * untrusted diagnostic strings — never treated as an identity or trust signal.
 */
export const clientHelloMessageSchema = z
  .object({
    type: z.literal('client:hello'),
    id: messageIdSchema,
    protocolVersion: z.number().int().positive(),
    client: z
      .object({
        name: z.string().min(1).max(64),
        version: z.string().min(1).max(32),
      })
      .strict(),
  })
  .strict();

export type ClientHelloMessage = z.infer<typeof clientHelloMessageSchema>;

/** `client:ping` is an explicit, client-initiated liveness/round-trip check. */
export const clientPingMessageSchema = z
  .object({
    type: z.literal('client:ping'),
    id: messageIdSchema,
  })
  .strict();

export type ClientPingMessage = z.infer<typeof clientPingMessageSchema>;

export const clientMessageSchema = z.discriminatedUnion('type', [
  clientHelloMessageSchema,
  clientPingMessageSchema,
]);

export type ClientMessage = z.infer<typeof clientMessageSchema>;
