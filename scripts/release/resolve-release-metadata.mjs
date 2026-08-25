import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * T15.1 — the ONE place that knows how a Chantivo release version maps to a git tag, a release
 * directory, and the exact filename of every artifact in it. Every other consumer (the release
 * workflow, the promote workflow, the completeness check, the manifest builder, the R2 publisher,
 * and their tests) imports from here rather than re-deriving `v${version}` or
 * `ChantivoSetup-${version}.exe` in a shell fragment inside YAML — a duplicated filename rule that
 * drifts by one character is exactly how a release publishes an artifact nothing can find.
 *
 * It is also the fail-fast trigger gate: `resolveReleaseMetadata()` refuses to produce metadata at
 * all when the trigger that asked for it disagrees with the repository's own version, so a
 * mismatched tag/dispatch is rejected before any expensive build step runs, not after.
 */

/** Matches `scripts/bump-version.mjs`'s deliberately plain MAJOR.MINOR.PATCH rule — no pre-release or
 * build-metadata suffix support anywhere in this repo's release surface yet (ADR 0025). Kept as its
 * own constant here rather than imported so this module has no dependency on the bump tool; the two
 * are held together by `tests/repository/release-metadata.test.mjs`, which asserts they agree. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/u;

export const RELEASE_ARTIFACT_KEYS = Object.freeze([
  'windows-x64',
  'linux-server-x64',
  'linux-installer',
]);

/** The installer script is the one release artifact that is copied out of this repository rather than
 * produced by a build; its name never carries a version, because the canonical bootstrap copy at
 * `installer/install-chantivo.sh` in the bucket must keep a stable, linkable URL. */
export const INSTALLER_FILENAME = 'install-chantivo.sh';

export const MANIFEST_FILENAME = 'release-manifest.json';
export const CHECKSUMS_FILENAME = 'SHA256SUMS';

export function isValidReleaseVersion(candidate) {
  return typeof candidate === 'string' && SEMVER_PATTERN.test(candidate);
}

export function windowsInstallerFilename(version) {
  return `ChantivoSetup-${version}.exe`;
}

export function linuxServerFilename(version) {
  return `chantivo-dedicated-server-${version}-linux-x64.tar.gz`;
}

export function releaseTagFor(version) {
  return `v${version}`;
}

/** Every file a complete `dist-release/<version>/` must contain — exactly these, nothing else. Order
 * is deliberate and stable so callers can compare serialized lists directly. */
export function expectedReleaseFilenames(version) {
  return [
    windowsInstallerFilename(version),
    linuxServerFilename(version),
    INSTALLER_FILENAME,
    MANIFEST_FILENAME,
    CHECKSUMS_FILENAME,
  ];
}

/** The three files that carry a checksum in SHA256SUMS. `release-manifest.json` and `SHA256SUMS`
 * describe the release and so cannot describe themselves. */
export function checksummedReleaseFilenames(version) {
  return [windowsInstallerFilename(version), linuxServerFilename(version), INSTALLER_FILENAME];
}

export async function readRootPackageVersion() {
  const content = await readFile(path.join(repositoryRoot, 'package.json'), 'utf8');
  return JSON.parse(content).version;
}

export class ReleaseMetadataError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReleaseMetadataError';
  }
}

/**
 * Pure trigger validation + metadata derivation. Kept free of any filesystem or network access so the
 * workflow, the promote workflow, and the tests all exercise the identical function against the
 * identical inputs.
 *
 * @param {object} input
 * @param {string} input.packageVersion  root package.json's version (the single source of truth).
 * @param {'push'|'workflow_dispatch'|string} input.eventName  GitHub `github.event_name`.
 * @param {string} [input.ref]  GitHub `github.ref` (e.g. `refs/tags/v0.1.1`, `refs/heads/main`).
 * @param {string} [input.inputVersion]  the `version` workflow_dispatch input, when present.
 * @param {boolean} [input.publishRequested]  the `publish` workflow_dispatch input, when present.
 */
