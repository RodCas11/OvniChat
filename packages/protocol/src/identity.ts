import { z } from 'zod';

/**
 * T7 local cryptographic client identity — wire schemas and the pure canonical signing-payload
 * builder. Deliberately crypto-free (no `node:crypto`, no signing/verification logic): this file
 * is imported by `apps/desktop/src/renderer/**`, which Vite bundles for the sandboxed Electron
 * Renderer with no Node builtins available. The actual Ed25519 key generation, signing, and
 * verification live in `@disco-voador/identity` (Node-only, Main-process/`services/realtime`
 * only — see that package and `docs/architecture/CLIENT_IDENTITY.md`). Every constant that must
 * stay numerically in sync with that package (raw-key/signature byte lengths, the `dv1_` id
 * prefix) is intentionally duplicated here rather than imported, so this package's dependency
 * graph never pulls in Node capabilities.
 */

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/u;

/** Unpadded base64url length of a raw 32-byte Ed25519 public key: `ceil(32 * 8 / 6)` = 43. */
export const IDENTITY_PUBLIC_KEY_BASE64URL_LENGTH = 43;
/** Unpadded base64url length of a raw 64-byte Ed25519 signature: `ceil(64 * 8 / 6)` = 86. */
export const IDENTITY_SIGNATURE_BASE64URL_LENGTH = 86;
/** Unpadded base64url length of a raw 32-byte challenge nonce: `ceil(32 * 8 / 6)` = 43. */
export const IDENTITY_NONCE_BASE64URL_LENGTH = 43;
/** `'dv1_'` followed by 43 base64url characters (a SHA-256 digest of the raw public key). */
export const IDENTITY_ID_PATTERN = /^dv1_[A-Za-z0-9_-]{43}$/u;
/** Generous bound on the server-generated `connectionId` — currently a UUID (36 chars) but not
 * contractually pinned to that exact format. Restricted to alphanumeric/hyphen so it can never
 * contain the `\n` delimiter used by {@link buildIdentityAuthPayload}. */
export const IDENTITY_CONNECTION_ID_MAX_LENGTH = 128;
const CONNECTION_ID_PATTERN = /^[A-Za-z0-9-]{1,128}$/u;

export const identityPublicKeySchema = z
  .string()
  .length(IDENTITY_PUBLIC_KEY_BASE64URL_LENGTH)
  .regex(BASE64URL_PATTERN, 'public key must be base64url');

export const identitySignatureSchema = z
  .string()
  .length(IDENTITY_SIGNATURE_BASE64URL_LENGTH)
  .regex(BASE64URL_PATTERN, 'signature must be base64url');

export const identityNonceSchema = z
  .string()
  .length(IDENTITY_NONCE_BASE64URL_LENGTH)
  .regex(BASE64URL_PATTERN, 'nonce must be base64url');

export const identityIdSchema = z
  .string()
  .regex(IDENTITY_ID_PATTERN, 'identity id must be "dv1_" followed by 43 base64url characters');

export const identityConnectionIdSchema = z
  .string()
  .regex(CONNECTION_ID_PATTERN, 'connection id must be 1-128 alphanumeric/hyphen characters');

/** Positive integer epoch-milliseconds timestamp — used for a challenge's `expiresAt`. */
export const identityExpiresAtSchema = z.number().int().positive();

/**
 * Domain-separation tag prefixing every canonical identity-auth signing payload (see
 * {@link buildIdentityAuthPayload}). Ensures a signature produced for this specific handshake
 * purpose can never be replayed as if it were a signature over some other kind of message this
 * project (or a future one reusing the same keypair) might ever ask the identity to sign.
 * Versioned independently of the wire protocol version carried *inside* the payload.
 */
export const IDENTITY_AUTH_DOMAIN = 'disco-voador:identity-auth:v1';

export interface IdentityAuthPayloadFields {
  readonly protocolVersion: number;
  readonly connectionId: string;
  readonly nonce: string;
  readonly expiresAt: number;
  readonly publicKey: string;
  readonly nickname: string;
}

/**
 * Builds the exact byte sequence both the client (before signing) and the server (before
 * verifying) must independently reconstruct from the same field values. A fixed-order,
 * newline-delimited, domain-separated string rather than `JSON.stringify` specifically to avoid
 * JSON key-ordering ambiguity between two independent implementations. Safe from delimiter
 * injection because every field is independently bounded/pattern-validated before this is ever
 * called, and none of `publicKey` (base64url), `nonce` (base64url), `connectionId`
 * (alphanumeric/hyphen), or `nickname` (rejects control characters, which includes `\n`, via
 * `displayNameSchema`) can contain a newline. `TextEncoder` is used rather than `Buffer` so this
 * function runs identically in Node (Main process, `services/realtime`) and the browser-like
 * sandboxed Renderer.
 */
export function buildIdentityAuthPayload(fields: IdentityAuthPayloadFields): Uint8Array {
  const canonical = [
    IDENTITY_AUTH_DOMAIN,
    String(fields.protocolVersion),
    fields.connectionId,
    fields.nonce,
    String(fields.expiresAt),
    fields.publicKey,
    fields.nickname,
  ].join('\n');
  return new TextEncoder().encode(canonical);
}
