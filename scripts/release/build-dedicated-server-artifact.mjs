import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * T15 — produces the Linux Dedicated Server release tarball. Reuses the exact same pruning command
 * `services/dedicated-server/Dockerfile`'s build stage already uses (`pnpm deploy --prod
 * --config.inject-workspace-packages=true`), so the artifact this script produces and the artifact
 * inside the production Docker image are the same real thing, verified against the same real build
 * step — not two parallel implementations that could quietly drift apart.
 *
 * `--config.inject-workspace-packages=true` (not `--legacy`) was chosen during T14's Dockerfile work
 * after `--legacy` was found to silently re-resolve dependencies from the registry instead of this
 * repo's frozen lockfile; see the Dockerfile's own comment for the full story.
 */
async function readVersion() {
  const content = await readFile(path.join(repositoryRoot, 'package.json'), 'utf8');
  return JSON.parse(content).version;
}

export async function buildDedicatedServerArtifact({
  platform = process.platform === 'win32' ? 'linux' : process.platform,
  arch = process.arch,
} = {}) {
  const version = await readVersion();
  const stagingRoot = await mkdtemp(path.join(tmpdir(), 'chantivo-release-'));
  const deployDir = path.join(stagingRoot, 'chantivo-dedicated-server');

  // Windows resolves `pnpm` to `pnpm.cmd`, and Node's `child_process` cannot `spawn()` a `.cmd` file
  // directly without a shell (confirmed empirically here: `execFile('pnpm.cmd', ...)` with no shell
  // throws `spawn EINVAL` on Windows even though the same call works fine on POSIX with the real
  // `pnpm` binary) — `shell: true` is Windows' own documented requirement for this, not a style
  // choice. Every argument below is a static, hardcoded literal (no user input ever reaches this
  // array), so DEP0190's "arguments are concatenated, not escaped" risk is inert in practice; if this
  // function ever needs to accept a caller-supplied argument, that argument must be validated before
  // reaching this call, not trusted because this comment says today's arguments are safe.
  const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

  try {
    await execFileAsync(pnpmCommand, ['--filter', '@disco-voador/dedicated-server...', 'build'], {
      cwd: repositoryRoot,
      shell: true,
    });
    await execFileAsync(
      pnpmCommand,
      [
        '--filter',
        '@disco-voador/dedicated-server',
        'deploy',
        '--prod',
        '--config.inject-workspace-packages=true',
        deployDir,
      ],
      { cwd: repositoryRoot, shell: true },
    );

    const outDir = path.join(repositoryRoot, 'dist-release', version);
    await mkdir(outDir, { recursive: true });
    const artifactName = `chantivo-dedicated-server-${version}-${platform}-${arch}.tar.gz`;
    const artifactPath = path.join(outDir, artifactName);

    // `--no-same-owner`/`--no-same-permissions`: the archive's own permission bits should never be
    // trusted as authoritative once extracted on an arbitrary target host — the installer script
    // (T15) applies its own deliberate ownership/permissions after extraction. `-C stagingRoot .`
    // (not `-C deployDir`) so the archive's single top-level entry is `chantivo-dedicated-server/`,
    // matching what a `--one-top-level` extraction on the installer side expects. `--force-local`:
    // a real bug hit building this on Windows — GNU/bsdtar both parse a bare `X:` drive-letter
    // prefix (e.g. `E:\Codigos\...`) as an `ssh`-style `host:path` remote-archive address unless told
    // otherwise, and fail with "Cannot connect to E: resolve failed." `--force-local` is tar's own
    // documented escape hatch for exactly this ambiguity; it's a no-op on POSIX paths, so it's safe
    // to always pass, not just on win32.
    await execFileAsync('tar', [
      'czf',
      artifactPath,
      '--force-local',
      '--no-same-owner',
      '--no-same-permissions',
      '-C',
      stagingRoot,
      'chantivo-dedicated-server',
    ]);

    return { version, platform, arch, artifactName, artifactPath, outDir };
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  const result = await buildDedicatedServerArtifact();
  console.info(`Built ${result.artifactName}`);
}
