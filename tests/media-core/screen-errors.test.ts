import { describe, expect, it } from 'vitest';

import {
  ScreenAccessError,
  classifyScreenErrorReason,
} from '../../packages/media-core/src/screen-errors.js';

describe('classifyScreenErrorReason', () => {
  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['PermissionDeniedError', 'permission-denied'],
    ['NotFoundError', 'no-source-available'],
    ['NotReadableError', 'capture-failed'],
    ['AbortError', 'unknown'],
    ['InvalidStateError', 'unknown'],
    ['OverconstrainedError', 'unknown'],
    ['SecurityError', 'unknown'],
  ] as const)('maps DOMException name %s to reason %s', (name, expectedReason) => {
    const error = new DOMException('message', name);
    expect(classifyScreenErrorReason(error)).toBe(expectedReason);
  });

  it('maps a plain object with a recognized .name the same as a real DOMException', () => {
    expect(classifyScreenErrorReason({ name: 'NotAllowedError' })).toBe('permission-denied');
  });

  it('maps an unrecognized DOMException name to "unknown"', () => {
    expect(classifyScreenErrorReason(new DOMException('message', 'SomeOtherError'))).toBe(
      'unknown',
    );
  });

  it.each([undefined, null, 'a string', 42, {}, new Error('a generic non-DOMException Error')])(
    'maps a value without a recognized DOM error name (%j) to "unknown" rather than throwing',
    (value) => {
      expect(() => classifyScreenErrorReason(value)).not.toThrow();
      expect(classifyScreenErrorReason(value)).toBe('unknown');
    },
  );
});

describe('ScreenAccessError', () => {
  it('carries the reason, message, and original cause', () => {
    const cause = new DOMException('denied', 'NotAllowedError');
    const error = new ScreenAccessError(
      'permission-denied',
      'Screen share access was denied or cancelled.',
      cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('ScreenAccessError');
    expect(error.reason).toBe('permission-denied');
    expect(error.message).toBe('Screen share access was denied or cancelled.');
    expect(error.cause).toBe(cause);
  });

  it('allows an absent cause', () => {
    const error = new ScreenAccessError('unknown', 'no track');
    expect(error.cause).toBeUndefined();
  });
});
