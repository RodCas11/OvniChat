import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  DESKTOP_RUNTIME_TSC_ARGS,
  buildWindowsArtifact,
  canonicalInstallerName,
  prepareDesktopRuntime,
} from '../../scripts/release/build-windows-artifact.mjs';

/** A minimal but genuine x64 PE file: DOS `MZ` header with `e_lfanew` pointing at a `PE\0\0` signature
 * immediately followed by the `IMAGE_FILE_MACHINE_AMD64` (`0x8664`) machine-type field — enough for
 * `validateProcessLoopbackHelperExecutable` to accept it as a real x64 executable without needing a
 * genuine MSVC-produced binary in this fixture-only test. */
function fakeAmd64PeFile() {
  const header = Buffer.alloc(0x40);
  header.write('MZ', 0, 'ascii');
  const peHeaderOffset = 0x40;
  header.writeUInt32LE(peHeaderOffset, 0x3c);
  const peHeader = Buffer.alloc(6);
  peHeader.write('PE\0\0', 0, 'ascii');
  peHeader.writeUInt16LE(0x8664, 4);
  return Buffer.concat([header, peHeader, Buffer.alloc(256, 0x90)]);
}

/**
 * T15.1 CI fix — guards the *desktop build contract*: the rule that
 * `scripts/release/build-windows-artifact.mjs` builds every workspace package `apps/desktop` needs
 * before it lets Electron Forge run, and never assumes some earlier job on some other runner did it.
 *
 * The real failure these tests exist to prevent, observed on a real `windows-latest` runner:
 *
 *   Failed to resolve entry for package "@disco-voador/config".
 *
 * Everything here is fixture- or source-based. No Electron download, no Squirrel, no real Forge run —
 * the real build is proven by actually running the script, not by the unit suite.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const windowsArtifactScriptPath = path.join(
  repoRoot,
  'scripts',
  'release',
  'build-windows-artifact.mjs',
);

async function readJson(relativePath) {
  return JSON.parse(await readFile(path.join(repoRoot, relativePath), 'utf8'));
}

/** `buildWindowsArtifact` refuses to run a Squirrel make off win32 — an intentional guard, not
 * something to weaken for a test. This repository targets Windows 10/11 x64 and its CI runs on
 * `windows-latest`, so these run everywhere they can actually matter. */
const describeOnWindows = describe.skipIf(process.platform !== 'win32');

describe('root build:desktop-runtime script', () => {
  it('exists and is the narrowest command that builds apps/desktop’s reference graph', async () => {
    const rootManifest = await readJson('package.json');
    const script = rootManifest.scripts?.['build:desktop-runtime'];

    expect(script, 'root package.json must declare a build:desktop-runtime script').toBeDefined();
    expect(script).toBe('tsc -b apps/desktop --pretty false');
    // Deliberately targets apps/desktop alone rather than the whole monorepo (`tsc -b`), which would
    // also build services/realtime and services/dedicated-server for no benefit to an installer.
    expect(script).not.toContain('services/');
  });

  it('matches the argument list build-windows-artifact.mjs actually runs', async () => {
    const rootManifest = await readJson('package.json');
    const script = rootManifest.scripts?.['build:desktop-runtime'] ?? '';

    // The script text and the release script's argv are the same real command, so a developer
    // running `pnpm build:desktop-runtime` by hand reproduces exactly what CI does.
    expect(script).toBe(`tsc ${DESKTOP_RUNTIME_TSC_ARGS.join(' ')}`);
  });
});

describe('apps/desktop project-reference cascade', () => {
  /**
   * `tsc -b apps/desktop` is only sufficient because TypeScript's reference cascade covers every
   * workspace package the Vite/Forge build will try to resolve from `node_modules`. That equivalence
   * is the whole contract; if a `@disco-voador/*` runtime dependency is ever added without a matching
   * tsconfig reference, its `dist/` would silently not be built and CI would fail again with the same
   * misleading "Failed to resolve entry for package" message.
   */
  it('references exactly the workspace packages apps/desktop depends on', async () => {
    const desktopManifest = await readJson(path.join('apps', 'desktop', 'package.json'));
    const desktopTsconfig = await readJson(path.join('apps', 'desktop', 'tsconfig.json'));

    const dependencyNames = Object.keys(desktopManifest.dependencies ?? {})
      .filter((name) => name.startsWith('@disco-voador/'))
      .map((name) => name.slice('@disco-voador/'.length))
      .sort();

    const referencedPackages = (desktopTsconfig.references ?? [])
      .map((reference) => reference.path.replace(/\\/gu, '/'))
      .filter((referencePath) => referencePath.includes('packages/'))
      .map((referencePath) => referencePath.split('packages/')[1])
      .sort();

    expect(referencedPackages).toEqual(dependencyNames);
  });
});

