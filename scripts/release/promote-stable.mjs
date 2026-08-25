import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256File, validatePublishedRelease } from './build-manifest.mjs';
import { createR2Client, endpointUrlForAccount } from './r2-client.mjs';
import {
  CANONICAL_INSTALLER_KEY,
  POINTER_CACHE_CONTROL,
  STABLE_CHANNEL_KEY,
  contentTypeFor,
  releaseObjectKey,
} from './r2-publication-plan.mjs';
import {
  CHECKSUMS_FILENAME,
  INSTALLER_FILENAME,
  MANIFEST_FILENAME,
  isValidReleaseVersion,
} from './resolve-release-metadata.mjs';
import {
  buildStableChannel,
  serializeStableChannel,
  validateStableChannel,
} from './stable-channel.mjs';

/**
 * T15.1 — PROMOTE phase. Moves the `stable` pointer to an ALREADY-PUBLISHED immutable release.
 *
 * This script builds nothing. There is no Electron build, no Forge make, no server build, no artifact
 * generation of any kind anywhere in this file or in the workflow that runs it — that is the entire
 * point of separating promotion from publication. The bytes an operator downloads after a promotion
 * are the exact bytes that were verified and published earlier, from the tagged commit, by a separate
 * human decision. Regenerating anything here would silently break that chain.
 *
 * Write ordering (deliberate, and the reason a client never observes an inconsistent pair):
 *
 *   1. `installer/install-chantivo.sh`  — the canonical bootstrap installer, copied byte-for-byte from
 *      `releases/<version>/install-chantivo.sh` after verifying its SHA-256 against the published
 *      manifest.
 *   2. `channels/stable.json`           — the pointer that names the new stable version.
 *
 * S3-compatible storage offers no multi-object transaction, so SOME ordering window always exists. The
 * question is only which window is harmless. With the installer written first, the window contains a
 * NEWER installer alongside an OLDER stable pointer: that installer reads the old pointer, resolves
 * `releases/<old-version>/`, and installs it — an immutable, complete, previously-validated release.
 * Nothing breaks. The reverse order would leave an OLDER installer being handed a NEWER pointer, i.e.
 * a client asked to interpret a channel document written after it, which is exactly the direction that
 * cannot be reasoned about safely.
 *
 * Reruns are idempotent: each write is skipped when the object already holds byte-identical content.
 */

function sha256Text(text) {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value.trim();
}

async function fetchRequired({ client, key, destinationPath, description }) {
  const found = await client.getObject({ key, destinationPath });
  if (!found) {
    throw new Error(
      `${key} does not exist in the release bucket. ${description} Promotion is all-or-nothing: nothing has been changed.`,
    );
  }
  return destinationPath;
}

/**
 * Downloads and fully validates the immutable release the caller wants to promote. Throws — never
 * returns a partially-validated result — on any missing file, any manifest/checksum inconsistency, any
 * version disagreement, and any arm64 claim.
 */
export async function verifyPublishedReleaseForPromotion({ client, version, workDir }) {
  const manifestPath = path.join(workDir, MANIFEST_FILENAME);
  const checksumsPath = path.join(workDir, CHECKSUMS_FILENAME);
  const installerPath = path.join(workDir, INSTALLER_FILENAME);

  await fetchRequired({
    client,
    key: releaseObjectKey(version, MANIFEST_FILENAME),
    destinationPath: manifestPath,
    description: `Either ${version} was never published, or its publication did not complete (release-manifest.json is written last, precisely so its absence means "incomplete").`,
  });
  await fetchRequired({
    client,
    key: releaseObjectKey(version, CHECKSUMS_FILENAME),
    destinationPath: checksumsPath,
    description: `A release without SHA256SUMS is unverifiable and must never be promoted.`,
  });

  const manifestText = await readFile(manifestPath, 'utf8');
  const checksumsText = await readFile(checksumsPath, 'utf8');
  const manifest = validatePublishedRelease({
    expectedVersion: version,
    manifestText,
    checksumsText,
  });

  // The manifest is only a claim until the real artifact objects are confirmed to exist with the
  // declared content. The two large binaries are confirmed by their recorded sha256 metadata (cheap,
  // and exactly what the publisher wrote); the installer is downloaded in full because promotion is
  // about to copy its bytes to the canonical location, so it must be verified byte-for-byte.
  for (const [key, artifact] of Object.entries(manifest.artifacts)) {
    if (key === 'linux-installer') continue;
    const objectKey = releaseObjectKey(version, artifact.filename);
    const head = await client.headObject(objectKey);
    if (!head.exists) {
      throw new Error(
        `${objectKey} is missing even though release-manifest.json declares it. ${version} is an incomplete publication and cannot be promoted.`,
      );
    }
    if (head.sha256 !== artifact.sha256) {
      throw new Error(
        `${objectKey} has sha256 metadata ${JSON.stringify(head.sha256)} but the manifest declares ${artifact.sha256}. Refusing to promote an internally inconsistent release.`,
      );
    }
    if (typeof head.size === 'number' && head.size !== artifact.size) {
      throw new Error(
        `${objectKey} is ${head.size} bytes but the manifest declares ${artifact.size}. Refusing to promote.`,
      );
    }
  }

  await fetchRequired({
    client,
    key: releaseObjectKey(version, INSTALLER_FILENAME),
    destinationPath: installerPath,
    description: `The canonical bootstrap installer is copied from the release, never regenerated, so it must be present in the release itself.`,
  });
  const installerSha256 = await sha256File(installerPath);
  const declared = manifest.artifacts['linux-installer'].sha256;
  if (installerSha256 !== declared) {
    throw new Error(
      `${releaseObjectKey(version, INSTALLER_FILENAME)} hashes to ${installerSha256} but the published manifest declares ${declared}. Refusing to copy unverified bytes to the canonical installer location every new operator downloads.`,
    );
  }

  return { manifest, installerPath, installerSha256 };
}

