import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, open, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * T15.1 — produces the Windows desktop release installer by running this repo's real, already-proven
 * Electron Forge production build (`apps/desktop`'s own `make` script → `@electron-forge/
 * maker-squirrel`), then locating and validating the genuine Squirrel `Setup.exe` it produced before
 * copying it to the canonical `dist-release/<version>/` location that
 * `build-dedicated-server-artifact.mjs` already writes into.
 *
 * This script is **self-contained**: it prepares the desktop runtime dependency graph itself (see
 * `DESKTOP_RUNTIME_TSC_ARGS`) rather than inheriting `dist/` output from a previous step. A GitHub
 * Actions job gets its own isolated runner and its own fresh checkout, so "the quality gate already
 * built everything" is never true for the `windows-build` job — that assumption is what produced the
 * real CI failure `Failed to resolve entry for package "@disco-voador/config"`. The same sequence
 * therefore holds identically for a developer running this locally, for `workflow_dispatch`, for a
 * tag-triggered build, and for a bare `pnpm install` + `node scripts/release/build-windows-
 * artifact.mjs` on an otherwise untouched checkout.
 *
 * The Forge output path is deliberately *discovered*, never assumed. `@electron-forge/maker-
 * squirrel@7.11.2`'s own `MakerSquirrel.make()` computes its output as
 * `<makeDir>/squirrel.windows/<targetArch>` and its installer filename as
 * `${appName}-${packageJSON.version} Setup.exe` — both are Forge's internal implementation detail
 * (read directly from the installed `MakerSquirrel.js`, not from its `.d.ts`), and either could
 * change with a Forge upgrade or a `MakerSquirrel` config edit. Hardcoding
 * `squirrel.windows/x64/Chantivo-<version> Setup.exe` would then silently either fail with a
 * misleading "file not found" or, worse, pick up a stale artifact from a previous build. So this
 * script walks `apps/desktop/out/make/` for `.exe` files and refuses to guess whenever the result is
 * anything other than exactly one candidate that passes every validation below.
 *
 * Code signing is explicitly out of scope: the Squirrel maker is configured without a certificate and
 * the installer this produces is unsigned. That is expected, not a defect to work around here.
 */

/** `apps/desktop`'s own directory — the cwd Electron Forge must run from, and the resolution base for
 * the locally installed CLIs this script invokes. */
const DESKTOP_PACKAGE_DIR = path.join(repositoryRoot, 'apps', 'desktop');

/**
 * T15.1 CI Blocker #4 — the process-loopback native helper contract.
 *
 * `apps/desktop/forge.config.ts`'s `packagerConfig.extraResource` packages
 * `packages/windows-media/native/process-loopback-helper/build/process-loopback-helper.exe` into every
 * Windows build. That file is generated and gitignored (see `.gitignore`, `packages/windows-media/
 * native/**\/build/`) — it is never a tracked source asset — so a genuinely clean checkout has no such
 * file until something actually compiles it. Before this fix, the only thing that ever produced it was
 * a human running `packages/windows-media/native/process-loopback-helper/build.ps1` by hand; a real
 * `windows-latest` CI checkout, or any other developer's fresh machine, would fail Forge packaging with
 * ENOENT on this exact path. These constants and `buildProcessLoopbackHelper`/
 * `validateProcessLoopbackHelperExecutable` below make that build automatic and unconditional, run
 * before `runForgeMake` inside `buildWindowsArtifact`.
 *
 * The path segments mirror `forge.config.ts`'s own `processLoopbackHelperExePath` construction exactly
 * (`packages/windows-media/native/process-loopback-helper/build/process-loopback-helper.exe`, resolved
 * from each file's own real on-disk location rather than from any shared import — `forge.config.ts` is
 * loaded directly by Electron Forge's own TypeScript loader, and this script is a plain `.mjs` run by
 * bare `node`, so a shared imported module would need to work identically under both loaders for no
 * real benefit over two independently-verifiable literals). `tests/repository/
 * windows-native-helper-packaging.test.mjs` reads both files' real source text and asserts the segment
 * lists stay identical, so the two cannot silently drift apart.
 */
export const PROCESS_LOOPBACK_HELPER_DIR = path.join(
  repositoryRoot,
  'packages',
  'windows-media',
  'native',
  'process-loopback-helper',
);

/** The build script this repo treats as the single source of truth for the actual compiler/linker
 * invocation (flags, libs, `/MT` static CRT) — never duplicated here or in any GitHub workflow YAML. */
const PROCESS_LOOPBACK_HELPER_BUILD_SCRIPT = path.join(PROCESS_LOOPBACK_HELPER_DIR, 'build.ps1');

/** `build.ps1`'s own gitignored output directory. Removed before every rebuild (see
 * `buildProcessLoopbackHelper`) so a stale helper left over from an earlier run can never be mistaken
 * for a fresh one. */
export const PROCESS_LOOPBACK_HELPER_BUILD_DIR = path.join(PROCESS_LOOPBACK_HELPER_DIR, 'build');

export const PROCESS_LOOPBACK_HELPER_EXE_PATH = path.join(
  PROCESS_LOOPBACK_HELPER_BUILD_DIR,
  'process-loopback-helper.exe',
);

/** `IMAGE_FILE_MACHINE_AMD64` from `winnt.h` — the PE `IMAGE_FILE_HEADER.Machine` value for x64. This
 * repository targets Windows 10/11 **x64** only (see `CLAUDE.md`); a helper compiled for any other
 * architecture (e.g. an ARM64 cross-compile, or a stale x86 build from a differently-configured
 * `vcvars` script) must never be silently packaged and shipped. */
const IMAGE_FILE_MACHINE_AMD64 = 0x8664;

/** The 4-byte `"PE\0\0"` signature that immediately precedes the `IMAGE_FILE_HEADER` at the file offset
 * recorded in the DOS header's `e_lfanew` field (bytes 0x3C–0x3F). */
const PE_SIGNATURE = Buffer.from([0x50, 0x45, 0x00, 0x00]);

/**
 * T15.1 CI fix — the desktop build contract.
 *
 * Every `@disco-voador/*` workspace package declares `"main": "dist/index.js"` with no `exports` map
 * and no source fallback, so `apps/desktop`'s Vite/Rollup build (run by `@electron-forge/plugin-vite`
 * inside `electron-forge make`) resolves them as ordinary `node_modules` packages whose **compiled
 * output must already exist on disk**. A genuinely clean checkout + `pnpm install` has no `dist/`
 * anywhere, and the real `windows-build` GitHub Actions job runs on its own isolated runner and
 * checkout — whatever the separate `quality-gate` job built lives on a different machine's
 * filesystem. That is the real, observed CI failure this constant exists to prevent:
 *
 *   Failed to resolve entry for package "@disco-voador/config".
 *
 * `tsc -b apps/desktop` is the narrowest command that fixes it: TypeScript's own project-reference
 * cascade walks `apps/desktop/tsconfig.json`'s `references` and builds config, identity, media-core,
 * protocol, rtc-core, shared and windows-media (plus `shared`'s own reference to protocol) before
 * `apps/desktop` itself. That reference list is 1:1 with `apps/desktop/package.json`'s
 * `@disco-voador/*` dependencies — verified directly, and re-verified by
 * `tests/repository/desktop-build-contract.test.mjs` so the two cannot silently drift apart.
 * Enumerating the seven package paths here instead would duplicate that list and rot the first time a
 * dependency is added.
 *
 * Kept identical to the root `build:desktop-runtime` script (asserted by that same test), so the
 * command a developer runs by hand and the command CI runs are the same real thing.
 */
export const DESKTOP_RUNTIME_TSC_ARGS = Object.freeze(['-b', 'apps/desktop', '--pretty', 'false']);

/** What `apps/desktop`'s `make` script must contain for this script's direct CLI invocation (below)
 * to be equivalent to `pnpm --filter @disco-voador/desktop run make`. */
const EXPECTED_DESKTOP_MAKE_SCRIPT = 'electron-forge make';

/** The only tree this script will ever read an installer out of. Note this is `out/make`, not `out`:
 * `electron-forge package`'s own raw packaged-app directory (`out/Chantivo-win32-x64/Chantivo.exe`)
 * is a real `.exe` too, and must never be mistaken for the installer. */
const FORGE_MAKE_RELATIVE_ROOT = path.join('apps', 'desktop', 'out', 'make');

/** DOS/PE magic number. Every real Windows executable — including a Squirrel `Setup.exe` — starts
 * with the two ASCII bytes `MZ` (0x4D 0x5A). Checking these two bytes is enough to catch "this file
 * is not actually an executable" (a truncated download, an HTML error page saved with an `.exe`
 * name, a text placeholder) without pulling in a PE-parsing dependency for a build script. It is
 * deliberately *not* an integrity or authenticity check — that is what `SHA256SUMS` (a separate
 * script) and, eventually, code signing are for. */
const PE_MAGIC = Buffer.from('MZ', 'ascii');

/** Matches a plain `MAJOR.MINOR.PATCH` token delimited by `-`, `_`, space, or a path/extension dot,
 * so `Chantivo-0.1.0 Setup.exe` yields `0.1.0`. Intentionally conservative: if Forge's naming ever
 * changes to something without a recognisable version token, this returns `undefined` and the
 * cross-check is skipped rather than failing on a naming convention this script cannot actually
 * observe. */
const EMBEDDED_VERSION_PATTERN = /(?:^|[-_ ])(\d+\.\d+\.\d+)(?=[-_ .]|$)/u;

class WindowsArtifactError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'WindowsArtifactError';
    /** Stable machine-readable discriminator so CI can report *which* failure happened rather than
     * a generic "build failed". Never change an existing value without updating callers. */
    this.code = code;
  }
}

