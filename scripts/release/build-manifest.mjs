import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CHECKSUMS_FILENAME,
  INSTALLER_FILENAME,
  MANIFEST_FILENAME,
  isValidReleaseVersion,
  linuxServerFilename,
  windowsInstallerFilename,
} from './resolve-release-metadata.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * T15 — scans `dist-release/<version>/` for real, already-built artifacts and emits the two things
 * `install-chantivo.sh`/`chantivo-server update` actually trust: `SHA256SUMS` (plain
 * `sha256sum`-format, so `sha256sum -c` works directly against it — this is the file installers
 * verify against, not the JSON) and `release-manifest.json` (the same data plus display metadata, for
 * humans/tooling that want it structured). Never includes anything but the hash/size/name of files
 * that already exist on disk — no secret, no build-environment detail.
 *
 * T15.1 extended this from "whatever files happen to be in the directory, described by a filename
 * regex" to an explicit, versioned schema covering all three real release artifacts (the Windows
 * desktop installer, the Linux Dedicated Server tarball, and the bootstrap installer script). Two
 * deliberate changes came with that:
 *
 * 1. The artifact set is now CLOSED. An unexpected filename, a missing expected one, or anything
 *    claiming an architecture this release does not actually ship (arm64) is an error, not an
 *    "unknown" entry quietly written into a published manifest. T15's `platformNameFor` would happily
 *    emit `"platform": "unknown"` or `"platform": "linux-arm64"` for a stray file; a published release
 *    manifest is a truth claim to every operator who verifies against it, so it can no longer contain
 *    a guess.
 * 2. The manifest is a DETERMINISTIC function of (version, artifact bytes, git commit) — the wall-clock
 *    `releasedAt` field T15 emitted was removed. This is what makes republication safety decidable:
 *    the R2 publisher can compare an already-published `release-manifest.json` against the one this
 *    build produces and get a meaningful identical/conflicting answer. A timestamp would have made
 *    every rerun look like a conflicting change to an immutable release.
 */

/** Bump when a field is added, removed, or changes meaning. Consumers (the promote workflow, any
 * future in-app update check) must refuse a schemaVersion they do not understand rather than guess. */
export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;

/**
 * The complete, closed set of artifact keys, each bound to the exact filename it must have and the
 * truthful platform/architecture it actually runs on. `linux-installer` has `arch: null` on purpose:
 * `install-chantivo.sh` is a POSIX shell script that runs on any Linux architecture, but it can only
 * install the linux-x64 server artifact this release ships (see `detect_arch` in
 * `infrastructure/install/lib/fetch-verify.sh`, which fails loudly and honestly on arm64 rather than
 * constructing a download URL for an artifact that does not exist).
 */
export const RELEASE_ARTIFACT_SPECS = Object.freeze({
  'linux-installer': Object.freeze({
    filenameFor: () => INSTALLER_FILENAME,
    platform: 'linux',
    arch: null,
    kind: 'install-script',
  }),
  'linux-server-x64': Object.freeze({
    filenameFor: linuxServerFilename,
    platform: 'linux',
    arch: 'x64',
    kind: 'dedicated-server-tarball',
  }),
  'windows-x64': Object.freeze({
    filenameFor: windowsInstallerFilename,
    platform: 'windows',
    arch: 'x64',
    kind: 'desktop-installer',
  }),
});

/** Sorted so serialization is byte-stable regardless of insertion order. */
const ARTIFACT_KEYS = Object.freeze(Object.keys(RELEASE_ARTIFACT_SPECS).sort());

/** Files that describe the release rather than being part of it, and so carry no manifest entry and
 * no self-referential checksum. */
const DESCRIPTOR_FILENAMES = Object.freeze([MANIFEST_FILENAME, CHECKSUMS_FILENAME]);

export function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

export function expectedArtifactFilenames(version) {
  return ARTIFACT_KEYS.map((key) => RELEASE_ARTIFACT_SPECS[key].filenameFor(version));
}

