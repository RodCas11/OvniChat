import { describe, expect, it } from 'vitest';

import {
  STABLE_CHANNEL_SCHEMA_VERSION,
  StableChannelError,
  buildStableChannel,
  canonicalInstallerUrl,
  normalizePublicBaseUrl,
  serializeStableChannel,
  validateStableChannel,
} from '../../scripts/release/stable-channel.mjs';

/**
 * T15.1 — `channels/stable.json` is the one mutable pointer that decides what every new public
 * install downloads. These tests pin its schema, its normalization rules, and the values it must
 * refuse: a plaintext base URL, an embedded credential, and — specifically — Chantivo's own beta
 * Dedicated Server host, which is one operator's deployment and never a distribution point.
 */

const BASE = 'https://downloads.example.test';

describe('normalizePublicBaseUrl', () => {
  it('strips trailing slashes and keeps origin + path', () => {
    expect(normalizePublicBaseUrl(`${BASE}/`)).toBe(BASE);
    expect(normalizePublicBaseUrl(`${BASE}///`)).toBe(BASE);
    expect(normalizePublicBaseUrl(`  ${BASE}/dist/  `)).toBe(`${BASE}/dist`);
  });

  it.each([
    ['plaintext http', 'http://downloads.example.test'],
    ['embedded credentials', 'https://user:pass@downloads.example.test'],
    ['a query string', 'https://downloads.example.test?token=abc'],
    ['a fragment', 'https://downloads.example.test#frag'],
    ['a relative path', '/releases'],
    ['an empty value', '   '],
  ])('rejects %s', (_label, candidate) => {
    expect(() => normalizePublicBaseUrl(candidate)).toThrow(StableChannelError);
  });

  it('accepts the one Chantivo-operated host that actually serves releases', () => {
    expect(normalizePublicBaseUrl('https://downloads.chantivo.app/')).toBe(
      'https://downloads.chantivo.app',
    );
  });

  it('rejects every other Chantivo-operated host, including an operator deployment', () => {
    // A Dedicated Server host is one operator's deployment, not a distribution point; the apex/www
    // hosts are the website. None of them may become the download location baked into new installs.
    for (const candidate of [
      'https://beta.chantivo.app',
      'https://BETA.Chantivo.App/x',
      'https://chantivo.app',
      'https://www.chantivo.app/dl',
    ]) {
      expect(() => normalizePublicBaseUrl(candidate)).toThrow(StableChannelError);
    }
  });

  it("does not restrict an operator's own mirror domain", () => {
    expect(normalizePublicBaseUrl('https://mirror.internal.example/chantivo')).toBe(
      'https://mirror.internal.example/chantivo',
    );
  });
});

describe('buildStableChannel', () => {
  it('emits the declared schema', () => {
    const channel = buildStableChannel({ version: '0.1.1', publicBaseUrl: BASE });
    expect(channel).toEqual({
      schemaVersion: STABLE_CHANNEL_SCHEMA_VERSION,
      channel: 'stable',
      version: '0.1.1',
      releaseBaseUrl: `${BASE}/releases/0.1.1`,
      manifestUrl: `${BASE}/releases/0.1.1/release-manifest.json`,
    });
  });

  it('serializes deterministically with a stable key order', () => {
    const first = serializeStableChannel(
      buildStableChannel({ version: '0.1.1', publicBaseUrl: BASE }),
    );
    const second = serializeStableChannel(
      buildStableChannel({ version: '0.1.1', publicBaseUrl: BASE }),
    );
    expect(first).toBe(second);
    expect(Object.keys(JSON.parse(first))).toEqual([
      'schemaVersion',
      'channel',
      'version',
      'releaseBaseUrl',
      'manifestUrl',
    ]);
  });

  it("keeps the release version's own field first among the version-shaped keys, for the installer's scalar extractor", () => {
    // infrastructure/install/lib/fetch-verify.sh's read_manifest_version greps the FIRST
    // `"version": "..."` pair. `"schemaVersion"` must not be mistaken for it.
    const text = serializeStableChannel(
      buildStableChannel({ version: '0.1.1', publicBaseUrl: BASE }),
    );
    const match = /"version"\s*:\s*"([^"]*)"/u.exec(text);
    expect(match?.[1]).toBe('0.1.1');
  });

  it.each(['v0.1.1', '0.1', 'latest', ''])('refuses to point stable at %s', (version) => {
    expect(() => buildStableChannel({ version, publicBaseUrl: BASE })).toThrow(StableChannelError);
  });
});

describe('validateStableChannel', () => {
  const valid = serializeStableChannel(
    buildStableChannel({ version: '0.1.1', publicBaseUrl: BASE }),
  );

  it('accepts what buildStableChannel produced', () => {
    expect(validateStableChannel(valid, { expectedVersion: '0.1.1' }).version).toBe('0.1.1');
  });

  it('rejects a pointer for a different version than requested', () => {
    expect(() => validateStableChannel(valid, { expectedVersion: '0.1.2' })).toThrow(
      /points at 0\.1\.1, not the requested 0\.1\.2/u,
    );
  });

  it('rejects an unknown schemaVersion', () => {
    const broken = JSON.stringify({ ...JSON.parse(valid), schemaVersion: 7 });
    expect(() => validateStableChannel(broken)).toThrow(/only understands 1/u);
  });

  it('rejects a wrong channel name', () => {
    const broken = JSON.stringify({ ...JSON.parse(valid), channel: 'beta' });
    expect(() => validateStableChannel(broken)).toThrow(/expected "stable"/u);
  });

  it('rejects a releaseBaseUrl that does not resolve to its own version', () => {
    const broken = JSON.stringify({
      ...JSON.parse(valid),
      releaseBaseUrl: `${BASE}/releases/9.9.9`,
    });
    expect(() => validateStableChannel(broken)).toThrow(/does not resolve to releases\/0\.1\.1/u);
  });

  it('rejects a manifestUrl inconsistent with its own base', () => {
    const broken = JSON.stringify({
      ...JSON.parse(valid),
      manifestUrl: 'https://elsewhere.example.test/release-manifest.json',
    });
    expect(() => validateStableChannel(broken)).toThrow(/does not match its own releaseBaseUrl/u);
  });

  it('rejects invalid JSON', () => {
    expect(() => validateStableChannel('nope')).toThrow(/not valid JSON/u);
  });
});

describe('canonicalInstallerUrl', () => {
  it('points at the bucket-level bootstrap installer, not a versioned copy', () => {
    expect(canonicalInstallerUrl(BASE)).toBe(`${BASE}/installer/install-chantivo.sh`);
  });
});
