import {
  deriveIdentityId,
  generateIdentityKeyPair,
  signWithIdentityKey,
  verifyIdentitySignature,
} from '@disco-voador/identity';
import { buildIdentityAuthPayload } from '@disco-voador/protocol';
import { safeStorage } from 'electron';

import {
  IdentityStorageError,
  readIdentityFile,
  writeIdentityFile,
  type StoredIdentityFile,
} from './identity-file.js';

/**
 * T7 Main-process identity service — the only place the decrypted private key ever exists. The
 * Renderer never receives it: it can only ask {@link getPublicIdentity} (public data) or
 * {@link signIdentityChallenge} (a signature over a payload this module itself reconstructs from
 * structured, validated parameters — never raw bytes the caller supplies), never a generic
 * "sign anything" oracle. See `docs/architecture/CLIENT_IDENTITY.md`.
 */

export interface PublicIdentity {
  readonly identityId: string;
  readonly publicKey: string;
}

export interface SignIdentityChallengeParams {
  readonly protocolVersion: number;
  readonly connectionId: string;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly nickname: string;
}

interface LoadedIdentity {
  readonly publicKey: string;
  readonly privateKey: string;
  readonly identityId: string;
}

let cachedIdentity: LoadedIdentity | undefined;
let loadPromise: Promise<LoadedIdentity> | undefined;

function assertEncryptionAvailable(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new IdentityStorageError(
      'OS-level secure storage (Windows DPAPI) is unavailable on this machine, so the local ' +
        'identity cannot be created or unlocked. Chantivo refuses to store the private key ' +
        'unencrypted as a fallback.',
    );
  }
}

const SELF_CHECK_PAYLOAD = new TextEncoder().encode('disco-voador:identity-self-check:v1');

/**
 * A stored `publicKey`/`encryptedPrivateKey` pair that does not actually correspond to each other
 * (Section 17's "public/private mismatch" corruption case) would otherwise go undetected until
 * the first real server handshake fails — signs and immediately verifies a fixed local payload so
 * this is caught at load time instead, with an actionable error, never a silent bad identity.
 */
function verifyKeyPairIntegrity(publicKey: string, privateKey: string): void {
  let signature: string;
  try {
    signature = signWithIdentityKey(privateKey, publicKey, SELF_CHECK_PAYLOAD);
  } catch (error) {
    throw new IdentityStorageError('The stored identity key material is corrupted', error);
  }
  if (!verifyIdentitySignature(publicKey, SELF_CHECK_PAYLOAD, signature)) {
    throw new IdentityStorageError(
      'The stored public and private key do not correspond to each other — the local identity ' +
        'file is corrupted',
    );
  }
}

function decodeStoredFile(file: StoredIdentityFile): LoadedIdentity {
  assertEncryptionAvailable();

  let privateKey: string;
  try {
    privateKey = safeStorage.decryptString(Buffer.from(file.encryptedPrivateKey, 'base64'));
  } catch (error) {
    throw new IdentityStorageError('The stored private key could not be decrypted', error);
  }

  verifyKeyPairIntegrity(file.publicKey, privateKey);

  if (deriveIdentityId(file.publicKey) !== file.identityId) {
    throw new IdentityStorageError('The stored identity id does not match its public key');
  }

  return { publicKey: file.publicKey, privateKey, identityId: file.identityId };
}

async function createAndPersistIdentity(): Promise<LoadedIdentity> {
  assertEncryptionAvailable();

  const keyPair = generateIdentityKeyPair();
  const identityId = deriveIdentityId(keyPair.publicKey);
  const encryptedPrivateKey = safeStorage.encryptString(keyPair.privateKey).toString('base64');

  await writeIdentityFile({
    version: 1,
    publicKey: keyPair.publicKey,
    encryptedPrivateKey,
    identityId,
  });

  return { publicKey: keyPair.publicKey, privateKey: keyPair.privateKey, identityId };
}

async function loadOrCreateIdentity(): Promise<LoadedIdentity> {
  const existing = await readIdentityFile();
  return existing ? decodeStoredFile(existing) : createAndPersistIdentity();
}

/**
 * Loads the persisted identity, creating one on first run. Two concurrent first-ever callers
 * share the same in-flight promise rather than each independently generating and persisting a
 * keypair — only one identity ever becomes canonical (T7's identity-creation race requirement).
 * Once resolved, the identity is cached for the process's lifetime: verification happens once at
 * connection setup, not on every use (T7's performance guidance) — a fresh load only happens
 * again after an explicit {@link regenerateIdentity}.
 */
async function getOrCreateIdentity(): Promise<LoadedIdentity> {
  if (cachedIdentity) return cachedIdentity;
  loadPromise ??= loadOrCreateIdentity()
    .then((identity) => {
      cachedIdentity = identity;
      return identity;
    })
    .finally(() => {
      loadPromise = undefined;
    });
  return loadPromise;
}

export async function getPublicIdentity(): Promise<PublicIdentity> {
  const identity = await getOrCreateIdentity();
  return { identityId: identity.identityId, publicKey: identity.publicKey };
}

/**
 * Signs the canonical identity-auth payload this module itself builds from `params` plus the
 * loaded identity's own public key — the caller (ultimately the Renderer, via IPC) supplies only
 * structured challenge fields, never bytes to sign directly, so a compromised Renderer can never
 * turn this into a generic signing oracle (see the module doc comment).
 */
export async function signIdentityChallenge(params: SignIdentityChallengeParams): Promise<string> {
  const identity = await getOrCreateIdentity();
  const payload = buildIdentityAuthPayload({
    protocolVersion: params.protocolVersion,
    connectionId: params.connectionId,
    nonce: params.nonce,
    expiresAt: params.expiresAt,
    publicKey: identity.publicKey,
    nickname: params.nickname,
  });
  return signWithIdentityKey(identity.privateKey, identity.publicKey, payload);
}

/**
 * Destructive: mints and persists a brand-new keypair, replacing the current one. Only ever
 * triggered by an explicit, confirmation-gated user action in the Renderer — never automatically
 * (not on nickname change, app update, or connection/WebRTC failure; see
 * `docs/architecture/CLIENT_IDENTITY.md`). Takes effect for future connections only: this
 * function only changes what {@link getOrCreateIdentity} returns from now on — it has no way to
 * reach into, and never touches, a `RealtimeClient` connection already `ready` on the old
 * identity, which keeps using it until it disconnects and reconnects.
 */
export async function regenerateIdentity(): Promise<PublicIdentity> {
  const identity = await createAndPersistIdentity();
  cachedIdentity = identity;
  return { identityId: identity.identityId, publicKey: identity.publicKey };
}
