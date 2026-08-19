import { rename, writeFile } from 'node:fs/promises';

/**
 * Write-to-temp-then-rename: `rename` is atomic on the same filesystem (both source and
 * destination live in the same directory here), so a process crash or power loss mid-write can
 * never leave a half-written `filePath` — readers only ever see the old complete file or the new
 * complete file, never a partial one. Used for every file T7's identity/preferences persistence
 * writes; see `docs/architecture/CLIENT_IDENTITY.md`.
 */
export async function writeFileAtomic(filePath: string, contents: string): Promise<void> {
  const tempPath = `${filePath}.tmp-${String(process.pid)}-${String(Date.now())}-${String(Math.random()).slice(2)}`;
  // 0o600 is a no-op on Windows (this project's only target platform) but harmless, and correct
  // on any POSIX filesystem the test suite happens to run on.
  await writeFile(tempPath, contents, { encoding: 'utf8', mode: 0o600 });
  await rename(tempPath, filePath);
}
