import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { isValidVersion } from '../../scripts/bump-version.mjs';
import { canonicalInstallerName } from '../../scripts/release/build-windows-artifact.mjs';
import {
  ReleaseMetadataError,
  checksummedReleaseFilenames,
  expectedReleaseFilenames,
  isValidReleaseVersion,
  linuxServerFilename,
  releaseTagFor,
  resolveReleaseMetadata,
  toGithubOutputLines,
  windowsInstallerFilename,
} from '../../scripts/release/resolve-release-metadata.mjs';

/**
 * T15.1 — the release-metadata resolver is the fail-fast gate every other release step depends on:
 * it decides whether a trigger is even allowed to produce a candidate, and it owns the only correct
 * spelling of every release filename. These tests pin both halves, including each rejection case
 * individually, because "the mismatch was rejected" and "the mismatch was rejected for the RIGHT
 * reason" are different guarantees when the failure mode is publishing the wrong bytes under the
 * right name.
 */

const repositoryRoot = process.cwd();

function readVersion(relativePath) {
  return JSON.parse(readFileSync(path.join(repositoryRoot, relativePath), 'utf8')).version;
}

describe('release version consistency', () => {
  it('keeps root, desktop, and dedicated-server package versions identical', () => {
    const root = readVersion('package.json');
    expect(isValidReleaseVersion(root)).toBe(true);
    expect(readVersion('apps/desktop/package.json')).toBe(root);
    expect(readVersion('services/dedicated-server/package.json')).toBe(root);
  });

  it('agrees with scripts/bump-version.mjs about what a valid version is', () => {
    for (const candidate of ['0.1.1', '1.0.0', '10.20.30', '0.1', 'v0.1.1', '0.1.0-beta', '']) {
      expect(isValidReleaseVersion(candidate)).toBe(isValidVersion(candidate));
    }
  });
});

describe('release filenames', () => {
  it('derives the canonical artifact names for a version', () => {
    expect(windowsInstallerFilename('0.1.1')).toBe('ChantivoSetup-0.1.1.exe');
    expect(linuxServerFilename('0.1.1')).toBe('chantivo-dedicated-server-0.1.1-linux-x64.tar.gz');
    expect(releaseTagFor('0.1.1')).toBe('v0.1.1');
  });

  it('agrees with the Windows build script about the installer filename', () => {
    // Two scripts, one filename rule. If either side is edited alone, the installer this pipeline
    // uploads would not be the one the assemble step looks for.
    for (const version of ['0.1.1', '1.2.3', '10.20.30']) {
      expect(canonicalInstallerName(version)).toBe(windowsInstallerFilename(version));
    }
  });

  it('expects exactly five files in a release directory', () => {
    expect(expectedReleaseFilenames('0.1.1')).toEqual([
      'ChantivoSetup-0.1.1.exe',
      'chantivo-dedicated-server-0.1.1-linux-x64.tar.gz',
      'install-chantivo.sh',
      'release-manifest.json',
      'SHA256SUMS',
    ]);
  });

  it('checksums the three real artifacts, never the descriptors that describe them', () => {
    const checksummed = checksummedReleaseFilenames('0.1.1');
    expect(checksummed).toHaveLength(3);
    expect(checksummed).not.toContain('SHA256SUMS');
    expect(checksummed).not.toContain('release-manifest.json');
  });

  it('never names an arm64 artifact', () => {
    expect(expectedReleaseFilenames('0.1.1').join(' ')).not.toMatch(/arm64/iu);
  });
});

describe('resolveReleaseMetadata — tag push', () => {
  it('accepts a tag that matches the package version', () => {
    const metadata = resolveReleaseMetadata({
      packageVersion: '0.1.1',
      eventName: 'push',
      ref: 'refs/tags/v0.1.1',
    });
    expect(metadata.version).toBe('0.1.1');
    expect(metadata.tag).toBe('v0.1.1');
    expect(metadata.releaseDir).toBe('dist-release/0.1.1');
    expect(metadata.artifactBundleName).toBe('chantivo-release-0.1.1');
    expect(metadata.releaseKeyPrefix).toBe('releases/0.1.1');
    expect(metadata.publishRequested).toBe(false);
  });

  it('rejects a tag ahead of the package version', () => {
    expect(() =>
      resolveReleaseMetadata({
        packageVersion: '0.1.1',
        eventName: 'push',
        ref: 'refs/tags/v0.1.2',
      }),
    ).toThrow(/does not match root package.json version 0\.1\.1/u);
  });

  it('rejects a tag behind the package version', () => {
    expect(() =>
      resolveReleaseMetadata({
        packageVersion: '0.1.1',
        eventName: 'push',
        ref: 'refs/tags/v0.1.0',
      }),
    ).toThrow(/expected tag "v0\.1\.1"/u);
  });

  it('rejects a branch ref', () => {
    expect(() =>
      resolveReleaseMetadata({
        packageVersion: '0.1.1',
        eventName: 'push',
        ref: 'refs/heads/main',
      }),
    ).toThrow(/only run for tag pushes/u);
  });
});