async function readVersion() {
  const content = await readFile(path.join(repositoryRoot, 'package.json'), 'utf8');
  return JSON.parse(content).version;
}

/** The canonical release filename. Space-free and prefix-stable (unlike Forge's own
 * `Chantivo-<version> Setup.exe`, whose embedded space is hostile to URLs, `sha256sum -c`, and
 * shell one-liners), so the published artifact name is decided here rather than inherited from a
 * Forge implementation detail. */
export function canonicalInstallerName(version) {
  return `ChantivoSetup-${version}.exe`;
}

export function forgeMakeRoot(root = repositoryRoot) {
  return path.join(root, FORGE_MAKE_RELATIVE_ROOT);
}

/** True only when `candidate` is a real descendant of `directory`. Uses `path.relative` rather than
 * a string `startsWith`, which would wrongly accept a sibling like `out/make-evil/x.exe`. */
export function isWithinDirectory(candidate, directory) {
  const relative = path.relative(path.resolve(directory), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export function extractEmbeddedVersion(filename) {
  const match = EMBEDDED_VERSION_PATTERN.exec(path.basename(filename, path.extname(filename)));
  return match ? match[1] : undefined;
}

/** Recursively collects every regular `.exe` file under `makeRoot`. Uses `withFileTypes` and skips
 * symlinks outright (`isFile()`/`isDirectory()` are both false for a symlink entry), so no link
 * planted inside the output tree can widen the search beyond it. */
export async function collectExecutableCandidates(makeRoot) {
  const found = [];
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile() && path.extname(entry.name).toLowerCase() === '.exe') {
        found.push(entryPath);
      }
    }
  };
  await walk(makeRoot);
  return found.sort((a, b) => a.localeCompare(b));
}

