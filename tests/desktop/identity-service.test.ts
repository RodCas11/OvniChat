import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { deriveIdentityId, generateIdentityKeyPair } from '@disco-voador/identity';
import { buildIdentityAuthPayload } from '@disco-voador/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Fakes only the OS-backed half of `safeStorage` (real DPAPI is not available in a test process)
 * with a simple reversible transform — everything else (file I/O, atomic write, JSON schema
 * validation, the actual Ed25519 crypto) runs for real against a real temporary directory, so
 * these tests exercise the genuine persistence/race/corruption behavior, not a mocked stand-in
 * for it.
 */
let userDataDir = '';
const isEncryptionAvailable = vi.fn(() => true);
const encryptString = vi.fn((value: string) => Buffer.from(`enc:${value}`, 'utf8'));
const decryptString = vi.fn((buffer: Buffer) => {
  const text = buffer.toString('utf8');
  if (!text.startsWith('enc:')) throw new Error('ciphertext does not match the expected format');
  return text.slice(4);
});

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
  safeStorage: {
    isEncryptionAvailable: () => isEncryptionAvailable(),
    encryptString: (value: string) => encryptString(value),
    decryptString: (buffer: Buffer) => decryptString(buffer),
  },
}));

/** `identity-service.ts` caches the loaded identity in module-level state, so each test needs a
 * fresh module instance (`vi.resetModules()` + a dynamic re-import) to avoid leaking a previous
 * test's cached identity across an unrelated `userDataDir`. */
async function freshIdentityService() {
  vi.resetModules();
  return import('../../apps/desktop/src/main/identity/identity-service.js');
}

async function freshIdentityFile() {
  vi.resetModules();
  return import('../../apps/desktop/src/main/identity/identity-file.js');
}

