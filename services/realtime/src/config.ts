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
  REALTIME_HEARTBEAT_INTERVAL_MS: envPositiveInt().default(15_000),
  REALTIME_HEARTBEAT_TIMEOUT_MS: envPositiveInt().default(10_000),
  REALTIME_RATE_LIMIT_MAX_MESSAGES: envPositiveInt().default(30),
  REALTIME_RATE_LIMIT_WINDOW_MS: envPositiveInt().default(10_000),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
});

export interface RealtimeConfig {
  readonly host: string;
  readonly port: number;
  readonly maxConnections: number;
  readonly maxMessageBytes: number;
  readonly handshakeTimeoutMs: number;
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;
  readonly rateLimit: {
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
    heartbeatIntervalMs: parsed.REALTIME_HEARTBEAT_INTERVAL_MS,
    heartbeatTimeoutMs: parsed.REALTIME_HEARTBEAT_TIMEOUT_MS,
    rateLimit: {
      maxMessages: parsed.REALTIME_RATE_LIMIT_MAX_MESSAGES,
      windowMs: parsed.REALTIME_RATE_LIMIT_WINDOW_MS,
    },
    logLevel: parsed.LOG_LEVEL,
  };
}
