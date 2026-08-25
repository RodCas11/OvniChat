import { mkdir } from 'node:fs/promises';
import path from 'node:path';

import {
  createNoopLogger,
  createRealtimeServer,
  type Logger,
  type RealtimeServerAddress,
} from '@disco-voador/realtime';
import type { ServerCapability } from '@disco-voador/protocol';

import { AuthorizationStore } from './authorization/store.js';
import { ChannelStore } from './channels/store.js';
import { ChatStore } from './chat/store.js';
import type { DedicatedServerConfig } from './config.js';
import { SqliteProfileStore } from './profile/store.js';
import { mintTurnCredentials } from './turn/mint-turn-credentials.js';

/**
 * The product-facing capability set this Dedicated Server offers — matches the media sources
 * (T3-T6) plus persistent text chat (T10). Not derived from anything dynamic; a future optional
 * capability extends this list, not a negotiation protocol (see
 * `packages/protocol/src/server-metadata.ts`).
 */
const DEDICATED_SERVER_CAPABILITIES: readonly ServerCapability[] = [
  'voice',
  'camera',
  'screen-video',
  'screen-audio',
  'text-chat',
];

export interface DedicatedServerHandle {
  readonly connectionCount: number;
  readonly config: DedicatedServerConfig;
  /** T15 — whether this server's authorization store already has at least one claimed Server Admin
   * at the moment this handle was composed (see `AuthorizationStore.hasAnyServerAdmin`'s own doc
   * comment). `cli.ts` uses this, never a raw token, to decide whether its startup banner should
   * point the operator at `chantivo-server admin-token create`. */
  readonly hasAnyServerAdmin: boolean;
  start(): Promise<RealtimeServerAddress>;
  stop(): Promise<void>;
}

export interface DedicatedServerDependencies {
  readonly logger?: Logger;
  /** T9 — injectable for tests that want a deterministic clock or an in-memory (`:memory:`) store
   * instead of a real data-directory file. Defaults to a real `AuthorizationStore` at
   * `<dataDir>/authorization.sqlite`. */
  readonly authorization?: AuthorizationStore;
  /** T10 — injectable for the same reasons `authorization` is. Defaults to a real `ChatStore` at
   * `<dataDir>/chat.sqlite` — its own physical file, entirely separate from the authorization store
   * (see `docs/adr/0014-persistent-server-owned-chat-history.md`). */
  readonly chat?: ChatStore;
  /** T13.2 — injectable for the same reasons `authorization`/`chat` are. Defaults to a real
   * `ChannelStore` at `<dataDir>/channels.sqlite` — its own physical file, entirely separate from
   * both other stores (see `channels/migrations.ts`'s own doc comment). */
  readonly channels?: ChannelStore;
  /** T13.3 — injectable for the same reasons `authorization`/`chat`/`channels` are. Defaults to a
   * real `SqliteProfileStore` at `<dataDir>/profiles.sqlite` — its own physical file, entirely
   * separate from the other three stores (see `profile/migrations.ts`'s own doc comment). */
  readonly profile?: SqliteProfileStore;
}

/**
 * Composition root (T8 Section 40): the one place that turns a validated
 * {@link DedicatedServerConfig} plus its dependencies into a runnable Dedicated Server, by
 * composing `@disco-voador/realtime`'s reusable `createRealtimeServer` — no protocol/session logic
 * is duplicated here, only product-identity wiring (server name, capabilities, the configured
 * voice-channel catalog, and — T9 — the SQLite-backed authorization store). `cli.ts` is the only
 * caller that also touches `process.env`/`process.exit`; this function itself is
 * Node-process-lifecycle-free and directly integration-testable.
 *
 * T9's authorization store is created here, synchronously with the rest of composition (opening/
 * migrating a SQLite file is itself synchronous, per `node:sqlite`'s `DatabaseSync` — see
 * `docs/architecture/SERVER_AUTHORIZATION.md`), *before* `start()` is ever called, so a corrupt or
 * unreadable store fails the whole composition immediately rather than after the server has
 * already started accepting connections.
 */
