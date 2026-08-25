import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * T15.1 — the installer's release-source default, `--version` flag, stable-channel resolution, and
 * download-integrity behaviour, exercised against the REAL
 * `infrastructure/install/install-chantivo.sh` by sourcing it in a real Bash shell — never against a
 * transcription of its logic. The script guards its own `main "$@"` invocation with a
 * `BASH_SOURCE[0] = $0` check exactly so this is possible: sourcing defines the functions and mutates
 * nothing on the host.
 *
 * Skipped (never silently passed) where Bash or sha256sum is unavailable — the assertions are about a
 * Bash script's real behaviour, and a fabricated substitute would be worse than an honest skip.
 */

const repositoryRoot = process.cwd();
const installerPath = path
  .join(repositoryRoot, 'infrastructure/install/install-chantivo.sh')
  .replaceAll('\\', '/');

function toolAvailable(command) {
  try {
    execFileSync('bash', ['-c', `command -v ${command} >/dev/null 2>&1`], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function bashAvailable() {
  try {
    execFileSync('bash', ['-c', 'exit 0'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const hasBash = bashAvailable();
const hasSha256sum = hasBash && toolAvailable('sha256sum');
const hasTar = hasBash && toolAvailable('tar');

function runInInstaller(lines, { env = {} } = {}) {
  const script = ['set -Eeuo pipefail', `source "${installerPath}" >/dev/null 2>&1`, ...lines].join(
    '\n',
  );
  return execFileSync('bash', ['-c', script], {
    encoding: 'utf8',
    stdio: 'pipe',
    env: { ...process.env, ...env },
  });
}

function runExpectingFailure(lines, options = {}) {
  try {
    runInInstaller(lines, options);
    return undefined;
  } catch (error) {
    return String(error.stderr ?? '');
  }
}

const sha256 = (buffer) => createHash('sha256').update(buffer).digest('hex');

describe.skipIf(!hasBash)('install-chantivo.sh — release source default and override', () => {
  it('defaults to the public distribution host when nothing is configured', () => {
    const output = runInInstaller(
      ['printf "%s|%s\\n" "$RELEASE_SOURCE" "$RELEASE_SOURCE_EXPLICIT"'],
      {
        env: { CHANTIVO_RELEASE_SOURCE: '' },
      },
    );
    expect(output.trim()).toBe('https://downloads.chantivo.app|0');
  });

  it('never defaults to a GitHub raw URL or to a Chantivo-operated deployment', () => {
    const source = runInInstaller(['printf "%s" "$DEFAULT_RELEASE_SOURCE"']);
    expect(source).not.toMatch(/githubusercontent|github\.com/iu);
    expect(source).not.toContain('beta.chantivo.app');
    expect(source.startsWith('https://')).toBe(true);
  });

  it('honours $CHANTIVO_RELEASE_SOURCE and marks it explicit', () => {
    const output = runInInstaller(
      ['printf "%s|%s\\n" "$RELEASE_SOURCE" "$RELEASE_SOURCE_EXPLICIT"'],
      {
        env: { CHANTIVO_RELEASE_SOURCE: 'file:///opt/mirror/dist-release/0.1.1' },
      },
    );
    expect(output.trim()).toBe('file:///opt/mirror/dist-release/0.1.1|1');
  });

  it('honours --release-source, in both spellings, over the default', () => {
    for (const args of [
      '--release-source https://mirror.example.test',
      '--release-source=https://mirror.example.test',
    ]) {
      const output = runInInstaller([
        `parse_args ${args}`,
        'printf "%s|%s\\n" "$RELEASE_SOURCE" "$RELEASE_SOURCE_EXPLICIT"',
      ]);
      expect(output.trim()).toBe('https://mirror.example.test|1');
    }
  });

  it('accepts --version in both spellings', () => {
    for (const args of ['--version 0.1.1', '--version=0.1.1']) {
      expect(runInInstaller([`parse_args ${args}`, 'printf "%s" "$RELEASE_VERSION_ARG"'])).toBe(
        '0.1.1',
      );
    }
  });
});

describe.skipIf(!hasBash)('install-chantivo.sh — release location resolution', () => {
  let fixtureRoot;

  beforeAll(() => {
    fixtureRoot = mkdtempSync(path.join(tmpdir(), 'chantivo-installer-fixture-'));
    mkdirSync(path.join(fixtureRoot, 'base/channels'), { recursive: true });
    mkdirSync(path.join(fixtureRoot, 'base/releases/0.1.1'), { recursive: true });
    writeFileSync(
      path.join(fixtureRoot, 'base/channels/stable.json'),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          channel: 'stable',
          version: '0.1.1',
          releaseBaseUrl: 'https://downloads.example.test/releases/0.1.1',
          manifestUrl: 'https://downloads.example.test/releases/0.1.1/release-manifest.json',
        },
        null,
        2,
      )}\n`,
    );
  });

  afterAll(() => {
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  const resolve = (lines) =>
    runInInstaller([
      ...lines,
      'resolve_release_location',
      'printf "%s|%s|%s\\n" "$RELEASE_DIR_URI" "$RELEASE_VERSION_ARG" "$RELEASE_SOURCE_NOTE"',
    ]);

  it('resolves an explicit --version to releases/<version>/ under the source', () => {
    const [dir, version, note] = resolve([
      "RELEASE_SOURCE='https://downloads.example.test'",
      "RELEASE_VERSION_ARG='0.1.1'",
    ])
      .trim()
      .split('|');
    expect(dir).toBe('https://downloads.example.test/releases/0.1.1');
    expect(version).toBe('0.1.1');
    expect(note).toContain('requested version 0.1.1');
  });

  it('follows channels/stable.json when no --version is given', () => {
    const [dir, version, note] = resolve([
      `RELEASE_SOURCE='${fixtureRoot.replaceAll('\\', '/')}/base'`,
      'RELEASE_SOURCE_EXPLICIT=1',
      "RELEASE_VERSION_ARG=''",
    ])
      .trim()
      .split('|');
    expect(dir).toBe(`${fixtureRoot.replaceAll('\\', '/')}/base/releases/0.1.1`);
    expect(version).toBe('0.1.1');
    expect(note).toBe('stable channel -> 0.1.1');
  });

  it('prefers an explicit --version over the stable channel, without substituting', () => {
    const [dir, version] = resolve([
      `RELEASE_SOURCE='${fixtureRoot.replaceAll('\\', '/')}/base'`,
      'RELEASE_SOURCE_EXPLICIT=1',
      "RELEASE_VERSION_ARG='0.1.0'",
    ])
      .trim()
      .split('|');
    expect(dir.endsWith('/releases/0.1.0')).toBe(true);
    expect(version).toBe('0.1.0');
  });

  it('uses an explicit source directly when it carries no channel document (the fixture layout)', () => {
    const [dir, , note] = resolve([
      `RELEASE_SOURCE='${fixtureRoot.replaceAll('\\', '/')}/base/releases/0.1.1'`,
      'RELEASE_SOURCE_EXPLICIT=1',
      "RELEASE_VERSION_ARG=''",
    ])
      .trim()
      .split('|');
    expect(dir).toBe(`${fixtureRoot.replaceAll('\\', '/')}/base/releases/0.1.1`);
    expect(note).toContain('used directly as the release directory');
  });

  it('refuses to guess a version when the DEFAULT source has no readable channel document', () => {
    const stderr = runExpectingFailure([
      "RELEASE_SOURCE='file:///definitely/not/here'",
      'RELEASE_SOURCE_EXPLICIT=0',
      "RELEASE_VERSION_ARG=''",
      'resolve_release_location',
    ]);
    expect(stderr).toMatch(/never guesses a version/u);
  });

  it.each(['v0.1.1', '0.1', 'latest', '../../etc', '0.1.1-beta'])(
    'rejects --version %s',
    (version) => {
      const stderr = runExpectingFailure([
        "RELEASE_SOURCE='https://downloads.example.test'",
        `RELEASE_VERSION_ARG='${version}'`,
        'resolve_release_location',
      ]);
      expect(stderr).toMatch(/Invalid --version/u);
    },
  );

  it('agrees with the publisher about the releases/<version>/ object layout', () => {
    // Same layout rule as scripts/release/r2-publication-plan.mjs's releaseObjectKey. If either side
    // is edited alone, published objects and download URLs stop lining up.
    const dir = runInInstaller([
      'release_dir_uri_for_version "https://downloads.example.test" "0.1.1"',
    ]);
    expect(dir).toBe('https://downloads.example.test/releases/0.1.1');
  });
});

describe.skipIf(!hasBash || !hasSha256sum || !hasTar)(
  'install-chantivo.sh — download integrity fails closed',
  () => {
    let fixtureRoot;
    let releaseDir;

    beforeAll(() => {
      fixtureRoot = mkdtempSync(path.join(tmpdir(), 'chantivo-integrity-fixture-'));
      releaseDir = path.join(fixtureRoot, 'releases/0.1.1');
      mkdirSync(releaseDir, { recursive: true });

      const artifactName = 'chantivo-dedicated-server-0.1.1-linux-x64.tar.gz';
      const artifactBody = Buffer.from('not really a tarball, but real bytes with a real hash');
      writeFileSync(path.join(releaseDir, artifactName), artifactBody);
      writeFileSync(
        path.join(releaseDir, 'release-manifest.json'),
        `${JSON.stringify({ schemaVersion: 1, product: 'Chantivo', version: '0.1.1' }, null, 2)}\n`,
      );
      writeFileSync(
        path.join(releaseDir, 'SHA256SUMS'),
        `${sha256(artifactBody)}  ${artifactName}\n`,
      );
    });

    afterAll(() => {
      rmSync(fixtureRoot, { recursive: true, force: true });
    });

    const uri = () => `${releaseDir.replaceAll('\\', '/')}`;

    it('verifies a genuine artifact against SHA256SUMS and reports the version', () => {
      const output = runInInstaller([
        'uname() { printf "x86_64\\n"; }',
        `download_and_verify_release '${uri()}' '0.1.1' >/dev/null`,
        'printf "%s|%s\\n" "$RELEASE_VERSION" "$RELEASE_ARCH"',
      ]);
      expect(output.trim()).toBe('0.1.1|x64');
    });

    it('refuses a tampered artifact before any extraction happens', () => {
      const artifactPath = path.join(
        releaseDir,
        'chantivo-dedicated-server-0.1.1-linux-x64.tar.gz',
      );
      const original = readFileSync(artifactPath);
      try {
        writeFileSync(
          artifactPath,
          Buffer.from('tampered payload of a different length entirely!!'),
        );
        const stderr = runExpectingFailure([
          'uname() { printf "x86_64\\n"; }',
          `download_and_verify_release '${uri()}' '0.1.1'`,
        ]);
        expect(stderr).toMatch(/Checksum verification FAILED/u);
        expect(stderr).toMatch(/refusing to install a corrupted or tampered download/u);
      } finally {
        writeFileSync(artifactPath, original);
      }
    });

    it('refuses a release whose manifest names a different version than was requested', () => {
      const stderr = runExpectingFailure([
        'uname() { printf "x86_64\\n"; }',
        `download_and_verify_release '${uri()}' '0.1.2'`,
      ]);
      expect(stderr).toMatch(/Version mismatch/u);
      expect(stderr).toMatch(/Refusing to install a different version than the one you asked for/u);
    });

    it('refuses an arm64 host honestly rather than downloading an x64 artifact', () => {
      const stderr = runExpectingFailure([
        'uname() { printf "aarch64\\n"; }',
        `download_and_verify_release '${uri()}' '0.1.1'`,
      ]);
      expect(stderr).toMatch(/does not yet ship a verified arm64 Dedicated Server artifact/u);
    });

    it('refuses a source whose SHA256SUMS does not list the artifact', () => {
      const sumsPath = path.join(releaseDir, 'SHA256SUMS');
      const original = readFileSync(sumsPath);
      try {
        writeFileSync(sumsPath, `${'0'.repeat(64)}  something-else.tar.gz\n`);
        const stderr = runExpectingFailure([
          'uname() { printf "x86_64\\n"; }',
          `download_and_verify_release '${uri()}' '0.1.1'`,
        ]);
        expect(stderr).toMatch(/refusing to trust an unverifiable download/u);
      } finally {
        writeFileSync(sumsPath, original);
      }
    });
  },
);
