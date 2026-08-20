import { describe, expect, it } from 'vitest';

import {
  CHAT_HISTORY_MAX_PAGE_SIZE,
  CHAT_MESSAGE_BODY_MAX_LENGTH,
  chatMessageBodySchema,
  chatMessageViewSchema,
} from '../../packages/protocol/src/chat.js';
import {
  clientChatHistoryRequestMessageSchema,
  clientChatSendMessageSchema,
  serverChatHistoryPageMessageSchema,
  serverChatMessageMessageSchema,
} from '../../packages/protocol/src/messages/chat.js';

/**
 * T10 — dedicated protocol-schema coverage for chat wire messages, mirroring the pattern every
 * other message-family test file in this directory already uses. Prior to this file, chat schemas
 * were exercised only indirectly through realtime/dedicated-server integration tests, which never
 * specifically probed the schema-layer boundaries (oversized body/limit, control characters,
 * unstripped sender-spoofing fields) documented in `packages/protocol/src/chat.ts`.
 */

describe('chatMessageBodySchema', () => {
  it('accepts an ordinary body', () => {
    expect(chatMessageBodySchema.safeParse('hello there').success).toBe(true);
  });

  it('accepts a body at exactly the max length', () => {
    const body = 'x'.repeat(CHAT_MESSAGE_BODY_MAX_LENGTH);
    expect(chatMessageBodySchema.safeParse(body).success).toBe(true);
  });

  it('rejects a body one character over the max length', () => {
    const body = 'x'.repeat(CHAT_MESSAGE_BODY_MAX_LENGTH + 1);
    expect(chatMessageBodySchema.safeParse(body).success).toBe(false);
  });

  it('rejects an empty body', () => {
    expect(chatMessageBodySchema.safeParse('').success).toBe(false);
  });

  it('rejects a whitespace-only body (trimmed to empty)', () => {
    expect(chatMessageBodySchema.safeParse('   \n\t  ').success).toBe(false);
  });

  it('allows tab, LF, and CR (ordinary multi-line composition)', () => {
    expect(chatMessageBodySchema.safeParse('line one\nline two\ttabbed\r\n').success).toBe(true);
  });

  it('rejects other C0 control characters', () => {
    expect(chatMessageBodySchema.safeParse('hi\x01there').success).toBe(false);
    expect(chatMessageBodySchema.safeParse('hi\x07there').success).toBe(false);
  });

  it('rejects DEL (0x7F)', () => {
    expect(chatMessageBodySchema.safeParse('hi\x7Fthere').success).toBe(false);
  });

  it('accepts Unicode content (emoji, accents, CJK, Cyrillic) unmodified', () => {
    const body = 'olá 👽🛸 café — 日本語 — Здравствуйте';
    const result = chatMessageBodySchema.safeParse(body);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(body);
  });

  it('does not interpret or strip HTML/script-looking content — it is plain text to this schema', () => {
    const body = '<script>window.__OWNED = true</script>';
    const result = chatMessageBodySchema.safeParse(body);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe(body);
  });
});

