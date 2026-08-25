import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildManifest } from '../../scripts/release/build-manifest.mjs';
import { publishRelease } from '../../scripts/release/publish-release-to-r2.mjs';
import {
  IMMUTABLE_CACHE_CONTROL,
  releaseObjectKey,
} from '../../scripts/release/r2-publication-plan.mjs';
import { expectedReleaseFilenames } from '../../scripts/release/resolve-release-metadata.mjs';

/**
 * T15.1 — the PUBLISH phase end to end, against a real on-disk release candidate and a fake in-memory
 * object store. No credential, endpoint, account id, or bucket name in this file corresponds to
 * anything real, and nothing here can reach the network.
 */

const VERSION = '0.1.1';
const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

function createFakeBucket(initial = new Map()) {
  const objects = new Map(initial);
  const writes = [];
  return {
    objects,
    writes,
    async headObject(key) {
      const object = objects.get(key);
      return object
        ? { exists: true, sha256: object.sha256, size: object.size }
        : { exists: false };
    },
    async putObject({ key, bodyPath, cacheControl, contentType, sha256: hash }) {
      const body = await readFile(bodyPath);
      objects.set(key, { sha256: hash, size: body.length, cacheControl, contentType });
      writes.push({ key, cacheControl, contentType });
    },
    async getObject() {
      throw new Error('publishRelease must never download from the bucket.');
    },
  };
}

describe('publishRelease', () => {
  let releaseDir;

  beforeEach(async () => {
    releaseDir = await mkdtemp(path.join(tmpdir(), 'chantivo-publish-test-'));
    await writeFile(path.join(releaseDir, `ChantivoSetup-${VERSION}.exe`), 'MZ fake installer');
    await writeFile(
      path.join(releaseDir, `chantivo-dedicated-server-${VERSION}-linux-x64.tar.gz`),
      'fake tarball',
    );
    await writeFile(path.join(releaseDir, 'install-chantivo.sh'), '#!/usr/bin/env bash\nexit 0\n');
    await buildManifest(VERSION, { releaseDir });
  });

  afterEach(async () => {
    await rm(releaseDir, { recursive: true, force: true });
  });

  async function currentObjects() {
    const map = new Map();
    for (const filename of expectedReleaseFilenames(VERSION)) {
      const body = await readFile(path.join(releaseDir, filename));
      map.set(releaseObjectKey(VERSION, filename), { sha256: sha256(body), size: body.length });
    }
    return map;
  }

  it('publishes an unpublished version, manifest last, with immutable caching', async () => {
    const client = createFakeBucket();
    const result = await publishRelease({ version: VERSION, releaseDir, client, log: () => {} });

    expect(result.status).toBe('publish');
    expect(client.writes).toHaveLength(5);
    expect(client.writes.at(-1).key).toBe(releaseObjectKey(VERSION, 'release-manifest.json'));
    for (const write of client.writes) {
      expect(write.cacheControl).toBe(IMMUTABLE_CACHE_CONTROL);
      expect(write.key.startsWith(`releases/${VERSION}/`)).toBe(true);
    }
  });

  it('never writes the mutable pointers — publishing does not decide what new installs get', async () => {
    const client = createFakeBucket();
    await publishRelease({ version: VERSION, releaseDir, client, log: () => {} });
    const keys = client.writes.map((write) => write.key);
    expect(keys).not.toContain('channels/stable.json');
    expect(keys).not.toContain('installer/install-chantivo.sh');
  });

  it('is an idempotent no-op when the identical release is already published', async () => {
    const client = createFakeBucket(await currentObjects());
    const result = await publishRelease({ version: VERSION, releaseDir, client, log: () => {} });
    expect(result.status).toBe('idempotent');
    expect(client.writes).toHaveLength(0);
  });

  it('fails hard and writes nothing when a published object differs', async () => {
    const objects = await currentObjects();
    objects.set(releaseObjectKey(VERSION, `ChantivoSetup-${VERSION}.exe`), {
      sha256: 'f'.repeat(64),
      size: 17,
    });
    const client = createFakeBucket(objects);
    await expect(
      publishRelease({ version: VERSION, releaseDir, client, log: () => {} }),
    ).rejects.toThrow(/Refusing to overwrite published release 0\.1\.1/u);
    expect(client.writes).toHaveLength(0);
  });

  it('reconciles a partial publication by uploading only what is missing', async () => {
    const objects = await currentObjects();
    objects.delete(releaseObjectKey(VERSION, 'release-manifest.json'));
    const client = createFakeBucket(objects);
    const result = await publishRelease({ version: VERSION, releaseDir, client, log: () => {} });

    expect(result.status).toBe('reconcile');
    expect(client.writes.map((write) => write.key)).toEqual([
      releaseObjectKey(VERSION, 'release-manifest.json'),
    ]);
  });

  it('refuses to publish an incomplete candidate directory', async () => {
    await rm(path.join(releaseDir, `ChantivoSetup-${VERSION}.exe`));
    const client = createFakeBucket();
    await expect(
      publishRelease({ version: VERSION, releaseDir, client, log: () => {} }),
    ).rejects.toThrow(/missing required release file: ChantivoSetup-0\.1\.1\.exe/u);
    expect(client.writes).toHaveLength(0);
  });

  it('refuses a non-SemVer version outright', async () => {
    const client = createFakeBucket();
    await expect(
      publishRelease({ version: 'v0.1.1', releaseDir, client, log: () => {} }),
    ).rejects.toThrow(/not a plain MAJOR\.MINOR\.PATCH/u);
  });

  it('uploads nothing in dry-run mode', async () => {
    const client = createFakeBucket();
    const result = await publishRelease({
      version: VERSION,
      releaseDir,
      client,
      dryRun: true,
      log: () => {},
    });
    expect(result.uploaded).toHaveLength(5);
    expect(client.writes).toHaveLength(0);
  });
});
