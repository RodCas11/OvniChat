import { describe, expect, it } from 'vitest';

import {
  clientMediaTrackSourceMessageSchema,
  midSchema,
  serverMediaTrackSourceMessageSchema,
} from '../../packages/protocol/src/messages/media.js';

describe('clientMediaTrackSourceMessageSchema', () => {
  it('accepts a valid camera announcement', () => {
    expect(
      clientMediaTrackSourceMessageSchema.safeParse({
        type: 'media:track-source',
        id: 'm1',
        targetParticipantId: 'p2',
        mid: '1',
        source: 'camera',
      }).success,
    ).toBe(true);
  });

  it('accepts a valid screen-video announcement', () => {
    expect(
      clientMediaTrackSourceMessageSchema.safeParse({
        type: 'media:track-source',
        id: 'm1',
        targetParticipantId: 'p2',
        mid: '2',
        source: 'screen-video',
      }).success,
    ).toBe(true);
  });

  it('accepts a valid microphone announcement', () => {
    expect(
      clientMediaTrackSourceMessageSchema.safeParse({
        type: 'media:track-source',
        id: 'm1',
        targetParticipantId: 'p2',
        mid: '0',
        source: 'microphone',
      }).success,
    ).toBe(true);
  });

  it('accepts a valid screen-audio announcement', () => {
    expect(
      clientMediaTrackSourceMessageSchema.safeParse({
        type: 'media:track-source',
        id: 'm1',
        targetParticipantId: 'p2',
        mid: '3',
        source: 'screen-audio',
      }).success,
    ).toBe(true);
  });

  it('rejects an unrecognized source', () => {
    expect(
      clientMediaTrackSourceMessageSchema.safeParse({
        type: 'media:track-source',
        id: 'm1',
        targetParticipantId: 'p2',
        mid: '1',
        source: 'system-audio',
      }).success,
    ).toBe(false);
  });

  it('rejects an empty mid', () => {
    expect(
      clientMediaTrackSourceMessageSchema.safeParse({
        type: 'media:track-source',
        id: 'm1',
        targetParticipantId: 'p2',
        mid: '',
        source: 'camera',
      }).success,
    ).toBe(false);
  });

  it('rejects a missing target', () => {
    expect(
      clientMediaTrackSourceMessageSchema.safeParse({
        type: 'media:track-source',
        id: 'm1',
        mid: '1',
        source: 'camera',
      }).success,
    ).toBe(false);
  });

  it('rejects an oversized mid', () => {
    expect(midSchema.safeParse('x'.repeat(65)).success).toBe(false);
  });

  it('does not accept a client-supplied source identity (unexpected field)', () => {
    expect(
      clientMediaTrackSourceMessageSchema.safeParse({
        type: 'media:track-source',
        id: 'm1',
        targetParticipantId: 'p2',
        mid: '1',
        source: 'camera',
        sourceParticipantId: 'spoofed',
      }).success,
    ).toBe(false);
  });
});

describe('serverMediaTrackSourceMessageSchema', () => {
  it('accepts a forwarded announcement with a server-derived source identity', () => {
    expect(
      serverMediaTrackSourceMessageSchema.safeParse({
        type: 'media:track-source',
        id: 'm1',
        sourceParticipantId: 'p1',
        mid: '2',
        source: 'screen-video',
      }).success,
    ).toBe(true);
  });

  it('rejects a forwarded announcement that still has a targetParticipantId (wrong shape for this direction)', () => {
    expect(
      serverMediaTrackSourceMessageSchema.safeParse({
        type: 'media:track-source',
        id: 'm1',
        targetParticipantId: 'p2',
        mid: '1',
        source: 'camera',
      }).success,
    ).toBe(false);
  });
});