async function writePointerIfChanged({ client, key, bodyPath, sha256, contentType, dryRun, log }) {
  const head = await client.headObject(key);
  if (head.exists && head.sha256 === sha256) {
    log(`${key} already holds these exact bytes — leaving it untouched (idempotent rerun).`);
    return false;
  }
  if (dryRun) {
    log(`[dry-run] would write ${key} (${POINTER_CACHE_CONTROL})`);
    return true;
  }
  await client.putObject({
    key,
    bodyPath,
    cacheControl: POINTER_CACHE_CONTROL,
    contentType,
    sha256,
  });
  log(`Wrote ${key} (${POINTER_CACHE_CONTROL}).`);
  return true;
}

export async function promoteStable({
  client,
  version,
  publicBaseUrl,
  workDir,
  dryRun = false,
  log = console.info,
}) {
  if (!isValidReleaseVersion(version)) {
    throw new Error(`"${version}" is not a plain MAJOR.MINOR.PATCH version; refusing to promote.`);
  }

  const { manifest, installerPath, installerSha256 } = await verifyPublishedReleaseForPromotion({
    client,
    version,
    workDir,
  });
  log(`Published release ${manifest.version} verified complete and internally consistent.`);

  const channel = buildStableChannel({ version, publicBaseUrl });
  const channelText = serializeStableChannel(channel);
  // Re-parse what is about to be written: a pointer that this repository's own validator would reject
  // must never reach the bucket.
  validateStableChannel(channelText, { expectedVersion: version });
  const channelPath = path.join(workDir, 'stable.json');
  await writeFile(channelPath, channelText, 'utf8');

  // Step 1 — canonical installer first. See this file's header for why this ordering is the safe one.
  const installerWritten = await writePointerIfChanged({
    client,
    key: CANONICAL_INSTALLER_KEY,
    bodyPath: installerPath,
    sha256: installerSha256,
    contentType: contentTypeFor(INSTALLER_FILENAME),
    dryRun,
    log,
  });

  // Step 2 — stable pointer last.
  const channelWritten = await writePointerIfChanged({
    client,
    key: STABLE_CHANNEL_KEY,
    bodyPath: channelPath,
    sha256: sha256Text(channelText),
    contentType: 'application/json',
    dryRun,
    log,
  });

  return { version, channel, installerWritten, channelWritten, installerSha256 };
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  const dryRun = process.argv.includes('--dry-run');
  const version = requireEnv('PROMOTE_VERSION');
  const publicBaseUrl = requireEnv('PUBLIC_BASE_URL');

  const client = createR2Client({
    bucket: requireEnv('CLOUDFLARE_R2_BUCKET'),
    endpointUrl: endpointUrlForAccount(requireEnv('CLOUDFLARE_R2_ACCOUNT_ID')),
  });

  const workDir = await mkdtemp(path.join(tmpdir(), 'chantivo-promote-'));
  try {
    const result = await promoteStable({ client, version, publicBaseUrl, workDir, dryRun });
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(
        process.env.GITHUB_STEP_SUMMARY,
        `## Promote ${version} to stable\n\n- \`${CANONICAL_INSTALLER_KEY}\`: ${result.installerWritten ? 'updated' : 'already current'}\n- \`${STABLE_CHANNEL_KEY}\`: ${result.channelWritten ? 'updated' : 'already current'}\n- releaseBaseUrl: ${result.channel.releaseBaseUrl}\n`,
        'utf8',
      );
    }
    console.info(
      `stable now points at ${result.channel.version} (${result.channel.releaseBaseUrl})`,
    );
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}
