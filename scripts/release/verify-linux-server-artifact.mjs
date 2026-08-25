import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { isValidReleaseVersion, linuxServerFilename } from './resolve-release-metadata.mjs';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * T15.1 — validates the Linux Dedicated Server tarball that
 * `scripts/release/build-dedicated-server-artifact.mjs` just produced, before it is allowed anywhere
 * near a release. `build-dedicated-server-artifact.mjs` was proven in T15, but "the build command
 * exited 0" and "the archive contains a runnable server of the right version" are different claims,
 * and only the second one matters to an operator.
 *
 * Also enforces the architecture-honesty rule the rest of this pipeline depends on: linux-x64 is the
 * only architecture Chantivo has actually built and run, so an artifact filename claiming anything
 * else is rejected here rather than becoming a published lie. This mirrors `detect_arch()` in
 * `infrastructure/install/lib/fetch-verify.sh`, which fails loudly on arm64 hosts for the same reason.
 */

export class LinuxArtifactError extends Error {
  constructor(message) {
    super(message);
    this.name = 'LinuxArtifactError';
  }
}

/**
 * Pure check over an archive's entry list (as produced by `tar -tzf`). Returns violation strings.
 * Split out from the I/O below so every failure mode is testable without building a real tarball.
 */
export function findArchiveContentViolations({ version, entries }) {
  const violations = [];
  const normalized = entries
    .map((entry) => entry.replaceAll('\\', '/').replace(/^\.\//u, ''))
    .filter((entry) => entry.length > 0);

  const topLevel = new Set(normalized.map((entry) => entry.split('/')[0]));
  if (!(topLevel.size === 1 && topLevel.has('chantivo-dedicated-server'))) {
    violations.push(
      `archive must have exactly one top-level directory "chantivo-dedicated-server/", found: ${[...topLevel].sort().join(', ') || '<empty archive>'}`,
    );
  }

  for (const required of [
    'chantivo-dedicated-server/dist/cli.js',
    'chantivo-dedicated-server/package.json',
  ]) {
    if (!normalized.includes(required)) {
      violations.push(`archive is missing ${required}`);
    }
  }

  const escaping = normalized.filter(
    (entry) => entry.startsWith('/') || entry.split('/').includes('..'),
  );
  if (escaping.length > 0) {
    violations.push(
      `archive contains absolute or parent-traversing paths (${escaping.slice(0, 3).join(', ')}) — refusing to ship an archive that could write outside its extraction directory`,
    );
  }

  const arm64Entries = normalized.filter((entry) => /arm64|aarch64/iu.test(entry));
  if (arm64Entries.length > 0) {
    violations.push(
      `archive contains arm64/aarch64 path(s) (${arm64Entries.slice(0, 3).join(', ')}) — this release ships linux-x64 only`,
    );
  }

  if (!isValidReleaseVersion(version)) {
    violations.push(`"${version}" is not a plain MAJOR.MINOR.PATCH version`);
  }

  return violations;
}

async function listArchiveEntries(artifactPath) {
  try {
    const { stdout } = await execFileAsync('tar', ['-tzf', artifactPath, '--force-local'], {
      maxBuffer: 64 * 1024 * 1024,
    });
    return stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  } catch (error) {
    throw new LinuxArtifactError(
      `Could not read ${path.basename(artifactPath)} with tar -tzf: ${error instanceof Error ? error.message : String(error)}. An unreadable archive is a failed build, not a release.`,
    );
  }
}

async function readVersionFromArchive({ artifactPath }) {
  const { stdout } = await execFileAsync(
    'tar',
    ['-xzOf', artifactPath, '--force-local', 'chantivo-dedicated-server/package.json'],
    { maxBuffer: 8 * 1024 * 1024 },
  );
  return JSON.parse(stdout).version;
}

export async function verifyLinuxServerArtifact({ version, releaseDir }) {
  if (!isValidReleaseVersion(version)) {
    throw new LinuxArtifactError(`"${version}" is not a plain MAJOR.MINOR.PATCH version.`);
  }
  const filename = linuxServerFilename(version);
  const artifactPath = path.join(
    releaseDir ?? path.join(repositoryRoot, 'dist-release', version),
    filename,
  );

  let fileStat;
  try {
    fileStat = await stat(artifactPath);
  } catch {
    throw new LinuxArtifactError(
      `${filename} was not produced at ${artifactPath}. The Dedicated Server build reported success but left no artifact — exactly the class of silent failure this check exists to catch.`,
    );
  }
  if (!fileStat.isFile() || fileStat.size === 0) {
    throw new LinuxArtifactError(
      `${filename} is empty or not a regular file (${fileStat.size} bytes).`,
    );
  }

  const entries = await listArchiveEntries(artifactPath);
  const violations = findArchiveContentViolations({ version, entries });
  if (violations.length > 0) {
    throw new LinuxArtifactError(
      `${filename} is not a valid release artifact:\n- ${violations.join('\n- ')}`,
    );
  }

  const embeddedVersion = await readVersionFromArchive({ artifactPath });
  if (embeddedVersion !== version) {
    throw new LinuxArtifactError(
      `${filename} contains a Dedicated Server reporting version ${embeddedVersion}, but the release is ${version}. An artifact that misreports its own version makes every operator's "chantivo-server version" output a lie.`,
    );
  }

  return {
    filename,
    artifactPath,
    size: fileStat.size,
    version: embeddedVersion,
    entryCount: entries.length,
  };
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  const [, , versionArg] = process.argv;
  const version =
    versionArg ??
    JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')).version;
  const result = await verifyLinuxServerArtifact({ version });
  console.info(
    `${result.filename} verified: ${result.size} bytes, ${result.entryCount} entries, reports version ${result.version}`,
  );
}
