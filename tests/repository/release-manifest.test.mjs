import { describe, expect, it } from 'vitest';

import {
  RELEASE_MANIFEST_SCHEMA_VERSION,
  ReleaseManifestError,
  artifactKeyForFilename,
  buildReleaseManifest,
  parseChecksums,
  renderChecksums,
  serializeManifest,
  validatePublishedRelease,
} from '../../scripts/release/build-manifest.mjs';

/**
 * T15.1 — a published `release-manifest.json` is a truth claim to every operator who verifies against
 * it. These tests pin the schema, the truthfulness of its platform/architecture fields (the T15
 * version emitted `platform: "unknown"` for anything its filename regex did not recognize — including
 * the Windows installer, whose canonical name contains no platform token at all), the
 * manifest/SHA256SUMS cross-consistency rules, and every rejection case, using deliberately broken
 * fixtures rather than only happy-path data.
 */

const VERSION = '0.1.1';
const WINDOWS = 'ChantivoSetup-0.1.1.exe';
const LINUX = 'chantivo-dedicated-server-0.1.1-linux-x64.tar.gz';
const INSTALLER = 'install-chantivo.sh';

const hash = (seed) => seed.repeat(64).slice(0, 64);
const SHA_WINDOWS = hash('a1');
const SHA_LINUX = hash('b2');
const SHA_INSTALLER = hash('c3');

function completeFiles(overrides = []) {
  const base = [
    { filename: WINDOWS, sha256: SHA_WINDOWS, size: 91_000_000 },
    { filename: LINUX, sha256: SHA_LINUX, size: 7_400_000 },
    { filename: INSTALLER, sha256: SHA_INSTALLER, size: 80_385 },
  ];
  return overrides.length > 0 ? overrides : base;
}

function completeManifest() {
  return buildReleaseManifest({
    version: VERSION,
    files: completeFiles(),
    gitCommit: 'a'.repeat(40),
  });
}

function completeChecksums() {
  return renderChecksums([
    { filename: WINDOWS, sha256: SHA_WINDOWS },
    { filename: LINUX, sha256: SHA_LINUX },
    { filename: INSTALLER, sha256: SHA_INSTALLER },
  ]);
}