export function createDedicatedServer(
  config: DedicatedServerConfig,
  deps: DedicatedServerDependencies = {},
): DedicatedServerHandle {
  const logger = deps.logger ?? createNoopLogger();
  // `dataDir: ':memory:'` is a deliberate, documented escape hatch (tests, and any operator who
  // genuinely wants a fully ephemeral server with no authorization state surviving a restart) —
  // SQLite's own `:memory:` identifier must be the *entire* path, never joined with a filename.
  const authorizationPath =
    config.dataDir === ':memory:' ? ':memory:' : path.join(config.dataDir, 'authorization.sqlite');
  const authorization =
    deps.authorization ??
    new AuthorizationStore(authorizationPath, { accessMode: config.accessMode });
  // T13.2 — its own physical file, opened *before* `chat` (see `channels/migrations.ts`'s own doc
  // comment) so the best-effort `pruneOrphanedChannelHistory` startup hygiene step below can use
  // `channels.listActiveNodeIds()`.
  const channelsPath =
    config.dataDir === ':memory:' ? ':memory:' : path.join(config.dataDir, 'channels.sqlite');
  const channels = deps.channels ?? new ChannelStore(channelsPath, { seed: config.voiceChannels });

  // T10 — its own physical file, never shared with `authorizationPath` (see the module doc comment
  // above and ADR 0014): a chat-store problem can never jeopardize authorization state, and the two
  // stores can be backed up/retained on independent schedules.
  const chatPath =
    config.dataDir === ':memory:' ? ':memory:' : path.join(config.dataDir, 'chat.sqlite');
  const chat = deps.chat ?? new ChatStore(chatPath);
  // T13.2 — best-effort disk-growth hygiene only, never the actual safety mechanism (that is the
  // mandatory `ChannelPort.getVisibleNode` check every channel-scoped chat request already goes
  // through) — see `ChatPort.pruneOrphanedChannelHistory`'s own doc comment.
  chat.pruneOrphanedChannelHistory(channels.listActiveNodeIds());

  // T13.3 — its own physical file, never shared with any other store (see `profile/migrations.ts`'s
  // own doc comment): a profile-store problem can never jeopardize authorization/chat/channel state.
  const profilePath =
    config.dataDir === ':memory:' ? ':memory:' : path.join(config.dataDir, 'profiles.sqlite');
  const profile = deps.profile ?? new SqliteProfileStore(profilePath);

  const realtimeServer = createRealtimeServer(config.realtime, {
    logger,
    serverMetadata: { name: config.name, capabilities: DEDICATED_SERVER_CAPABILITIES },
    authorization,
    chat,
    channels,
    profile,
    // T14 — mints a fresh credential set on every call rather than caching one, so a returning
    // identity's handshake never risks handing out an already-(near-)expired credential (see
    // `mintTurnCredentials`'s own doc comment). `undefined` when TURN is not configured at all.
    turnCredentials: { mint: () => (config.turn ? mintTurnCredentials(config.turn) : undefined) },
  });

  // Guards against a second `stop()` call re-closing already-closed store handles (`node:sqlite`'s
  // `DatabaseSync.close()` throws "database is not open" on a double-close, unlike the underlying
  // realtime server's own `stop()`, which already no-ops safely if called twice — see `server.ts`'s
  // `if (!wss) return;`). Mirrors that same idempotency guarantee at this composition-root layer.
  let stopped = false;

  return {
    get connectionCount() {
      return realtimeServer.connectionCount;
    },
    config,
    hasAnyServerAdmin: authorization.hasAnyServerAdmin(),
    start: () => realtimeServer.start(),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await realtimeServer.stop();
      authorization.close();
      chat.close();
      channels.close();
      profile.close();
    },
  };
}

/** Ensures `config.dataDir` exists before {@link createDedicatedServer} opens the SQLite file
 * inside it — split out so `cli.ts` can await it before composition (a real file path needs the
 * directory to exist first; `:memory:`/test callers that inject their own `authorization` never
 * need this). */
export async function ensureDataDirExists(dataDir: string): Promise<void> {
  if (dataDir === ':memory:') return;
  await mkdir(dataDir, { recursive: true });
}
