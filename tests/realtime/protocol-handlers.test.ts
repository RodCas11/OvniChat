import { CURRENT_PROTOCOL_VERSION } from '@disco-voador/protocol';
import { describe, expect, it } from 'vitest';

import {
  handleClientHello,
  handleClientPing,
  routeClientMessage,
  type HandlerContext,
} from '../../services/realtime/src/protocol-handlers.js';

const FIXED_TIME = new Date('2026-08-18T00:00:00.000Z');

function makeContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    connectionId: 'conn-1',
    now: () => FIXED_TIME,
    heartbeat: { intervalMs: 15000, timeoutMs: 10000 },
    ...overrides,
  };
}

describe('handleClientHello', () => {
  it('builds a server:hello echoing the request id and carrying connection/heartbeat info', () => {
    const response = handleClientHello(
      {
        type: 'client:hello',
        id: 'req-1',
        protocolVersion: 1,
        client: { name: 'test', version: '0.0.0' },
      },
      makeContext(),
    );

    expect(response).toEqual({
      type: 'server:hello',
      id: 'req-1',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      connectionId: 'conn-1',
      serverTime: FIXED_TIME.toISOString(),
      heartbeat: { intervalMs: 15000, timeoutMs: 10000 },
    });
  });
});

describe('handleClientPing', () => {
  it('builds a server:pong echoing the ping id', () => {
    expect(handleClientPing({ type: 'client:ping', id: 'ping-7' })).toEqual({
      type: 'server:pong',
      id: 'ping-7',
    });
  });
});

describe('routeClientMessage', () => {
  const ctx = makeContext();
  const validHello = {
    type: 'client:hello' as const,
    id: 'req-1',
    protocolVersion: 1,
    client: { name: 'test', version: '0.0.0' },
  };
  const ping = { type: 'client:ping' as const, id: 'ping-1' };

  it('accepts a hello while awaiting_hello and transitions to ready', () => {
    const result = routeClientMessage(validHello, 'awaiting_hello', ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextState).toBe('ready');
      expect(result.response.type).toBe('server:hello');
    }
  });

  it('rejects a hello with an unsupported protocol version', () => {
    const result = routeClientMessage(
      { ...validHello, protocolVersion: 999 },
      'awaiting_hello',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_PROTOCOL');
  });

  it('rejects a duplicate hello once already ready', () => {
    const result = routeClientMessage(validHello, 'ready', ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNEXPECTED_MESSAGE');
  });

  it('rejects a hello sent while closing/closed', () => {
    for (const state of ['closing', 'closed'] as const) {
      const result = routeClientMessage(validHello, state, ctx);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a ping sent before the handshake completes', () => {
    const result = routeClientMessage(ping, 'awaiting_hello', ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('HANDSHAKE_REQUIRED');
  });

  it('accepts a ping once ready and keeps the state unchanged', () => {
    const result = routeClientMessage(ping, 'ready', ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextState).toBe('ready');
      expect(result.response).toEqual({ type: 'server:pong', id: 'ping-1' });
    }
  });

  it('rejects a ping sent while closing', () => {
    const result = routeClientMessage(ping, 'closing', ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('HANDSHAKE_REQUIRED');
  });
});
