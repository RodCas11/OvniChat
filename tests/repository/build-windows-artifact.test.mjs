import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  canonicalInstallerName,
  collectExecutableCandidates,
  discoverForgeInstaller,
  extractEmbeddedVersion,
  isWithinDirectory,
} from '../../scripts/release/build-windows-artifact.mjs';

/** Fixture directories only — never a real Electron Forge build, which needs Windows, an Electron
 * download, and minutes of wall clock. What is under test here is the discovery/validation logic
 * that decides whether a *given* file on disk is a genuine, unambiguous Squirrel installer; the
 * Forge invocation itself is exercised by actually running the script, not by the unit suite. */

let fixtureRoot;
let squirrelDir;

/** Mirrors `@electron-forge/maker-squirrel`'s real output layout
 * (`<makeDir>/squirrel.windows/<arch>/`) so the fixtures exercise the same nesting the walker faces
 * in a real build. */
const REAL_SQUIRREL_SUBPATH = path.join('squirrel.windows', 'x64');

async function writeExe(name, contents) {
  await writeFile(path.join(squirrelDir, name), contents);
}

function mzFile(padding = 4096) {
  return Buffer.concat([Buffer.from('MZ', 'ascii'), Buffer.alloc(padding, 0x90)]);
}

beforeEach(async () => {
  fixtureRoot = await mkdtemp(path.join(tmpdir(), 'chantivo-windows-artifact-test-'));
  squirrelDir = path.join(fixtureRoot, REAL_SQUIRREL_SUBPATH);
  await mkdir(squirrelDir, { recursive: true });
});

afterEach(async () => {
  await rm(fixtureRoot, { recursive: true, force: true });
});

describe('canonicalInstallerName', () => {
  it.each([
    ['0.1.1', 'ChantivoSetup-0.1.1.exe'],
    ['0.1.0', 'ChantivoSetup-0.1.0.exe'],
    ['10.20.30', 'ChantivoSetup-10.20.30.exe'],
  ])('produces the canonical release filename for %s', (version, expected) => {
    expect(canonicalInstallerName(version)).toBe(expected);
  });

  it('never contains a space, unlike Forge’s own "Chantivo-<version> Setup.exe"', () => {
    expect(canonicalInstallerName('0.1.1')).not.toContain(' ');
  });
});

describe('isWithinDirectory', () => {
  it('accepts a real descendant', () => {
    expect(isWithinDirectory(path.join(fixtureRoot, 'a', 'b.exe'), fixtureRoot)).toBe(true);
  });

  it('rejects the directory itself', () => {
    expect(isWithinDirectory(fixtureRoot, fixtureRoot)).toBe(false);
  });

  it('rejects a parent path', () => {
    expect(isWithinDirectory(path.dirname(fixtureRoot), fixtureRoot)).toBe(false);
  });

  it('rejects a prefix-sharing sibling directory', () => {
    expect(isWithinDirectory(`${fixtureRoot}-evil${path.sep}x.exe`, fixtureRoot)).toBe(false);
  });
});

describe('extractEmbeddedVersion', () => {
  it("reads the version out of Forge's real installer filename", () => {
    expect(extractEmbeddedVersion('Chantivo-0.1.1 Setup.exe')).toBe('0.1.1');
  });

  it('returns undefined when the filename carries no version token', () => {
    expect(extractEmbeddedVersion('ChantivoSetup.exe')).toBeUndefined();
  });
});

describe('collectExecutableCandidates', () => {
  it('finds nested .exe files and ignores non-.exe Squirrel siblings', async () => {
    await writeExe('Chantivo-0.1.1 Setup.exe', mzFile());
    await writeFile(path.join(squirrelDir, 'RELEASES'), 'hash Chantivo-0.1.1-full.nupkg 1\n');
    await writeFile(path.join(squirrelDir, 'Chantivo-0.1.1-full.nupkg'), 'not an exe');

    const found = await collectExecutableCandidates(fixtureRoot);

    expect(found).toEqual([path.join(squirrelDir, 'Chantivo-0.1.1 Setup.exe')]);
  });
});