/**
 * Locates and fully validates the single genuine Squirrel installer under `makeRoot`. Throws a
 * `WindowsArtifactError` with a specific `code` for every distinct failure mode — the caller (CI)
 * needs to distinguish "Forge produced nothing" from "Forge produced two things" from "Forge
 * produced a corrupt thing", because those have completely different causes and fixes.
 */
export async function discoverForgeInstaller({ makeRoot, version } = {}) {
  let resolvedRoot;
  try {
    resolvedRoot = await realpath(makeRoot);
  } catch {
    throw new WindowsArtifactError(
      'ForgeOutputMissing',
      `Electron Forge output directory not found: ${makeRoot} — expected \`electron-forge make\` (run for apps/desktop) to create it.`,
    );
  }

  const candidates = await collectExecutableCandidates(resolvedRoot);

  if (candidates.length === 0) {
    throw new WindowsArtifactError(
      'NoInstallerCandidate',
      `No .exe candidate found under ${resolvedRoot} — Electron Forge's Squirrel maker produced no Windows installer.`,
    );
  }

  if (candidates.length > 1) {
    const listed = candidates.map((c) => `- ${path.relative(resolvedRoot, c)}`).join('\n');
    throw new WindowsArtifactError(
      'AmbiguousInstallerCandidates',
      `Expected exactly 1 .exe under ${resolvedRoot}, found ${candidates.length} — refusing to guess which one is the real Squirrel installer. Delete the Forge make output and rebuild. Found:\n${listed}`,
    );
  }

  const [installerPath] = candidates;
  // Defence in depth: the walk above only descends real directories inside `resolvedRoot`, so this
  // should be unreachable. It exists so that a future widening of the search (a broader glob, an
  // added `makeRoot` override) cannot silently start copying files from outside Forge's own tree.
  if (!isWithinDirectory(installerPath, resolvedRoot)) {
    throw new WindowsArtifactError(
      'InstallerOutsideForgeOutput',
      `Resolved installer ${installerPath} is outside the expected Forge output tree ${resolvedRoot} — refusing to copy it.`,
    );
  }

  const fileStat = await stat(installerPath);
  if (fileStat.size === 0) {
    throw new WindowsArtifactError(
      'EmptyInstaller',
      `Installer ${installerPath} is 0 bytes — Electron Forge produced an empty file.`,
    );
  }

  const header = Buffer.alloc(PE_MAGIC.length);
  const handle = await open(installerPath, 'r');
  let bytesRead;
  try {
    const read = await handle.read(header, 0, PE_MAGIC.length, 0);
    bytesRead = read.bytesRead;
  } finally {
    await handle.close();
  }
  if (bytesRead < PE_MAGIC.length || !header.equals(PE_MAGIC)) {
    throw new WindowsArtifactError(
      'InvalidExecutableHeader',
      `Installer ${installerPath} does not start with the "MZ" DOS/PE magic bytes (found ${JSON.stringify(header.subarray(0, bytesRead).toString('latin1'))}) — this is not a Windows executable.`,
    );
  }

  // Forge embeds `apps/desktop/package.json`'s version in the installer filename, while `version`
  // here comes from the root `package.json`; a mismatch therefore also catches the two drifting
  // apart (what `scripts/verify-version.mjs` guards independently). Skipped entirely when Forge's
  // filename carries no recognisable version token — see EMBEDDED_VERSION_PATTERN.
  const embeddedVersion = extractEmbeddedVersion(installerPath);
  if (version !== undefined && embeddedVersion !== undefined && embeddedVersion !== version) {
    throw new WindowsArtifactError(
      'InstallerVersionMismatch',
      `Installer "${path.basename(installerPath)}" embeds version ${embeddedVersion} but the resolved release version is ${version} — refusing to publish a mismatched artifact.`,
    );
  }

  return { installerPath, sizeBytes: fileStat.size, embeddedVersion };
}

