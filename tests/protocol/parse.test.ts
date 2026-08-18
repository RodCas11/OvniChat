import { describe, expect, it } from 'vitest';

import { parseClientMessage, parseServerMessage } from '../../packages/protocol/src/parse.js';

describe('parseClientMessage', () => {
  it('returns ok:true with the typed message for valid input', () => {
    const result = parseClientMessage({ type: 'client:ping', id: 'p1' });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toEqual({ type: 'client:ping', id: 'p1' });
    }
  });

  it('returns ok:false with readable issues for invalid input, never throwing', () => {
    expect(() => parseClientMessage({ type: 'client:unknown' })).not.toThrow();
    const result = parseClientMessage({ type: 'client:unknown' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('handles non-object JSON values (a parsed JSON string/number/array/null) without throwing', () => {
    for (const value of ['just a string', 42, null, [1, 2], true]) {
      expect(() => parseClientMessage(value)).not.toThrow();
      expect(parseClientMessage(value).ok).toBe(false);
    }
  });
});

describe('parseServerMessage', () => {
  it('parses a valid server:error', () => {
    const result = parseServerMessage({
      type: 'server:error',
      id: 'e1',
      code: 'HANDSHAKE_TIMEOUT',
      message: 'no hello received',
    });
    expect(result.ok).toBe(true);
  });

  it('rejects an invalid error code', () => {
    const result = parseServerMessage({
      type: 'server:error',
      id: 'e1',
      code: 'NOT_A_REAL_CODE',
      message: 'x',
    });
    expect(result.ok).toBe(false);
  });
});
