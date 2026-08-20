import os from 'node:os';

/**
 * T12 — runtime detection of Windows process-loopback audio capture support
 * (`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`). Per this repo's own prior primary-source research
 * (`docs/references/WINDOWS_MEDIA.md`), Microsoft's own documentation disagrees on the exact minimum
 * build across different pages (20348 vs. 20438) — "implementations must feature-test and report the
 * actual OS build rather than trusting product names alone." This module is the feature-test.
 *
 * Empirically confirmed on a real Windows 11 development machine (build 26200) during this task:
 * `os.release()` reports `"10.0.26200"` — the true numeric build, matching
 * `HKLM\SOFTWARE\Microsoft\Windows NT\CurrentVersion\CurrentBuild` exactly — while that same
 * machine's registry `ProductName` value still literally reads `"Windows 10 Pro"`. This is a live,
 * firsthand reproduction of exactly the "don't trust product names" warning above: this module
 * therefore reads only the numeric build out of `os.release()`, never anything derived from a
 * product-name string. This is a session-specific empirical confirmation for this one machine and
 * Node version, not a guarantee for every possible Windows configuration — the native helper's own
 * `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK` activation is the real, final authority, and a
 * genuinely wrong capability result here still fails safely: `ProcessAudioErrorCode.UnsupportedPlatform`
 * (see `protocol.ts`) is exactly the defense-in-depth path for that case.
 */

/** The lower of Microsoft's two disagreeing minimum-build figures — deliberately the conservative
 * (more permissive) choice: reporting "supported" for a build that the more restrictive 20438 figure
 * would reject fails safe (the real activation call still enforces the platform's actual
 * requirement and surfaces `UnsupportedPlatform` if this guess was too permissive), whereas reporting
 * "unsupported" for a build that would have actually worked pointlessly denies a capable user. See
 * `docs/references/WINDOWS_MEDIA.md`'s "Application/process-tree loopback" section for the primary
 * sources behind both figures. */
export const MINIMUM_PROCESS_LOOPBACK_BUILD = 20348;

export type ProcessAudioCapabilityResult =
  | { readonly supported: true; readonly detectedBuild: number }
  | {
      readonly supported: false;
      readonly reason: 'not-windows' | 'build-too-old';
      readonly detectedBuild: number | undefined;
    };

/** Parses the numeric Windows build out of `os.release()` (`"<major>.<minor>.<build>"` on Windows —
 * e.g. `"10.0.26200"`), never trusting `os.version()`/`os.type()`'s product-name-shaped strings for
 * the actual version decision (see this module's own doc comment for why). Returns `undefined` if
 * the string does not parse as expected (should not happen on a genuine Windows release() string,
 * but this function never throws on unexpected input — an unparseable release string degrades to
 * "capability unknown," handled by the caller as unsupported, never as an assumed-supported guess). */
function detectWindowsBuild(release: string): number | undefined {
  const match = /^\d+\.\d+\.(\d+)/u.exec(release);
  if (!match) return undefined;
  const build = Number(match[1]);
  return Number.isInteger(build) && build > 0 ? build : undefined;
}

/**
 * Fail-narrow, never fail-broad (T12 Section 7, mandatory): this function only ever answers "is
 * process-scoped capture available," and its `false` result must never be treated by a caller as a
 * reason to silently fall back to system-wide capture instead — that would capture *more* than what
 * an unsupported "Application audio" selection asked for, the exact privacy inversion this task's
 * own spec forbids.
 */
export function detectProcessAudioCapability(
  platform: NodeJS.Platform = process.platform,
  release: string = os.release(),
): ProcessAudioCapabilityResult {
  if (platform !== 'win32') {
    return { supported: false, reason: 'not-windows', detectedBuild: undefined };
  }

  const detectedBuild = detectWindowsBuild(release);
  if (detectedBuild === undefined || detectedBuild < MINIMUM_PROCESS_LOOPBACK_BUILD) {
    return { supported: false, reason: 'build-too-old', detectedBuild };
  }

  return { supported: true, detectedBuild };
}