/**
 * Resolves a locally installed CLI's real JavaScript entry point, so it can be run as
 * `node <entry> …` instead of through a `.cmd`/`.bat` shim.
 *
 * Why this exists at all: on Windows `pnpm`/`tsc`/`electron-forge` on `PATH` are `.cmd` shims, and
 * Node's `child_process` cannot `spawn()` a `.cmd` file without a shell (`execFile('pnpm.cmd', …)`
 * with `shell: false` throws `spawn EINVAL` — confirmed empirically in this repo). Passing
 * `shell: true` *with an argument array* is exactly the shape Node 22+ flags as **DEP0190**
 * ("Passing args to a child process with shell option true can lead to security vulnerabilities, as
 * the arguments are not escaped, only concatenated") — and Node fires that on the shape of the call,
 * not on whether today's arguments happen to be static literals. Building a hand-interpolated shell
 * string instead would *be* the vulnerability the deprecation warns about.
 *
 * Resolving the entry `.js` and spawning `process.execPath` sidesteps both horns: no shell is
 * involved (so no DEP0190, and arguments are passed as a real argv array that no shell ever parses)
 * and no `.cmd` is spawned (so no `EINVAL`). It is also the most hermetic option available here —
 * it depends only on what `pnpm install` guarantees on disk, never on `PATH`, on which package
 * manager launched this script, or on pnpm being reachable at all. `createRequire` from
 * `apps/desktop` means Node's ordinary upward resolution finds the package whether pnpm hoisted it
 * to the repository root (this workspace's `nodeLinker: hoisted`) or nested it under `apps/desktop`.
 */
