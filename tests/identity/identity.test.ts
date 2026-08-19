import { describe, expect, it } from 'vitest';

import {
  IDENTITY_ID_PREFIX,
  IDENTITY_KEY_BASE64URL_LENGTH,
  IDENTITY_SIGNATURE_BASE64URL_LENGTH,
  IdentityCryptoError,
  deriveIdentityId,
  generateIdentityChallengeNonce,
  generateIdentityKeyPair,
  signWithIdentityKey,
  verifyIdentitySignature,
} from '../../packages/identity/src/index.js';

describe('generateIdentityKeyPair', () => {
  it('generates a public and private key of the expected raw base64url length', () => {
    const keyPair = generateIdentityKeyPair();
    expect(keyPair.publicKey).toHaveLength(IDENTITY_KEY_BASE64URL_LENGTH);
    expect(keyPair.privateKey).toHaveLength(IDENTITY_KEY_BASE64URL_LENGTH);
    expect(keyPair.publicKey).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(keyPair.privateKey).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it('generates a different keypair on every call', () => {
    const a = generateIdentityKeyPair();
    const b = generateIdentityKeyPair();
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});

describe('signWithIdentityKey / verifyIdentitySignature', () => {
  it('produces a signature that verifies against the matching public key', () => {
    const { publicKey, privateKey } = generateIdentityKeyPair();
    const payload = new TextEncoder().encode('disco-voador:identity-auth:v1\npayload');

    const signature = signWithIdentityKey(privateKey, publicKey, payload);

    expect(signature).toHaveLength(IDENTITY_SIGNATURE_BASE64URL_LENGTH);
    expect(verifyIdentitySignature(publicKey, payload, signature)).toBe(true);
  });

  it('rejects a signature verified against a different public key', () => {
    const signer = generateIdentityKeyPair();
    const other = generateIdentityKeyPair();
    const payload = new TextEncoder().encode('same payload');

    const signature = signWithIdentityKey(signer.privateKey, signer.publicKey, payload);

    expect(verifyIdentitySignature(other.publicKey, payload, signature)).toBe(false);
  });

  it('rejects a signature verified against a tampered payload', () => {
    const { publicKey, privateKey } = generateIdentityKeyPair();
    const signature = signWithIdentityKey(privateKey, publicKey, new TextEncoder().encode('a'));

    expect(verifyIdentitySignature(publicKey, new TextEncoder().encode('b'), signature)).toBe(
      false,
    );
  });

  it('safely returns false for a well-formed but degenerate public key, never throws', () => {
    const { privateKey, publicKey } = generateIdentityKeyPair();
    const signature = signWithIdentityKey(privateKey, publicKey, new TextEncoder().encode('x'));
    const zeroPublicKey = Buffer.alloc(32, 0).toString('base64url');

    expect(() =>
      verifyIdentitySignature(zeroPublicKey, new TextEncoder().encode('x'), signature),
    ).not.toThrow();
    expect(verifyIdentitySignature(zeroPublicKey, new TextEncoder().encode('x'), signature)).toBe(
      false,
    );
  });

  it('throws IdentityCryptoError for a schema-invalid private key', () => {
    const { publicKey } = generateIdentityKeyPair();
    expect(() =>
      signWithIdentityKey('not-base64url-of-right-length', publicKey, new Uint8Array()),
    ).toThrow(IdentityCryptoError);
  });

  it('throws IdentityCryptoError for a schema-invalid signature (wrong length)', () => {
    const { publicKey } = generateIdentityKeyPair();
    expect(() =>
      verifyIdentitySignature(publicKey, new TextEncoder().encode('x'), 'too-short'),
    ).toThrow(IdentityCryptoError);
  });

  it('throws IdentityCryptoError for a schema-invalid public key (wrong length)', () => {
    expect(() =>
      verifyIdentitySignature('too-short', new TextEncoder().encode('x'), 'x'.repeat(86)),
    ).toThrow(IdentityCryptoError);
  });
});

describe('deriveIdentityId', () => {
  it('derives a stable, prefixed id for a given public key', () => {
    const { publicKey } = generateIdentityKeyPair();
    const first = deriveIdentityId(publicKey);
    const second = deriveIdentityId(publicKey);

    expect(first).toBe(second);
    expect(first.startsWith(IDENTITY_ID_PREFIX)).toBe(true);
  });

  it('derives different ids for different public keys', () => {
    const a = generateIdentityKeyPair();
    const b = generateIdentityKeyPair();

    expect(deriveIdentityId(a.publicKey)).not.toBe(deriveIdentityId(b.publicKey));
  });

  it('throws IdentityCryptoError for a schema-invalid public key', () => {
    expect(() => deriveIdentityId('not valid base64url!!')).toThrow(IdentityCryptoError);
  });
});

describe('generateIdentityChallengeNonce', () => {
  it('generates a base64url nonce of the expected length', () => {
    const nonce = generateIdentityChallengeNonce();
    expect(nonce).toHaveLength(IDENTITY_KEY_BASE64URL_LENGTH);
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/u);
  });

  it('generates a different nonce on every call', () => {
    const a = generateIdentityChallengeNonce();
    const b = generateIdentityChallengeNonce();
    expect(a).not.toBe(b);
  });
});
