import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readPackageVersions } from './verify-version.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Deliberately plain `MAJOR.MINOR.PATCH` — no pre-release/build-metadata suffix support. T15 has no
 * use for one yet (see `docs/adr/` for the release-versioning ADR); add real parsing here only when
 * a concrete need for it exists. */
const SEMVER_PATTERN = /^\d+\.\d+\.\d+$/u;

export function isValidVersion(candidate) {
  return SEMVER_PATTERN.test(candidate);
}

export async function bumpVersion(newVersion) {
  if (!isValidVersion(newVersion)) {
    throw new Error(`Invalid version "${newVersion}" — expected MAJOR.MINOR.PATCH (e.g. 0.1.0)`);
  }

  const current = await readPackageVersions();
  for (const { path: relativePath } of current) {
    const absolutePath = path.join(repositoryRoot, relativePath);
    const content = await readFile(absolutePath, 'utf8');
    const pkg = JSON.parse(content);
    pkg.version = newVersion;
    // Matches this repo's existing package.json formatting (2-space indent, trailing newline) —
    // `prettier --write` is still expected to run afterward to catch anything this doesn't, same as
    // every other generated/edited file in this repo's workflow.
    await writeFile(absolutePath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  }
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  const [, , newVersion] = process.argv;
  if (!newVersion) {
    console.error('Usage: node scripts/bump-version.mjs <newVersion>');
    process.exitCode = 1;
  } else {
    await bumpVersion(newVersion);
    console.info(
      `Bumped to ${newVersion} in: ${(await readPackageVersions()).map((e) => e.path).join(', ')}`,
    );
  }
}