async function resolveNodeCliEntry(packageName, binName) {
  const requireFromDesktop = createRequire(path.join(DESKTOP_PACKAGE_DIR, 'noop.cjs'));
  let manifestPath;
  try {
    manifestPath = requireFromDesktop.resolve(`${packageName}/package.json`);
  } catch {
    throw new WindowsArtifactError(
      'BuildToolMissing',
      `Cannot resolve ${packageName} from ${DESKTOP_PACKAGE_DIR} — run \`pnpm install\` before building the Windows installer.`,
    );
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName];
  if (typeof bin !== 'string' || bin.length === 0) {
    throw new WindowsArtifactError(
      'BuildToolMissing',
      `${packageName} declares no "${binName}" bin entry — refusing to guess where its CLI lives.`,
    );
  }
  return path.resolve(path.dirname(manifestPath), bin);
}

/**
 * Resolves the real, on-disk Windows PowerShell executable rather than relying on `PATH` — the same
 * "no `.cmd`/shell shim, no `PATH` dependency" discipline `resolveNodeCliEntry` already applies to the
 * Node-based CLIs above. `windows-latest` GitHub Actions runners (and every real Windows 10/11 install)
 * ship Windows PowerShell 5.1 at this exact, well-known path regardless of what a later-installed
 * PowerShell 7 (`pwsh.exe`) may or may not add to `PATH`; `build.ps1` itself only uses syntax compatible
 * with Windows PowerShell 5.1 (confirmed by this same script actually invoking it), so resolving that
 * specific, always-present binary — never whatever `powershell`/`pwsh` a shell's `PATH` happens to
 * resolve first — is what makes this invocation deterministic rather than environment-dependent.
 */