describeOnWindows('build-windows-artifact.mjs execution sequence', () => {
  let fixtureRoot;
  let makeRoot;
  let releaseRoot;
  let helperDir;
  let helperBuildDir;
  let helperBuildScript;
  let helperExePath;
  let version;

  /** Records every child process the script asks for, and — only when asked to run Forge or to build
   * the native helper — produces the output a real run would leave behind. Discovery/validation
   * therefore only succeeds if the corresponding step was actually invoked, so "the steps ran, in this
   * order" is observed rather than asserted from the source text. */
  function recordingExecute(calls) {
    return async (command, args) => {
      calls.push({ command, args: [...args] });
      const isForgeMake = args.some((argument) => argument === 'make');
      const isHelperBuild = args.includes(helperBuildScript);
      if (isForgeMake) {
        const squirrelDir = path.join(makeRoot, 'squirrel.windows', 'x64');
        await mkdir(squirrelDir, { recursive: true });
        await writeFile(
          path.join(squirrelDir, `Chantivo-${version} Setup.exe`),
          Buffer.concat([Buffer.from('MZ', 'ascii'), Buffer.alloc(2048, 0x90)]),
        );
      }
      if (isHelperBuild) {
        await mkdir(helperBuildDir, { recursive: true });
        await writeFile(helperExePath, fakeAmd64PeFile());
      }
      return { stdout: '', stderr: '' };
    };
  }

  beforeEach(async () => {
    fixtureRoot = await mkdtemp(path.join(tmpdir(), 'chantivo-desktop-contract-'));
    makeRoot = path.join(fixtureRoot, 'out', 'make');
    releaseRoot = path.join(fixtureRoot, 'dist-release');
    helperDir = path.join(fixtureRoot, 'native', 'process-loopback-helper');
    helperBuildDir = path.join(helperDir, 'build');
    helperBuildScript = path.join(helperDir, 'build.ps1');
    helperExePath = path.join(helperBuildDir, 'process-loopback-helper.exe');
    version = (await readJson('package.json')).version;
  });

  afterEach(async () => {
    await rm(fixtureRoot, { recursive: true, force: true });
  });

  /** Every `buildWindowsArtifact` call in this describe block passes the same fixture-rooted helper
   * seams, so the real `packages/windows-media` tree on disk is never touched by this fixture-only
   * suite. */
  function buildArtifactOptions(execute) {
    return {
      execute,
      makeRoot,
      releaseRoot,
      helperDir,
      helperBuildDir,
      helperBuildScript,
      helperExePath,
    };
  }

  it('runs desktop-runtime prep, then the native helper build, then electron-forge make, in that order', async () => {
    const calls = [];

    const result = await buildWindowsArtifact(buildArtifactOptions(recordingExecute(calls)));

    expect(calls).toHaveLength(3);

    const [prepare, helperBuild, make] = calls;
    expect(prepare.args.slice(1)).toEqual([...DESKTOP_RUNTIME_TSC_ARGS]);
    expect(prepare.args[0]).toMatch(/typescript[\\/]/u);
    expect(helperBuild.args).toContain(helperBuildScript);
    expect(helperBuild.args).toContain('-NonInteractive');
    expect(make.args.slice(1)).toEqual(['make']);
    expect(make.args[0]).toMatch(/electron-forge/u);

    expect(result.artifactName).toBe(canonicalInstallerName(version));
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('spawns a real resolved executable for every child process, never a shell and never a .cmd/.bat shim', async () => {
    const calls = [];

    await buildWindowsArtifact(buildArtifactOptions(recordingExecute(calls)));

    for (const call of calls) {
      expect(path.isAbsolute(call.command)).toBe(true);
      const lower = call.command.toLowerCase();
      expect(lower.endsWith('.cmd')).toBe(false);
      expect(lower.endsWith('.bat')).toBe(false);
    }
    // Exactly one of the three calls is the resolved PowerShell executable (the native helper build);
    // the other two are `process.execPath` (tsc, then electron-forge).
    const nodeCalls = calls.filter((call) => call.command === process.execPath);
    expect(nodeCalls).toHaveLength(2);
    const otherCalls = calls.filter((call) => call.command !== process.execPath);
    expect(otherCalls).toHaveLength(1);
    expect(otherCalls[0].command.toLowerCase()).toMatch(/powershell\.exe$/u);
  });

  it('rebuilds the native helper unconditionally, removing any stale build/ output first', async () => {
    await mkdir(helperBuildDir, { recursive: true });
    await writeFile(path.join(helperBuildDir, 'stale-leftover.txt'), 'from a previous run');

    const calls = [];
    await buildWindowsArtifact(buildArtifactOptions(recordingExecute(calls)));

    // The stale file must be gone: buildProcessLoopbackHelper removes the whole build dir before
    // re-invoking build.ps1, exactly like buildWindowsArtifact already does for Forge's own makeRoot.
    await expect(stat(path.join(helperBuildDir, 'stale-leftover.txt'))).rejects.toThrow();
    // But the (fixture-simulated) freshly-built helper must exist and have passed validation.
    await expect(stat(helperExePath)).resolves.toBeDefined();
  });

  it('prepares the desktop runtime on every run, with no "already built?" short-circuit', async () => {
    const calls = [];
    const execute = recordingExecute(calls);

    await buildWindowsArtifact(buildArtifactOptions(execute));
    await buildWindowsArtifact(buildArtifactOptions(execute));

    const prepareCalls = calls.filter((call) =>
      call.args.slice(1).join(' ').includes(DESKTOP_RUNTIME_TSC_ARGS.join(' ')),
    );
    expect(prepareCalls).toHaveLength(2);
  });

  it('prepareDesktopRuntime is unconditional in isolation too', async () => {
    const calls = [];
    const execute = recordingExecute(calls);

    await prepareDesktopRuntime({ execute });
    await prepareDesktopRuntime({ execute });
    await prepareDesktopRuntime({ execute });

    expect(calls).toHaveLength(3);
    for (const call of calls) {
      expect(call.command).toBe(process.execPath);
      expect(call.args.slice(1)).toEqual([...DESKTOP_RUNTIME_TSC_ARGS]);
    }
  });
});

describe('build-windows-artifact.mjs child-process safety (DEP0190)', () => {
  /**
   * Node 22+ emits DEP0190 for `child_process` calls that combine `shell: true` with an argument
   * array, because a shell concatenates rather than escapes those arguments. This reads the real
   * source rather than mocking, matching this repo's existing "policy test reads real source"
   * approach in tests/repository/policies.test.mjs.
   */
  let code;

  /** Strips comments, so the assertions below describe what the script *does* rather than what its
   * (necessarily DEP0190-quoting) documentation says. The `[^:]` guard keeps `https://` URLs from
   * being mistaken for a line comment. */
  function stripComments(source) {
    return source.replace(/\/\*[\s\S]*?\*\//gu, '').replace(/(^|[^:])\/\/.*$/gmu, '$1');
  }

  beforeEach(async () => {
    code = stripComments(await readFile(windowsArtifactScriptPath, 'utf8'));
  });

  it('never passes a shell option to child_process', () => {
    expect(code).not.toMatch(/shell\s*:/u);
  });

  it('never spawns a Windows .cmd/.bat shim', () => {
    expect(code).not.toMatch(/\.(?:cmd|bat)['"`]/u);
    expect(code).not.toContain('pnpm.cmd');
  });

  it('imports only execFile from node:child_process, never the shell-running exec/execSync', () => {
    // `exec`/`execSync` run their single string argument through a shell, which is the manual
    // interpolation anti-pattern DEP0190 warns about. Only `execFile` (argv array, no shell) is
    // allowed here.
    const importMatch = /import\s*\{([^}]*)\}\s*from\s*'node:child_process'/u.exec(code);
    expect(importMatch, 'expected a named import from node:child_process').not.toBeNull();

    const imported = importMatch[1]
      .split(',')
      .map((name) => name.trim())
      .filter(Boolean)
      .sort();
    expect(imported).toEqual(['execFile']);
  });

  it('spawns only process.execPath or an explicitly resolved PowerShell executable — never a bare string or a shell', () => {
    const spawnedCommands = [...code.matchAll(/\bexecute\(\s*([^,]+),/gu)].map((match) =>
      match[1].trim(),
    );

    // `process.execPath` covers `tsc`/`electron-forge` (see resolveNodeCliEntry); `powershellPath` is
    // `resolveWindowsPowerShellExecutable`'s own return value, used only to build the native helper.
    // Both are variables holding a real, resolved on-disk path — never a literal string a shell could
    // reinterpret, and never a bare command name relying on `PATH`.
    const allowedIdentifiers = new Set(['process.execPath', 'powershellPath']);

    expect(spawnedCommands.length).toBeGreaterThan(0);
    for (const command of spawnedCommands) {
      expect(allowedIdentifiers.has(command)).toBe(true);
    }
  });
});

describe('canonical Windows installer filename', () => {
  it('is unchanged by this fix', () => {
    expect(canonicalInstallerName('0.1.1')).toBe('ChantivoSetup-0.1.1.exe');
    expect(canonicalInstallerName('1.2.3')).toBe('ChantivoSetup-1.2.3.exe');
  });
});