/** Maps a filename back to its artifact key, or `undefined` when the file has no place in a release
 * of this version. Exact-match only — deliberately not a regex, so a near-miss filename
 * (`ChantivoSetup-0.1.0.exe` inside a 0.1.1 release) is an error rather than a fuzzy match. */
export function artifactKeyForFilename(version, filename) {
  return ARTIFACT_KEYS.find((key) => RELEASE_ARTIFACT_SPECS[key].filenameFor(version) === filename);
}

export class ReleaseManifestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseManifestError';
  }
}

const HEX_SHA256 = /^[0-9a-f]{64}$/u;

/**
 * Pure manifest construction. `files` is an array of `{ filename, sha256, size }` for the real
 * artifact files (never the descriptors). Throws rather than emitting a manifest that would make a
 * false claim.
 */
export function buildReleaseManifest({
  version,
  files,
  gitCommit = undefined,
  allowPartial = false,
}) {
  if (!isValidReleaseVersion(version)) {
    throw new ReleaseManifestError(
      `Cannot build a release manifest for "${version}" — expected a plain MAJOR.MINOR.PATCH version.`,
    );
  }

  const byFilename = new Map();
  for (const file of files) {
    if (byFilename.has(file.filename)) {
      throw new ReleaseManifestError(`Duplicate artifact entry for ${file.filename}.`);
    }
    byFilename.set(file.filename, file);
  }

  const artifacts = {};
  for (const key of ARTIFACT_KEYS) {
    const spec = RELEASE_ARTIFACT_SPECS[key];
    const filename = spec.filenameFor(version);
    const file = byFilename.get(filename);
    if (!file) {
      // `allowPartial` exists for ONE case: this repository's local fixture workflow, where an
      // operator builds only the Linux tarball and wants a manifest/SHA256SUMS pair to point
      // install-chantivo.sh at (see infrastructure/install/README.md). It is never used by the release
      // pipeline, and it cannot leak into a publication: verify-release-directory.mjs and
      // validatePublishedRelease both independently require the complete artifact set, so a partial
      // manifest fails long before anything reaches R2.
      if (allowPartial) continue;
      throw new ReleaseManifestError(
        `Release ${version} is missing its ${key} artifact (${filename}).`,
      );
    }
    if (!HEX_SHA256.test(String(file.sha256 ?? ''))) {
      throw new ReleaseManifestError(
        `${filename}: sha256 must be 64 lowercase hex characters, got "${file.sha256}".`,
      );
    }
    if (!Number.isInteger(file.size) || file.size <= 0) {
      throw new ReleaseManifestError(
        `${filename}: size must be a positive integer byte count, got ${file.size}. A zero-byte artifact is never a valid release.`,
      );
    }
    byFilename.delete(filename);
    // Explicit key order — object literal order IS the serialization order for JSON.stringify.
    artifacts[key] = {
      filename,
      sha256: file.sha256,
      size: file.size,
      platform: spec.platform,
      arch: spec.arch,
      kind: spec.kind,
    };
  }

  const unexpected = [...byFilename.keys()].sort();
  if (unexpected.length > 0) {
    throw new ReleaseManifestError(
      `Release ${version} contains file(s) that are not part of a Chantivo release: ${unexpected.join(', ')}. A published release directory holds exactly the declared artifacts and nothing else.`,
    );
  }

  const manifest = {
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    product: 'Chantivo',
    version,
    artifacts,
  };
  if (gitCommit) {
    manifest.gitCommit = gitCommit;
  }
  return manifest;
}

/** Byte-stable serialization: 2-space indent + trailing newline, matching every other generated JSON
 * in this repository. Key order comes from `buildReleaseManifest`'s literal ordering, never from
 * `Object.keys` of caller-supplied data. */
export function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/** Standard `sha256sum` output format: `<hex><two spaces><filename>`, sorted by filename so the file
 * is byte-stable. */
export function renderChecksums(entries) {
  return [...entries]
    .sort((a, b) => (a.filename < b.filename ? -1 : a.filename > b.filename ? 1 : 0))
    .map((entry) => `${entry.sha256}  ${entry.filename}\n`)
    .join('');
}

