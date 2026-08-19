import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  verify,
} from 'node:crypto';

/**
 * T7 local cryptographic client identity — Ed25519 keypair generation, signing, verification, and
 * `identityId` derivation. Deliberately Node-only (`node:crypto`): this package is imported by the
 * Electron Main process (which owns the private key — the Renderer never does, see
 * `docs/architecture/CLIENT_IDENTITY.md`) and by `services/realtime` (which verifies signatures and
 * derives the authoritative `identityId`), never by anything Vite bundles for the sandboxed
 * Renderer. `packages/protocol` stays crypto-free (wire schemas and the pure canonical-payload
 * builder only) specifically so it remains safe to import from the Renderer — see that package's
 * `identity.ts` for the shared, environment-neutral half of this design.
 *
 * Ed25519 chosen per T7's own guidance: the client only needs key generation, signing, and
 * verification — no key exchange, no encryption — and Node's built-in `crypto` module has provided
 * a stable, well-maintained implementation since long before this project's pinned runtime (verified
 * directly against it: `generateKeyPairSync('ed25519')` / `sign(null, data, privateKey)` /
 * `verify(null, data, publicKey, signature)` all work as expected). No third-party crypto dependency
 * was introduced.
 *
 * Wire/storage encoding: every key, signature, and nonce this module produces or accepts is the
 * **raw** cryptographic material — 32 bytes for an Ed25519 public key or private-key seed, 64 bytes
 * for a signature — represented as unpadded base64url text (`IdentityKeyPair.publicKey` etc.), never
 * a DER/SPKI/PKCS8-wrapped or algorithm-tagged blob. This keeps the wire format small, portable, and
 * exactly reproducible byte-for-byte on both sides of the protocol, and matches the JWK `OKP` `x`/`d`
 * fields Node's own `KeyObject.export({ format: 'jwk' })` already produces for Ed25519 — this module
 * reads/writes exactly those fields rather than inventing a bespoke encoding.
 */

const RAW_KEY_BYTES = 32;
const RAW_SIGNATURE_BYTES = 64;
/** Unpadded base64url length for 32 raw bytes: `ceil(32 * 8 / 6)` = 43 characters. */
export const IDENTITY_KEY_BASE64URL_LENGTH = 43;
/** Unpadded base64url length for 64 raw bytes: `ceil(64 * 8 / 6)` = 86 characters. */
export const IDENTITY_SIGNATURE_BASE64URL_LENGTH = 86;

/** `'dv1_'` + 43 base64url characters (a SHA-256 digest of the raw public key, see
 * {@link deriveIdentityId}). Bumped (`dv2_`, ...) only if the derivation algorithm itself ever
 * changes — never for a routine key rotation, which produces a new id under the same `dv1_` scheme. */
export const IDENTITY_ID_PREFIX = 'dv1_';

export class IdentityCryptoError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'IdentityCryptoError';
  }
}

export interface IdentityKeyPair {
  /** Raw 32-byte Ed25519 public key, unpadded base64url — safe to transmit, log, and display. */
  readonly publicKey: string;
  /** Raw 32-byte Ed25519 private-key seed, unpadded base64url — sensitive; callers must handle this
   * exactly like the identity's private key material, because it is. */
  readonly privateKey: string;
}

function isBase64UrlOfLength(value: string, length: number): boolean {
  return value.length === length && /^[A-Za-z0-9_-]+$/u.test(value);
}

/** Unpadded base64url character length for `bytes` raw bytes: `ceil(bytes * 8 / 6)`. */
function base64UrlLengthForBytes(bytes: number): number {
  return Math.ceil((bytes * 8) / 6);
}

function decodeRawKey(base64Url: string, expectedBytes: number, label: string): Buffer {
  const expectedLength = base64UrlLengthForBytes(expectedBytes);
  if (!isBase64UrlOfLength(base64Url, expectedLength)) {
    throw new IdentityCryptoError(
      `${label} must be ${String(expectedLength)} base64url characters`,
    );
  }
  const buffer = Buffer.from(base64Url, 'base64url');
  if (buffer.length !== expectedBytes) {
    throw new IdentityCryptoError(`${label} did not decode to ${String(expectedBytes)} bytes`);
  }
  return buffer;
}

/** Generates a new random Ed25519 keypair. Never derived from hardware, machine identifiers, or any
 * other non-random input — pure cryptographic randomness, per T7's explicit requirement. */
