// T13.2 — `channelErrorMessage`/`channelManageErrorMessage`/`describeChannelAdminError` never leak
// a raw protocol error code to the UI, and the admin-flavored mapping is distinct from the
// join-flavored one for the one code the server genuinely reuses for both meanings.
import { describe, expect, it } from 'vitest';

import {
  channelErrorMessage,
  channelManageErrorMessage,
  describeChannelAdminError,
} from '../../apps/desktop/src/renderer/workspace/channel-error-copy.js';
import { ChannelRequestError } from '../../apps/desktop/src/renderer/voice/use-voice-channel.js';

describe('channelErrorMessage (T13.2)', () => {
  it('renders polished copy for CHANNEL_FULL and CHANNEL_ACCESS_DENIED, never a raw code', () => {
    expect(channelErrorMessage('CHANNEL_FULL')).toBe('This channel is full.');
    expect(channelErrorMessage('CHANNEL_ACCESS_DENIED')).toBe(
      "You don't have permission to join this channel.",
    );
  });
});

describe('channelManageErrorMessage (T13.2)', () => {
  it('maps CHANNEL_ACCESS_DENIED to admin-flavored copy, distinct from the join-flavored one', () => {
    const message = channelManageErrorMessage({
      code: 'CHANNEL_ACCESS_DENIED',
      message: 'server message',
    });
    expect(message).toBe("You don't have permission to manage this channel.");
    expect(message).not.toBe(channelErrorMessage('CHANNEL_ACCESS_DENIED'));
  });

  it('falls back to the shared table, then the server message, for every other code', () => {
    expect(channelManageErrorMessage({ code: 'CHANNEL_NOT_FOUND', message: 'irrelevant' })).toBe(
      'This channel no longer exists.',
    );
    expect(
      channelManageErrorMessage({ code: 'INTERNAL_ERROR', message: 'server-authored text' }),
    ).toBe('server-authored text');
  });
});

describe('describeChannelAdminError (T13.2)', () => {
  it('unwraps a ChannelRequestError via channelManageErrorMessage', () => {
    const error = new ChannelRequestError('CHANNEL_ACCESS_DENIED', 'server text');
    expect(describeChannelAdminError(error)).toBe(
      "You don't have permission to manage this channel.",
    );
  });

  it('falls back to a plain Error message for a non-protocol error', () => {
    expect(describeChannelAdminError(new Error('Not connected.'))).toBe('Not connected.');
  });

  it('never throws or returns a raw code for a totally unknown thrown value', () => {
    expect(describeChannelAdminError('boom')).toBe('Something went wrong.');
  });
});