describe('buildReleaseManifest', () => {
  it('produces the declared schema with truthful platform and architecture fields', () => {
    const manifest = completeManifest();
    expect(manifest.schemaVersion).toBe(RELEASE_MANIFEST_SCHEMA_VERSION);
    expect(manifest.version).toBe(VERSION);
    expect(Object.keys(manifest.artifacts)).toEqual([
      'linux-installer',
      'linux-server-x64',
      'windows-x64',
    ]);
    expect(manifest.artifacts['windows-x64']).toMatchObject({
      filename: WINDOWS,
      sha256: SHA_WINDOWS,
      size: 91_000_000,
      platform: 'windows',
      arch: 'x64',
    });
    expect(manifest.artifacts['linux-server-x64']).toMatchObject({
      platform: 'linux',
      arch: 'x64',
    });
  });

  it('never records an "unknown" platform for the Windows installer (T15 regression)', () => {
    // The canonical Windows filename carries no `-win-x64`/`-linux-x64` token, so T15's filename-regex
    // classifier fell through to "unknown". A published manifest may not contain a shrug.
    const manifest = completeManifest();
    for (const artifact of Object.values(manifest.artifacts)) {
      expect(artifact.platform).not.toBe('unknown');
      expect(artifact.kind).not.toBe('unknown');
    }
    expect(serializeManifest(manifest)).not.toMatch(/unknown/iu);
  });

  it('claims no arm64 anywhere', () => {
    expect(serializeManifest(completeManifest())).not.toMatch(/arm64/iu);
  });

  it('serializes deterministically', () => {
    expect(serializeManifest(completeManifest())).toBe(serializeManifest(completeManifest()));
    expect(serializeManifest(completeManifest()).endsWith('}\n')).toBe(true);
  });

  it.each([
    ['windows', WINDOWS],
    ['linux server', LINUX],
    ['installer', INSTALLER],
  ])('rejects a release missing the %s artifact', (_label, filename) => {
    const files = completeFiles().filter((file) => file.filename !== filename);
    expect(() => buildReleaseManifest({ version: VERSION, files })).toThrow(ReleaseManifestError);
  });

  it('allows a deliberately partial manifest only when explicitly asked', () => {
    // The local Linux-only fixture workflow (infrastructure/install/README.md). Opt-in, and harmless:
    // the release pipeline never passes this, and both the candidate completeness check and
    // validatePublishedRelease independently require the full artifact set.
    const files = completeFiles().filter((file) => file.filename !== WINDOWS);
    const manifest = buildReleaseManifest({ version: VERSION, files, allowPartial: true });
    expect(Object.keys(manifest.artifacts)).toEqual(['linux-installer', 'linux-server-x64']);
    // ...and such a manifest is still not promotable.
    expect(() =>
      validatePublishedRelease({
        expectedVersion: VERSION,
        manifestText: serializeManifest(manifest),
        checksumsText: completeChecksums(),
      }),
    ).toThrow(/missing artifact\(s\): windows-x64/u);
  });

  it('still rejects an unexpected extra file even when partial is allowed', () => {
    const files = [...completeFiles(), { filename: 'notes.txt', sha256: hash('d4'), size: 12 }];
    expect(() => buildReleaseManifest({ version: VERSION, files, allowPartial: true })).toThrow(
      /not part of a Chantivo release/u,
    );
  });

  it('rejects an unexpected extra file', () => {
    const files = [...completeFiles(), { filename: 'notes.txt', sha256: hash('d4'), size: 12 }];
    expect(() => buildReleaseManifest({ version: VERSION, files })).toThrow(
      /not part of a Chantivo release/u,
    );
  });

  it('rejects a zero-byte artifact', () => {
    const files = completeFiles().map((file) =>
      file.filename === WINDOWS ? { ...file, size: 0 } : file,
    );
    expect(() => buildReleaseManifest({ version: VERSION, files })).toThrow(
      /never a valid release/u,
    );
  });

  it('rejects a malformed checksum', () => {
    const files = completeFiles().map((file) =>
      file.filename === LINUX ? { ...file, sha256: 'NOTAHASH' } : file,
    );
    expect(() => buildReleaseManifest({ version: VERSION, files })).toThrow(/64 lowercase hex/u);
  });

  it('rejects a non-SemVer version', () => {
    expect(() => buildReleaseManifest({ version: 'v0.1.1', files: completeFiles() })).toThrow(
      ReleaseManifestError,
    );
  });
});

describe('artifactKeyForFilename', () => {
  it('maps exact filenames only', () => {
    expect(artifactKeyForFilename(VERSION, WINDOWS)).toBe('windows-x64');
    expect(artifactKeyForFilename(VERSION, LINUX)).toBe('linux-server-x64');
    expect(artifactKeyForFilename(VERSION, INSTALLER)).toBe('linux-installer');
    // A near-miss from a previous release must not fuzzy-match into this one.
    expect(artifactKeyForFilename(VERSION, 'ChantivoSetup-0.1.0.exe')).toBeUndefined();
    expect(
      artifactKeyForFilename(VERSION, 'chantivo-dedicated-server-0.1.1-linux-arm64.tar.gz'),
    ).toBeUndefined();
  });
});

describe('SHA256SUMS rendering and parsing', () => {
  it('renders sha256sum-compatible, filename-sorted lines', () => {
    // Exactly `<64 hex><two spaces><filename>` — the format `sha256sum -c` consumes verbatim — sorted
    // by filename so the file is byte-stable across runs.
    expect(completeChecksums()).toBe(
      `${SHA_WINDOWS}  ${WINDOWS}\n` +
        `${SHA_LINUX}  ${LINUX}\n` +
        `${SHA_INSTALLER}  ${INSTALLER}\n`,
    );
  });

  it('round-trips through parseChecksums', () => {
    const parsed = parseChecksums(completeChecksums());
    expect(parsed.get(WINDOWS)).toBe(SHA_WINDOWS);
    expect(parsed.size).toBe(3);
  });

  it('rejects a malformed line rather than silently skipping it', () => {
    expect(() => parseChecksums(`${SHA_WINDOWS} ${WINDOWS}\n`)).toThrow(
      /Malformed SHA256SUMS line/u,
    );
    expect(() => parseChecksums('garbage\n')).toThrow(ReleaseManifestError);
  });

  it('rejects duplicate entries', () => {
    expect(() => parseChecksums(`${SHA_WINDOWS}  ${WINDOWS}\n${SHA_LINUX}  ${WINDOWS}\n`)).toThrow(
      /Duplicate SHA256SUMS entry/u,
    );
  });
});

