import { describe, expect, it } from 'vitest';

import {
  CANONICAL_INSTALLER_KEY,
  IMMUTABLE_CACHE_CONTROL,
  POINTER_CACHE_CONTROL,
  STABLE_CHANNEL_KEY,
  completenessMarkerKey,
  contentTypeFor,
  planPublication,
  pointerObjectDescriptors,
  releaseObjectDescriptors,
  releaseObjectKey,
} from '../../scripts/release/r2-publication-plan.mjs';
import { expectedReleaseFilenames } from '../../scripts/release/resolve-release-metadata.mjs';

/**
 * T15.1 — the immutability rule, tested as real logic against fabricated object listings rather than
 * against a real bucket. All four states a publication attempt can find are covered: nothing
 * published, everything published and identical, something published and different, and a partial
 * previous publication.
 *
 * Every value here is fake. No production credential, endpoint, account id, or bucket name appears in
 * this file or in any other test in this repository.
 */

const VERSION = '0.1.1';
const hash = (seed) => seed.repeat(64).slice(0, 64);

const FILES = {
  [`ChantivoSetup-${VERSION}.exe`]: { sha256: hash('a1'), size: 91_000_000 },
  [`chantivo-dedicated-server-${VERSION}-linux-x64.tar.gz`]: {
    sha256: hash('b2'),
    size: 7_400_000,
  },
  'install-chantivo.sh': { sha256: hash('c3'), size: 80_385 },
  SHA256SUMS: { sha256: hash('d4'), size: 210 },
  'release-manifest.json': { sha256: hash('e5'), size: 900 },
};

const descriptors = () => releaseObjectDescriptors({ version: VERSION, files: FILES });

function remoteFrom(filenames, { mutate = () => ({}) } = {}) {
  const remote = new Map();
  for (const filename of filenames) {
    remote.set(releaseObjectKey(VERSION, filename), {
      exists: true,
      sha256: FILES[filename].sha256,
      size: FILES[filename].size,
      ...mutate(filename),
    });
  }
  return remote;
}

describe('releaseObjectDescriptors', () => {
  it('covers exactly the five release files under releases/<version>/', () => {
    const plan = descriptors();
    expect(plan.map((entry) => entry.filename).sort()).toEqual(
      [...expectedReleaseFilenames(VERSION)].sort(),
    );
    for (const entry of plan) {
      expect(entry.key).toBe(`releases/${VERSION}/${entry.filename}`);
    }
  });

  it('writes release-manifest.json last, as the completeness marker', () => {
    const plan = descriptors();
    expect(plan.at(-1).filename).toBe('release-manifest.json');
    expect(plan.at(-1).isCompletenessMarker).toBe(true);
    expect(plan.at(-2).filename).toBe('SHA256SUMS');
    expect(completenessMarkerKey(VERSION)).toBe(`releases/${VERSION}/release-manifest.json`);
    expect(plan.filter((entry) => entry.isCompletenessMarker)).toHaveLength(1);
  });

  it('marks every immutable release object with long-lived immutable caching', () => {
    for (const entry of descriptors()) {
      expect(entry.cacheControl).toBe(IMMUTABLE_CACHE_CONTROL);
      expect(entry.cacheControl).toMatch(/immutable/u);
      expect(entry.cacheControl).toMatch(/max-age=31536000/u);
    }
  });

  it('refuses to plan a partial upload when a local file is unaccounted for', () => {
    const incomplete = { ...FILES };
    delete incomplete['SHA256SUMS'];
    expect(() => releaseObjectDescriptors({ version: VERSION, files: incomplete })).toThrow(
      /refusing to plan a partial upload/u,
    );
  });
});

describe('content types', () => {
  it('labels each artifact truthfully', () => {
    expect(contentTypeFor(`ChantivoSetup-${VERSION}.exe`)).toBe('application/octet-stream');
    expect(contentTypeFor(`chantivo-dedicated-server-${VERSION}-linux-x64.tar.gz`)).toBe(
      'application/gzip',
    );
    expect(contentTypeFor('install-chantivo.sh')).toBe('text/x-shellscript');
    expect(contentTypeFor('release-manifest.json')).toBe('application/json');
    expect(contentTypeFor('SHA256SUMS')).toBe('text/plain');
  });
});

describe('planPublication — nothing published yet', () => {
  it('uploads everything', () => {
    const plan = planPublication({
      version: VERSION,
      descriptors: descriptors(),
      remote: new Map(),
    });
    expect(plan.status).toBe('publish');
    expect(plan.uploads).toHaveLength(5);
    expect(plan.identical).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
    expect(plan.completenessMarkerPresent).toBe(false);
    expect(plan.uploads.at(-1).isCompletenessMarker).toBe(true);
  });
});

describe('planPublication — already published, identical', () => {
  it('reports an idempotent no-op and uploads nothing', () => {
    const plan = planPublication({
      version: VERSION,
      descriptors: descriptors(),
      remote: remoteFrom(expectedReleaseFilenames(VERSION)),
    });
    expect(plan.status).toBe('idempotent');
    expect(plan.uploads).toHaveLength(0);
    expect(plan.identical).toHaveLength(5);
    expect(plan.summary).toMatch(/already published and byte-identical/u);
  });
});

