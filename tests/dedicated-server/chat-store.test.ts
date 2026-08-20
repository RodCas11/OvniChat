import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ChatStore } from '../../services/dedicated-server/src/chat/store.js';

/**
 * Real, non-mocked `node:sqlite` storage — matching `authorization-store.test.ts`'s own testing
 * philosophy. Most tests use `:memory:` for speed; the restart-persistence tests use a real file on
 * disk to prove history survives closing and reopening the store, not just staying alive in one
 * process's memory (T10 Section 6/7/48).
 */

function openStore(now?: () => number): ChatStore {
  return new ChatStore(':memory:', now ? { now } : {});
}

describe('ChatStore — sending', () => {
  it('persists a server-scope message and returns the canonical stored record', () => {
    const store = openStore(() => 1_000);
    const result = store.sendMessage({
      scope: 'server',
      channelId: undefined,
      senderIdentityId: 'dv1_rodrigo',
      senderNickname: 'Rodrigo',
      body: 'bora jogar?',
    });
    expect(result).toMatchObject({
      ok: true,
      message: {
        messageId: expect.any(Number) as unknown as number,
        scope: 'server',
        senderNickname: 'Rodrigo',
        body: 'bora jogar?',
        createdAt: 1_000,
      },
    });
    if (!result.ok) return;
    // channelId absent for server scope, and no senderIdentityId/senderParticipantId anywhere on
    // the returned record — the store never returns a stable identity to its caller (T10 Section
    // 13/53); the caller (protocol-handlers.ts) attaches senderParticipantId itself when relevant.
    expect(result.message).not.toHaveProperty('channelId');
    expect(result.message).not.toHaveProperty('senderIdentityId');
    expect(result.message).not.toHaveProperty('senderParticipantId');
    store.close();
  });

  it('persists a channel-scope message with its channelId', () => {
    const store = openStore();
    const result = store.sendMessage({
      scope: 'channel',
      channelId: 'games',
      senderIdentityId: 'dv1_arthur',
      senderNickname: 'Arthur',
      body: 'indo',
    });
    expect(result).toMatchObject({
      ok: true,
      message: { scope: 'channel', channelId: 'games', senderNickname: 'Arthur', body: 'indo' },
    });
    store.close();
  });

  it('assigns monotonically increasing message ids across sends', () => {
    const store = openStore();
    const a = store.sendMessage({
      scope: 'server',
      channelId: undefined,
      senderIdentityId: 'dv1_x',
      senderNickname: 'X',
      body: 'one',
    });
    const b = store.sendMessage({
      scope: 'server',
      channelId: undefined,
      senderIdentityId: 'dv1_x',
      senderNickname: 'X',
      body: 'two',
    });
    if (!a.ok || !b.ok) throw new Error('setup failed');
    expect(b.message.messageId).toBeGreaterThan(a.message.messageId);
    store.close();
  });

  it('records nickname-at-send, never rewritten by a later send under a different nickname', () => {
    const store = openStore();
    const first = store.sendMessage({
      scope: 'server',
      channelId: undefined,
      senderIdentityId: 'dv1_x',
      senderNickname: 'Rodrigo',
      body: 'oi',
    });
    const second = store.sendMessage({
      scope: 'server',
      channelId: undefined,
      senderIdentityId: 'dv1_x',
      senderNickname: 'Gepeto',
      body: 'oi de novo',
    });
    if (!first.ok || !second.ok) throw new Error('setup failed');
    expect(first.message.senderNickname).toBe('Rodrigo');
    expect(second.message.senderNickname).toBe('Gepeto');

    const history = store.getHistory({
      scope: 'server',
      channelId: undefined,
      beforeMessageId: undefined,
      limit: 10,
    });
    expect(history.messages.map((m) => m.senderNickname)).toEqual(['Rodrigo', 'Gepeto']);
    store.close();
  });
});

