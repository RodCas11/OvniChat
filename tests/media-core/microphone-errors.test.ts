import { describe, expect, it } from 'vitest';

import {
  MicrophoneAccessError,
  classifyMicrophoneErrorReason,
} from '../../packages/media-core/src/microphone-errors.js';

describe('classifyMicrophoneErrorReason', () => {
  it.each([
    ['NotAllowedError', 'permission-denied'],
    ['PermissionDeniedError', 'permission-denied'],
    ['NotFoundError', 'device-not-found'],
    ['OverconstrainedError', 'device-not-found'],
    ['NotReadableError', 'device-unavailable'],
    ['TrackStartError', 'device-unavailable'],
    ['AbortError', 'unknown'],
    ['SecurityError', 'unknown'],
  ] as const)('maps DOMException name %s to reason %s', (name, expectedReason) => {
    const error = new DOMException('message', name);
    expect(classifyMicrophoneErrorReason(error)).toBe(expectedReason);
  });

  it('maps a plain object with a recognized .name the same as a real DOMException', () => {
    expect(classifyMicrophoneErrorReason({ name: 'NotAllowedError' })).toBe('permission-denied');
  });

  it('maps an unrecognized DOMException name to "unknown"', () => {
    expect(classifyMicrophoneErrorReason(new DOMException('message', 'SomeOtherError'))).toBe(
      'unknown',
    );
  });

  it.each([undefined, null, 'a string', 42, {}, new Error('a generic non-DOMException Error')])(
    'maps a value without a recognized DOM error name (%j) to "unknown" rather than throwing',
    (value) => {
      expect(() => classifyMicrophoneErrorReason(value)).not.toThrow();
      expect(classifyMicrophoneErrorReason(value)).toBe('unknown');
    },
  );
});

describe('MicrophoneAccessError', () => {
  it('carries the reason, message, and original cause', () => {
    const cause = new DOMException('denied', 'NotAllowedError');
    const error = new MicrophoneAccessError(
      'permission-denied',
      'Microphone access was denied.',
      cause,
    );

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('MicrophoneAccessError');
    expect(error.reason).toBe('permission-denied');
    expect(error.message).toBe('Microphone access was denied.');
    expect(error.cause).toBe(cause);
  });

  it('allows an absent cause', () => {
    const error = new MicrophoneAccessError('unknown', 'no track');
    expect(error.cause).toBeUndefined();
  });
});
