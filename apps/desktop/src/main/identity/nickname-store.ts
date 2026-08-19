import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { displayNameSchema } from '@disco-voador/protocol';
import { app } from 'electron';
import { z } from 'zod';

import { writeFileAtomic } from './atomic-write.js';

/**
 * Nickname is a client-local preference, not identity (T7 Section 6) — persisted in its own file,
 * entirely separate from `identity-file.ts`'s keypair, so changing it can never touch the
 * cryptographic identity. There is no central nickname registry; each server only ever learns the
 * current value via `client:hello`.
 */

const preferencesFileSchema = z.object({ nickname: z.string().max(64) }).strict();

function preferencesFilePath(): string {
  return path.join(app.getPath('userData'), 'preferences.json');
}

let cachedNickname: string | undefined;

/**
 * Empty string means "no nickname chosen yet" — the Renderer's first-run prompt trigger. Unlike
 * `identity-file.ts`'s deliberately strict corruption handling (throws rather than silently
 * regenerating), a corrupted or unreadable preferences file here is treated the same as "never
 * set" and silently falls back to the first-run prompt — a reasoned asymmetry, not an oversight:
 * losing a nickname has no security implication and is trivially re-enterable, unlike losing a
 * cryptographic identity's server-recognized history.
 */
export async function getNickname(): Promise<string> {
  if (cachedNickname !== undefined) return cachedNickname;

  let raw: string;
  try {
    raw = await readFile(preferencesFilePath(), 'utf8');
  } catch {
    cachedNickname = '';
    return cachedNickname;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    cachedNickname = '';
    return cachedNickname;
  }

  const result = preferencesFileSchema.safeParse(parsedJson);
  cachedNickname = result.success ? result.data.nickname : '';
  return cachedNickname;
}

/** Validates against the same `displayNameSchema` the wire protocol uses, so a nickname accepted
 * here is always one `client:hello` will later accept too. Returns `false` (never throws) for an
 * invalid nickname — the caller decides how to surface that to the user. */
export async function setNickname(nickname: string): Promise<boolean> {
  const result = displayNameSchema.safeParse(nickname);
  if (!result.success) return false;

  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFileAtomic(preferencesFilePath(), JSON.stringify({ nickname: result.data }));
  cachedNickname = result.data;
  return true;
}
