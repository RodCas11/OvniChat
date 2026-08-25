import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** T15 — root `package.json`'s `version` is the single source of truth for the Chantivo release
 * version; every other package.json that ships in a release artifact (the desktop app, the
 * dedicated server) must carry the identical value, or a release/installer artifact could silently
 * mismatch its own reported version. `workspace:*` internal dependencies don't encode a version, so
 * this is the only place drift could sneak in — via a manual edit that forgets one file. */
const versionedPackagePaths = [
  'package.json',
  'apps/desktop/package.json',
  'services/dedicated-server/package.json',
];

export async function readPackageVersions() {
  const versions = [];
  for (const relativePath of versionedPackagePaths) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    const content = await readFile(absolutePath, 'utf8');
    const { version } = JSON.parse(content);
    versions.push({ path: relativePath, version });
  }
  return versions;
}

export async function verifyVersion() {
  const versions = await readPackageVersions();
  const distinct = new Set(versions.map((entry) => entry.version));
  if (distinct.size > 1) {
    const detail = versions.map((entry) => `- ${entry.path}: ${entry.version}`).join('\n');
    throw new Error(
      `Package versions disagree — bump all with scripts/bump-version.mjs:\n${detail}`,
    );
  }
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  await verifyVersion();
  const [{ version }] = await readPackageVersions();
  console.info(`Package versions agree: ${version}`);
}