describe('ChatStore — scope and channel isolation', () => {
  it('server-scope history never includes channel-scope messages', () => {
    const store = openStore();
    store.sendMessage({
      scope: 'server',
      channelId: undefined,
      senderIdentityId: 'dv1_x',
      senderNickname: 'X',
      body: 'server message',
    });
    store.sendMessage({
      scope: 'channel',
      channelId: 'lobby',
      senderIdentityId: 'dv1_x',
      senderNickname: 'X',
      body: 'lobby message',
    });

    const history = store.getHistory({
      scope: 'server',
      channelId: undefined,
      beforeMessageId: undefined,
      limit: 10,
    });
    expect(history.messages).toHaveLength(1);
    expect(history.messages[0]?.body).toBe('server message');
    store.close();
  });

  it("one channel's history never includes another channel's messages", () => {
    const store = openStore();
    store.sendMessage({
      scope: 'channel',
      channelId: 'lobby',
      senderIdentityId: 'dv1_x',
      senderNickname: 'X',
      body: 'in lobby',
    });
    store.sendMessage({
      scope: 'channel',
      channelId: 'games',
      senderIdentityId: 'dv1_x',
      senderNickname: 'X',
      body: 'in games',
    });

    const lobbyHistory = store.getHistory({
      scope: 'channel',
      channelId: 'lobby',
      beforeMessageId: undefined,
      limit: 10,
    });
    expect(lobbyHistory.messages).toHaveLength(1);
    expect(lobbyHistory.messages[0]?.body).toBe('in lobby');
    store.close();
  });
});

describe('ChatStore — history pagination and ordering', () => {
  function seedMessages(store: ChatStore, count: number): void {
    for (let i = 0; i < count; i += 1) {
      store.sendMessage({
        scope: 'server',
        channelId: undefined,
        senderIdentityId: 'dv1_x',
        senderNickname: 'X',
        body: `message-${String(i)}`,
      });
    }
  }

  it('the first page (no cursor) returns the most recent messages, oldest-first within the page', () => {
    const store = openStore();
    seedMessages(store, 5);

    const page = store.getHistory({
      scope: 'server',
      channelId: undefined,
      beforeMessageId: undefined,
      limit: 3,
    });
    expect(page.messages.map((m) => m.body)).toEqual(['message-2', 'message-3', 'message-4']);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBe(page.messages[0]?.messageId);
    store.close();
  });

  it('paging backward with the returned cursor never duplicates or skips a message', () => {
    const store = openStore();
    seedMessages(store, 7);

    const firstPage = store.getHistory({
      scope: 'server',
      channelId: undefined,
      beforeMessageId: undefined,
      limit: 3,
    });
    expect(firstPage.messages.map((m) => m.body)).toEqual(['message-4', 'message-5', 'message-6']);
    expect(firstPage.hasMore).toBe(true);

    const secondPage = store.getHistory({
      scope: 'server',
      channelId: undefined,
      beforeMessageId: firstPage.nextCursor,
      limit: 3,
    });
    expect(secondPage.messages.map((m) => m.body)).toEqual(['message-1', 'message-2', 'message-3']);
    expect(secondPage.hasMore).toBe(true);

    const thirdPage = store.getHistory({
      scope: 'server',
      channelId: undefined,
      beforeMessageId: secondPage.nextCursor,
      limit: 3,
    });
    expect(thirdPage.messages.map((m) => m.body)).toEqual(['message-0']);
    expect(thirdPage.hasMore).toBe(false);
    expect(thirdPage.nextCursor).toBeUndefined();
    store.close();
  });

  it('an exact-boundary page reports hasMore: false and no nextCursor', () => {
    const store = openStore();
    seedMessages(store, 3);

    const page = store.getHistory({
      scope: 'server',
      channelId: undefined,
      beforeMessageId: undefined,
      limit: 3,
    });
    expect(page.messages).toHaveLength(3);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeUndefined();
    store.close();
  });

  it('an empty scope returns an empty, non-hasMore page rather than loading anything', () => {
    const store = openStore();
    const page = store.getHistory({
      scope: 'server',
      channelId: undefined,
      beforeMessageId: undefined,
      limit: 10,
    });
    expect(page).toEqual({ messages: [], hasMore: false, nextCursor: undefined });
    store.close();
  });
});