export function generateIdentityKeyPair(): IdentityKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const publicJwk = publicKey.export({ format: 'jwk' });
  const privateJwk = privateKey.export({ format: 'jwk' });
  if (typeof publicJwk.x !== 'string' || typeof privateJwk.d !== 'string') {
    // Should not happen for a freshly generated Ed25519 KeyObject — defensive, not an expected path.
    throw new IdentityCryptoError('generated keypair did not export the expected JWK fields');
  }
  return { publicKey: publicJwk.x, privateKey: privateJwk.d };
}

/** Reconstructs a signing key from its raw base64url seed and signs `payload` (already-canonical
 * bytes — see `packages/protocol`'s `identity.ts` for how the caller must have built them; this
 * function has no opinion on what it signs, by design, so it never independently re-derives or
 * second-guesses the payload). Returns a base64url-encoded raw 64-byte signature. */
export function signWithIdentityKey(
  privateKeyBase64Url: string,
  publicKeyBase64Url: string,
  payload: Uint8Array,
): string {
  const d = decodeRawKey(privateKeyBase64Url, RAW_KEY_BYTES, 'private key').toString('base64url');
  const x = decodeRawKey(publicKeyBase64Url, RAW_KEY_BYTES, 'public key').toString('base64url');
  let privateKey;
  try {
    privateKey = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x, d }, format: 'jwk' });
  } catch (error) {
    throw new IdentityCryptoError('private key material could not be reconstructed', error);
  }
  const signature = sign(null, Buffer.from(payload), privateKey);
  return signature.toString('base64url');
}

/**
 * Verifies `signature` over `payload` against `publicKeyBase64Url`. Returns a plain boolean, never
 * throws for a cryptographically invalid combination (a malformed/degenerate public key that still
 * decodes to 32 bytes is accepted by `createPublicKey` — Node's own Ed25519 point validation happens
 * inside `verify`, which safely returns `false` rather than throwing; live-verified against this
 * project's pinned Node runtime). A schema-invalid `publicKeyBase64Url`/`signature` (wrong length,
 * non-base64url characters) throws `IdentityCryptoError` instead — that is a caller bug (the wire
 * schema in `packages/protocol` should already have rejected it before this is ever called), not a
 * verification outcome.
 */
export function verifyIdentitySignature(
  publicKeyBase64Url: string,
  payload: Uint8Array,
  signatureBase64Url: string,
): boolean {
  const x = decodeRawKey(publicKeyBase64Url, RAW_KEY_BYTES, 'public key').toString('base64url');
  const signature = decodeRawKey(signatureBase64Url, RAW_SIGNATURE_BYTES, 'signature');
  let publicKey;
  try {
    publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
  } catch {
    // A public key that fails to reconstruct at all is not a verification pass or throw — it is
    // simply never valid for anything signed against it.
    return false;
  }
  try {
    return verify(null, Buffer.from(payload), publicKey, signature);
  } catch {
    // Defensive: Node's `verify` is not documented to throw for a well-formed-but-invalid key/
    // signature pair (confirmed live against this project's pinned runtime — it returns `false`),
    // but a boolean-returning security function must never let an unexpected throw escape as an
    // unhandled rejection/exception that could be mishandled by a caller as "not rejected yet."
    return false;
  }
}

/**
 * `identityId = 'dv1_' + base64url(SHA-256(raw 32-byte public key))` — deterministic, contains no
 * private material, stable for the lifetime of a given keypair, and different for different public
 * keys (a SHA-256 collision is not a practical concern). Hashes the **raw** public-key bytes, never
 * the base64url string or any other human-readable serialization of it — T7 explicitly requires
 * canonical byte material as the hash input, since a non-canonical encoding (different padding,
 * different casing, etc.) of the *same* key would otherwise hash to a *different* id.
 */
export function deriveIdentityId(publicKeyBase64Url: string): string {
  const raw = decodeRawKey(publicKeyBase64Url, RAW_KEY_BYTES, 'public key');
  const digest = createHash('sha256').update(raw).digest();
  return `${IDENTITY_ID_PREFIX}${digest.toString('base64url')}`;
}

/** Generates a fresh, cryptographically secure 32-byte nonce for one `server:identity-challenge`,
 * base64url-encoded. Never `Date.now()`, `Math.random()`, or a counter — see
 * `docs/architecture/CLIENT_IDENTITY.md`'s "Challenge security" section. */
export function generateIdentityChallengeNonce(): string {
  return randomBytes(RAW_KEY_BYTES).toString('base64url');
}
