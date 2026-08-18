import { describe, expect, it } from 'vitest';

import {
  clientHelloMessageSchema,
  clientMessageSchema,
  clientPingMessageSchema,
} from '../../packages/protocol/src/messages/client.js';

describe('clientHelloMessageSchema', () => {
  it('accepts a valid client:hello', () => {
    const result = clientHelloMessageSchema.safeParse({
      type: 'client:hello',
      id: 'req-1',
      protocolVersion: 1,
      client: { name: 'desktop', version: '0.0.0' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts any positive integer protocol version structurally (support is a separate check)', () => {
    const result = clientHelloMessageSchema.safeParse({
      type: 'client:hello',
      id: 'req-1',
      protocolVersion: 999,
      client: { name: 'desktop', version: '0.0.0' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects a missing required field', () => {
    const result = clientHelloMessageSchema.safeParse({
      type: 'client:hello',
      id: 'req-1',
      client: { name: 'desktop', version: '0.0.0' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a wrong-typed field', () => {
    const result = clientHelloMessageSchema.safeParse({
      type: 'client:hello',
      id: 'req-1',
      protocolVersion: '1',
      client: { name: 'desktop', version: '0.0.0' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unexpected extra top-level field', () => {
    const result = clientHelloMessageSchema.safeParse({
      type: 'client:hello',
      id: 'req-1',
      protocolVersion: 1,
      client: { name: 'desktop', version: '0.0.0' },
      unexpected: true,
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unexpected extra nested field', () => {
    const result = clientHelloMessageSchema.safeParse({
      type: 'client:hello',
      id: 'req-1',
      protocolVersion: 1,
      client: { name: 'desktop', version: '0.0.0', platform: 'win32' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a zero/negative protocol version', () => {
    expect(
      clientHelloMessageSchema.safeParse({
        type: 'client:hello',
        id: 'req-1',
        protocolVersion: 0,
        client: { name: 'desktop', version: '0.0.0' },
      }).success,
    ).toBe(false);
  });

  it('rejects an empty id', () => {
    expect(
      clientHelloMessageSchema.safeParse({
        type: 'client:hello',
        id: '',
        protocolVersion: 1,
        client: { name: 'desktop', version: '0.0.0' },
      }).success,
    ).toBe(false);
  });

  it('rejects an id past the maximum length', () => {
    expect(
      clientHelloMessageSchema.safeParse({
        type: 'client:hello',
        id: 'x'.repeat(65),
        protocolVersion: 1,
        client: { name: 'desktop', version: '0.0.0' },
      }).success,
    ).toBe(false);
  });
});

describe('clientPingMessageSchema', () => {
  it('accepts a valid client:ping', () => {
    expect(clientPingMessageSchema.safeParse({ type: 'client:ping', id: 'ping-1' }).success).toBe(
      true,
    );
  });

  it('rejects extra fields', () => {
    expect(
      clientPingMessageSchema.safeParse({ type: 'client:ping', id: 'ping-1', extra: 1 }).success,
    ).toBe(false);
  });
});

describe('clientMessageSchema (discriminated union)', () => {
  it('routes to the correct member by type', () => {
    expect(clientMessageSchema.safeParse({ type: 'client:ping', id: '1' }).success).toBe(true);
  });

  it('rejects an unknown message type', () => {
    const result = clientMessageSchema.safeParse({ type: 'client:unknown', id: '1' });
    expect(result.success).toBe(false);
  });

  it('rejects a malformed envelope (not an object)', () => {
    expect(clientMessageSchema.safeParse('not an object').success).toBe(false);
    expect(clientMessageSchema.safeParse(null).success).toBe(false);
    expect(clientMessageSchema.safeParse([1, 2, 3]).success).toBe(false);
  });

  it('rejects an envelope missing a type discriminator', () => {
    expect(clientMessageSchema.safeParse({ id: '1' }).success).toBe(false);
  });
});
