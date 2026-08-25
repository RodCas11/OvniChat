import {
  CHECKSUMS_FILENAME,
  INSTALLER_FILENAME,
  MANIFEST_FILENAME,
  expectedReleaseFilenames,
  isValidReleaseVersion,
} from './resolve-release-metadata.mjs';

/**
 * T15.1 — the decision layer for "may this build write these bytes into the release bucket?", kept as
 * pure, testable logic rather than inline shell inside a workflow, because it is the single most
 * safety-critical rule in the whole pipeline: a published release is IMMUTABLE. Once `0.1.1` exists,
 * `0.1.1` means one exact set of bytes forever. Changing what a version contains requires a new
 * version number — there is no supported path to overwrite one, and this module is what makes that a
 * structural property instead of a convention.
 *
 * The caller (`publish-release-to-r2.mjs`) is responsible only for I/O: hashing local files and
 * asking R2 what it already holds. Every judgement about publish/idempotent/conflict/reconcile
 * happens here, against plain data.
 */

/** `releases/<version>/*` never changes, so it can be cached essentially forever. */
export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable';

/** `channels/stable.json` and `installer/install-chantivo.sh` are mutable pointers. A stale CDN edge
 * serving an old stable pointer, or an old bootstrap installer, is exactly the failure this avoids —
 * these two objects are the only mutable ones in the bucket and they must never be cached hard. */
export const POINTER_CACHE_CONTROL = 'no-cache';

export const STABLE_CHANNEL_KEY = 'channels/stable.json';
export const CANONICAL_INSTALLER_KEY = `installer/${INSTALLER_FILENAME}`;

const CONTENT_TYPES = Object.freeze({
  '.exe': 'application/octet-stream',
  '.gz': 'application/gzip',
  '.json': 'application/json',
  '.sh': 'text/x-shellscript',
});

export function contentTypeFor(filename) {
  if (filename === CHECKSUMS_FILENAME) return 'text/plain';
  const dot = filename.lastIndexOf('.');
  return (
    (dot === -1 ? undefined : CONTENT_TYPES[filename.slice(dot)]) ?? 'application/octet-stream'
  );
}

export function releaseObjectKey(version, filename) {
  return `releases/${version}/${filename}`;
}

/**
 * The completeness marker. Everything in this system — the promote workflow, any future update
 * check — treats the presence of `releases/<version>/release-manifest.json` as "this release is
 * complete and safe to reference." It is therefore always the LAST object written, so a publication
 * interrupted at any point leaves an obviously-incomplete release rather than a complete-looking one
 * with a missing artifact.
 */
export function completenessMarkerKey(version) {
  return releaseObjectKey(version, MANIFEST_FILENAME);
}

/**
 * Builds the ordered upload plan for an immutable release. `files` maps filename -> `{ sha256, size }`
 * for every expected file. Ordering is load-bearing: artifacts, then SHA256SUMS, then the manifest.
 */
export function releaseObjectDescriptors({ version, files }) {
  if (!isValidReleaseVersion(version)) {
    throw new Error(`"${version}" is not a plain MAJOR.MINOR.PATCH version.`);
  }
  const expected = expectedReleaseFilenames(version);
  const ordered = [
    ...expected.filter((name) => name !== MANIFEST_FILENAME && name !== CHECKSUMS_FILENAME),
    CHECKSUMS_FILENAME,
    MANIFEST_FILENAME,
  ];

  return ordered.map((filename) => {
    const file = files[filename];
    if (!file) {
      throw new Error(
        `No local file information for ${filename}; refusing to plan a partial upload.`,
      );
    }
    return {
      filename,
      key: releaseObjectKey(version, filename),
      sha256: file.sha256,
      size: file.size,
      cacheControl: IMMUTABLE_CACHE_CONTROL,
      contentType: contentTypeFor(filename),
      isCompletenessMarker: filename === MANIFEST_FILENAME,
    };
  });
}

