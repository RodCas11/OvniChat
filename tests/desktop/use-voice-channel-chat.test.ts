import { describe, expect, it } from 'vitest';

import {
  chatThreadKey,
  decodeChatThreadKey,
  mergeChatMessages,
} from '../../apps/desktop/src/renderer/voice/use-voice-channel.js';

/**
 * T10 — direct unit coverage for `use-voice-channel.ts`'s client-side chat reconciliation logic,
 * flagged by `qa-engineer`'s T10 review as load-bearing but only indirectly exercised through the
 * full hook. Mirrors `RemoteMediaReconciler`'s own precedent (T3-T6) of keeping a dedup/merge-shaped
 * concern testable without a live React/E2E harness.
 */

function message(messageId: number, body = `body-${String(messageId)}`) {
  return {
    messageId,
    scope: 'server' as const,
    senderNickname: 'X',
    body,
    createdAt: 1000 + messageId,
  };
}

describe('chatThreadKey', () => {
  it('returns a fixed key for server scope, ignoring any channelId', () => {
    expect(chatThreadKey('server', undefined)).toBe('server');
    expect(chatThreadKey('server', 'ignored')).toBe('server');
  });

  it('returns a channel-scoped key including the channelId', () => {
    expect(chatThreadKey('channel', 'general')).toBe('channel:general');
    expect(chatThreadKey('channel', 'games')).toBe('channel:games');
  });

  it('distinguishes two different channels', () => {
    expect(chatThreadKey('channel', 'general')).not.toBe(chatThreadKey('channel', 'games'));
  });
});

describe('decodeChatThreadKey', () => {
  it('round-trips a server-scope key', () => {
    expect(decodeChatThreadKey(chatThreadKey('server', undefined))).toEqual({
      scope: 'server',
      channelId: undefined,
    });
  });

  it('round-trips a channel-scope key', () => {
    expect(decodeChatThreadKey(chatThreadKey('channel', 'general'))).toEqual({
      scope: 'channel',
      channelId: 'general',
    });
    expect(decodeChatThreadKey(chatThreadKey('channel', 'games'))).toEqual({
      scope: 'channel',
      channelId: 'games',
    });
  });
});

describe('mergeChatMessages', () => {
  it('merges two disjoint sets into ascending messageId order', () => {
    const result = mergeChatMessages([message(1), message(3)], [message(2)]);
    expect(result.map((m) => m.messageId)).toEqual([1, 2, 3]);
  });

  it('deduplicates by messageId — a live message already present in a history page is not repeated', () => {
    const existing = [message(1), message(2)];
    const incoming = [message(2), message(3)];
    const result = mergeChatMessages(existing, incoming);
    expect(result.map((m) => m.messageId)).toEqual([1, 2, 3]);
    expect(result).toHaveLength(3);
  });

  it('an incoming message with the same id replaces the existing one rather than duplicating it', () => {
    const existing = [message(1, 'stale-copy')];
    const incoming = [message(1, 'canonical-copy')];
    const result = mergeChatMessages(existing, incoming);
    expect(result).toHaveLength(1);
    expect(result[0]?.body).toBe('canonical-copy');
  });

  it('prepending an older history page ahead of already-loaded messages still sorts ascending', () => {
    const alreadyLoaded = [message(5), message(6)];
    const olderPage = [message(3), message(4)];
    const result = mergeChatMessages(alreadyLoaded, olderPage);
    expect(result.map((m) => m.messageId)).toEqual([3, 4, 5, 6]);
  });

  it('appending one live message to an existing thread keeps ascending order', () => {
    const result = mergeChatMessages([message(1), message(2)], [message(3)]);
    expect(result.map((m) => m.messageId)).toEqual([1, 2, 3]);
  });

  it('merging an empty incoming list is a no-op beyond re-sorting', () => {
    const existing = [message(2), message(1)];
    const result = mergeChatMessages(existing, []);
    expect(result.map((m) => m.messageId)).toEqual([1, 2]);
  });

  it('merging into an empty existing list returns the incoming messages sorted', () => {
    const result = mergeChatMessages([], [message(3), message(1), message(2)]);
    expect(result.map((m) => m.messageId)).toEqual([1, 2, 3]);
  });

  it('out-of-order arrival (history page arriving interleaved with a newer live message) still reconciles correctly', () => {
    // Simulates: live message 5 arrives first, then a history page covering 1-4 arrives afterward.
    const afterLive = mergeChatMessages([], [message(5)]);
    const afterHistory = mergeChatMessages(afterLive, [
      message(1),
      message(2),
      message(3),
      message(4),
    ]);
    expect(afterHistory.map((m) => m.messageId)).toEqual([1, 2, 3, 4, 5]);
  });
});
