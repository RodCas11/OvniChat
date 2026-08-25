import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isValidReleaseVersion } from './resolve-release-metadata.mjs';

/**
 * T15.1 — the promote workflow's fail-fast input check, as a real file rather than an inline `node -e`
 * fragment inside YAML. Two reasons: shell/YAML quoting around an inline script is a recurring source
 * of silent breakage (a mis-escaped quote turns a validation step into a no-op that still exits 0),
 * and this repository's rule is that version rules live in exactly one module — the same
 * `isValidReleaseVersion` the release workflow, the manifest builder, and the installer's own
 * `validate_release_version` are all held against.
 *
 * Runs before any credential is used, so a typo costs a red step, not a half-finished promotion.
 */
export function validatePromotionInput(version) {
  if (!isValidReleaseVersion(version)) {
    throw new Error(
      `Refusing to promote "${version}" — expected a bare MAJOR.MINOR.PATCH version such as 0.1.1 (no leading "v", no tag name, no "latest", no range).`,
    );
  }
  return version;
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  const version = validatePromotionInput(process.env.PROMOTE_VERSION ?? '');
  console.info(`Promotion target: ${version}`);
}
