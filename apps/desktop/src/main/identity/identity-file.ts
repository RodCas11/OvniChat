import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { IDENTITY_ID_PATTERN, IDENTITY_PUBLIC_KEY_BASE64URL_LENGTH } from '@disco-voador/protocol';
import { app } from 'electron';
import { z } from 'zod';

import { writeFileAtomic } from './atomic-write.js';

const IDENTITY_FILE_VERSION = 1;
/** Generous bound on `safeStorage.encryptString()`'s base64 output for a 32-byte private key —
 * DPAPI/Keychain/libsecret framing adds some overhead, but nowhere near this much. Purely to
 * reject an absurd/corrupted value cheaply, not a real expected size. */
const MAX_ENCRYPTED_PRIVATE_KEY_LENGTH = 4096;

const identityFileSchema = z
  .object({
    version: z.literal(IDENTITY_FILE_VERSION),
    publicKey: z.string().length(IDENTITY_PUBLIC_KEY_BASE64URL_LENGTH),
    encryptedPrivateKey: z.string().min(1).max(MAX_ENCRYPTED_PRIVATE_KEY_LENGTH),
    identityId: z.string().regex(IDENTITY_ID_PATTERN),
  })
  .strict();

export type StoredIdentityFile = z.infer<typeof identityFileSchema>;

export class IdentityStorageError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'IdentityStorageError';
  }
}

function identityDirectory(): string {
  return path.join(app.getPath('userData'), 'identity');
}

function identityFilePath(): string {
  return path.join(identityDirectory(), 'identity.json');
}

/**
 * Returns `undefined` only for "no identity file exists yet" (first run) — every other failure
 * mode (unreadable, not JSON, fails schema validation, wrong `version`) throws
 * {@link IdentityStorageError} instead of silently falling through to first-run behavior, per T7's
 * explicit requirement never to regenerate a corrupt identity without the user's confirmation.
 */
export async function readIdentityFile(): Promise<StoredIdentityFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(identityFilePath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new IdentityStorageError('Failed to read the local identity file', error);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new IdentityStorageError('The local identity file is not valid JSON', error);
  }

  const result = identityFileSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new IdentityStorageError(
      'The local identity file has an invalid, corrupted, or unsupported format',
    );
  }
  return result.data;
}

export async function writeIdentityFile(file: StoredIdentityFile): Promise<void> {
  await mkdir(identityDirectory(), { recursive: true });
  await writeFileAtomic(identityFilePath(), JSON.stringify(file));
}