describe('validatePublishedRelease', () => {
  it('accepts a complete, self-consistent release', () => {
    const manifest = validatePublishedRelease({
      expectedVersion: VERSION,
      manifestText: serializeManifest(completeManifest()),
      checksumsText: completeChecksums(),
    });
    expect(manifest.version).toBe(VERSION);
  });

  it('rejects a manifest for a different version', () => {
    expect(() =>
      validatePublishedRelease({
        expectedVersion: '0.1.2',
        manifestText: serializeManifest(completeManifest()),
        checksumsText: completeChecksums(),
      }),
    ).toThrow(/declares version "0\.1\.1" but 0\.1\.2 was requested/u);
  });

  it('rejects an unknown schemaVersion instead of guessing', () => {
    const broken = { ...completeManifest(), schemaVersion: 99 };
    expect(() =>
      validatePublishedRelease({
        expectedVersion: VERSION,
        manifestText: serializeManifest(broken),
        checksumsText: completeChecksums(),
      }),
    ).toThrow(/only understands 1/u);
  });

  it('rejects invalid JSON', () => {
    expect(() =>
      validatePublishedRelease({
        expectedVersion: VERSION,
        manifestText: '{ not json',
        checksumsText: completeChecksums(),
      }),
    ).toThrow(/not valid JSON/u);
  });

  it('rejects a manifest missing an artifact', () => {
    const broken = completeManifest();
    delete broken.artifacts['windows-x64'];
    expect(() =>
      validatePublishedRelease({
        expectedVersion: VERSION,
        manifestText: serializeManifest(broken),
        checksumsText: completeChecksums(),
      }),
    ).toThrow(/missing artifact\(s\): windows-x64/u);
  });

  it('rejects a checksum that disagrees with the manifest', () => {
    const checksums = renderChecksums([
      { filename: WINDOWS, sha256: hash('ff') },
      { filename: LINUX, sha256: SHA_LINUX },
      { filename: INSTALLER, sha256: SHA_INSTALLER },
    ]);
    expect(() =>
      validatePublishedRelease({
        expectedVersion: VERSION,
        manifestText: serializeManifest(completeManifest()),
        checksumsText: checksums,
      }),
    ).toThrow(/internally inconsistent/u);
  });

  it('rejects a manifest entry SHA256SUMS does not cover', () => {
    const checksums = renderChecksums([
      { filename: LINUX, sha256: SHA_LINUX },
      { filename: INSTALLER, sha256: SHA_INSTALLER },
    ]);
    expect(() =>
      validatePublishedRelease({
        expectedVersion: VERSION,
        manifestText: serializeManifest(completeManifest()),
        checksumsText: checksums,
      }),
    ).toThrow(/does not list ChantivoSetup-0\.1\.1\.exe/u);
  });

  it('rejects a stray SHA256SUMS entry the manifest does not declare', () => {
    const checksums = `${completeChecksums()}${hash('ee')}  extra-thing.bin\n`;
    expect(() =>
      validatePublishedRelease({
        expectedVersion: VERSION,
        manifestText: serializeManifest(completeManifest()),
        checksumsText: checksums,
      }),
    ).toThrow(/lists file\(s\) the manifest does not declare: extra-thing\.bin/u);
  });

  it('rejects an untruthful architecture claim', () => {
    const broken = completeManifest();
    broken.artifacts['linux-server-x64'].arch = 'arm64';
    expect(() =>
      validatePublishedRelease({
        expectedVersion: VERSION,
        manifestText: serializeManifest(broken),
        checksumsText: completeChecksums(),
      }),
    ).toThrow(/only ships linux\/x64/u);
  });

  it('rejects an arm64 mention anywhere in the published metadata', () => {
    const checksums = `${completeChecksums()}`.replace(INSTALLER, 'install-chantivo-arm64.sh');
    expect(() =>
      validatePublishedRelease({
        expectedVersion: VERSION,
        manifestText: serializeManifest(completeManifest()),
        checksumsText: checksums,
      }),
    ).toThrow(ReleaseManifestError);
  });
});
