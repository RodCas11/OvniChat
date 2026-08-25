import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * T15.1 CI Blocker #4 — locks the contract between `apps/desktop/forge.config.ts`'s
 * `packagerConfig.extraResource` and `scripts/release/build-windows-artifact.mjs`'s build sequence.
 *
 * The real bug this guards against: `extraResource` packages
 * `packages/windows-media/native/process-loopback-helper/build/process-loopback-helper.exe` into every
 * Windows build, but that file is generated and gitignored — never a tracked source asset (see
 * `.gitignore`'s `packages/windows-media/native/**\/build/` and the `git ls-files` assertion below). If
 * a future change ever adds another generated/gitignored `extraResource` entry without a matching
 * automated build step invoked unconditionally by `build-windows-artifact.mjs` *before*
 * `electron-forge make` runs, a genuinely clean checkout (a fresh GitHub Actions `windows-latest`
 * runner, or any other developer's fresh machine) would fail Forge packaging with ENOENT — exactly the
 * failure mode this task fixed for `process-loopback-helper.exe`. This test reads real source text
 * (matching this repository's own established `tests/repository/policies.test.mjs`/
 * `desktop-build-contract.test.mjs` "policy test reads real source" pattern) rather than unit-testing
 * exported functions, so it fails immediately if the two files' contracts ever drift apart again.
 *
 * Deliberately does NOT apply this guard to `chantivoIconBasePath + '.ico'`, the other `extraResource`
 * entry in the same array: that file is a committed source asset (confirmed via `git ls-files` below),
 * not something any build step needs to produce.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const FORGE_CONFIG_PATH = path.join(repoRoot, 'apps', 'desktop', 'forge.config.ts');
const BUILD_WINDOWS_ARTIFACT_PATH = path.join(
  repoRoot,
  'scripts',
  'release',
  'build-windows-artifact.mjs',
);
const HELPER_EXE_RELATIVE_PATH = path.join(
  'packages',
  'windows-media',
  'native',
  'process-loopback-helper',
  'build',
  'process-loopback-helper.exe',
);
const CHANTIVO_ICON_RELATIVE_PATH = path.join('apps', 'desktop', 'resources', 'chantivo.ico');

/** Strips comments so structural assertions describe what the source actually does, not what a
 * (possibly stale) comment claims — matching `desktop-build-contract.test.mjs`'s own `stripComments`. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
}

/** Every path segment `path.join(...)`/`path.join(desktopDir, ...)` passes as a plain string literal,
 * in order. Used to compare the two files' independently-computed helper paths without caring about
 * which base variable (`desktopDir` vs `repositoryRoot`) each file joins onto. */
function extractStringLiteralSegments(joinCallSource) {
  return [...joinCallSource.matchAll(/'([^']*)'/gu)].map((match) => match[1]);
}

async function readSource(filePath) {
  return stripComments(await readFile(filePath, 'utf8'));
}

// forge.config.ts uses an asar-unpack glob string literal containing a slash-star sequence. Naive
// block-comment stripping (which knows nothing about string-literal context) would mistake that
// sequence for the start of a comment and swallow far more of the file than any real comment,
// corrupting the source. forge.config.ts's targeted declarations below are unambiguous even in raw
// source (they are never themselves inside a comment), so this reads it without stripping anything,
// unlike readSource above.
async function readRawSource(filePath) {
  return readFile(filePath, 'utf8');
}

function gitTrackedFiles() {
  const output = execFileSync('git', ['ls-files'], { cwd: repoRoot, encoding: 'utf8' });
  return new Set(
    output
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
  );
}

describe('process-loopback-helper.exe is generated, not a tracked asset', () => {
  it('is absent from git ls-files (confirms it is gitignored/generated, never committed)', () => {
    const tracked = gitTrackedFiles();
    expect(tracked.has(HELPER_EXE_RELATIVE_PATH.replaceAll('\\', '/'))).toBe(false);
  });

  it('the sibling Chantivo .ico extraResource entry IS a tracked, committed source asset', () => {
    const tracked = gitTrackedFiles();
    expect(tracked.has(CHANTIVO_ICON_RELATIVE_PATH.replaceAll('\\', '/'))).toBe(true);
  });
});

describe('forge.config.ts extraResource <-> build-windows-artifact.mjs contract', () => {
  it('forge.config.ts packages process-loopback-helper.exe via extraResource, by path', async () => {
    const code = await readRawSource(FORGE_CONFIG_PATH);

    const extraResourceMatch = /extraResource:\s*\[([^\]]*)\]/u.exec(code);
    expect(extraResourceMatch, 'expected packagerConfig.extraResource array').not.toBeNull();
    expect(extraResourceMatch[1]).toContain('processLoopbackHelperExePath');
    expect(extraResourceMatch[1]).toContain("chantivoIconBasePath + '.ico'");
  });

  it("forge.config.ts's processLoopbackHelperExePath resolves the same relative segments build-windows-artifact.mjs does", async () => {
    const forgeConfigCode = await readRawSource(FORGE_CONFIG_PATH);
    const artifactCode = await readSource(BUILD_WINDOWS_ARTIFACT_PATH);

    const forgeJoinMatch = /const processLoopbackHelperExePath = path\.join\(([\s\S]*?)\);/u.exec(
      forgeConfigCode,
    );
    expect(
      forgeJoinMatch,
      'expected forge.config.ts processLoopbackHelperExePath path.join(...)',
    ).not.toBeNull();
    const forgeSegments = extractStringLiteralSegments(forgeJoinMatch[1]);
    // forge.config.ts joins from its own directory upward (`'..', '..'`), then the real path segments.
    expect(forgeSegments.slice(-6)).toEqual([
      'packages',
      'windows-media',
      'native',
      'process-loopback-helper',
      'build',
      'process-loopback-helper.exe',
    ]);

    const artifactDirMatch =
      /export const PROCESS_LOOPBACK_HELPER_DIR = path\.join\(([\s\S]*?)\);/u.exec(artifactCode);
    expect(
      artifactDirMatch,
      'expected build-windows-artifact.mjs PROCESS_LOOPBACK_HELPER_DIR path.join(...)',
    ).not.toBeNull();
    const artifactDirSegments = extractStringLiteralSegments(artifactDirMatch[1]);
    expect(artifactDirSegments).toEqual([
      'packages',
      'windows-media',
      'native',
      'process-loopback-helper',
    ]);
    expect(artifactCode).toContain(
      "export const PROCESS_LOOPBACK_HELPER_BUILD_DIR = path.join(PROCESS_LOOPBACK_HELPER_DIR, 'build');",
    );
    expect(artifactCode).toContain("  'process-loopback-helper.exe',\n);");
  });

  it('build-windows-artifact.mjs builds and validates the native helper unconditionally, BEFORE electron-forge make', async () => {
    const code = await readSource(BUILD_WINDOWS_ARTIFACT_PATH);

    // Slice by literal markers rather than a brace-counting regex — robust regardless of how many
    // (possibly nested-looking) braces the block's own object literals contain.
    const runMakeStart = code.indexOf('if (runMake) {');
    const afterRunMakeMarker =
      'const { installerPath, sizeBytes, embeddedVersion } = await discoverForgeInstaller(';
    const runMakeEnd = code.indexOf(afterRunMakeMarker);
    expect(runMakeStart).toBeGreaterThan(-1);
    expect(runMakeEnd).toBeGreaterThan(runMakeStart);
    const block = code.slice(runMakeStart, runMakeEnd);

    const helperBuildCallIndex = block.indexOf('await buildProcessLoopbackHelper(');
    const helperValidateCallIndex = block.indexOf('await validateProcessLoopbackHelperExecutable(');
    const forgeMakeCallIndex = block.indexOf('await runForgeMake(');

    expect(helperBuildCallIndex).toBeGreaterThan(-1);
    expect(helperValidateCallIndex).toBeGreaterThan(-1);
    expect(forgeMakeCallIndex).toBeGreaterThan(-1);

    // Order matters: the helper must be built and validated before Forge ever runs, so a genuinely
    // clean checkout never reaches `electron-forge make` with a missing extraResource file.
    expect(helperBuildCallIndex).toBeLessThan(helperValidateCallIndex);
    expect(helperValidateCallIndex).toBeLessThan(forgeMakeCallIndex);

    // Unconditional: no `if`/ternary/short-circuit guarding the helper build call itself (mirrors the
    // same "no already-built? short-circuit" discipline already enforced for prepareDesktopRuntime).
    const linesBeforeHelperBuild = block.slice(0, helperBuildCallIndex).split('\n');
    const lastFewLines = linesBeforeHelperBuild.slice(-3).join('\n');
    expect(lastFewLines).not.toMatch(/\bif\s*\(/u);
  });

  it('buildProcessLoopbackHelper removes any stale build/ output before invoking build.ps1', async () => {
    const code = await readSource(BUILD_WINDOWS_ARTIFACT_PATH);

    const bodyStart = code.indexOf('export async function buildProcessLoopbackHelper(');
    const bodyEnd = code.indexOf('export async function validateProcessLoopbackHelperExecutable(');
    expect(bodyStart).toBeGreaterThan(-1);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const body = code.slice(bodyStart, bodyEnd);

    const rmCallIndex = body.indexOf('await rm(buildDir');
    const executeCallIndex = body.indexOf('await execute(');
    expect(rmCallIndex).toBeGreaterThan(-1);
    expect(executeCallIndex).toBeGreaterThan(-1);
    expect(rmCallIndex).toBeLessThan(executeCallIndex);
  });

  it('validates the built helper is a real, non-empty, x64 PE executable (not just "a file exists")', async () => {
    const code = await readSource(BUILD_WINDOWS_ARTIFACT_PATH);

    const bodyStart = code.indexOf(
      'export async function validateProcessLoopbackHelperExecutable(',
    );
    const bodyEnd = code.indexOf('async function sha256File(filePath) {');
    expect(bodyStart).toBeGreaterThan(-1);
    expect(bodyEnd).toBeGreaterThan(bodyStart);
    const body = code.slice(bodyStart, bodyEnd);

    expect(body).toContain('fileStat.size === 0');
    expect(body).toContain('IMAGE_FILE_MACHINE_AMD64');
    expect(body).toContain('PE_SIGNATURE');
  });

  it('never duplicates the native compiler/linker invocation outside build.ps1', async () => {
    const artifactCode = await readSource(BUILD_WINDOWS_ARTIFACT_PATH);

    // The compiler/linker flags this repo has already chosen for the helper (see build.ps1's own
    // doc comment) must never be re-specified here — build.ps1 remains the single source of truth.
    for (const forbidden of ['cl.exe', 'link.exe', '/MT', 'vcvars64', 'cl /nologo']) {
      expect(artifactCode).not.toContain(forbidden);
    }
  });
});