async function resolveWindowsPowerShellExecutable() {
  const systemRoot = process.env.SystemRoot ?? 'C:\\Windows';
  const powershellPath = path.join(
    systemRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  try {
    await stat(powershellPath);
  } catch {
    throw new WindowsArtifactError(
      'PowerShellMissing',
      `Windows PowerShell not found at ${powershellPath} — cannot build the process-loopback native helper without it.`,
    );
  }
  return powershellPath;
}

/**
 * Builds `process-loopback-helper.exe` from source via `packages/windows-media`'s own canonical
 * `build:native-helper` script (`build.ps1`) — the single source of truth for the actual compiler/
 * linker invocation; this function only decides *when* and *how* to invoke it, never what flags it
 * passes to `cl`/`link`.
 *
 * Deliberately **unconditional**, matching `prepareDesktopRuntime`'s own "no already-built?
 * short-circuit" discipline: `PROCESS_LOOPBACK_HELPER_BUILD_DIR` is removed first so a stale helper
 * left over from an earlier run (a different source revision, a different architecture, a partially
 * written previous build) is never trusted — the same reasoning `buildWindowsArtifact` already applies
 * to Forge's own `makeRoot` before every `runMake`.
 *
 * Invoked via an explicit, resolved `powershell.exe` path and a plain argv array (`-NoProfile`,
 * `-NonInteractive`, `-ExecutionPolicy Bypass`, `-File <build.ps1>`) — never a shell string, for the
 * exact DEP0190 reason documented on `resolveNodeCliEntry`/`runForgeMake`.
 *
 * `helperDir`/`buildDir`/`buildScript`/`helperPath` are injection seams for the test suite only, the
 * same pattern `buildWindowsArtifact`'s own `makeRoot`/`releaseRoot` already use — every default is the
 * real repository location.
 */
export async function buildProcessLoopbackHelper({
  execute = execFileAsync,
  helperDir = PROCESS_LOOPBACK_HELPER_DIR,
  buildDir = PROCESS_LOOPBACK_HELPER_BUILD_DIR,
  buildScript = PROCESS_LOOPBACK_HELPER_BUILD_SCRIPT,
  helperPath = PROCESS_LOOPBACK_HELPER_EXE_PATH,
} = {}) {
  await rm(buildDir, { recursive: true, force: true });

  const powershellPath = await resolveWindowsPowerShellExecutable();
  await execute(
    powershellPath,
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', buildScript],
    { cwd: helperDir, maxBuffer: 64 * 1024 * 1024 },
  );

  return { helperPath, powershellPath };
}

/**
 * Validates that `helperPath` is a genuine, non-empty, x64 Windows PE executable — the same category
 * of "this is not just a name on disk, it is a real executable" proof `discoverForgeInstaller` already
 * applies to the Squirrel `Setup.exe`, extended here with a machine-type check (this project targets
 * Windows 10/11 **x64** only) via a lightweight manual DOS/PE header parse rather than a new dependency.
 *
 * DOS/PE layout relied on here (see Microsoft's PE format documentation): the DOS header's `e_lfanew`
 * field (a 4-byte little-endian offset) at bytes 0x3C–0x3F points to the real PE header, which begins
 * with the 4-byte `"PE\0\0"` signature immediately followed by a 2-byte little-endian
 * `IMAGE_FILE_HEADER.Machine` field — `0x8664` for x64 (`IMAGE_FILE_MACHINE_AMD64`).
 */
export async function validateProcessLoopbackHelperExecutable(helperPath) {
  let fileStat;
  try {
    fileStat = await stat(helperPath);
  } catch {
    throw new WindowsArtifactError(
      'ProcessLoopbackHelperMissing',
      `${helperPath} does not exist — build.ps1 reported success but produced no output, or was never run.`,
    );
  }

  if (!fileStat.isFile()) {
    throw new WindowsArtifactError(
      'ProcessLoopbackHelperNotAFile',
      `${helperPath} exists but is not a regular file.`,
    );
  }

  if (fileStat.size === 0) {
    throw new WindowsArtifactError(
      'ProcessLoopbackHelperEmpty',
      `${helperPath} is 0 bytes — build.ps1 produced an empty file.`,
    );
  }

  const handle = await open(helperPath, 'r');
  try {
    const dosHeader = Buffer.alloc(0x40);
    const { bytesRead: dosBytesRead } = await handle.read(dosHeader, 0, dosHeader.length, 0);
    if (dosBytesRead < dosHeader.length || !dosHeader.subarray(0, 2).equals(PE_MAGIC)) {
      throw new WindowsArtifactError(
        'ProcessLoopbackHelperInvalidHeader',
        `${helperPath} does not start with the "MZ" DOS/PE magic bytes — this is not a Windows executable.`,
      );
    }

    const peHeaderOffset = dosHeader.readUInt32LE(0x3c);
    const peHeader = Buffer.alloc(6);
    const { bytesRead: peBytesRead } = await handle.read(
      peHeader,
      0,
      peHeader.length,
      peHeaderOffset,
    );
    if (peBytesRead < peHeader.length || !peHeader.subarray(0, 4).equals(PE_SIGNATURE)) {
      throw new WindowsArtifactError(
        'ProcessLoopbackHelperInvalidHeader',
        `${helperPath} has no valid "PE\\0\\0" signature at DOS-header-declared offset ${peHeaderOffset} — this is not a valid PE executable.`,
      );
    }

    const machineType = peHeader.readUInt16LE(4);
    if (machineType !== IMAGE_FILE_MACHINE_AMD64) {
      throw new WindowsArtifactError(
        'ProcessLoopbackHelperWrongArchitecture',
        `${helperPath} has PE machine type 0x${machineType.toString(16)}, expected x64 (0x${IMAGE_FILE_MACHINE_AMD64.toString(16)}) — refusing to package a non-x64 helper for this x64-only product.`,
      );
    }

    return { sizeBytes: fileStat.size, machineType };
  } finally {
    await handle.close();
  }
}

/** Streams `filePath` through SHA-256 rather than reading it whole into memory — the real Squirrel
 * `Setup.exe` this guards is ~140 MB (see `runForgeMake`'s own comment). */
async function sha256File(filePath) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

/**
 * Compiles every workspace package `apps/desktop` depends on (and `apps/desktop` itself) via the
 * project-reference cascade described on `DESKTOP_RUNTIME_TSC_ARGS`.
 *
 * Deliberately **unconditional**: there is no "is it already built?" short-circuit. An incremental
 * `tsc -b` is already a no-op-with-a-timestamp-check when the output is current, so a guard here
 * would buy nothing and would reintroduce exactly the assumption that broke CI — that some earlier
 * step, on some other machine, already produced usable `dist/` output.
 */
export async function prepareDesktopRuntime({ execute = execFileAsync } = {}) {
  const tscEntry = await resolveNodeCliEntry('typescript', 'tsc');
  await execute(process.execPath, [tscEntry, ...DESKTOP_RUNTIME_TSC_ARGS], {
    cwd: repositoryRoot,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { tscEntry, args: [...DESKTOP_RUNTIME_TSC_ARGS] };
}

/**
 * Runs the real `electron-forge make` for `apps/desktop`.
 *
 * This invokes Forge's own CLI entry directly rather than `pnpm --filter @disco-voador/desktop run
 * make`, for the `.cmd`/DEP0190 reason documented on `resolveNodeCliEntry`. The equivalence that
 * makes the substitution safe — that `apps/desktop`'s `make` script is exactly `electron-forge make`,
 * with no pre/post script and no extra flags — is asserted here rather than assumed, so adding a
 * `premake` step or a flag to that script fails loudly instead of being silently skipped by a release
 * build.
 */
export async function runForgeMake({ execute = execFileAsync } = {}) {
  const manifest = JSON.parse(
    await readFile(path.join(DESKTOP_PACKAGE_DIR, 'package.json'), 'utf8'),
  );
  const makeScript = manifest.scripts?.make;
  const hasPrePostHook =
    manifest.scripts?.premake !== undefined || manifest.scripts?.postmake !== undefined;
  if (makeScript?.trim() !== EXPECTED_DESKTOP_MAKE_SCRIPT || hasPrePostHook) {
    throw new WindowsArtifactError(
      'UnexpectedDesktopMakeScript',
      `apps/desktop's "make" script is ${JSON.stringify(makeScript)}${hasPrePostHook ? ' and declares a premake/postmake hook' : ''}, but this release script invokes Electron Forge's CLI directly on the assumption it is exactly ${JSON.stringify(EXPECTED_DESKTOP_MAKE_SCRIPT)} with no hooks. Update this script to match, rather than letting a release silently skip part of the desktop build.`,
    );
  }

  const forgeEntry = await resolveNodeCliEntry('@electron-forge/cli', 'electron-forge');
  await execute(process.execPath, [forgeEntry, 'make'], {
    cwd: DESKTOP_PACKAGE_DIR,
    // A real Forge make of this app produces a ~140 MB installer and takes minutes; Node's default
    // 1 MB stdout buffer is comfortably exceeded by Forge's own progress output.
    maxBuffer: 64 * 1024 * 1024,
  });
  return { forgeEntry };
}

/**
 * `execute`, `makeRoot` and `releaseRoot` are injection seams for the test suite only — every default
 * is the real thing, so the production call sites (`--skip-make` included) pass nothing at all and a
 * misconfigured caller cannot redirect a real release build somewhere unexpected.
 */
export async function buildWindowsArtifact({
  runMake = true,
  execute = execFileAsync,
  makeRoot = forgeMakeRoot(),
  releaseRoot = path.join(repositoryRoot, 'dist-release'),
  helperDir = PROCESS_LOOPBACK_HELPER_DIR,
  helperBuildDir = PROCESS_LOOPBACK_HELPER_BUILD_DIR,
  helperBuildScript = PROCESS_LOOPBACK_HELPER_BUILD_SCRIPT,
  helperExePath = PROCESS_LOOPBACK_HELPER_EXE_PATH,
} = {}) {
  if (runMake && process.platform !== 'win32') {
    throw new WindowsArtifactError(
      'UnsupportedPlatform',
      `The Squirrel Windows installer can only be built on win32 (current platform: ${process.platform}).`,
    );
  }

  const version = await readVersion();

  if (runMake) {
    // Forge/electron-winstaller append to `out/make/squirrel.windows/<arch>/` without clearing it,
    // so a previous release's `Setup.exe` would still be sitting there and turn discovery into an
    // (correctly rejected, but pointlessly fatal) ambiguity. Removing Forge's *make* output before
    // rebuilding is the deterministic fix; the tree is fully regenerated by the command below, and
    // nothing else — including the packaged app under `out/Chantivo-win32-x64/` — is touched.
    await rm(makeRoot, { recursive: true, force: true });

    // Step 1 of 3, and it must stay first: Forge's Vite build resolves `@disco-voador/*` through
    // their compiled `dist/` output, which does not exist yet on a clean checkout. See
    // `DESKTOP_RUNTIME_TSC_ARGS`. This script assumes nothing about what any earlier CI job, on any
    // other runner, may or may not have built.
    console.info(
      `[1/3] Building desktop runtime dependencies: tsc ${DESKTOP_RUNTIME_TSC_ARGS.join(' ')}`,
    );
    await prepareDesktopRuntime({ execute });

    // Step 2 of 3, and it must run before Forge: `apps/desktop/forge.config.ts`'s
    // `packagerConfig.extraResource` packages `process-loopback-helper.exe` by path, and Forge does not
    // build it — it only copies whatever already exists there. Unconditional and self-contained for the
    // same reason as step 1: no assumption that a human already ran `build.ps1` by hand on this machine.
    console.info('[2/3] Building process-loopback-helper.exe from source (build.ps1)…');
    const { helperPath } = await buildProcessLoopbackHelper({
      execute,
      helperDir,
      buildDir: helperBuildDir,
      buildScript: helperBuildScript,
      helperPath: helperExePath,
    });
    const { sizeBytes: helperSizeBytes } =
      await validateProcessLoopbackHelperExecutable(helperPath);
    console.info(
      `      Built and validated ${helperPath} (${helperSizeBytes} bytes, x64 PE executable).`,
    );

    // Step 3 of 3: the real Electron Forge production build.
    console.info('[3/3] Running electron-forge make for apps/desktop (several minutes)…');
    await runForgeMake({ execute });
  }

  const { installerPath, sizeBytes, embeddedVersion } = await discoverForgeInstaller({
    makeRoot,
    version,
  });

  const outDir = path.join(releaseRoot, version);
  await mkdir(outDir, { recursive: true });
  const artifactName = canonicalInstallerName(version);
  const artifactPath = path.join(outDir, artifactName);
  // Copy, never move: Forge's own output tree stays intact so a failed/retried publish step can be
  // re-run without repeating the whole Electron build.
  await copyFile(installerPath, artifactPath);

  // Verify the copy is byte-identical to Forge's own output before trusting it as the release artifact
  // — a partial/corrupted copy (a full disk, an interrupted process) must fail loudly here rather than
  // silently publishing a broken installer downstream.
  const [sourceSha256, artifactSha256] = await Promise.all([
    sha256File(installerPath),
    sha256File(artifactPath),
  ]);
  if (sourceSha256 !== artifactSha256) {
    throw new WindowsArtifactError(
      'InstallerCopyIntegrityMismatch',
      `Copied installer ${artifactPath} (sha256 ${artifactSha256}) does not match its source ${installerPath} (sha256 ${sourceSha256}) — refusing to publish a corrupted copy.`,
    );
  }

  return {
    version,
    artifactName,
    artifactPath,
    outDir,
    sourcePath: installerPath,
    sizeBytes,
    embeddedVersion,
    sha256: artifactSha256,
  };
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  const result = await buildWindowsArtifact({ runMake: !process.argv.includes('--skip-make') });
  const megabytes = (result.sizeBytes / (1024 * 1024)).toFixed(1);
  console.info(
    [
      `Built Chantivo Windows installer ${result.version}`,
      `  source: ${result.sourcePath}`,
      `  output: ${result.artifactPath}`,
      `  size:   ${result.sizeBytes} bytes (${megabytes} MiB)`,
      `  sha256: ${result.sha256}`,
    ].join('\n'),
  );
}