/** Parses `sha256sum`-format text into a `filename -> sha256` map. Rejects malformed lines instead of
 * skipping them: a checksum file that is partly unparseable must never be treated as if the entries
 * that did parse were the whole story. */
export function parseChecksums(text) {
  const result = new Map();
  const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}(\S.*)$/u.exec(line);
    if (!match) {
      throw new ReleaseManifestError(`Malformed SHA256SUMS line: ${JSON.stringify(line)}`);
    }
    if (result.has(match[2])) {
      throw new ReleaseManifestError(`Duplicate SHA256SUMS entry for ${match[2]}.`);
    }
    result.set(match[2], match[1]);
  }
  return result;
}

/**
 * Validates an already-serialized manifest + checksum pair against each other and against an expected
 * version. This is the function the promote workflow runs against what R2 actually holds, so it must
 * assume the inputs are untrusted text, not something this repository just produced.
 *
 * Returns the parsed manifest on success; throws `ReleaseManifestError` with a specific reason
 * otherwise. Never returns a partially-validated result — promotion is all-or-nothing.
 */
export function validatePublishedRelease({ expectedVersion, manifestText, checksumsText }) {
  if (!isValidReleaseVersion(expectedVersion)) {
    throw new ReleaseManifestError(
      `"${expectedVersion}" is not a plain MAJOR.MINOR.PATCH version; refusing to validate.`,
    );
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    throw new ReleaseManifestError(
      `release-manifest.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (manifest?.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION) {
    throw new ReleaseManifestError(
      `release-manifest.json declares schemaVersion ${JSON.stringify(manifest?.schemaVersion)}; this tool only understands ${RELEASE_MANIFEST_SCHEMA_VERSION}. Refusing to guess at an unknown schema.`,
    );
  }
  if (manifest.version !== expectedVersion) {
    throw new ReleaseManifestError(
      `release-manifest.json declares version ${JSON.stringify(manifest.version)} but ${expectedVersion} was requested. Refusing to promote a release that disagrees with its own version.`,
    );
  }

  const artifacts = manifest.artifacts;
  if (!artifacts || typeof artifacts !== 'object' || Array.isArray(artifacts)) {
    throw new ReleaseManifestError('release-manifest.json has no artifacts object.');
  }

  const presentKeys = Object.keys(artifacts).sort();
  const missingKeys = ARTIFACT_KEYS.filter((key) => !presentKeys.includes(key));
  if (missingKeys.length > 0) {
    throw new ReleaseManifestError(
      `release-manifest.json is missing artifact(s): ${missingKeys.join(', ')}. An incomplete release is never promotable.`,
    );
  }
  const extraKeys = presentKeys.filter((key) => !ARTIFACT_KEYS.includes(key));
  if (extraKeys.length > 0) {
    throw new ReleaseManifestError(
      `release-manifest.json declares unknown artifact key(s): ${extraKeys.join(', ')}.`,
    );
  }

  const checksums = parseChecksums(checksumsText);

  for (const key of ARTIFACT_KEYS) {
    const spec = RELEASE_ARTIFACT_SPECS[key];
    const entry = artifacts[key];
    const expectedFilename = spec.filenameFor(expectedVersion);
    if (entry?.filename !== expectedFilename) {
      throw new ReleaseManifestError(
        `release-manifest.json's ${key} names ${JSON.stringify(entry?.filename)}; expected ${expectedFilename}.`,
      );
    }
    if (entry.platform !== spec.platform || entry.arch !== spec.arch) {
      throw new ReleaseManifestError(
        `release-manifest.json's ${key} claims platform ${JSON.stringify(entry.platform)}/arch ${JSON.stringify(entry.arch)}; this release only ships ${spec.platform}/${spec.arch ?? 'any'}.`,
      );
    }
    if (!HEX_SHA256.test(String(entry.sha256 ?? ''))) {
      throw new ReleaseManifestError(
        `release-manifest.json's ${key} has an invalid sha256: ${JSON.stringify(entry.sha256)}.`,
      );
    }
    if (!Number.isInteger(entry.size) || entry.size <= 0) {
      throw new ReleaseManifestError(
        `release-manifest.json's ${key} declares size ${JSON.stringify(entry.size)}; a released artifact is never zero bytes.`,
      );
    }
    const checksum = checksums.get(expectedFilename);
    if (!checksum) {
      throw new ReleaseManifestError(
        `SHA256SUMS does not list ${expectedFilename}, so the manifest's claim about it is unverifiable.`,
      );
    }
    if (checksum !== entry.sha256) {
      throw new ReleaseManifestError(
        `${expectedFilename}: release-manifest.json says ${entry.sha256} but SHA256SUMS says ${checksum}. The published release is internally inconsistent.`,
      );
    }
    checksums.delete(expectedFilename);
  }

  const strays = [...checksums.keys()].sort();
  if (strays.length > 0) {
    throw new ReleaseManifestError(
      `SHA256SUMS lists file(s) the manifest does not declare: ${strays.join(', ')}.`,
    );
  }

  // Belt-and-braces truthfulness check across the whole serialized surface: no arm64 claim may appear
  // anywhere, not even in a field this validator does not otherwise inspect.
  const combined = `${manifestText}\n${checksumsText}`;
  if (/arm64/iu.test(combined)) {
    throw new ReleaseManifestError(
      'Published release metadata mentions arm64. Chantivo ships linux-x64 and windows-x64 only; an arm64 claim in a release is false advertising to every operator who reads it.',
    );
  }

  return manifest;
}