describe('discoverForgeInstaller', () => {
  it('accepts exactly one valid, version-matching installer', async () => {
    await writeExe('Chantivo-0.1.1 Setup.exe', mzFile());

    const result = await discoverForgeInstaller({ makeRoot: fixtureRoot, version: '0.1.1' });

    expect(
      result.installerPath.endsWith(path.join(REAL_SQUIRREL_SUBPATH, 'Chantivo-0.1.1 Setup.exe')),
    ).toBe(true);
    expect(result.sizeBytes).toBe(4098);
    expect(result.embeddedVersion).toBe('0.1.1');
  });

  it('accepts an installer whose filename carries no version token, skipping the cross-check', async () => {
    await writeExe('ChantivoSetup.exe', mzFile());

    const result = await discoverForgeInstaller({ makeRoot: fixtureRoot, version: '0.1.1' });

    expect(result.embeddedVersion).toBeUndefined();
  });

  it('rejects a missing Forge output tree', async () => {
    await expect(
      discoverForgeInstaller({ makeRoot: path.join(fixtureRoot, 'never-built'), version: '0.1.1' }),
    ).rejects.toMatchObject({
      code: 'ForgeOutputMissing',
      message: expect.stringContaining('Electron Forge output directory not found'),
    });
  });

  it('rejects when no .exe candidate exists at all', async () => {
    await writeFile(path.join(squirrelDir, 'RELEASES'), 'nothing useful\n');

    await expect(
      discoverForgeInstaller({ makeRoot: fixtureRoot, version: '0.1.1' }),
    ).rejects.toMatchObject({
      code: 'NoInstallerCandidate',
      message: expect.stringContaining('No .exe candidate found under'),
    });
  });

  it('rejects ambiguous candidates and lists every one it found', async () => {
    await writeExe('Chantivo-0.1.0 Setup.exe', mzFile());
    await writeExe('Chantivo-0.1.1 Setup.exe', mzFile());

    const error = await discoverForgeInstaller({
      makeRoot: fixtureRoot,
      version: '0.1.1',
    }).catch((thrown) => thrown);

    expect(error.code).toBe('AmbiguousInstallerCandidates');
    expect(error.message).toContain('found 2');
    expect(error.message).toContain('Chantivo-0.1.0 Setup.exe');
    expect(error.message).toContain('Chantivo-0.1.1 Setup.exe');
  });

  it('rejects a zero-byte installer', async () => {
    await writeExe('Chantivo-0.1.1 Setup.exe', Buffer.alloc(0));

    await expect(
      discoverForgeInstaller({ makeRoot: fixtureRoot, version: '0.1.1' }),
    ).rejects.toMatchObject({
      code: 'EmptyInstaller',
      message: expect.stringContaining('is 0 bytes'),
    });
  });

  it('rejects a file that does not start with the MZ magic bytes', async () => {
    await writeExe(
      'Chantivo-0.1.1 Setup.exe',
      Buffer.from('<html>not an installer</html>', 'utf8'),
    );

    await expect(
      discoverForgeInstaller({ makeRoot: fixtureRoot, version: '0.1.1' }),
    ).rejects.toMatchObject({
      code: 'InvalidExecutableHeader',
      message: expect.stringContaining('"MZ" DOS/PE magic bytes'),
    });
  });

  it('rejects a one-byte file that cannot even hold the magic number', async () => {
    await writeExe('Chantivo-0.1.1 Setup.exe', Buffer.from('M', 'ascii'));

    await expect(
      discoverForgeInstaller({ makeRoot: fixtureRoot, version: '0.1.1' }),
    ).rejects.toMatchObject({ code: 'InvalidExecutableHeader' });
  });

  it('rejects an installer whose embedded version disagrees with the release version', async () => {
    await writeExe('Chantivo-0.1.0 Setup.exe', mzFile());

    await expect(
      discoverForgeInstaller({ makeRoot: fixtureRoot, version: '0.1.1' }),
    ).rejects.toMatchObject({
      code: 'InstallerVersionMismatch',
      message: expect.stringContaining('embeds version 0.1.0'),
    });
  });
});