describe('resolveReleaseMetadata — workflow_dispatch', () => {
  it('accepts a matching version for a build-only dispatch from a branch', () => {
    const metadata = resolveReleaseMetadata({
      packageVersion: '0.1.1',
      eventName: 'workflow_dispatch',
      ref: 'refs/heads/main',
      inputVersion: '0.1.1',
      publishRequested: false,
    });
    expect(metadata.publishRequested).toBe(false);
  });

  it('rejects a requested version the checkout does not carry', () => {
    expect(() =>
      resolveReleaseMetadata({
        packageVersion: '0.1.0',
        eventName: 'workflow_dispatch',
        ref: 'refs/tags/v0.1.1',
        inputVersion: '0.1.1',
      }),
    ).toThrow(/requested version 0\.1\.1 but this checkout's root package\.json is 0\.1\.0/u);
  });

  it('rejects a non-SemVer version input', () => {
    for (const inputVersion of ['v0.1.1', 'latest', '0.1', '']) {
      expect(() =>
        resolveReleaseMetadata({
          packageVersion: '0.1.1',
          eventName: 'workflow_dispatch',
          ref: 'refs/tags/v0.1.1',
          inputVersion,
        }),
      ).toThrow(ReleaseMetadataError);
    }
  });

  it('requires the exact matching tag ref before publishing', () => {
    expect(() =>
      resolveReleaseMetadata({
        packageVersion: '0.1.1',
        eventName: 'workflow_dispatch',
        ref: 'refs/heads/main',
        inputVersion: '0.1.1',
        publishRequested: true,
      }),
    ).toThrow(/requires running this workflow from "refs\/tags\/v0\.1\.1"/u);
  });

  it('rejects publishing from a different tag that happens to carry the right package version', () => {
    expect(() =>
      resolveReleaseMetadata({
        packageVersion: '0.1.1',
        eventName: 'workflow_dispatch',
        ref: 'refs/tags/v0.1.1-rc',
        inputVersion: '0.1.1',
        publishRequested: true,
      }),
    ).toThrow(/but it was started from "refs\/tags\/v0\.1\.1-rc"/u);
  });

  it('marks publish as requested only when it was explicitly asked for from the right ref', () => {
    const publishing = resolveReleaseMetadata({
      packageVersion: '0.1.1',
      eventName: 'workflow_dispatch',
      ref: 'refs/tags/v0.1.1',
      inputVersion: '0.1.1',
      publishRequested: true,
    });
    expect(publishing.publishRequested).toBe(true);

    const notPublishing = resolveReleaseMetadata({
      packageVersion: '0.1.1',
      eventName: 'workflow_dispatch',
      ref: 'refs/tags/v0.1.1',
      inputVersion: '0.1.1',
      publishRequested: false,
    });
    expect(notPublishing.publishRequested).toBe(false);
  });
});

describe('resolveReleaseMetadata — malformed package versions', () => {
  it('rejects a package version with an accidental leading v', () => {
    expect(() =>
      resolveReleaseMetadata({
        packageVersion: 'v0.1.1',
        eventName: 'push',
        ref: 'refs/tags/vv0.1.1',
      }),
    ).toThrow(/starts with "v"/u);
  });

  it('rejects a non-SemVer package version', () => {
    expect(() =>
      resolveReleaseMetadata({ packageVersion: '0.1', eventName: 'push', ref: 'refs/tags/v0.1' }),
    ).toThrow(/not a plain MAJOR\.MINOR\.PATCH/u);
  });

  it('rejects an unsupported trigger', () => {
    expect(() =>
      resolveReleaseMetadata({ packageVersion: '0.1.1', eventName: 'schedule' }),
    ).toThrow(/Unsupported release trigger/u);
  });
});

describe('toGithubOutputLines', () => {
  it('emits every key the workflow consumes, with no newline injection', () => {
    const lines = toGithubOutputLines(
      resolveReleaseMetadata({
        packageVersion: '0.1.1',
        eventName: 'push',
        ref: 'refs/tags/v0.1.1',
      }),
    );
    expect(lines).toContain('version=0.1.1');
    expect(lines).toContain('windows_filename=ChantivoSetup-0.1.1.exe');
    expect(lines).toContain('release_key_prefix=releases/0.1.1');
    for (const line of lines) {
      expect(line).not.toMatch(/[\r\n]/u);
    }
  });
});