/**
 * Compares the intended objects against what the bucket already holds.
 *
 * `remote` maps object key -> `{ exists: boolean, sha256?: string, size?: number }`. `sha256` is the
 * value read back from the object's own `sha256` user metadata, which `publish-release-to-r2.mjs`
 * always sets on upload. An existing object with NO recorded sha256 is treated as a conflict, not as
 * "probably fine": an object this pipeline cannot prove identical is an object it must not overwrite.
 *
 * @returns {{status: 'publish'|'idempotent'|'reconcile'|'conflict', uploads: object[], identical: object[], conflicts: {key: string, reason: string}[], completenessMarkerPresent: boolean, summary: string}}
 */
export function planPublication({ version, descriptors, remote }) {
  const uploads = [];
  const identical = [];
  const conflicts = [];

  const remoteFor = (key) =>
    (remote instanceof Map ? remote.get(key) : remote?.[key]) ?? { exists: false };

  for (const descriptor of descriptors) {
    const existing = remoteFor(descriptor.key);
    if (!existing.exists) {
      uploads.push(descriptor);
      continue;
    }
    if (typeof existing.sha256 !== 'string' || existing.sha256.length === 0) {
      conflicts.push({
        key: descriptor.key,
        reason:
          'already exists but records no sha256 metadata, so it cannot be proven identical to this build. Refusing to overwrite an unverifiable published object.',
      });
      continue;
    }
    if (existing.sha256 !== descriptor.sha256) {
      conflicts.push({
        key: descriptor.key,
        reason: `already exists with a DIFFERENT sha256 (published ${existing.sha256}, this build ${descriptor.sha256}). A published version is immutable — release a new version number instead.`,
      });
      continue;
    }
    if (typeof existing.size === 'number' && existing.size !== descriptor.size) {
      conflicts.push({
        key: descriptor.key,
        reason: `already exists with a matching sha256 but a different size (published ${existing.size} bytes, this build ${descriptor.size}). Refusing to act on contradictory metadata.`,
      });
      continue;
    }
    identical.push(descriptor);
  }

  const completenessMarkerPresent = remoteFor(completenessMarkerKey(version)).exists === true;

  let status;
  if (conflicts.length > 0) {
    status = 'conflict';
  } else if (uploads.length === 0) {
    status = 'idempotent';
  } else if (identical.length === 0 && !completenessMarkerPresent) {
    status = 'publish';
  } else {
    status = 'reconcile';
  }

  const summaries = {
    publish: `${version} is not published yet — uploading ${uploads.length} object(s), release-manifest.json last.`,
    idempotent: `${version} is already published and byte-identical to this build — nothing to upload.`,
    reconcile: `${version} is PARTIALLY published (${identical.length} object(s) already present and verified identical, ${uploads.length} missing${completenessMarkerPresent ? '' : ', completeness marker absent'}). Re-uploading only what is missing; nothing already published will be altered.`,
    conflict: `${version} is already published with DIFFERENT content and will not be overwritten:\n- ${conflicts.map((conflict) => `${conflict.key}: ${conflict.reason}`).join('\n- ')}`,
  };

  return {
    status,
    // On a conflict the upload list is deliberately emptied rather than returned for reference: a
    // caller must not be able to act on "the parts that would have been fine" while a conflict is
    // unresolved. A conflicting release is not partially publishable, it is not publishable.
    uploads: status === 'conflict' ? [] : uploads,
    blockedUploads: status === 'conflict' ? uploads : [],
    identical,
    conflicts,
    completenessMarkerPresent,
    summary: summaries[status],
  };
}

/** The two mutable pointer objects, described the same way so the promote step's upload arguments are
 * derived from one place rather than typed twice into YAML. */
export function pointerObjectDescriptors() {
  return [
    {
      key: STABLE_CHANNEL_KEY,
      cacheControl: POINTER_CACHE_CONTROL,
      contentType: 'application/json',
    },
    {
      key: CANONICAL_INSTALLER_KEY,
      cacheControl: POINTER_CACHE_CONTROL,
      contentType: contentTypeFor(INSTALLER_FILENAME),
    },
  ];
}
