import { execFile } from 'node:child_process';
import { copyFile, mkdir, open, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
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
      `Electron Forge output directory not found: ${makeRoot} — expected \`pnpm --filter @disco-voador/desktop run make\` to create it.`,
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

export async function buildWindowsArtifact({ runMake = true } = {}) {
  if (runMake && process.platform !== 'win32') {
    throw new WindowsArtifactError(
      'UnsupportedPlatform',
      `The Squirrel Windows installer can only be built on win32 (current platform: ${process.platform}).`,
    );
  }

  const version = await readVersion();
  const makeRoot = forgeMakeRoot();

  if (runMake) {
    // Forge/electron-winstaller append to `out/make/squirrel.windows/<arch>/` without clearing it,
    // so a previous release's `Setup.exe` would still be sitting there and turn discovery into an
    // (correctly rejected, but pointlessly fatal) ambiguity. Removing Forge's *make* output before
    // rebuilding is the deterministic fix; the tree is fully regenerated by the command below, and
    // nothing else — including the packaged app under `out/Chantivo-win32-x64/` — is touched.
    await rm(makeRoot, { recursive: true, force: true });

    // Windows resolves `pnpm` to `pnpm.cmd`, which Node's `child_process` cannot spawn without a
    // shell; same rationale (and same static, caller-input-free argument list) as
    // `build-dedicated-server-artifact.mjs` — see its own comment for the full story.
    const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    await execFileAsync(pnpmCommand, ['--filter', '@disco-voador/desktop', 'run', 'make'], {
      cwd: repositoryRoot,
      shell: true,
      // A real Forge make of this app produces a ~140 MB installer and takes minutes; Node's default
      // 1 MB stdout buffer is comfortably exceeded by Forge's own progress output.
      maxBuffer: 64 * 1024 * 1024,
    });
  }

  const { installerPath, sizeBytes, embeddedVersion } = await discoverForgeInstaller({
    makeRoot,
    version,
  });

  const outDir = path.join(repositoryRoot, 'dist-release', version);
  await mkdir(outDir, { recursive: true });
  const artifactName = canonicalInstallerName(version);
  const artifactPath = path.join(outDir, artifactName);
  // Copy, never move: Forge's own output tree stays intact so a failed/retried publish step can be
  // re-run without repeating the whole Electron build.
  await copyFile(installerPath, artifactPath);

  return {
    version,
    artifactName,
    artifactPath,
    outDir,
    sourcePath: installerPath,
    sizeBytes,
    embeddedVersion,
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
    ].join('\n'),
  );
}
