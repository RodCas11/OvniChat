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
 *
 * The three T3 codes below are deliberately **non-fatal**: unlike everything above, which
 * indicates a broken/hostile client and always closes the connection, these represent ordinary
 * recoverable conditions a well-behaved client can legitimately hit — most often a race where the
 * other side of a signaling exchange already left. The connection stays open; only a
 * `server:error` is sent. See `docs/architecture/WEBRTC_VOICE.md` for the full policy and
 * `services/realtime/src/connection.ts` for where fatal-vs-non-fatal is decided (derived from
 * whether the error has an assigned close code, not a separately-maintained flag).
 *
 * - `CHANNEL_NOT_FOUND` — `voice:join` named a channel the server does not have in its catalog.
 * - `NOT_IN_VOICE_CHANNEL` — `voice:leave` or a `webrtc:*` message arrived from a connection that
 *   is not currently a member of any voice channel.
 * - `SIGNALING_TARGET_INVALID` — a `webrtc:*` message's `targetParticipantId` does not resolve to
 *   a participant currently in the sender's own voice channel (unknown, or in a different
 *   channel).
 * - `CHANNEL_FULL` — `voice:join` named a channel already at `MAX_CHANNEL_PARTICIPANTS`. Bounds
 *   membership so a channel can never grow past what `voice:joined`'s own `participants` snapshot
 *   is allowed to carry (same limit, one source of truth — see `messages/voice.ts`); also bounds
 *   the `O(members)` fan-out cost of every subsequent join/leave in that channel.
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
  'CHANNEL_NOT_FOUND',
  'NOT_IN_VOICE_CHANNEL',
  'SIGNALING_TARGET_INVALID',
  'CHANNEL_FULL',
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;
