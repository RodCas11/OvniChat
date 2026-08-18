import { z } from 'zod';

/**
 * Small, closed set of machine-readable error codes a server can send a client. Kept deliberately
 * small: every T2 failure case maps to exactly one of these, never a free-form string.
 *
 * - `INVALID_MESSAGE` — malformed JSON, a schema violation (unknown type, missing/extra/wrong-typed
 *   fields), or an unsupported (binary) frame.
 * - `UNSUPPORTED_PROTOCOL` — `client:hello.protocolVersion` is not in `SUPPORTED_PROTOCOL_VERSIONS`.
 * - `HANDSHAKE_REQUIRED` — a non-hello message arrived before the handshake completed.
 * - `HANDSHAKE_TIMEOUT` — the client never completed the handshake within the configured timeout.
 * - `UNEXPECTED_MESSAGE` — a structurally valid message isn't allowed in the connection's current
 *   state (e.g. a second `client:hello` after the connection is already `ready`).
 * - `RATE_LIMITED` — the connection exceeded its per-connection message rate limit.
 * - `MESSAGE_TOO_LARGE` — documented for protocol completeness. This server enforces the maximum
 *   message size at the WebSocket transport layer (`ws`'s `maxPayload`), which terminates the
 *   connection with the standard close code `1009` before the oversized frame can be parsed —
 *   there is no application-level message to attach this code to in practice, but a future
 *   transport could report it this way.
 * - `INTERNAL_ERROR` — an unexpected server-side failure while handling an otherwise-valid message.
 *   The client never receives implementation details (stack traces, internal error messages).
 * - `SERVER_AT_CAPACITY` — the server already has `REALTIME_MAX_CONNECTIONS` connections open and
 *   is rejecting a new one before any handshake work is spent on it.
 */
export const errorCodeSchema = z.enum([
  'INVALID_MESSAGE',
  'UNSUPPORTED_PROTOCOL',
  'HANDSHAKE_REQUIRED',
  'HANDSHAKE_TIMEOUT',
  'UNEXPECTED_MESSAGE',
  'RATE_LIMITED',
  'MESSAGE_TOO_LARGE',
  'INTERNAL_ERROR',
  'SERVER_AT_CAPACITY',
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;