export function resolveReleaseMetadata({
  packageVersion,
  eventName,
  ref = '',
  inputVersion = '',
  publishRequested = false,
} = {}) {
  if (typeof packageVersion !== 'string' || packageVersion.length === 0) {
    throw new ReleaseMetadataError('Root package.json has no version field to release.');
  }
  // A package version that literally starts with `v` would make the tag `vv0.1.1` and every artifact
  // filename wrong in a way no later step could detect — reject it with its own message rather than
  // letting the generic SemVer failure below hide the real cause.
  if (packageVersion.startsWith('v')) {
    throw new ReleaseMetadataError(
      `Root package.json version "${packageVersion}" starts with "v". The version field holds a bare SemVer value (0.1.1); only the git tag carries the "v" prefix.`,
    );
  }
  if (!isValidReleaseVersion(packageVersion)) {
    throw new ReleaseMetadataError(
      `Root package.json version "${packageVersion}" is not a plain MAJOR.MINOR.PATCH SemVer value.`,
    );
  }

  const version = packageVersion;
  const tag = releaseTagFor(version);
  const expectedTagRef = `refs/tags/${tag}`;

  if (eventName === 'push') {
    if (!ref.startsWith('refs/tags/')) {
      throw new ReleaseMetadataError(
        `Release builds only run for tag pushes; got ref "${ref}". Push a "${tag}" tag instead.`,
      );
    }
    if (ref !== expectedTagRef) {
      throw new ReleaseMetadataError(
        `Tag "${ref.slice('refs/tags/'.length)}" does not match root package.json version ${version} (expected tag "${tag}"). Bump the version with scripts/bump-version.mjs and re-tag; never publish a tag whose name disagrees with the version inside the artifacts.`,
      );
    }
  } else if (eventName === 'workflow_dispatch') {
    if (!isValidReleaseVersion(inputVersion)) {
      throw new ReleaseMetadataError(
        `workflow_dispatch input version "${inputVersion}" is not a plain MAJOR.MINOR.PATCH SemVer value.`,
      );
    }
    if (inputVersion !== version) {
      throw new ReleaseMetadataError(
        `workflow_dispatch requested version ${inputVersion} but this checkout's root package.json is ${version}. Re-run from the ref that actually carries ${inputVersion}.`,
      );
    }
    // The ref check is what separates "a commit that happens to have the right package.json" from
    // "the immutable tag a human deliberately re-ran this workflow against." Only enforced when a
    // publication was actually requested: a dispatch with publish=false is a candidate rebuild and
    // may legitimately run from a branch.
    if (publishRequested && ref !== expectedTagRef) {
      throw new ReleaseMetadataError(
        `Publishing ${version} requires running this workflow from "${expectedTagRef}", but it was started from "${ref}". Re-run it with ref=${tag} so the published bytes are provably the tagged commit's.`,
      );
    }
  } else {
    throw new ReleaseMetadataError(
      `Unsupported release trigger "${eventName}" (expected "push" or "workflow_dispatch").`,
    );
  }

  return {
    version,
    tag,
    expectedTagRef,
    releaseDir: `dist-release/${version}`,
    artifactBundleName: `chantivo-release-${version}`,
    windowsFilename: windowsInstallerFilename(version),
    linuxServerFilename: linuxServerFilename(version),
    installerFilename: INSTALLER_FILENAME,
    manifestFilename: MANIFEST_FILENAME,
    checksumsFilename: CHECKSUMS_FILENAME,
    expectedFilenames: expectedReleaseFilenames(version),
    checksummedFilenames: checksummedReleaseFilenames(version),
    /** R2 key prefix for the immutable release. Never includes a bucket name or an endpoint — those
     * come from the operator-configured GitHub variable/secret at the point of use. */
    releaseKeyPrefix: `releases/${version}`,
    publishRequested: eventName === 'workflow_dispatch' && publishRequested === true,
  };
}

/** GitHub Actions step-output serialization. Kept next to the resolver so the key names the workflow
 * consumes are defined exactly once. */
export function toGithubOutputLines(metadata) {
  return [
    `version=${metadata.version}`,
    `tag=${metadata.tag}`,
    `release_dir=${metadata.releaseDir}`,
    `artifact_bundle=${metadata.artifactBundleName}`,
    `windows_filename=${metadata.windowsFilename}`,
    `linux_filename=${metadata.linuxServerFilename}`,
    `installer_filename=${metadata.installerFilename}`,
    `release_key_prefix=${metadata.releaseKeyPrefix}`,
  ];
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  const metadata = resolveReleaseMetadata({
    packageVersion: await readRootPackageVersion(),
    eventName: process.env.GITHUB_EVENT_NAME ?? '',
    ref: process.env.GITHUB_REF ?? '',
    inputVersion: process.env.RELEASE_INPUT_VERSION ?? '',
    publishRequested: process.env.RELEASE_INPUT_PUBLISH === 'true',
  });

  const lines = toGithubOutputLines(metadata);
  if (process.env.GITHUB_OUTPUT) {
    const { appendFile } = await import('node:fs/promises');
    await appendFile(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`, 'utf8');
  }
  console.info(`Release metadata resolved:\n${lines.map((line) => `  ${line}`).join('\n')}`);
}
