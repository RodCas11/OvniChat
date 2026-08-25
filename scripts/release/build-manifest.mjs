import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** T15 — scans `dist-release/<version>/` for real, already-built artifacts and emits the two things
 * `install-chantivo.sh`/`chantivo-server update` actually trust: `SHA256SUMS` (plain
 * `sha256sum`-format, so `sha256sum -c` works directly against it — this is the file installers
 * verify against, not the JSON) and `release-manifest.json` (the same data plus display metadata, for
 * humans/tooling that want it structured). Never includes anything but the hash/size/name of files
 * that already exist on disk — no secret, no build-environment detail. */

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => {
      resolve(hash.digest('hex'));
    });
  });
}

function platformKindFor(filename) {
  if (filename.endsWith('.tar.gz')) return 'dedicated-server-tarball';
  if (filename.endsWith('.exe')) return 'desktop-installer';
  return 'unknown';
}

function platformNameFor(filename) {
  const match = /-(linux-x64|linux-arm64|win-x64)/u.exec(filename);
  return match ? match[1] : 'unknown';
}

async function readVersion() {
  const content = await readFile(path.join(repositoryRoot, 'package.json'), 'utf8');
  return JSON.parse(content).version;
}

async function currentGitCommit() {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: repositoryRoot });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

export async function buildManifest(version = undefined) {
  const resolvedVersion = version ?? (await readVersion());
  const releaseDir = path.join(repositoryRoot, 'dist-release', resolvedVersion);
  const entries = await readdir(releaseDir);
  const artifactFiles = entries.filter(
    (name) => name !== 'release-manifest.json' && name !== 'SHA256SUMS',
  );

  const artifacts = [];
  for (const filename of artifactFiles) {
    const filePath = path.join(releaseDir, filename);
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) continue;
    const sha256 = await sha256File(filePath);
    artifacts.push({
      name: filename,
      platform: platformNameFor(filename),
      kind: platformKindFor(filename),
      filename,
      sha256,
      sizeBytes: fileStat.size,
    });
  }

  const manifest = {
    product: 'Chantivo',
    version: resolvedVersion,
    releasedAt: new Date().toISOString(),
    gitCommit: await currentGitCommit(),
    artifacts,
  };

  await writeFile(
    path.join(releaseDir, 'release-manifest.json'),
    `${JSON.stringify(manifest, null, 2)}\n`,
    'utf8',
  );
  const sumsContent = artifacts.map((a) => `${a.sha256}  ${a.filename}\n`).join('');
  await writeFile(path.join(releaseDir, 'SHA256SUMS'), sumsContent, 'utf8');

  return manifest;
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  const [, , versionArg] = process.argv;
  const manifest = await buildManifest(versionArg);
  console.info(
    `Wrote release-manifest.json + SHA256SUMS for ${manifest.artifacts.length} artifact(s)`,
  );
}