describe('ChatStore — restart persistence (T10 Section 6/48)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dv-chat-restart-'));
    dbPath = path.join(dir, 'chat.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('server and channel history both survive closing and reopening the store', () => {
    const first = new ChatStore(dbPath);
    first.sendMessage({
      scope: 'server',
      channelId: undefined,
      senderIdentityId: 'dv1_a',
      senderNickname: 'A',
      body: 'PERSISTENCE_TEST_123',
    });
    first.sendMessage({
      scope: 'channel',
      channelId: 'games',
      senderIdentityId: 'dv1_a',
      senderNickname: 'A',
      body: 'GAME_HISTORY_1',
    });
    first.close();

    const second = new ChatStore(dbPath);
    const serverHistory = second.getHistory({
      scope: 'server',
      channelId: undefined,
      beforeMessageId: undefined,
      limit: 10,
    });
    expect(serverHistory.messages.map((m) => m.body)).toEqual(['PERSISTENCE_TEST_123']);

    const channelHistory = second.getHistory({
      scope: 'channel',
      channelId: 'games',
      beforeMessageId: undefined,
      limit: 10,
    });
    expect(channelHistory.messages.map((m) => m.body)).toEqual(['GAME_HISTORY_1']);
    second.close();
  });

  it('message ids remain stable and ordering-consistent across a restart', () => {
    const first = new ChatStore(dbPath);
    const sent = first.sendMessage({
      scope: 'server',
      channelId: undefined,
      senderIdentityId: 'dv1_a',
      senderNickname: 'A',
      body: 'before restart',
    });
    if (!sent.ok) throw new Error('setup failed');
    first.close();

    const second = new ChatStore(dbPath);
    const afterRestart = second.sendMessage({
      scope: 'server',
      channelId: undefined,
      senderIdentityId: 'dv1_a',
      senderNickname: 'A',
      body: 'after restart',
    });
    if (!afterRestart.ok) throw new Error('setup failed');
    // A fresh AUTOINCREMENT sequence never reuses an id already assigned before the restart.
    expect(afterRestart.message.messageId).toBeGreaterThan(sent.message.messageId);
    second.close();
  });
});

describe('ChatStore — storage inspection (proves no raw sender identity leaks into the port)', () => {
  it('the underlying row does store sender_identity_id, but ChatPort.getHistory never returns it', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dv-chat-inspect-'));
    try {
      const dbPath = path.join(dir, 'chat.sqlite');
      const store = new ChatStore(dbPath);
      store.sendMessage({
        scope: 'server',
        channelId: undefined,
        senderIdentityId: 'dv1_secret_identity',
        senderNickname: 'X',
        body: 'hello',
      });
      store.close();

      // Independent connection, not the store's own read path — proves the persisted schema, not
      // just the port's returned shape.
      const raw = new DatabaseSync(dbPath);
      const rows = raw.prepare('SELECT * FROM chat_messages').all() as {
        sender_identity_id: string;
        body: string;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.sender_identity_id).toBe('dv1_secret_identity');
      raw.close();

      // Re-open via the real port and confirm the identity never surfaces through it.
      const reopened = new ChatStore(dbPath);
      const page = reopened.getHistory({
        scope: 'server',
        channelId: undefined,
        beforeMessageId: undefined,
        limit: 10,
      });
      expect(page.messages[0]).not.toHaveProperty('senderIdentityId');
      expect(JSON.stringify(page.messages[0])).not.toContain('dv1_secret_identity');
      reopened.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
