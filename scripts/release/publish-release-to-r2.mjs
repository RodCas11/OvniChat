import { appendFile, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sha256File } from './build-manifest.mjs';
import { createR2Client, endpointUrlForAccount } from './r2-client.mjs';
import { planPublication, releaseObjectDescriptors } from './r2-publication-plan.mjs';
import { expectedReleaseFilenames, isValidReleaseVersion } from './resolve-release-metadata.mjs';
import { verifyReleaseDirectory } from './verify-release-directory.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * T15.1 — PUBLISH phase. Writes one immutable, versioned release into R2 and nothing else. It never
 * touches `channels/stable.json` and never touches `installer/install-chantivo.sh`: publishing a
 * version and deciding that version is what new installs should get are two separate human decisions,
 * and conflating them is how a broken release reaches every new operator at once.
 *
 * Order of operations, and why:
 *   1. Re-verify the candidate directory locally (all five files, non-empty, checksums match the real
 *      bytes). The candidate was already verified when it was assembled, but it travelled through an
 *      artifact upload/download since then; verifying again here costs seconds and is the last point
 *      at which a corrupted artifact can be caught before it becomes permanent.
 *   2. Ask R2 what it already holds for this version.
 *   3. Decide (pure logic in `r2-publication-plan.mjs`): publish / idempotent / reconcile / conflict.
 *   4. Upload, artifacts first, `release-manifest.json` LAST — its presence is the completeness marker
 *      the promote step and any future update check rely on.
 */

function requireEnv(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Missing required environment variable ${name}.`);
  }
  return value.trim();
}

async function localFileFacts({ version, releaseDir }) {
  const files = {};
  for (const filename of expectedReleaseFilenames(version)) {
    const filePath = path.join(releaseDir, filename);
    const fileStat = await stat(filePath);
    files[filename] = { sha256: await sha256File(filePath), size: fileStat.size };
  }
  return files;
}

export async function publishRelease({
  version,
  releaseDir,
  client,
  dryRun = false,
  log = console.info,
}) {
  if (!isValidReleaseVersion(version)) {
    throw new Error(`"${version}" is not a plain MAJOR.MINOR.PATCH version; refusing to publish.`);
  }

  await verifyReleaseDirectory({ version, releaseDir });
  log(`Release candidate ${version} re-verified locally before publication.`);

  const files = await localFileFacts({ version, releaseDir });
  const descriptors = releaseObjectDescriptors({ version, files });

  const remote = new Map();
  for (const descriptor of descriptors) {
    remote.set(descriptor.key, await client.headObject(descriptor.key));
  }

  const plan = planPublication({ version, descriptors, remote });
  log(plan.summary);

  if (plan.status === 'conflict') {
    throw new Error(
      `Refusing to overwrite published release ${version}.\n${plan.summary}\nA published version is immutable by design. If the content genuinely needs to change, bump to a new version with scripts/bump-version.mjs, tag it, and publish that instead.`,
    );
  }

  if (plan.status === 'idempotent') {
    return { ...plan, uploaded: [] };
  }

  const uploaded = [];
  for (const descriptor of plan.uploads) {
    if (dryRun) {
      log(
        `[dry-run] would upload ${descriptor.key} (${descriptor.size} bytes, ${descriptor.cacheControl})`,
      );
    } else {
      await client.putObject({
        key: descriptor.key,
        bodyPath: path.join(releaseDir, descriptor.filename),
        cacheControl: descriptor.cacheControl,
        contentType: descriptor.contentType,
        sha256: descriptor.sha256,
      });
      log(
        `Uploaded ${descriptor.key}${descriptor.isCompletenessMarker ? ' (completeness marker — release is now complete)' : ''}`,
      );
    }
    uploaded.push(descriptor.key);
  }

  return { ...plan, uploaded };
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  const dryRun = process.argv.includes('--dry-run');
  const version =
    process.env.RELEASE_VERSION ||
    JSON.parse(await readFile(path.join(repositoryRoot, 'package.json'), 'utf8')).version;
  const releaseDir = process.env.RELEASE_DIR
    ? path.resolve(process.env.RELEASE_DIR)
    : path.join(repositoryRoot, 'dist-release', version);

  const client = createR2Client({
    bucket: requireEnv('CLOUDFLARE_R2_BUCKET'),
    endpointUrl: endpointUrlForAccount(requireEnv('CLOUDFLARE_R2_ACCOUNT_ID')),
  });

  const result = await publishRelease({ version, releaseDir, client, dryRun });

  if (process.env.GITHUB_STEP_SUMMARY) {
    await appendFile(
      process.env.GITHUB_STEP_SUMMARY,
      `## Publish ${version}\n\n- status: \`${result.status}\`\n- objects uploaded: ${result.uploaded.length}\n- objects already present and verified identical: ${result.identical.length}\n`,
      'utf8',
    );
  }
  console.info(`Publish finished with status: ${result.status}`);
}
