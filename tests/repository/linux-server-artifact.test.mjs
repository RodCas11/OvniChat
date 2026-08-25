import { describe, expect, it } from 'vitest';

import { buildDedicatedServerArtifact } from '../../scripts/release/build-dedicated-server-artifact.mjs';
import { findArchiveContentViolations } from '../../scripts/release/verify-linux-server-artifact.mjs';

/**
 * T15.1 — "the build command exited 0" and "the archive contains a runnable Dedicated Server of the
 * right version, for the only architecture this project actually supports" are different claims.
 * These tests pin the second one against fabricated `tar -tzf` listings, so every rejection path is
 * covered without building a real tarball on every run.
 */

const VERSION = '0.1.1';
const VALID_ENTRIES = [
  'chantivo-dedicated-server/',
  'chantivo-dedicated-server/package.json',
  'chantivo-dedicated-server/dist/cli.js',
  'chantivo-dedicated-server/dist/index.js',
  'chantivo-dedicated-server/node_modules/ws/package.json',
];

describe('buildDedicatedServerArtifact target guard', () => {
  it.each([
    ['linux', 'arm64'],
    ['linux', 'ia32'],
    ['darwin', 'x64'],
  ])('refuses to name a %s-%s artifact before running any build', async (platform, arch) => {
    // Rejected before the first `pnpm` invocation, so this never actually builds anything. The
    // architecture in the filename is a claim every operator's installer resolves a download URL
    // from; it may only name something this project has really built and run.
    await expect(buildDedicatedServerArtifact({ platform, arch })).rejects.toThrow(
      /Chantivo ships linux-x64 only/u,
    );
  });
});

describe('findArchiveContentViolations', () => {
  it('accepts a well-formed Dedicated Server archive', () => {
    expect(findArchiveContentViolations({ version: VERSION, entries: VALID_ENTRIES })).toEqual([]);
  });

  it('tolerates a ./-prefixed listing', () => {
    const prefixed = VALID_ENTRIES.map((entry) => `./${entry}`);
    expect(findArchiveContentViolations({ version: VERSION, entries: prefixed })).toEqual([]);
  });

  it('rejects an archive with no single top-level directory', () => {
    const violations = findArchiveContentViolations({
      version: VERSION,
      entries: ['dist/cli.js', 'package.json'],
    });
    expect(violations.join('\n')).toMatch(/exactly one top-level directory/u);
  });

  it('rejects an archive missing the CLI entrypoint', () => {
    const violations = findArchiveContentViolations({
      version: VERSION,
      entries: VALID_ENTRIES.filter((entry) => !entry.endsWith('dist/cli.js')),
    });
    expect(violations).toContain('archive is missing chantivo-dedicated-server/dist/cli.js');
  });

  it('rejects an archive missing its package.json', () => {
    const violations = findArchiveContentViolations({
      version: VERSION,
      entries: VALID_ENTRIES.filter(
        (entry) => !entry.endsWith('/package.json') || entry.includes('node_modules'),
      ),
    });
    expect(violations).toContain('archive is missing chantivo-dedicated-server/package.json');
  });

  it('rejects an absolute path that could write outside the extraction directory', () => {
    const violations = findArchiveContentViolations({
      version: VERSION,
      entries: [...VALID_ENTRIES, '/etc/systemd/system/evil.service'],
    });
    expect(violations.join('\n')).toMatch(/absolute or parent-traversing paths/u);
  });

  it('rejects a parent-traversing path', () => {
    const violations = findArchiveContentViolations({
      version: VERSION,
      entries: [...VALID_ENTRIES, 'chantivo-dedicated-server/../../escape.sh'],
    });
    expect(violations.join('\n')).toMatch(/absolute or parent-traversing paths/u);
  });

  it('rejects an arm64 payload, the architecture this release does not ship', () => {
    const violations = findArchiveContentViolations({
      version: VERSION,
      entries: [
        ...VALID_ENTRIES,
        'chantivo-dedicated-server/node_modules/native/linux-arm64/binding.node',
      ],
    });
    expect(violations.join('\n')).toMatch(/this release ships linux-x64 only/u);
  });

  it('rejects a non-SemVer version', () => {
    expect(
      findArchiveContentViolations({ version: 'v0.1.1', entries: VALID_ENTRIES }).join('\n'),
    ).toMatch(/not a plain MAJOR\.MINOR\.PATCH/u);
  });

  it('rejects an empty archive', () => {
    const violations = findArchiveContentViolations({ version: VERSION, entries: [] });
    expect(violations.join('\n')).toMatch(/<empty archive>/u);
  });
});
