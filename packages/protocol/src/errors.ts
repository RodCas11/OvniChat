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
 *
 * The four T7 codes below cover the local-identity handshake (`client:hello` ->
 * `server:identity-challenge` -> `client:identity-proof` -> `server:hello`, see
 * `docs/architecture/CLIENT_IDENTITY.md`). All four are fatal — an unauthenticated connection can
 * never be allowed to linger in a retry loop — and deliberately coarse: T7's own guidance is not
 * to create "useful oracle behavior via overly granular failure distinctions without a product
 * reason," so e.g. a replayed challenge and a signature from the wrong key both surface as
 * `IDENTITY_INVALID_SIGNATURE` rather than as separate codes (the state machine already makes
 * same-connection replay impossible, and cross-connection replay fails signature verification
 * anyway, since the payload binds `connectionId`/`nonce`).
 *
 * - `IDENTITY_INVALID_PUBLIC_KEY` — `client:hello.publicKey` does not decode to a usable Ed25519
 *   public key (schema-valid base64url shape, but the key material itself is unusable).
 * - `IDENTITY_INVALID_SIGNATURE` — `client:identity-proof.signature` does not verify against the
 *   connection's outstanding challenge and the public key it presented at `client:hello`. Covers
 *   a wrong-key signature, a tampered payload, and a replayed/copied proof alike.
 * - `IDENTITY_CHALLENGE_EXPIRED` — the proof arrived after the challenge's `expiresAt`.
 * - `IDENTITY_PROTOCOL_ERROR` — an identity message arrived out of order for the connection's
 *   current state (e.g. `client:identity-proof` with no outstanding challenge, or a second
 *   `client:hello` after one was already accepted).
 *
 * The T9 codes below cover server-local authorization (see
 * `docs/architecture/SERVER_AUTHORIZATION.md`). Two are **fatal admission-time** rejections —
 * evaluated after identity verification succeeds but before the connection ever reaches `ready`,
 * so they close the connection exactly like the `IDENTITY_*` codes above:
 *
 * - `BANNED` — the verified identity is currently subject to an active ban on this server. Also
 *   used to close an already-`ready` connection when an administrator bans it live.
 * - `INVITE_REQUIRED` — the server is configured `accessMode: invite-only`, the identity has no
 *   persistent server-local group membership, and `client:hello.serverToken` was absent, invalid,
 *   expired, or already consumed.
 *
 * `KICKED` is also fatal, but never an admission-time rejection — it only ever closes an
 * already-`ready` connection an administrator explicitly kicked, and unlike `BANNED` does not
 * imply anything persists past that one disconnect.
 *
 * Everything else below is **non-fatal** — an authorization mutation a caller was not permitted to
 * perform, or a nonexistent target, is an ordinary, expected condition an admin UI can recover from
 * without tearing down the connection, exactly like T3's own signaling error codes:
 *
 * - `AUTHORIZATION_DENIED` — the caller's current permissions do not include the one a requested
 *   action requires. Never distinguishes *why* beyond that (e.g. never reveals whether a group even
 *   exists to a caller who couldn't manage it anyway).
 * - `GROUP_NOT_FOUND` — a `groupId` does not exist in this server's authorization store.
 * - `PROTECTED_GROUP` — an operation targeted one of the three built-in groups in a way that isn't
 *   allowed (deleting any of them, or an edit to `server-admin` that would leave it materially
 *   unable to administer the server).
 * - `LAST_ADMIN` — an operation would leave the server with zero identities holding the built-in
 *   Server Admin group. Rejected unconditionally, regardless of who requests it.
 * - `TOKEN_INVALID` — a redeemed token's digest matches no known, unconsumed token.
 * - `TOKEN_EXPIRED` — the token matched a known record, but its `expiresAt` has passed.
 * - `TOKEN_ALREADY_USED` — the token matched a known record already consumed by an earlier,
 *   successful redemption.
 * - `PARTICIPANT_NOT_FOUND` — a `targetParticipantId` does not resolve to a connection currently in
 *   any voice channel on this server (moderation targets an *online* participant; see
 *   `docs/architecture/SERVER_AUTHORIZATION.md`).
 *
 * The T10 code below covers persistent server-side text chat (see
 * `docs/architecture/PERSISTENT_TEXT_CHAT.md`). Non-fatal, matching every other rate-limit-shaped
 * condition in this list — a chatty-but-legitimate client is throttled, not disconnected:
 *
 * - `CHAT_RATE_LIMITED` — the connection exceeded its per-connection chat-send or chat-history-
 *   request rate limit (a separate, smaller bucket than the generic transport-level `RATE_LIMITED`
 *   — see `services/realtime/src/connection.ts`).
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
  'IDENTITY_INVALID_PUBLIC_KEY',
  'IDENTITY_INVALID_SIGNATURE',
  'IDENTITY_CHALLENGE_EXPIRED',
  'IDENTITY_PROTOCOL_ERROR',
  'BANNED',
  'INVITE_REQUIRED',
  'KICKED',
  'AUTHORIZATION_DENIED',
  'GROUP_NOT_FOUND',
  'PROTECTED_GROUP',
  'LAST_ADMIN',
  'TOKEN_INVALID',
  'TOKEN_EXPIRED',
  'TOKEN_ALREADY_USED',
  'PARTICIPANT_NOT_FOUND',
  'CHAT_RATE_LIMITED',
]);

export type ErrorCode = z.infer<typeof errorCodeSchema>;
