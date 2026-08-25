import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildManifest } from '../../scripts/release/build-manifest.mjs';
import { expectedReleaseFilenames } from '../../scripts/release/resolve-release-metadata.mjs';
import {
  ReleaseDirectoryError,
  findReleaseDirectoryViolations,
  verifyReleaseDirectory,
} from '../../scripts/release/verify-release-directory.mjs';

/**
 * T15.1 — the structural gate for T15's real release bug: Electron Forge genuinely produced a
 * `Setup.exe`, the build reported success, and the file was simply not in `dist-release/<version>/`
 * when the release was assembled, because nothing in the pipeline was looking.
 *
 * Every failure mode is tested individually — each of the five files missing on its own, an extra
 * file, a zero-byte file, a near-miss filename from another version, and an arm64-named artifact —
 * because a completeness check that only catches "everything is missing" would not have caught the
 * bug it exists for.
 */

const VERSION = '0.1.1';
const EXPECTED = expectedReleaseFilenames(VERSION);

function listing(overrides = {}) {
  const { drop = [], add = [], zero = [] } = overrides;
  return EXPECTED.filter((name) => !drop.includes(name))
    .map((name) => ({ name, size: zero.includes(name) ? 0 : 1024, isFile: true }))
    .concat(add.map((name) => ({ name, size: 1024, isFile: true })));
}

describe('findReleaseDirectoryViolations', () => {
  it('accepts exactly the five expected, non-empty files', () => {
    expect(findReleaseDirectoryViolations({ version: VERSION, entries: listing() })).toEqual([]);
  });

  it.each(EXPECTED)('fails when %s is missing', (missing) => {
    const violations = findReleaseDirectoryViolations({
      version: VERSION,
      entries: listing({ drop: [missing] }),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(`missing required release file: ${missing}`);
  });

  it('fails on an unexpected extra file', () => {
    const violations = findReleaseDirectoryViolations({
      version: VERSION,
      entries: listing({ add: ['RELEASE_NOTES.txt'] }),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('unexpected file in release directory: RELEASE_NOTES.txt');
  });

  it.each(EXPECTED)('fails when %s is zero bytes', (empty) => {
    const violations = findReleaseDirectoryViolations({
      version: VERSION,
      entries: listing({ zero: [empty] }),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('a build that failed quietly');
  });

  it('fails on a near-miss filename from a different version', () => {
    // The exact shape of the T15 bug's most dangerous variant: a file that LOOKS right is present, so
    // a loose check passes, while the file the release actually needs is absent.
    const violations = findReleaseDirectoryViolations({
      version: VERSION,
      entries: listing({ drop: ['ChantivoSetup-0.1.1.exe'], add: ['ChantivoSetup-0.1.0.exe'] }),
    });
    expect(violations).toHaveLength(2);
    expect(violations.join('\n')).toContain(
      'missing required release file: ChantivoSetup-0.1.1.exe',
    );
    expect(violations.join('\n')).toContain(
      'unexpected file in release directory: ChantivoSetup-0.1.0.exe',
    );
  });

  it('fails specifically and honestly on an arm64-named artifact', () => {
    const violations = findReleaseDirectoryViolations({
      version: VERSION,
      entries: listing({ add: ['chantivo-dedicated-server-0.1.1-linux-arm64.tar.gz'] }),
    });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('does not ship arm64');
  });

  it('fails when an expected entry is a directory rather than a file', () => {
    const entries = listing().map((entry) =>
      entry.name === 'SHA256SUMS' ? { ...entry, isFile: false } : entry,
    );
    expect(findReleaseDirectoryViolations({ version: VERSION, entries })).toEqual([
      'SHA256SUMS is not a regular file',
    ]);
  });

  it('refuses to verify a non-SemVer version', () => {
    expect(findReleaseDirectoryViolations({ version: 'v0.1.1', entries: listing() })).toEqual([
      '"v0.1.1" is not a plain MAJOR.MINOR.PATCH version; refusing to verify.',
    ]);
  });
});

describe('verifyReleaseDirectory against real files', () => {
  let releaseDir;

  beforeEach(async () => {
    releaseDir = await mkdtemp(path.join(tmpdir(), 'chantivo-release-test-'));
    await writeFile(
      path.join(releaseDir, `ChantivoSetup-${VERSION}.exe`),
      'MZ fake installer bytes',
    );
    await writeFile(
      path.join(releaseDir, `chantivo-dedicated-server-${VERSION}-linux-x64.tar.gz`),
      'fake tarball bytes',
    );
    await writeFile(path.join(releaseDir, 'install-chantivo.sh'), '#!/usr/bin/env bash\nexit 0\n');
  });

  afterEach(async () => {
    await rm(releaseDir, { recursive: true, force: true });
  });

  it('accepts a directory whose manifest and checksums describe the real bytes', async () => {
    await buildManifest(VERSION, { releaseDir });
    const manifest = await verifyReleaseDirectory({ version: VERSION, releaseDir });
    expect(manifest.version).toBe(VERSION);
    expect(Object.keys(manifest.artifacts)).toHaveLength(3);
  });

  it('detects a same-size artifact substitution the size check alone would miss', async () => {
    // The realistic tamper: identical byte count, different content. Only the re-hash catches it.
    await buildManifest(VERSION, { releaseDir });
    await writeFile(path.join(releaseDir, 'install-chantivo.sh'), '#!/usr/bin/env bash\nexit 1\n');
    await expect(verifyReleaseDirectory({ version: VERSION, releaseDir })).rejects.toThrow(
      /SHA-256 on disk .* does not match the manifest/u,
    );
  });

  it('detects an artifact whose size changed after the checksums were generated', async () => {
    await buildManifest(VERSION, { releaseDir });
    await writeFile(
      path.join(releaseDir, 'install-chantivo.sh'),
      '#!/usr/bin/env bash\nrm -rf /\n',
    );
    await expect(verifyReleaseDirectory({ version: VERSION, releaseDir })).rejects.toThrow(
      /manifest declares 27 bytes but the file on disk is 29/u,
    );
  });

  it('refuses a directory that never had a manifest generated', async () => {
    await expect(verifyReleaseDirectory({ version: VERSION, releaseDir })).rejects.toBeInstanceOf(
      ReleaseDirectoryError,
    );
  });

  it('refuses a missing directory outright', async () => {
    await expect(
      verifyReleaseDirectory({ version: VERSION, releaseDir: path.join(releaseDir, 'nope') }),
    ).rejects.toThrow(/not found or unreadable/u);
  });
});
