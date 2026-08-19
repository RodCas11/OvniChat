import { describe, expect, it } from 'vitest';

import {
  IDENTITY_AUTH_DOMAIN,
  buildIdentityAuthPayload,
  identityConnectionIdSchema,
  identityExpiresAtSchema,
  identityIdSchema,
  identityNonceSchema,
  identityPublicKeySchema,
  identitySignatureSchema,
} from '../../packages/protocol/src/identity.js';

const validKey = 'A'.repeat(43);
const validSignature = 'A'.repeat(86);
const validIdentityId = `dv1_${'A'.repeat(43)}`;

describe('identityPublicKeySchema', () => {
  it('accepts a well-formed base64url key', () => {
    expect(identityPublicKeySchema.safeParse(validKey).success).toBe(true);
  });

  it('rejects the wrong length', () => {
    expect(identityPublicKeySchema.safeParse('short').success).toBe(false);
  });

  it('rejects non-base64url characters', () => {
    expect(identityPublicKeySchema.safeParse('+'.repeat(43)).success).toBe(false);
  });
});

describe('identitySignatureSchema', () => {
  it('accepts a well-formed base64url signature', () => {
    expect(identitySignatureSchema.safeParse(validSignature).success).toBe(true);
  });

  it('rejects the wrong length', () => {
    expect(identitySignatureSchema.safeParse('short').success).toBe(false);
  });
});

describe('identityNonceSchema', () => {
  it('accepts a well-formed base64url nonce', () => {
    expect(identityNonceSchema.safeParse(validKey).success).toBe(true);
  });

  it('rejects the wrong length', () => {
    expect(identityNonceSchema.safeParse('short').success).toBe(false);
  });
});

describe('identityIdSchema', () => {
  it('accepts a well-formed identity id', () => {
    expect(identityIdSchema.safeParse(validIdentityId).success).toBe(true);
  });

  it('rejects a missing prefix', () => {
    expect(identityIdSchema.safeParse('A'.repeat(47)).success).toBe(false);
  });

  it('rejects the wrong suffix length', () => {
    expect(identityIdSchema.safeParse('dv1_short').success).toBe(false);
  });
});

describe('identityConnectionIdSchema', () => {
  it('accepts a UUID-shaped connection id', () => {
    expect(
      identityConnectionIdSchema.safeParse('123e4567-e89b-12d3-a456-426614174000').success,
    ).toBe(true);
  });

  it('rejects an empty connection id', () => {
    expect(identityConnectionIdSchema.safeParse('').success).toBe(false);
  });

  it('rejects a connection id containing a newline', () => {
    expect(identityConnectionIdSchema.safeParse('abc\ndef').success).toBe(false);
  });
});

describe('identityExpiresAtSchema', () => {
  it('accepts a positive integer', () => {
    expect(identityExpiresAtSchema.safeParse(Date.now() + 1000).success).toBe(true);
  });

  it('rejects zero and negative values', () => {
    expect(identityExpiresAtSchema.safeParse(0).success).toBe(false);
    expect(identityExpiresAtSchema.safeParse(-1).success).toBe(false);
  });

  it('rejects a non-integer', () => {
    expect(identityExpiresAtSchema.safeParse(1.5).success).toBe(false);
  });
});

describe('buildIdentityAuthPayload', () => {
  const fields = {
    protocolVersion: 2,
    connectionId: 'conn-abc',
    nonce: validKey,
    expiresAt: 1_700_000_000_000,
    publicKey: validKey,
    nickname: 'Alice',
  };

  it('produces deterministic bytes for the same fields', () => {
    const a = buildIdentityAuthPayload(fields);
    const b = buildIdentityAuthPayload({ ...fields });
    expect(Array.from(a)).toEqual(Array.from(b));
  });

  it('embeds the domain separation tag as a decodable prefix', () => {
    const bytes = buildIdentityAuthPayload(fields);
    const text = new TextDecoder().decode(bytes);
    expect(text.startsWith(IDENTITY_AUTH_DOMAIN)).toBe(true);
  });

  it('produces different bytes when any single field changes', () => {
    const base = new TextDecoder().decode(buildIdentityAuthPayload(fields));

    expect(
      new TextDecoder().decode(buildIdentityAuthPayload({ ...fields, nickname: 'Bob' })),
    ).not.toBe(base);
    expect(
      new TextDecoder().decode(buildIdentityAuthPayload({ ...fields, connectionId: 'conn-xyz' })),
    ).not.toBe(base);
    expect(
      new TextDecoder().decode(
        buildIdentityAuthPayload({ ...fields, expiresAt: fields.expiresAt + 1 }),
      ),
    ).not.toBe(base);
    expect(
      new TextDecoder().decode(buildIdentityAuthPayload({ ...fields, protocolVersion: 3 })),
    ).not.toBe(base);
  });

  it('produces a newline-delimited, seven-field canonical string', () => {
    const text = new TextDecoder().decode(buildIdentityAuthPayload(fields));
    expect(text.split('\n')).toEqual([
      IDENTITY_AUTH_DOMAIN,
      '2',
      'conn-abc',
      validKey,
      '1700000000000',
      validKey,
      'Alice',
    ]);
  });
});