describe('identity-service', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(path.join(tmpdir(), 'dv-identity-test-'));
    isEncryptionAvailable.mockReturnValue(true);
    encryptString.mockClear();
    decryptString.mockClear();
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it('creates a new identity on first use with a correctly derived identityId', async () => {
    const { getPublicIdentity } = await freshIdentityService();
    const identity = await getPublicIdentity();

    expect(identity.identityId).toBe(deriveIdentityId(identity.publicKey));
    expect(identity.identityId).toMatch(/^dv1_[A-Za-z0-9_-]{43}$/u);
  });

  it('persists the identity to disk so a fresh module instance loads the same one back', async () => {
    const first = await freshIdentityService();
    const created = await first.getPublicIdentity();

    const second = await freshIdentityService();
    const loaded = await second.getPublicIdentity();

    expect(loaded).toEqual(created);
  });

  it('two concurrent first-ever callers share one in-flight load and only ever create one identity', async () => {
    const { getPublicIdentity } = await freshIdentityService();

    const [a, b] = await Promise.all([getPublicIdentity(), getPublicIdentity()]);

    expect(a).toEqual(b);
    // Only one keypair was ever generated and persisted — encryptString (the only place a
    // freshly generated private key gets written) was called exactly once, not twice.
    expect(encryptString).toHaveBeenCalledTimes(1);
  });

  it('signs an identity challenge with a signature that verifies against the public identity', async () => {
    const { getPublicIdentity, signIdentityChallenge } = await freshIdentityService();
    const identity = await getPublicIdentity();

    const params = {
      protocolVersion: 2,
      connectionId: 'conn-1',
      nonce: 'A'.repeat(43),
      expiresAt: Date.now() + 30_000,
      nickname: 'Ana',
    };
    const signature = await signIdentityChallenge(params);

    const { verifyIdentitySignature } = await import('@disco-voador/identity');
    const payload = buildIdentityAuthPayload({ ...params, publicKey: identity.publicKey });
    expect(verifyIdentitySignature(identity.publicKey, payload, signature)).toBe(true);
  });

  it('regenerateIdentity mints and persists a different identity, which a later load then returns', async () => {
    const service = await freshIdentityService();
    const original = await service.getPublicIdentity();

    const regenerated = await service.regenerateIdentity();
    expect(regenerated.identityId).not.toBe(original.identityId);

    const reloaded = await freshIdentityService();
    const afterRestart = await reloaded.getPublicIdentity();
    expect(afterRestart).toEqual(regenerated);
  });

  it('throws instead of silently falling back to plaintext when secure storage is unavailable', async () => {
    isEncryptionAvailable.mockReturnValue(false);
    const { getPublicIdentity } = await freshIdentityService();

    await expect(getPublicIdentity()).rejects.toThrow(/secure storage/i);
    expect(encryptString).not.toHaveBeenCalled();
  });

  it('throws an actionable error instead of silently regenerating when the identity file is corrupted JSON', async () => {
    mkdirSync(path.join(userDataDir, 'identity'), { recursive: true });
    writeFileSync(path.join(userDataDir, 'identity', 'identity.json'), '{not valid json');

    const { getPublicIdentity } = await freshIdentityService();
    await expect(getPublicIdentity()).rejects.toThrow(/not valid JSON/);
  });

  it('throws an actionable error for a schema-invalid identity file instead of silently regenerating', async () => {
    mkdirSync(path.join(userDataDir, 'identity'), { recursive: true });
    writeFileSync(
      path.join(userDataDir, 'identity', 'identity.json'),
      JSON.stringify({ version: 1, publicKey: 'too-short' }),
    );

    const { getPublicIdentity } = await freshIdentityService();
    await expect(getPublicIdentity()).rejects.toThrow(/invalid, corrupted, or unsupported/);
  });

  it('throws an actionable error for an unsupported file version instead of silently regenerating', async () => {
    const keyPair = generateIdentityKeyPair();
    mkdirSync(path.join(userDataDir, 'identity'), { recursive: true });
    writeFileSync(
      path.join(userDataDir, 'identity', 'identity.json'),
      JSON.stringify({
        version: 99,
        publicKey: keyPair.publicKey,
        encryptedPrivateKey: Buffer.from(`enc:${keyPair.privateKey}`, 'utf8').toString('base64'),
        identityId: deriveIdentityId(keyPair.publicKey),
      }),
    );

    const { getPublicIdentity } = await freshIdentityService();
    await expect(getPublicIdentity()).rejects.toThrow(/invalid, corrupted, or unsupported/);
  });

  it('detects a public/private key mismatch instead of silently signing with mismatched keys', async () => {
    const stored = generateIdentityKeyPair();
    const actuallyEncrypted = generateIdentityKeyPair(); // a different, unrelated keypair
    mkdirSync(path.join(userDataDir, 'identity'), { recursive: true });
    writeFileSync(
      path.join(userDataDir, 'identity', 'identity.json'),
      JSON.stringify({
        version: 1,
        publicKey: stored.publicKey,
        encryptedPrivateKey: Buffer.from(`enc:${actuallyEncrypted.privateKey}`, 'utf8').toString(
          'base64',
        ),
        identityId: deriveIdentityId(stored.publicKey),
      }),
    );

    const { getPublicIdentity } = await freshIdentityService();
    await expect(getPublicIdentity()).rejects.toThrow(/do not correspond/);
  });

  it('detects a stored identityId that does not match its public key', async () => {
    const keyPair = generateIdentityKeyPair();
    const otherKeyPair = generateIdentityKeyPair();
    mkdirSync(path.join(userDataDir, 'identity'), { recursive: true });
    writeFileSync(
      path.join(userDataDir, 'identity', 'identity.json'),
      JSON.stringify({
        version: 1,
        publicKey: keyPair.publicKey,
        encryptedPrivateKey: Buffer.from(`enc:${keyPair.privateKey}`, 'utf8').toString('base64'),
        // Deliberately mismatched: a real identityId, just not this key's.
        identityId: deriveIdentityId(otherKeyPair.publicKey),
      }),
    );

    const { getPublicIdentity } = await freshIdentityService();
    await expect(getPublicIdentity()).rejects.toThrow(/identity id does not match/);
  });

  it('writeIdentityFile leaves no partial file behind if the process were to fail mid-write (atomic rename)', async () => {
    const { readIdentityFile, writeIdentityFile } = await freshIdentityFile();
    const keyPair = generateIdentityKeyPair();
    const file = {
      version: 1 as const,
      publicKey: keyPair.publicKey,
      encryptedPrivateKey: 'enc-placeholder',
      identityId: deriveIdentityId(keyPair.publicKey),
    };

    await writeIdentityFile(file);
    // No leftover .tmp-* files: rename() replaced the target atomically, not a copy+delete.
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(path.join(userDataDir, 'identity'));
    expect(entries).toEqual(['identity.json']);

    const readBack = await readIdentityFile();
    expect(readBack).toEqual(file);
  });
});