describe('planPublication — already published, different', () => {
  it('hard-fails on a differing checksum rather than overwriting', () => {
    const remote = remoteFrom(expectedReleaseFilenames(VERSION), {
      mutate: (filename) =>
        filename === `ChantivoSetup-${VERSION}.exe` ? { sha256: hash('ff') } : {},
    });
    const plan = planPublication({ version: VERSION, descriptors: descriptors(), remote });
    expect(plan.status).toBe('conflict');
    expect(plan.uploads).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0].key).toBe(`releases/${VERSION}/ChantivoSetup-${VERSION}.exe`);
    expect(plan.conflicts[0].reason).toMatch(/immutable — release a new version number instead/u);
  });

  it('treats an existing object with no recorded checksum as a conflict, not as "probably fine"', () => {
    const remote = remoteFrom(expectedReleaseFilenames(VERSION), {
      mutate: (filename) => (filename === 'SHA256SUMS' ? { sha256: undefined } : {}),
    });
    const plan = planPublication({ version: VERSION, descriptors: descriptors(), remote });
    expect(plan.status).toBe('conflict');
    expect(plan.conflicts[0].reason).toMatch(/cannot be proven identical/u);
  });

  it('treats a matching checksum with a contradictory size as a conflict', () => {
    const remote = remoteFrom(expectedReleaseFilenames(VERSION), {
      mutate: (filename) => (filename === 'install-chantivo.sh' ? { size: 1 } : {}),
    });
    const plan = planPublication({ version: VERSION, descriptors: descriptors(), remote });
    expect(plan.status).toBe('conflict');
    expect(plan.conflicts[0].reason).toMatch(/contradictory metadata/u);
  });

  it('reports every conflicting object, not just the first', () => {
    const remote = remoteFrom(expectedReleaseFilenames(VERSION), {
      mutate: (filename) =>
        filename.endsWith('.exe') || filename.endsWith('.sh') ? { sha256: hash('ff') } : {},
    });
    const plan = planPublication({ version: VERSION, descriptors: descriptors(), remote });
    expect(plan.conflicts).toHaveLength(2);
  });
});

describe('planPublication — partial previous publication', () => {
  it('reconciles by uploading only what is missing', () => {
    // The realistic interruption: artifacts landed, the completeness marker never did.
    const present = expectedReleaseFilenames(VERSION).filter(
      (name) => name !== 'release-manifest.json',
    );
    const plan = planPublication({
      version: VERSION,
      descriptors: descriptors(),
      remote: remoteFrom(present),
    });
    expect(plan.status).toBe('reconcile');
    expect(plan.identical).toHaveLength(4);
    expect(plan.uploads.map((entry) => entry.filename)).toEqual(['release-manifest.json']);
    expect(plan.completenessMarkerPresent).toBe(false);
    expect(plan.summary).toMatch(/PARTIALLY published/u);
    expect(plan.summary).toMatch(/completeness marker absent/u);
  });

  it('still refuses to overwrite a conflicting object while reconciling', () => {
    const present = expectedReleaseFilenames(VERSION).filter(
      (name) => name !== 'release-manifest.json',
    );
    const remote = remoteFrom(present, {
      mutate: (filename) => (filename === 'SHA256SUMS' ? { sha256: hash('ff') } : {}),
    });
    const plan = planPublication({ version: VERSION, descriptors: descriptors(), remote });
    expect(plan.status).toBe('conflict');
    // Nothing is offered for upload while a conflict stands — not even the genuinely-missing manifest,
    // whose absence is real. A conflicting release is not partially publishable.
    expect(plan.uploads).toHaveLength(0);
    expect(plan.blockedUploads.map((entry) => entry.filename)).toEqual(['release-manifest.json']);
  });

  it('reports a marker-present-but-artifact-missing state honestly', () => {
    const present = expectedReleaseFilenames(VERSION).filter(
      (name) => name !== `ChantivoSetup-${VERSION}.exe`,
    );
    const plan = planPublication({
      version: VERSION,
      descriptors: descriptors(),
      remote: remoteFrom(present),
    });
    expect(plan.status).toBe('reconcile');
    expect(plan.completenessMarkerPresent).toBe(true);
    expect(plan.uploads.map((entry) => entry.filename)).toEqual([`ChantivoSetup-${VERSION}.exe`]);
  });
});

describe('mutable pointer objects', () => {
  it('uses the documented keys and a no-cache policy', () => {
    expect(STABLE_CHANNEL_KEY).toBe('channels/stable.json');
    expect(CANONICAL_INSTALLER_KEY).toBe('installer/install-chantivo.sh');
    for (const descriptor of pointerObjectDescriptors()) {
      expect(descriptor.cacheControl).toBe(POINTER_CACHE_CONTROL);
      expect(descriptor.cacheControl).not.toMatch(/immutable/u);
    }
  });

  it('keeps pointer keys outside the immutable releases/ prefix', () => {
    for (const descriptor of pointerObjectDescriptors()) {
      expect(descriptor.key.startsWith('releases/')).toBe(false);
    }
  });
});
