// T13.3 — `profileErrorMessage`/`describeProfileError` never leak a raw protocol error code to the
// UI, mirroring `channel-error-copy.test.ts`'s own exact assertions for the profile/avatar/presence
// domain.
import { describe, expect, it } from 'vitest';

import {
  describeProfileError,
  profileErrorMessage,
} from '../../apps/desktop/src/renderer/workspace/profile-error-copy.js';
import { ProfileRequestError } from '../../apps/desktop/src/renderer/voice/use-voice-channel.js';

describe('profileErrorMessage (T13.3)', () => {
  it('renders real, honest copy for every avatar-validation error code — never a raw code', () => {
    expect(profileErrorMessage('AVATAR_TOO_LARGE')).toBe('That image is too large for an avatar.');
    expect(profileErrorMessage('AVATAR_INVALID_FORMAT')).toBe(
      'Only PNG, JPEG, or WebP images can be used as an avatar.',
    );
    expect(profileErrorMessage('AVATAR_DIMENSIONS_TOO_LARGE')).toBe(
      'That image is too large — try a smaller picture.',
    );
    // Distinct copy from AVATAR_DIMENSIONS_TOO_LARGE — never "dimensions too large" for this case.
    expect(profileErrorMessage('AVATAR_ANIMATED_NOT_ALLOWED')).toBe(
      "Animated images aren't allowed for an avatar.",
    );
  });

  it('maps CUSTOM_STATUS_TOO_LONG, PROFILE_RATE_LIMITED, and MEMBER_NOT_FOUND', () => {
    expect(profileErrorMessage('CUSTOM_STATUS_TOO_LONG')).toBe('That status is too long.');
    expect(profileErrorMessage('PROFILE_RATE_LIMITED')).toBe(
      'Too many profile changes. Try again in a moment.',
    );
    expect(profileErrorMessage('MEMBER_NOT_FOUND')).toBe('That member is no longer online.');
  });

  it('returns undefined for a code this table does not cover', () => {
    expect(profileErrorMessage('INTERNAL_ERROR')).toBeUndefined();
  });
});

describe('describeProfileError (T13.3)', () => {
  it('unwraps a ProfileRequestError via profileErrorMessage', () => {
    const error = new ProfileRequestError('AVATAR_TOO_LARGE', 'server text');
    expect(describeProfileError(error)).toBe('That image is too large for an avatar.');
  });

  it('falls back to the server-authored message for a code with no table entry', () => {
    const error = new ProfileRequestError('INTERNAL_ERROR', 'server-authored text');
    expect(describeProfileError(error)).toBe('server-authored text');
  });

  it('falls back to a plain Error message for a non-protocol error', () => {
    expect(describeProfileError(new Error('Not connected.'))).toBe('Not connected.');
  });

  it('never throws or returns a raw code for a totally unknown thrown value', () => {
    expect(describeProfileError('boom')).toBe('Something went wrong.');
  });
});
