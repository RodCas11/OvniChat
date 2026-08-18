import { randomUUID } from 'node:crypto';
import { once } from 'node:events';

import { CLOSE_CODES, type ServerMessage } from '@disco-voador/protocol';
import { WebSocketServer, type WebSocket } from 'ws';

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

export interface RealtimeServerDependencies {
  readonly logger?: Logger;
}

/**
 * Builds a realtime server instance without starting it — `start()`/`stop()` are explicit so
 * integration tests (and the CLI bootstrap in `index.ts`) share the exact same reusable service
 * code rather than the implementation being reachable only through a CLI entrypoint.
 */
export function createRealtimeServer(
  config: RealtimeConfig,
  deps: RealtimeServerDependencies = {},
): RealtimeServerHandle {
  const logger = deps.logger ?? createNoopLogger();
  const connections = new Map<string, Connection>();
  const voiceRegistry = new VoiceRegistry(DEFAULT_VOICE_CHANNELS);
  let wss: WebSocketServer | undefined;

  function deliverToConnection(connectionId: string, message: ServerMessage): void {
    connections.get(connectionId)?.deliver(message);
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
      deliverToConnection,
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
