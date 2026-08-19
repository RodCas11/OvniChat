import { describe, expect, it } from 'vitest';

import {
  clientHelloMessageSchema,
  clientIdentityProofMessageSchema,
  clientMessageSchema,
  clientPingMessageSchema,
} from '../../packages/protocol/src/messages/client.js';

const validPublicKey = 'A'.repeat(43);
const validSignature = 'A'.repeat(86);

describe('clientHelloMessageSchema', () => {
  const baseValid = {
    type: 'client:hello' as const,
    id: 'req-1',
    protocolVersion: 1,
    client: { name: 'desktop', version: '0.0.0' },
    nickname: 'Alice',
    publicKey: validPublicKey,
  };

  it('accepts a valid client:hello', () => {
    const result = clientHelloMessageSchema.safeParse(baseValid);
    expect(result.success).toBe(true);
  });

  it('accepts any positive integer protocol version structurally (support is a separate check)', () => {
    const result = clientHelloMessageSchema.safeParse({ ...baseValid, protocolVersion: 999 });
    expect(result.success).toBe(true);
  });

  it('rejects a missing required field', () => {
    const result = clientHelloMessageSchema.safeParse({
      type: 'client:hello',
      id: 'req-1',
      client: { name: 'desktop', version: '0.0.0' },
      nickname: 'Alice',
      publicKey: validPublicKey,
    });
    expect(result.success).toBe(false);
  });

  it('rejects a missing nickname', () => {
    const withoutNickname: Record<string, unknown> = { ...baseValid };
    delete withoutNickname.nickname;
    expect(clientHelloMessageSchema.safeParse(withoutNickname).success).toBe(false);
  });

  it('rejects a missing publicKey', () => {
    const withoutPublicKey: Record<string, unknown> = { ...baseValid };
    delete withoutPublicKey.publicKey;
    expect(clientHelloMessageSchema.safeParse(withoutPublicKey).success).toBe(false);
  });

  it('rejects a publicKey of the wrong length', () => {
    expect(
      clientHelloMessageSchema.safeParse({ ...baseValid, publicKey: 'too-short' }).success,
    ).toBe(false);
  });

  it('rejects a publicKey with non-base64url characters', () => {
    expect(
      clientHelloMessageSchema.safeParse({ ...baseValid, publicKey: '+'.repeat(43) }).success,
    ).toBe(false);
  });

  it('rejects a blank nickname', () => {
    expect(clientHelloMessageSchema.safeParse({ ...baseValid, nickname: '' }).success).toBe(false);
  });

  it('rejects a wrong-typed field', () => {
    const result = clientHelloMessageSchema.safeParse({ ...baseValid, protocolVersion: '1' });
    expect(result.success).toBe(false);
  });

  it('rejects an unexpected extra top-level field', () => {
    const result = clientHelloMessageSchema.safeParse({ ...baseValid, unexpected: true });
    expect(result.success).toBe(false);
  });

  it('rejects an unexpected extra nested field', () => {
    const result = clientHelloMessageSchema.safeParse({
      ...baseValid,
      client: { name: 'desktop', version: '0.0.0', platform: 'win32' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a zero/negative protocol version', () => {
    expect(clientHelloMessageSchema.safeParse({ ...baseValid, protocolVersion: 0 }).success).toBe(
      false,
    );
  });

  it('rejects an empty id', () => {
    expect(clientHelloMessageSchema.safeParse({ ...baseValid, id: '' }).success).toBe(false);
  });

  it('rejects an id past the maximum length', () => {
    expect(clientHelloMessageSchema.safeParse({ ...baseValid, id: 'x'.repeat(65) }).success).toBe(
      false,
    );
  });
});

describe('clientIdentityProofMessageSchema', () => {
  it('accepts a valid client:identity-proof', () => {
    const result = clientIdentityProofMessageSchema.safeParse({
      type: 'client:identity-proof',
      id: 'req-2',
      signature: validSignature,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a signature of the wrong length', () => {
    expect(
      clientIdentityProofMessageSchema.safeParse({
        type: 'client:identity-proof',
        id: 'req-2',
        signature: 'too-short',
      }).success,
    ).toBe(false);
  });

  it('rejects extra fields', () => {
    expect(
      clientIdentityProofMessageSchema.safeParse({
        type: 'client:identity-proof',
        id: 'req-2',
        signature: validSignature,
        extra: 1,
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