async function currentGitCommit() {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

/**
 * I/O entrypoint: hashes the real files in `dist-release/<version>/` and writes
 * `release-manifest.json` + `SHA256SUMS`. Any descriptor file already present is ignored as input and
 * overwritten as output, so re-running is safe and produces identical bytes.
 */
export async function buildManifest(
  version = undefined,
  { releaseDir = undefined, allowPartial = false } = {},
) {
  const resolvedVersion =
    version ??
    JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')).version;
  const dir = releaseDir ?? path.join(repositoryRoot, 'dist-release', resolvedVersion);
  const entries = await readdir(dir);

  const files = [];
  for (const filename of entries.sort()) {
    if (DESCRIPTOR_FILENAMES.includes(filename)) continue;
    const filePath = path.join(dir, filename);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      throw new ReleaseManifestError(
        `${filename} in ${dir} is not a regular file. A release directory contains only release files.`,
      );
    }
    files.push({ filename, sha256: await sha256File(filePath), size: fileStat.size });
  }

  const manifest = buildReleaseManifest({
    version: resolvedVersion,
    files,
    gitCommit: process.env.GITHUB_SHA || (await currentGitCommit()),
    allowPartial,
  });

  const checksumEntries = Object.values(manifest.artifacts).map((artifact) => ({
    filename: artifact.filename,
    sha256: artifact.sha256,
  }));

  // SHA256SUMS is written BEFORE release-manifest.json on purpose, mirroring the R2 publication order:
  // release-manifest.json is the completeness marker everywhere in this system, so it is always the
  // last thing to appear.
  await writeFile(path.join(dir, CHECKSUMS_FILENAME), renderChecksums(checksumEntries), 'utf8');
  await writeFile(path.join(dir, MANIFEST_FILENAME), serializeManifest(manifest), 'utf8');

  return manifest;
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  const args = process.argv.slice(2);
  const allowPartial = args.includes('--allow-partial');
  const versionArg = args.find((arg) => !arg.startsWith('--'));
  const manifest = await buildManifest(versionArg, { allowPartial });
  console.info(
    `Wrote ${MANIFEST_FILENAME} + ${CHECKSUMS_FILENAME} for ${Object.keys(manifest.artifacts).length} artifact(s) of ${manifest.version}${allowPartial ? ' (partial: local fixture only, never publishable)' : ''}`,
  );
}
