import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

import {
  CLOSE_CODES,
  type ErrorCode,
  type ServerCapability,
  type ServerMessage,
  type VoiceChannelSummary,
} from '@disco-voador/protocol';
import { WebSocketServer, type WebSocket } from 'ws';

import { createNoopAuthorizationPort, type AuthorizationPort } from './authorization-port.js';
import { createNoopChatPort, type ChatPort } from './chat-port.js';
import { Connection } from './connection.js';
import type { RealtimeConfig } from './config.js';
import { createNoopLogger, type Logger } from './logging.js';
import { DEFAULT_VOICE_CHANNELS } from './voice/catalog.js';
import { VoiceRegistry } from './voice/registry.js';

export interface RealtimeServerAddress {
  readonly host: string;
  readonly port: number;
}

export interface RealtimeServerHandle {
  /** Number of currently-tracked connections (any state); mainly useful for tests. */
  readonly connectionCount: number;
  start(): Promise<RealtimeServerAddress>;
  stop(): Promise<void>;
}

/** Default display metadata for a `createRealtimeServer` caller that doesn't compose its own —
 * `services/dedicated-server` always supplies its own via {@link RealtimeServerDependencies}. */
const DEFAULT_SERVER_NAME = 'Disco Voador Realtime Service';
const DEFAULT_SERVER_CAPABILITIES: readonly ServerCapability[] = [
  'voice',
  'camera',
  'screen-video',
  'screen-audio',
];

export interface RealtimeServerDependencies {
  readonly logger?: Logger;
  /** T8 — the voice-channel catalog this server instance offers, server-operator configuration
   * (see `services/dedicated-server`) rather than a hardcoded constant. Defaults to
   * {@link DEFAULT_VOICE_CHANNELS} for direct `@disco-voador/realtime` consumers (its own dev CLI,
   * `tests/realtime/*`) that don't compose their own. */
  readonly voiceChannels?: readonly VoiceChannelSummary[];
  /** T8 — this server's own display metadata, echoed into every `server:hello`. */
  readonly serverMetadata?: {
    readonly name: string;
    readonly capabilities: readonly ServerCapability[];
  };
  /** T9 — server-local authorization (see `authorization-port.ts`). Defaults to a permissive
   * no-op port for direct `@disco-voador/realtime` consumers that don't compose their own —
   * `services/dedicated-server` always supplies `SqliteAuthorizationPort` instead. */
  readonly authorization?: AuthorizationPort;
  /** T10 — server-local persistent chat (see `chat-port.ts`). Defaults to a permissive no-op port
   * for direct `@disco-voador/realtime` consumers that don't compose their own —
   * `services/dedicated-server` always supplies `ChatStore` instead. */
  readonly chat?: ChatPort;
}

/**
 * Builds a realtime server instance without starting it — `start()`/`stop()` are explicit so
 * integration tests (and the CLI bootstrap in `index.ts`, and `services/dedicated-server`'s own
 * composition root) share the exact same reusable service code rather than the implementation
 * being reachable only through one CLI entrypoint.
 */
export function createRealtimeServer(
  config: RealtimeConfig,
  deps: RealtimeServerDependencies = {},
): RealtimeServerHandle {
  const logger = deps.logger ?? createNoopLogger();
  const serverMetadata = deps.serverMetadata ?? {
    name: DEFAULT_SERVER_NAME,
    capabilities: DEFAULT_SERVER_CAPABILITIES,
  };
  const authorization = deps.authorization ?? createNoopAuthorizationPort();
  const chat = deps.chat ?? createNoopChatPort();
  const connections = new Map<string, Connection>();
  const voiceRegistry = new VoiceRegistry(deps.voiceChannels ?? DEFAULT_VOICE_CHANNELS);
  let wss: WebSocketServer | undefined;

  function deliverToConnection(connectionId: string, message: ServerMessage): void {
    connections.get(connectionId)?.deliver(message);
  }

  /** T9 — the `Connection`-level counterpart to `deliverToConnection`, for moderation actions
   * (kick/ban) targeting a *different* connection than the one that triggered them. */
  function closeOtherConnection(connectionId: string, code: ErrorCode, message: string): void {
    connections.get(connectionId)?.forceReject(code, message);
  }

  /** T10 — pushes `message` to every currently-`ready` connection (server-wide chat broadcast).
   * `connections` tracks every connection regardless of handshake state, so this filters to `ready`
   * itself rather than assuming every tracked connection can receive a chat message. */
  function broadcastToReady(message: ServerMessage): void {
    for (const connection of connections.values()) {
      if (connection.state === 'ready') connection.deliver(message);
    }
  }

  function handleConnection(socket: WebSocket): void {
    if (connections.size >= config.maxConnections) {
      // Reject before spending any handshake/heartbeat/rate-limiter resources on it — the whole
      // point of the cap is to bound total per-connection resource use, so a rejected connection
      // must not itself become one more tracked Connection.
      logger.warn('server_at_capacity', { maxConnections: config.maxConnections });
      if (socket.readyState === socket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'server:error',
            id: randomUUID(),
            code: 'SERVER_AT_CAPACITY',
            message: 'Server is at capacity',
          }),
        );
      }
      socket.close(CLOSE_CODES.SERVER_AT_CAPACITY, 'SERVER_AT_CAPACITY');
      return;
    }

    const connection = new Connection(
      socket,
      config,
      logger,
      voiceRegistry,
      serverMetadata,
      authorization,
      chat,
      deliverToConnection,
      closeOtherConnection,
      broadcastToReady,
      (closed) => {
        connections.delete(closed.id);
      },
    );
    connections.set(connection.id, connection);
    logger.info('connection_opened', { connectionId: connection.id });
  }

  return {
    get connectionCount() {
      return connections.size;
    },

    async start(): Promise<RealtimeServerAddress> {
      if (wss) {
        throw new Error('Realtime server is already started');
      }

      wss = new WebSocketServer({
        host: config.host,
        port: config.port,
        maxPayload: config.maxMessageBytes,
      });

      wss.on('error', (error: Error) => logger.error('server_error', { error: error.message }));

      await once(wss, 'listening');
      wss.on('connection', handleConnection);

      const address = wss.address();
      if (!address || typeof address === 'string') {
        throw new Error('Realtime server bound to an unexpected address shape');
      }

      logger.info('server_started', { host: config.host, port: address.port });
      return { host: config.host, port: address.port };
    },

    async stop(): Promise<void> {
      if (!wss) return;
      logger.info('server_stopping', { connectionCount: connections.size });

      const pendingCloses = [...connections.values()].map((connection) => {
        connection.close(1001, 'server shutting down');
        return connection.closed;
      });

      const server = wss;
      await Promise.all([
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
        ...pendingCloses,
      ]);

      connections.clear();
      wss = undefined;
      logger.info('server_stopped', {});
    },
  };
}
