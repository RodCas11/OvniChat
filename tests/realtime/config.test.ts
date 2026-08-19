import { ConfigValidationError } from '@disco-voador/config';
import { describe, expect, it } from 'vitest';

import { loadRealtimeConfig } from '../../services/realtime/src/config.js';

describe('loadRealtimeConfig', () => {
  it('applies safe defaults when no environment is provided', () => {
    const config = loadRealtimeConfig({});
    expect(config).toEqual({
      host: '127.0.0.1',
      port: 8090,
      maxConnections: 1000,
      maxMessageBytes: 80 * 1024,
      handshakeTimeoutMs: 5000,
      identityChallengeTtlMs: 10000,
      heartbeatIntervalMs: 15000,
      heartbeatTimeoutMs: 10000,
      rateLimit: { maxMessages: 30, windowMs: 10000 },
      logLevel: 'info',
    });
  });

  it('reads and coerces every documented environment variable', () => {
    const config = loadRealtimeConfig({
      REALTIME_HOST: '0.0.0.0',
      REALTIME_PORT: '0',
      REALTIME_MAX_CONNECTIONS: '5',
      REALTIME_MAX_MESSAGE_BYTES: '4096',
      REALTIME_HANDSHAKE_TIMEOUT_MS: '2000',
      REALTIME_IDENTITY_CHALLENGE_TTL_MS: '4000',
      REALTIME_HEARTBEAT_INTERVAL_MS: '5000',
      REALTIME_HEARTBEAT_TIMEOUT_MS: '3000',
      REALTIME_RATE_LIMIT_MAX_MESSAGES: '10',
      REALTIME_RATE_LIMIT_WINDOW_MS: '1000',
      LOG_LEVEL: 'debug',
    });

    expect(config).toEqual({
      host: '0.0.0.0',
      port: 0,
      maxConnections: 5,
      maxMessageBytes: 4096,
      handshakeTimeoutMs: 2000,
      identityChallengeTtlMs: 4000,
      heartbeatIntervalMs: 5000,
      heartbeatTimeoutMs: 3000,
      rateLimit: { maxMessages: 10, windowMs: 1000 },
      logLevel: 'debug',
    });
  });

  it('fails clearly on an invalid value instead of silently falling back', () => {
    expect(() => loadRealtimeConfig({ REALTIME_PORT: 'not-a-port' })).toThrow(
      ConfigValidationError,
    );
  });

  it('fails on an out-of-range port', () => {
    expect(() => loadRealtimeConfig({ REALTIME_PORT: '99999' })).toThrow(ConfigValidationError);
  });

  it('fails on an unrecognized log level', () => {
    expect(() => loadRealtimeConfig({ LOG_LEVEL: 'verbose' })).toThrow(ConfigValidationError);
  });

  it('ignores unrelated environment variables (e.g. PATH) without conflating them', () => {
    expect(() =>
      loadRealtimeConfig({ PATH: '/usr/bin', HOME: '/home/x', REALTIME_HOST: '127.0.0.1' }),
    ).not.toThrow();
  });
});
