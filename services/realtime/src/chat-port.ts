import type { ChatMessageView, ChatScope } from '@disco-voador/protocol';

/**
 * T10 — the narrow, synchronous seam `services/realtime` depends on for persistent server-side text
 * chat, mirroring exactly how T9 injected `AuthorizationPort`: this package defines the contract and
 * a permissive default; `services/dedicated-server` provides the real, SQLite-backed implementation
 * (`ChatStore`) via composition. `services/realtime` itself never knows about SQL, files, or
 * pagination cursors as *implementation* — it only calls these methods at the exact points chat must
 * persist or be read back (`client:chat-send`, `client:chat-history-request`), and only ever passes
 * through whatever the port returns.
 *
 * Every method is synchronous, for the same reason `AuthorizationPort`'s methods are: `Connection`/
 * `routeClientMessage` are a fully synchronous hot path, and `node:sqlite`'s `DatabaseSync` is
 * itself synchronous, so there is no async boundary to bridge.
 *
 * Never accepts a client-supplied sender identity or nickname — {@link ChatPort.sendMessage}'s
 * `senderIdentityId`/`senderNickname` parameters are always the *caller's own*, server-verified
 * values (`ctx.identityId`/`ctx.nickname` in `protocol-handlers.ts`), never read from the client's
 * message body (T10 Section 29/30/74).
 */

export type SendChatMessageResult =
  | { readonly ok: true; readonly message: ChatMessageView }
  | { readonly ok: false; readonly code: 'INTERNAL_ERROR'; readonly message: string };

export interface ChatHistoryPage {
  readonly messages: readonly ChatMessageView[];
  readonly hasMore: boolean;
  /** The oldest message's own `messageId` in this page, to pass back as the next request's
   * `beforeMessageId` — absent iff `messages` is empty or this page reached the beginning of
   * history (i.e. `hasMore` is `false`). */
  readonly nextCursor: number | undefined;
}

export interface ChatPort {
  /** Persists a message and returns the canonical, already-`senderParticipantId`-free stored
   * record (the caller attaches `senderParticipantId` itself, since that is live connection state
   * this port never sees — see `docs/architecture/PERSISTENT_TEXT_CHAT.md`). Validates and persists
   * atomically; never returns `ok: true` for something that failed to store (T10 Section 40/41/42). */
  sendMessage(params: {
    readonly scope: ChatScope;
    /** Required iff `scope === 'channel'`; must be `undefined` for `scope === 'server'` — enforced
     * by the caller before this is ever invoked, not re-validated here. */
    readonly channelId: string | undefined;
    readonly senderIdentityId: string;
    readonly senderNickname: string;
    readonly body: string;
  }): SendChatMessageResult;

  /** Bounded, cursor-paginated history read — never loads the full table into memory (T10 Section
   * 39, mandatory). No permission check here; whether the caller may request this scope at all is
   * decided by `protocol-handlers.ts` before this is ever invoked (T10 Section 8: reading requires
   * no permission beyond being an admitted, `ready` connection). */
  getHistory(params: {
    readonly scope: ChatScope;
    readonly channelId: string | undefined;
    readonly beforeMessageId: number | undefined;
    readonly limit: number;
  }): ChatHistoryPage;

  /** Releases any held resources (e.g. closes the underlying database handle). */
  close(): void;
}

/**
 * The default `ChatPort` for any `@disco-voador/realtime` consumer that doesn't compose its own
 * (this package's own dev CLI, `tests/realtime/*`) — rejects every send with `INTERNAL_ERROR` and
 * returns empty history, preserving pre-T10 behavior (no chat store configured) rather than
 * pretending to persist anything. `services/dedicated-server` always supplies the real
 * `ChatStore` instead; this is never used in a real product deployment.
 */
export function createNoopChatPort(): ChatPort {
  return {
    sendMessage: () => ({
      ok: false,
      code: 'INTERNAL_ERROR',
      message: 'No chat store configured',
    }),
    getHistory: () => ({ messages: [], hasMore: false, nextCursor: undefined }),
    close: () => {},
  };
}
