import { describe, expect, it } from 'vitest';

import {
  computeTurnCredentialRefreshDelayMs,
  TURN_CREDENTIAL_REFRESH_MAX_DELAY_MS,
  TURN_CREDENTIAL_REFRESH_MIN_DELAY_MS,
} from '../../services/realtime/src/turn-credential-refresh.js';

const NOW = Date.parse('2026-08-25T00:00:00.000Z');

function expiresInSeconds(seconds: number): string {
  return new Date(NOW + seconds * 1_000).toISOString();
}

describe('computeTurnCredentialRefreshDelayMs (T15.2)', () => {
  it('schedules the refresh at half the credential’s remaining lifetime', () => {
    // The shipped default: a 6-hour TTL refreshes every 3 hours, so a client never holds a
    // credential that is more than half-expired.
    expect(computeTurnCredentialRefreshDelayMs(expiresInSeconds(21_600), NOW)).toBe(
      3 * 60 * 60 * 1_000,
    );
  });

  it('keeps the half-lifetime rule for a short operator-configured TTL too', () => {
    expect(computeTurnCredentialRefreshDelayMs(expiresInSeconds(600), NOW)).toBe(300_000);
  });

  it('never schedules faster than the floor, however short the TTL', () => {
    // The pre-T15.1 production value (300s) and an absurdly short one both clamp, so a
    // misconfiguration degrades into a bounded trickle rather than a message flood.
    expect(computeTurnCredentialRefreshDelayMs(expiresInSeconds(60), NOW)).toBe(
      TURN_CREDENTIAL_REFRESH_MIN_DELAY_MS,
    );
    expect(computeTurnCredentialRefreshDelayMs(expiresInSeconds(1), NOW)).toBe(
      TURN_CREDENTIAL_REFRESH_MIN_DELAY_MS,
    );
  });

  it('clamps an already-expired credential to the floor rather than refusing to reschedule', () => {
    // Clock skew, not a reason to strand this connection with a dead credential forever.
    expect(computeTurnCredentialRefreshDelayMs(expiresInSeconds(-10_000), NOW)).toBe(
      TURN_CREDENTIAL_REFRESH_MIN_DELAY_MS,
    );
  });

  it('caps an extreme TTL well inside what setTimeout can actually represent', () => {
    const tenYears = expiresInSeconds(10 * 365 * 24 * 60 * 60);
    const delay = computeTurnCredentialRefreshDelayMs(tenYears, NOW);
    expect(delay).toBe(TURN_CREDENTIAL_REFRESH_MAX_DELAY_MS);
    // Above ~24.8 days a delay overflows setTimeout's signed 32-bit millisecond field and fires
    // immediately, which would be a silent permanent busy-loop.
    expect(delay).toBeLessThan(2 ** 31 - 1);
  });

  it('returns undefined only for a timestamp it cannot parse at all', () => {
    expect(computeTurnCredentialRefreshDelayMs('not-a-timestamp', NOW)).toBeUndefined();
    expect(computeTurnCredentialRefreshDelayMs('', NOW)).toBeUndefined();
  });
});
