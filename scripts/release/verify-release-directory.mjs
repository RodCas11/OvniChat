import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ReleaseManifestError, sha256File, validatePublishedRelease } from './build-manifest.mjs';
import {
  CHECKSUMS_FILENAME,
  MANIFEST_FILENAME,
  expectedReleaseFilenames,
  isValidReleaseVersion,
} from './resolve-release-metadata.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * T15.1 — the structural answer to the T15 release bug where Electron Forge genuinely produced a
 * `Setup.exe`, the build reported success, and the file simply was not in `dist-release/<version>/`
 * when the release was assembled. Nothing in the pipeline was looking, so nothing failed.
 *
 * This check makes that class of bug impossible to repeat: a release candidate is valid only when its
 * directory contains EXACTLY the five expected entries, each a non-empty regular file, with the
 * manifest and checksum file internally consistent with the real bytes on disk. Anything missing,
 * anything extra, anything zero-byte, any near-miss filename (a previous version's installer left
 * behind), and any arm64 claim is a hard failure with a specific message — never a warning, never a
 * silent pass.
 */

export class ReleaseDirectoryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseDirectoryError';
  }
}

/**
 * Pure structural check over a directory listing. `entries` is an array of
 * `{ name, size, isFile }`. Returns an array of human-readable violation strings — empty means the
 * listing is structurally complete. Deliberately I/O-free so every failure mode is testable without
 * fabricating a 100 MB installer on disk.
 */
export function findReleaseDirectoryViolations({ version, entries }) {
  const violations = [];

  if (!isValidReleaseVersion(version)) {
    return [`"${version}" is not a plain MAJOR.MINOR.PATCH version; refusing to verify.`];
  }

  const expected = expectedReleaseFilenames(version);
  const byName = new Map();
  for (const entry of entries) {
    if (byName.has(entry.name)) {
      violations.push(`duplicate directory entry: ${entry.name}`);
      continue;
    }
    byName.set(entry.name, entry);
  }

  for (const filename of expected) {
    const entry = byName.get(filename);
    if (!entry) {
      violations.push(
        `missing required release file: ${filename} (a release directory holds exactly ${expected.length} files: ${expected.join(', ')})`,
      );
      continue;
    }
    if (!entry.isFile) {
      violations.push(`${filename} is not a regular file`);
      continue;
    }
    if (!Number.isInteger(entry.size) || entry.size <= 0) {
      violations.push(
        `${filename} is ${entry.size} bytes — a zero-byte artifact is never a valid release, it is a build that failed quietly`,
      );
    }
  }

  for (const [name] of byName) {
    if (expected.includes(name)) continue;
    if (/arm64/iu.test(name)) {
      violations.push(
        `${name}: this release does not ship arm64. linux-x64 and windows-x64 are the only architectures Chantivo has actually built and verified (see detect_arch in infrastructure/install/lib/fetch-verify.sh).`,
      );
      continue;
    }
    violations.push(
      `unexpected file in release directory: ${name}. Only ${expected.join(', ')} may be published; anything else is either a stale artifact from another version or something that must not be distributed.`,
    );
  }

  return violations;
}

/**
 * Full verification against a real directory: the structural check above, plus re-hashing every
 * artifact and confirming both `SHA256SUMS` and `release-manifest.json` describe the bytes that are
 * actually there. Throws on the first hard failure; returns the validated manifest on success.
 */
export async function verifyReleaseDirectory({ version, releaseDir }) {
  const dir = releaseDir ?? path.join(repositoryRoot, 'dist-release', version);

  let dirEntries;
  try {
    dirEntries = await readdir(dir, { withFileTypes: true });
  } catch {
    throw new ReleaseDirectoryError(`Release directory not found or unreadable: ${dir}`);
  }

  const entries = [];
  for (const dirent of dirEntries) {
    const isFile = dirent.isFile();
    const size = isFile ? (await stat(path.join(dir, dirent.name))).size : 0;
    entries.push({ name: dirent.name, size, isFile });
  }

  const violations = findReleaseDirectoryViolations({ version, entries });
  if (violations.length > 0) {
    throw new ReleaseDirectoryError(
      `Release candidate ${version} is not publishable:\n- ${violations.join('\n- ')}`,
    );
  }

  const manifestText = await readFile(path.join(dir, MANIFEST_FILENAME), 'utf8');
  const checksumsText = await readFile(path.join(dir, CHECKSUMS_FILENAME), 'utf8');

  let manifest;
  try {
    manifest = validatePublishedRelease({ expectedVersion: version, manifestText, checksumsText });
  } catch (error) {
    throw new ReleaseDirectoryError(
      error instanceof ReleaseManifestError ? error.message : String(error),
    );
  }

  for (const artifact of Object.values(manifest.artifacts)) {
    const filePath = path.join(dir, artifact.filename);
    const actualSize = (await stat(filePath)).size;
    if (actualSize !== artifact.size) {
      throw new ReleaseDirectoryError(
        `${artifact.filename}: manifest declares ${artifact.size} bytes but the file on disk is ${actualSize}.`,
      );
    }
    const actualSha256 = await sha256File(filePath);
    if (actualSha256 !== artifact.sha256) {
      throw new ReleaseDirectoryError(
        `${artifact.filename}: SHA-256 on disk (${actualSha256}) does not match the manifest (${artifact.sha256}). Never publish a release whose own checksum file is untrustworthy.`,
      );
    }
  }

  return manifest;
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  const [, , versionArg] = process.argv;
  const version =
    versionArg ??
    JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')).version;
  const manifest = await verifyReleaseDirectory({ version });
  console.info(
    `Release candidate ${manifest.version} is complete: ${expectedReleaseFilenames(manifest.version).join(', ')}`,
  );
}
