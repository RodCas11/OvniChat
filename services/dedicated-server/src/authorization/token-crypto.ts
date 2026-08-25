import { createHash, randomBytes } from 'node:crypto';

/**
 * T9 bearer-capability token generation and digesting (privilege keys, invite tokens). These are
 * high-entropy random secrets, not user-chosen
 * passwords — a slow, salted password-hashing KDF (bcrypt/scrypt/argon2) exists to slow down
 * brute-forcing a *low-entropy* human-chosen secret and is not justified here (T9 Section 12: "do
 * not invent password hashing requirements for random 256-bit capability tokens unless
 * justified"). A single fast SHA-256 digest over 256 bits of `randomBytes` output is already
 * computationally infeasible to reverse or brute-force, exactly the same reasoning
 * `packages/identity` already applies to Ed25519 key material.
 */

const TOKEN_SECRET_BYTES = 32;

export type TokenPrefix = 'PRIV' | 'INVITE' | 'ADMIN';

/** Generates a fresh `DV-<PREFIX>-<43-char base64url>` token. The prefix is a pure UX/diagnostic
 * label (so a pasted token is recognizable at a glance) — the server never derives the token's
 * actual kind from this string; that is always looked up from the stored digest's own row. */
export function generateServerToken(prefix: TokenPrefix): string {
  const secret = randomBytes(TOKEN_SECRET_BYTES).toString('base64url');
  return `DV-${prefix}-${secret}`;
}

/** Deterministic, one-way digest used as the token's storage/lookup key — the raw token itself is
 * never persisted (T9 Section 12/48). */
export function digestServerToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
