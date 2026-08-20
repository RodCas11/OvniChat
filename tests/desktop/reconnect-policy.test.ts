import { CLOSE_CODES } from '@disco-voador/protocol';
import { describe, expect, it } from 'vitest';

import {
  classifyCloseCode,
  describeNonRetryableClose,
} from '../../apps/desktop/src/renderer/realtime/reconnect-policy.js';

describe('classifyCloseCode', () => {
  it('classifies BANNED, KICKED, and INVITE_REQUIRED as non-retryable', () => {
    expect(classifyCloseCode(CLOSE_CODES.BANNED)).toBe('no-retry');
    expect(classifyCloseCode(CLOSE_CODES.KICKED)).toBe('no-retry');
    expect(classifyCloseCode(CLOSE_CODES.INVITE_REQUIRED)).toBe('no-retry');
  });

  it('classifies protocol-incompatibility and malformed-message codes as non-retryable', () => {
    expect(classifyCloseCode(CLOSE_CODES.UNSUPPORTED_PROTOCOL)).toBe('no-retry');
    expect(classifyCloseCode(CLOSE_CODES.INVALID_MESSAGE)).toBe('no-retry');
    expect(classifyCloseCode(CLOSE_CODES.HANDSHAKE_REQUIRED)).toBe('no-retry');
    expect(classifyCloseCode(CLOSE_CODES.UNEXPECTED_MESSAGE)).toBe('no-retry');
    expect(classifyCloseCode(CLOSE_CODES.MESSAGE_TOO_LARGE)).toBe('no-retry');
  });

  it('classifies a broken local identity as non-retryable', () => {
    expect(classifyCloseCode(CLOSE_CODES.IDENTITY_INVALID_PUBLIC_KEY)).toBe('no-retry');
    expect(classifyCloseCode(CLOSE_CODES.IDENTITY_INVALID_SIGNATURE)).toBe('no-retry');
    expect(classifyCloseCode(CLOSE_CODES.IDENTITY_PROTOCOL_ERROR)).toBe('no-retry');
  });

  it('classifies a merely-expired challenge as retryable (a fresh challenge resolves it)', () => {
    expect(classifyCloseCode(CLOSE_CODES.IDENTITY_CHALLENGE_EXPIRED)).toBe('retry');
  });

  it('classifies transient server-side conditions as retryable', () => {
    expect(classifyCloseCode(CLOSE_CODES.HANDSHAKE_TIMEOUT)).toBe('retry');
    expect(classifyCloseCode(CLOSE_CODES.RATE_LIMITED)).toBe('retry');
    expect(classifyCloseCode(CLOSE_CODES.INTERNAL_ERROR)).toBe('retry');
    expect(classifyCloseCode(CLOSE_CODES.SERVER_AT_CAPACITY)).toBe('retry');
  });

  it('classifies a normal/going-away close as retryable (e.g. a graceful server restart)', () => {
    expect(classifyCloseCode(CLOSE_CODES.NORMAL)).toBe('retry');
    expect(classifyCloseCode(CLOSE_CODES.GOING_AWAY)).toBe('retry');
  });

  it('classifies an unrecognized code (e.g. 1006 abnormal closure) as retryable by default', () => {
    expect(classifyCloseCode(1006)).toBe('retry');
    expect(classifyCloseCode(-1)).toBe('retry');
  });
});

describe('describeNonRetryableClose', () => {
  it('describes BANNED and KICKED distinctly', () => {
    expect(describeNonRetryableClose(CLOSE_CODES.BANNED)).toMatch(/banned/i);
    expect(describeNonRetryableClose(CLOSE_CODES.KICKED)).toMatch(/kicked/i);
  });

  it('returns undefined for a retryable code', () => {
    expect(describeNonRetryableClose(CLOSE_CODES.INTERNAL_ERROR)).toBeUndefined();
    expect(describeNonRetryableClose(1006)).toBeUndefined();
  });
});
