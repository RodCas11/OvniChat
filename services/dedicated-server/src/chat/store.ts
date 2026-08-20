import type { DatabaseSync } from 'node:sqlite';

import type { ChatMessageView, ChatScope } from '@disco-voador/protocol';
import type { ChatHistoryPage, ChatPort, SendChatMessageResult } from '@disco-voador/realtime';

import { openManagedDatabase } from '../storage/sqlite-store-utils.js';
import { MIGRATIONS } from './migrations.js';

/**
 * T10 persistent server-side chat storage, backed by `node:sqlite`'s `DatabaseSync` — its own
 * physical file (`chat.sqlite`), entirely separate from T9's `authorization.sqlite` (see
 * `docs/adr/0014-persistent-server-owned-chat-history.md` for why, and
 * `docs/architecture/PERSISTENT_TEXT_CHAT.md` for the full design).
 *
 * Implements `ChatPort` (`@disco-voador/realtime`) — `services/realtime` only ever calls through
 * that narrow interface, never anything SQLite-specific. Deliberately does not catch SQL errors
 * itself: a write/read failure propagates as a thrown exception, caught by the same outer
 * `try/catch` in `Connection.handleRawMessage` every other unexpected handler failure already goes
 * through — that existing path already logs only `error.message` (never a message body) and returns
 * the client a generic `INTERNAL_ERROR`, which is exactly the "do not tell the client it succeeded;
 * do not log the body" behavior T10 requires (Section 42/65), so duplicating that logic here would
 * only be a second, divergent implementation of the same policy.
 */

interface ChatMessageRow {
  readonly message_id: number;
  readonly scope: string;
  readonly channel_id: string | null;
  readonly sender_identity_id: string;
  readonly sender_nickname_at_send: string;
  readonly body: string;
  readonly created_at: number;
}

function rowToView(row: ChatMessageRow): ChatMessageView {
  return {
    messageId: row.message_id,
    scope: row.scope as ChatScope,
    ...(row.channel_id !== null ? { channelId: row.channel_id } : {}),
    senderNickname: row.sender_nickname_at_send,
    body: row.body,
    createdAt: row.created_at,
  };
}

export interface ChatStoreOptions {
  readonly now?: () => number;
}

export class ChatStore implements ChatPort {
  private readonly db: DatabaseSync;
  private readonly now: () => number;

  private readonly insertMessageStmt;
  private readonly selectServerHistoryStmt;
  private readonly selectServerHistoryBeforeStmt;
  private readonly selectChannelHistoryStmt;
  private readonly selectChannelHistoryBeforeStmt;

  constructor(path: string, options: ChatStoreOptions = {}) {
    this.now = options.now ?? (() => Date.now());

    const { db } = openManagedDatabase(path, MIGRATIONS, this.now);
    this.db = db;

    this.insertMessageStmt = this.db.prepare(
      `INSERT INTO chat_messages
         (scope, channel_id, sender_identity_id, sender_nickname_at_send, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    );
    // DESC order + LIMIT fetches "the most recent N" directly; the caller reverses to ascending
    // (oldest-first) for display. Fetching `limit + 1` rows is how `hasMore` is determined without
    // a separate COUNT query.
    this.selectServerHistoryStmt = this.db.prepare(
      `SELECT * FROM chat_messages WHERE scope = 'server' ORDER BY message_id DESC LIMIT ?`,
    );
    this.selectServerHistoryBeforeStmt = this.db.prepare(
      `SELECT * FROM chat_messages WHERE scope = 'server' AND message_id < ?
       ORDER BY message_id DESC LIMIT ?`,
    );
    this.selectChannelHistoryStmt = this.db.prepare(
      `SELECT * FROM chat_messages WHERE scope = 'channel' AND channel_id = ?
       ORDER BY message_id DESC LIMIT ?`,
    );
    this.selectChannelHistoryBeforeStmt = this.db.prepare(
      `SELECT * FROM chat_messages WHERE scope = 'channel' AND channel_id = ? AND message_id < ?
       ORDER BY message_id DESC LIMIT ?`,
    );
  }

  sendMessage(params: {
    readonly scope: ChatScope;
    readonly channelId: string | undefined;
    readonly senderIdentityId: string;
    readonly senderNickname: string;
    readonly body: string;
  }): SendChatMessageResult {
    const createdAt = this.now();
    const result = this.insertMessageStmt.run(
      params.scope,
      params.channelId ?? null,
      params.senderIdentityId,
      params.senderNickname,
      params.body,
      createdAt,
    );
    const messageId = Number(result.lastInsertRowid);

    return {
      ok: true,
      message: {
        messageId,
        scope: params.scope,
        ...(params.channelId ? { channelId: params.channelId } : {}),
        senderNickname: params.senderNickname,
        body: params.body,
        createdAt,
      },
    };
  }

  getHistory(params: {
    readonly scope: ChatScope;
    readonly channelId: string | undefined;
    readonly beforeMessageId: number | undefined;
    readonly limit: number;
  }): ChatHistoryPage {
    const fetchLimit = params.limit + 1;
    let rows: readonly ChatMessageRow[];
    if (params.scope === 'server') {
      rows =
        params.beforeMessageId !== undefined
          ? (this.selectServerHistoryBeforeStmt.all(
              params.beforeMessageId,
              fetchLimit,
            ) as unknown as ChatMessageRow[])
          : (this.selectServerHistoryStmt.all(fetchLimit) as unknown as ChatMessageRow[]);
    } else {
      // `channelId` is guaranteed present for `scope === 'channel'` by this port's own contract
      // (`protocol-handlers.ts` never calls this method otherwise — see `requireChannelId` there).
      if (params.channelId === undefined) {
        throw new Error('Invariant violated: channel-scope history request with no channelId');
      }
      const channelId = params.channelId;
      rows =
        params.beforeMessageId !== undefined
          ? (this.selectChannelHistoryBeforeStmt.all(
              channelId,
              params.beforeMessageId,
              fetchLimit,
            ) as unknown as ChatMessageRow[])
          : (this.selectChannelHistoryStmt.all(
              channelId,
              fetchLimit,
            ) as unknown as ChatMessageRow[]);
    }

    const hasMore = rows.length > params.limit;
    // Reverse to ascending (oldest-first) order — the DESC query fetched "most recent N" for
    // pagination convenience, but a chat UI renders oldest-to-newest within a page.
    const messages = rows
      .slice(0, params.limit)
      .reverse()
      .map((row) => rowToView(row));

    return {
      messages,
      hasMore,
      nextCursor: hasMore ? messages[0]?.messageId : undefined,
    };
  }

  close(): void {
    this.db.close();
  }
}
