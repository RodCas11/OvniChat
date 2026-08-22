import { describe, expect, it } from 'vitest';

import {
  clientVoiceJoinMessageSchema,
  clientVoiceLeaveMessageSchema,
  serverVoiceJoinedMessageSchema,
  serverVoiceParticipantJoinedMessageSchema,
  serverVoiceParticipantLeftMessageSchema,
} from '../../packages/protocol/src/messages/voice.js';
import { serverVoiceCatalogMessageSchema } from '../../packages/protocol/src/messages/channels.js';
import { clientMessageSchema } from '../../packages/protocol/src/messages/client.js';

describe('clientVoiceJoinMessageSchema', () => {
  const valid = { type: 'voice:join', id: 'j1', channelId: 'general', displayName: 'Rodrigo' };

  it('accepts a valid join', () => {
    expect(clientVoiceJoinMessageSchema.safeParse(valid).success).toBe(true);
  });

  it('trims a display name with surrounding whitespace', () => {
    const result = clientVoiceJoinMessageSchema.safeParse({ ...valid, displayName: '  Rodrigo  ' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.displayName).toBe('Rodrigo');
  });

  it('rejects an empty display name', () => {
    expect(clientVoiceJoinMessageSchema.safeParse({ ...valid, displayName: '' }).success).toBe(
      false,
    );
  });

  it('rejects a whitespace-only display name', () => {
    expect(clientVoiceJoinMessageSchema.safeParse({ ...valid, displayName: '   ' }).success).toBe(
      false,
    );
  });

  it('rejects an excessively long display name', () => {
    expect(
      clientVoiceJoinMessageSchema.safeParse({ ...valid, displayName: 'x'.repeat(33) }).success,
    ).toBe(false);
  });

  it('rejects a display name containing control characters', () => {
    expect(
      clientVoiceJoinMessageSchema.safeParse({ ...valid, displayName: 'evilbell' }).success,
    ).toBe(false);
    expect(
      clientVoiceJoinMessageSchema.safeParse({ ...valid, displayName: 'new\nline' }).success,
    ).toBe(false);
  });

  it('rejects an invalid channel id format', () => {
    expect(
      clientVoiceJoinMessageSchema.safeParse({ ...valid, channelId: 'General!' }).success,
    ).toBe(false);
    expect(clientVoiceJoinMessageSchema.safeParse({ ...valid, channelId: '' }).success).toBe(false);
    expect(
      clientVoiceJoinMessageSchema.safeParse({ ...valid, channelId: 'a'.repeat(65) }).success,
    ).toBe(false);
  });

  it('rejects unexpected extra fields (e.g. a spoofed participantId)', () => {
    expect(
      clientVoiceJoinMessageSchema.safeParse({ ...valid, participantId: 'spoofed' }).success,
    ).toBe(false);
  });
});

describe('clientVoiceLeaveMessageSchema', () => {
  it('accepts a valid leave', () => {
    expect(clientVoiceLeaveMessageSchema.safeParse({ type: 'voice:leave', id: 'l1' }).success).toBe(
      true,
    );
  });

  it('rejects extra fields', () => {
    expect(
      clientVoiceLeaveMessageSchema.safeParse({
        type: 'voice:leave',
        id: 'l1',
        channelId: 'general',
      }).success,
    ).toBe(false);
  });
});

describe('server voice messages', () => {
  it('accepts a valid voice:joined snapshot', () => {
    const result = serverVoiceJoinedMessageSchema.safeParse({
      type: 'voice:joined',
      id: 'j1',
      channelId: 'general',
      participantId: 'p1',
      participants: [{ participantId: 'p2', displayName: 'Arthur' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid voice:participant-joined event', () => {
    expect(
      serverVoiceParticipantJoinedMessageSchema.safeParse({
        type: 'voice:participant-joined',
        id: 'e1',
        channelId: 'general',
        participant: { participantId: 'p1', displayName: 'Rodrigo' },
      }).success,
    ).toBe(true);
  });

  it('accepts a valid voice:participant-left event', () => {
    expect(
      serverVoiceParticipantLeftMessageSchema.safeParse({
        type: 'voice:participant-left',
        id: 'e1',
        channelId: 'general',
        participantId: 'p1',
      }).success,
    ).toBe(true);
  });

  it('accepts a valid voice:catalog with an empty node list', () => {
    expect(
      serverVoiceCatalogMessageSchema.safeParse({ type: 'voice:catalog', id: 'c1', nodes: [] })
        .success,
    ).toBe(true);
  });

  it('accepts a valid voice:catalog with nodes', () => {
    expect(
      serverVoiceCatalogMessageSchema.safeParse({
        type: 'voice:catalog',
        id: 'c1',
        nodes: [
          {
            nodeId: 'general',
            kind: 'voice',
            name: 'General',
            sortOrder: 0,
            visibilityPolicy: 'inherit',
            joinPolicy: 'inherit',
            managePolicy: 'inherit',
            hasPassword: false,
            temporary: false,
          },
          {
            nodeId: 'games',
            kind: 'voice',
            name: 'Games',
            sortOrder: 1,
            visibilityPolicy: 'inherit',
            joinPolicy: 'inherit',
            managePolicy: 'inherit',
            hasPassword: false,
            temporary: false,
          },
        ],
      }).success,
    ).toBe(true);
  });
});

describe('clientMessageSchema union includes voice messages', () => {
  it('routes voice:join through the top-level union', () => {
    expect(
      clientMessageSchema.safeParse({
        type: 'voice:join',
        id: 'j1',
        channelId: 'general',
        displayName: 'Rodrigo',
      }).success,
    ).toBe(true);
  });
});