describe('clientChatSendMessageSchema', () => {
  it('accepts a valid server-scope send', () => {
    const result = clientChatSendMessageSchema.safeParse({
      type: 'client:chat-send',
      id: 'req-1',
      scope: 'server',
      body: 'hello',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid channel-scope send with channelId', () => {
    const result = clientChatSendMessageSchema.safeParse({
      type: 'client:chat-send',
      id: 'req-1',
      scope: 'channel',
      channelId: 'general',
      body: 'hello',
    });
    expect(result.success).toBe(true);
  });

  it('rejects channel scope with no channelId', () => {
    const result = clientChatSendMessageSchema.safeParse({
      type: 'client:chat-send',
      id: 'req-1',
      scope: 'channel',
      body: 'hello',
    });
    expect(result.success).toBe(false);
  });

  it('rejects server scope with a channelId present', () => {
    const result = clientChatSendMessageSchema.safeParse({
      type: 'client:chat-send',
      id: 'req-1',
      scope: 'server',
      channelId: 'general',
      body: 'hello',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an oversized body', () => {
    const result = clientChatSendMessageSchema.safeParse({
      type: 'client:chat-send',
      id: 'req-1',
      scope: 'server',
      body: 'x'.repeat(CHAT_MESSAGE_BODY_MAX_LENGTH + 1),
    });
    expect(result.success).toBe(false);
  });

  // T10 Section 29/30/74: no client message ever carries a sender field — `.strict()` rejects one
  // outright rather than silently ignoring it, so there is no way for a raw/hand-crafted client to
  // even attempt to assert its own sender identity, nickname, or live participant id.
  it('rejects an unrecognized field (e.g. a spoofed sender identity/nickname) via .strict()', () => {
    for (const spoofedField of ['senderNickname', 'senderIdentityId', 'senderParticipantId']) {
      const result = clientChatSendMessageSchema.safeParse({
        type: 'client:chat-send',
        id: 'req-1',
        scope: 'server',
        body: 'hello',
        [spoofedField]: 'attacker-controlled-value',
      });
      expect(result.success).toBe(false);
    }
  });
});

describe('clientChatHistoryRequestMessageSchema', () => {
  it('accepts a minimal server-scope request (no cursor, no limit)', () => {
    const result = clientChatHistoryRequestMessageSchema.safeParse({
      type: 'client:chat-history-request',
      id: 'req-1',
      scope: 'server',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a request with a cursor and an explicit limit at the max', () => {
    const result = clientChatHistoryRequestMessageSchema.safeParse({
      type: 'client:chat-history-request',
      id: 'req-1',
      scope: 'server',
      beforeMessageId: 42,
      limit: CHAT_HISTORY_MAX_PAGE_SIZE,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a limit over the max page size — a client cannot request an unbounded page', () => {
    const result = clientChatHistoryRequestMessageSchema.safeParse({
      type: 'client:chat-history-request',
      id: 'req-1',
      scope: 'server',
      limit: CHAT_HISTORY_MAX_PAGE_SIZE + 1,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-positive limit', () => {
    for (const limit of [0, -1]) {
      expect(
        clientChatHistoryRequestMessageSchema.safeParse({
          type: 'client:chat-history-request',
          id: 'req-1',
          scope: 'server',
          limit,
        }).success,
      ).toBe(false);
    }
  });

  it('rejects channel scope with no channelId', () => {
    const result = clientChatHistoryRequestMessageSchema.safeParse({
      type: 'client:chat-history-request',
      id: 'req-1',
      scope: 'channel',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-positive beforeMessageId cursor', () => {
    const result = clientChatHistoryRequestMessageSchema.safeParse({
      type: 'client:chat-history-request',
      id: 'req-1',
      scope: 'server',
      beforeMessageId: 0,
    });
    expect(result.success).toBe(false);
  });
});

describe('chatMessageViewSchema', () => {
  it('round-trips a server-scope message with Unicode content', () => {
    const view = {
      messageId: 1,
      scope: 'server' as const,
      senderNickname: 'Rodrigo',
      body: 'olá 👽🛸',
      createdAt: 1_700_000_000_000,
    };
    const result = chatMessageViewSchema.safeParse(view);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual(view);
  });

  it('never carries a senderIdentityId field — unknown keys are rejected by .strict()', () => {
    const result = chatMessageViewSchema.safeParse({
      messageId: 1,
      scope: 'server',
      senderNickname: 'X',
      senderIdentityId: 'dv1_should_never_appear',
      body: 'hi',
      createdAt: 1000,
    });
    expect(result.success).toBe(false);
  });

  it('rejects channel scope with no channelId, and server scope with one', () => {
    expect(
      chatMessageViewSchema.safeParse({
        messageId: 1,
        scope: 'channel',
        senderNickname: 'X',
        body: 'hi',
        createdAt: 1000,
      }).success,
    ).toBe(false);
    expect(
      chatMessageViewSchema.safeParse({
        messageId: 1,
        scope: 'server',
        channelId: 'general',
        senderNickname: 'X',
        body: 'hi',
        createdAt: 1000,
      }).success,
    ).toBe(false);
  });
});

describe('serverChatMessageMessageSchema / serverChatHistoryPageMessageSchema', () => {
  it('accepts a valid server:chat-message envelope', () => {
    const result = serverChatMessageMessageSchema.safeParse({
      type: 'server:chat-message',
      id: 'srv-1',
      message: {
        messageId: 1,
        scope: 'server',
        senderNickname: 'X',
        body: 'hi',
        createdAt: 1000,
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid, bounded server:chat-history-page envelope', () => {
    const result = serverChatHistoryPageMessageSchema.safeParse({
      type: 'server:chat-history-page',
      id: 'req-1',
      messages: [
        { messageId: 1, scope: 'server', senderNickname: 'X', body: 'hi', createdAt: 1000 },
      ],
      hasMore: false,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a history page with more messages than the max page size', () => {
    const messages = Array.from({ length: CHAT_HISTORY_MAX_PAGE_SIZE + 1 }, (_, i) => ({
      messageId: i + 1,
      scope: 'server' as const,
      senderNickname: 'X',
      body: 'hi',
      createdAt: 1000,
    }));
    const result = serverChatHistoryPageMessageSchema.safeParse({
      type: 'server:chat-history-page',
      id: 'req-1',
      messages,
      hasMore: false,
    });
    expect(result.success).toBe(false);
  });
});
