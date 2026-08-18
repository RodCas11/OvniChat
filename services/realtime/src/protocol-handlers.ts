import {
  CURRENT_PROTOCOL_VERSION,
  isSupportedProtocolVersion,
  type ClientHelloMessage,
  type ClientMessage,
  type ClientPingMessage,
  type ErrorCode,
  type ServerMessage,
} from '@disco-voador/protocol';

import type { ConnectionState } from './connection-state.js';

export interface HandlerContext {
  readonly connectionId: string;
  readonly now: () => Date;
  readonly heartbeat: { readonly intervalMs: number; readonly timeoutMs: number };
}

export function handleClientHello(message: ClientHelloMessage, ctx: HandlerContext): ServerMessage {
  return {
    type: 'server:hello',
    id: message.id,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    connectionId: ctx.connectionId,
    serverTime: ctx.now().toISOString(),
    heartbeat: { intervalMs: ctx.heartbeat.intervalMs, timeoutMs: ctx.heartbeat.timeoutMs },
  };
}

export function handleClientPing(message: ClientPingMessage): ServerMessage {
  return { type: 'server:pong', id: message.id };
}

export type RouteResult =
  | { readonly ok: true; readonly nextState: ConnectionState; readonly response: ServerMessage }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

/**
 * The single decision table for "given this validated message and the connection's current
 * state, what happens." Pure and Electron/WebSocket-free, so the full state x message-type matrix
 * is unit-testable without any real socket.
 */
export function routeClientMessage(
  message: ClientMessage,
  state: ConnectionState,
  ctx: HandlerContext,
): RouteResult {
  if (message.type === 'client:hello') {
    if (state !== 'awaiting_hello') {
      return { ok: false, code: 'UNEXPECTED_MESSAGE', message: 'Duplicate client:hello' };
    }
    if (!isSupportedProtocolVersion(message.protocolVersion)) {
      return {
        ok: false,
        code: 'UNSUPPORTED_PROTOCOL',
        message: `Unsupported protocol version ${String(message.protocolVersion)}`,
      };
    }
    return { ok: true, nextState: 'ready', response: handleClientHello(message, ctx) };
  }

  if (state !== 'ready') {
    return { ok: false, code: 'HANDSHAKE_REQUIRED', message: 'Handshake not completed' };
  }

  switch (message.type) {
    case 'client:ping':
      return { ok: true, nextState: state, response: handleClientPing(message) };
  }
}
