import { envNonEmptyString, envPort, envPositiveInt, parseConfig } from '@disco-voador/config';
import { z } from 'zod';

/**
 * Realtime service configuration. Parsed and validated exactly once at process startup
 * ({@link loadRealtimeConfig}); domain code never reads `process.env` directly. Every value has a
 * safe default for local development except `port`, which defaults to a fixed development port
 * but should be `0` (ephemeral) in tests so multiple test files can run in parallel without
 * colliding.
 *
 * Deliberately not `.strict()`: this schema validates a *subset* of `process.env`, which always
 * contains many unrelated variables (`PATH`, `HOME`, ...) in any real environment. Rejecting
 * those would make the service fail to start everywhere. Unknown keys are simply ignored — unlike
 * a wire protocol message, `process.env` is not an attacker-controlled input this process needs
 * to police the exact shape of.
 */
const realtimeConfigSchema = z.object({
  REALTIME_HOST: envNonEmptyString().default('127.0.0.1'),
  REALTIME_PORT: envPort().default(8090),
  REALTIME_MAX_CONNECTIONS: envPositiveInt().default(1_000),
  // Raised alongside `packages/protocol`'s `SDP_MAX_LENGTH` each time that bound has been raised
  // (16 KiB -> 32 KiB for T5's live-measured 3-source finding; 32 KiB -> 80 KiB for T6's
  // live-measured 4-source finding, a real offer measured at 25,235 characters against the old
  // 24576 SDP bound — see that file's doc comment) — kept with real headroom above it once JSON
  // envelope overhead and `\r\n` -> `\\r\\n` escaping are accounted for, not sized to the same
  // number, so a maximal-length `sdp` field never itself risks tripping this outer transport-frame
  // limit.
  REALTIME_MAX_MESSAGE_BYTES: envPositiveInt().default(80 * 1024),
  REALTIME_HANDSHAKE_TIMEOUT_MS: envPositiveInt().default(5_000),
  // Independent of REALTIME_HANDSHAKE_TIMEOUT_MS: this bounds how long one issued
  // server:identity-challenge stays answerable, giving a specific IDENTITY_CHALLENGE_EXPIRED
  // failure. The handshake timeout remains the hard backstop that closes an idle/unresponsive
  // connection regardless of whether a challenge is outstanding (see connection.ts).
  REALTIME_IDENTITY_CHALLENGE_TTL_MS: envPositiveInt().default(10_000),
  REALTIME_HEARTBEAT_INTERVAL_MS: envPositiveInt().default(15_000),
  REALTIME_HEARTBEAT_TIMEOUT_MS: envPositiveInt().default(10_000),
  REALTIME_RATE_LIMIT_MAX_MESSAGES: envPositiveInt().default(30),
  REALTIME_RATE_LIMIT_WINDOW_MS: envPositiveInt().default(10_000),
  // T10 — separate, smaller buckets for chat specifically (Section 60/61, mandatory): persistent
  // storage makes spam more expensive than T2's original in-memory-only threat model assumed, so
  // chat sends/history requests get their own limiter on top of (never instead of) the generic
  // transport-level one above. Deliberately non-fatal when exceeded (see `errors.ts`'s
  // `CHAT_RATE_LIMITED`) — a chatty-but-legitimate client is throttled, not disconnected, unlike
  // the fatal generic `RATE_LIMITED` above.
  REALTIME_CHAT_SEND_RATE_LIMIT_MAX_MESSAGES: envPositiveInt().default(10),
  REALTIME_CHAT_SEND_RATE_LIMIT_WINDOW_MS: envPositiveInt().default(10_000),
  REALTIME_CHAT_HISTORY_RATE_LIMIT_MAX_MESSAGES: envPositiveInt().default(20),
  REALTIME_CHAT_HISTORY_RATE_LIMIT_WINDOW_MS: envPositiveInt().default(10_000),
  // T13.2 — a separate, smaller bucket specifically for `voice:join` attempts against a
  // password-protected channel, consulted only in that branch before the `scryptSync`-backed check
  // (see `channel-port.ts`'s doc comment on the accepted ~30-80ms blocking cost this mitigates).
  // Deliberately non-fatal when exceeded (`CHANNEL_PASSWORD_RATE_LIMITED`), matching
  // `CHAT_RATE_LIMITED`'s own precedent.
  REALTIME_CHANNEL_PASSWORD_RATE_LIMIT_MAX_MESSAGES: envPositiveInt().default(5),
  REALTIME_CHANNEL_PASSWORD_RATE_LIMIT_WINDOW_MS: envPositiveInt().default(60_000),
  // T13.3 — separate, smaller buckets for profile self-service mutations (avatar/status/presence
  // changes) specifically, mirroring `REALTIME_CHAT_SEND_RATE_LIMIT_*`'s own precedent. Generous
  // for legitimate use (a user changing their avatar/status is an infrequent action), tight against
  // spam. Non-fatal when exceeded (`PROFILE_RATE_LIMITED`).
  REALTIME_PROFILE_MUTATION_RATE_LIMIT_MAX_MESSAGES: envPositiveInt().default(5),
  REALTIME_PROFILE_MUTATION_RATE_LIMIT_WINDOW_MS: envPositiveInt().default(600_000),
  // T13.3 — a separate, higher-throughput bucket for on-demand `client:profile-request-avatar`
  // specifically, since populating a member panel legitimately fetches several members' avatars in
  // a burst.
  REALTIME_AVATAR_FETCH_RATE_LIMIT_MAX_MESSAGES: envPositiveInt().default(30),
  REALTIME_AVATAR_FETCH_RATE_LIMIT_WINDOW_MS: envPositiveInt().default(60_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface RealtimeConfig {
  readonly host: string;
  readonly port: number;
  readonly maxConnections: number;
  readonly maxMessageBytes: number;
  readonly handshakeTimeoutMs: number;
  readonly identityChallengeTtlMs: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly rateLimit: {
    readonly maxMessages: number;
    readonly windowMs: number;
  };
  /** T10 — separate, smaller rate-limit buckets for `client:chat-send`/`client:chat-history-request`
   * specifically (see the schema's own doc comment above). */
  readonly chatSendRateLimit: {
    readonly maxMessages: number;
    readonly windowMs: number;
  };
  readonly chatHistoryRateLimit: {
    readonly maxMessages: number;
    readonly windowMs: number;
  };
  /** T13.2 — see the schema's own doc comment above. */
  readonly channelPasswordRateLimit: {
    readonly maxMessages: number;
    readonly windowMs: number;
  };
  /** T13.3 — see the schema's own doc comment above. */
  readonly profileMutationRateLimit: {
    readonly maxMessages: number;
    readonly windowMs: number;
  };
  readonly avatarFetchRateLimit: {
    readonly maxMessages: number;
    readonly windowMs: number;
  };
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export function loadRealtimeConfig(
  source: Record<string, string | undefined> = process.env,
): RealtimeConfig {
  const parsed = parseConfig(realtimeConfigSchema, source);

  return {
    host: parsed.REALTIME_HOST,
    port: parsed.REALTIME_PORT,
    maxConnections: parsed.REALTIME_MAX_CONNECTIONS,
    maxMessageBytes: parsed.REALTIME_MAX_MESSAGE_BYTES,
    handshakeTimeoutMs: parsed.REALTIME_HANDSHAKE_TIMEOUT_MS,
    identityChallengeTtlMs: parsed.REALTIME_IDENTITY_CHALLENGE_TTL_MS,
    heartbeatIntervalMs: parsed.REALTIME_HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: parsed.REALTIME_HEARTBEAT_TIMEOUT_MS,
    rateLimit: {
      maxMessages: parsed.REALTIME_RATE_LIMIT_MAX_MESSAGES,
      windowMs: parsed.REALTIME_RATE_LIMIT_WINDOW_MS,
    },
    chatSendRateLimit: {
      maxMessages: parsed.REALTIME_CHAT_SEND_RATE_LIMIT_MAX_MESSAGES,
      windowMs: parsed.REALTIME_CHAT_SEND_RATE_LIMIT_WINDOW_MS,
    },
    chatHistoryRateLimit: {
      maxMessages: parsed.REALTIME_CHAT_HISTORY_RATE_LIMIT_MAX_MESSAGES,
      windowMs: parsed.REALTIME_CHAT_HISTORY_RATE_LIMIT_WINDOW_MS,
    },
    channelPasswordRateLimit: {
      maxMessages: parsed.REALTIME_CHANNEL_PASSWORD_RATE_LIMIT_MAX_MESSAGES,
      windowMs: parsed.REALTIME_CHANNEL_PASSWORD_RATE_LIMIT_WINDOW_MS,
    },
    profileMutationRateLimit: {
      maxMessages: parsed.REALTIME_PROFILE_MUTATION_RATE_LIMIT_MAX_MESSAGES,
      windowMs: parsed.REALTIME_PROFILE_MUTATION_RATE_LIMIT_WINDOW_MS,
    },
    avatarFetchRateLimit: {
      maxMessages: parsed.REALTIME_AVATAR_FETCH_RATE_LIMIT_MAX_MESSAGES,
      windowMs: parsed.REALTIME_AVATAR_FETCH_RATE_LIMIT_WINDOW_MS,
    },
    logLevel: parsed.LOG_LEVEL,
  };
}
