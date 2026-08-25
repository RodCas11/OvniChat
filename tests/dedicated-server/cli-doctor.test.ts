import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  createRealtimeServer,
  loadRealtimeConfig,
  type RealtimeServerHandle,
} from '@disco-voador/realtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthorizationStore } from '../../services/dedicated-server/src/authorization/store.js';
import {
  printDoctorReport,
  resolvesToSameRealPath,
  runDoctorChecks,
} from '../../services/dedicated-server/src/cli-doctor.js';
import {
  classifyTurnHost,
  turnUrlHost,
  turnUrlPort,
} from '../../services/dedicated-server/src/turn/public-endpoint.js';

/**
 * T15 — `cli-doctor.ts` tests: real filesystem, real SQLite files (including a genuinely corrupted
 * one), and one real running realtime server for the health-endpoint checks. No `systemctl`/`docker`
 * concerns are exercised here — those are the Bash wrapper's own layer, out of this file's scope.
 */

function findCheck(
  results: readonly { name: string; status: string; message: string }[],
  name: string,
): { name: string; status: string; message: string } {
  const found = results.find((result) => result.name === name);
  if (!found)
    throw new Error(
      `No doctor check result named "${name}" (got: ${results.map((r) => r.name).join(', ')})`,
    );
  return found;
}

describe('runDoctorChecks', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dv-cli-doctor-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('stops after a single FAIL when configuration itself fails to load', async () => {
    const results = await runDoctorChecks({
      DISCO_VOADOR_SERVER_CONFIG_PATH: path.join(dir, 'does-not-exist.json'),
      DISCO_VOADOR_SERVER_ACCESS_MODE: 'not-a-real-mode',
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ name: 'Config', status: 'FAIL' });
    expect(results[0]?.message.length).toBeGreaterThan(0);
  });

  it('reports the data directory as FAIL when it does not exist, PASS when it does', async () => {
    const missingResults = await runDoctorChecks({
      DISCO_VOADOR_SERVER_CONFIG_PATH: path.join(dir, 'does-not-exist.json'),
      DISCO_VOADOR_SERVER_DATA_DIR: path.join(dir, 'never-created'),
      REALTIME_PORT: '0',
    });
    expect(findCheck(missingResults, 'Data directory').status).toBe('FAIL');

    const existingResults = await runDoctorChecks({
      DISCO_VOADOR_SERVER_CONFIG_PATH: path.join(dir, 'does-not-exist.json'),
      DISCO_VOADOR_SERVER_DATA_DIR: dir,
      REALTIME_PORT: '0',
    });
    expect(findCheck(existingResults, 'Data directory').status).toBe('PASS');
  });

  it('reports each SQLite store file as informational when absent (fresh install)', async () => {
    const results = await runDoctorChecks({
      DISCO_VOADOR_SERVER_CONFIG_PATH: path.join(dir, 'does-not-exist.json'),
      DISCO_VOADOR_SERVER_DATA_DIR: dir,
      REALTIME_PORT: '0',
    });

    for (const file of [
      'authorization.sqlite',
      'chat.sqlite',
      'channels.sqlite',
      'profiles.sqlite',
    ]) {
      expect(findCheck(results, `SQLite: ${file}`).status).toBe('INFO');
    }
  });

  it('reports a real, valid store file as PASS and a genuinely corrupted one as FAIL', async () => {
    // A real, valid authorization.sqlite, created and closed exactly like a real server would.
    const store = new AuthorizationStore(path.join(dir, 'authorization.sqlite'), {
      accessMode: 'open',
    });
    store.close();

    // A genuinely corrupted chat.sqlite — garbage bytes, not a valid SQLite file header.
    writeFileSync(path.join(dir, 'chat.sqlite'), 'not a real sqlite database, just plain bytes');

    const results = await runDoctorChecks({
      DISCO_VOADOR_SERVER_CONFIG_PATH: path.join(dir, 'does-not-exist.json'),
      DISCO_VOADOR_SERVER_DATA_DIR: dir,
      REALTIME_PORT: '0',
    });

    expect(findCheck(results, 'SQLite: authorization.sqlite').status).toBe('PASS');
    const corrupted = findCheck(results, 'SQLite: chat.sqlite');
    expect(corrupted.status).toBe('FAIL');
    expect(corrupted.message.length).toBeGreaterThan(0);
    // The two files that were never created stay informational, not failed.
    expect(findCheck(results, 'SQLite: channels.sqlite').status).toBe('INFO');
    expect(findCheck(results, 'SQLite: profiles.sqlite').status).toBe('INFO');
  });

  it('reports GET /healthz and GET /readyz as FAIL ("not reachable") when nothing is listening', async () => {
    // A real server is started, its ephemeral port captured, then stopped again — the port is
    // genuinely free by the time doctor probes it, giving a real "connection refused" condition
    // rather than an assumed one.
    const probe = createRealtimeServer(
      loadRealtimeConfig({ REALTIME_HOST: '127.0.0.1', REALTIME_PORT: '0' }),
    );
    const address = await probe.start();
    await probe.stop();

    const results = await runDoctorChecks({
      DISCO_VOADOR_SERVER_CONFIG_PATH: path.join(dir, 'does-not-exist.json'),
      DISCO_VOADOR_SERVER_DATA_DIR: dir,
      REALTIME_HOST: '127.0.0.1',
      REALTIME_PORT: String(address.port),
    });

    expect(findCheck(results, 'GET /healthz')).toMatchObject({ status: 'FAIL' });
    expect(findCheck(results, 'GET /healthz').message).toMatch(/not reachable/u);
    expect(findCheck(results, 'GET /readyz')).toMatchObject({ status: 'FAIL' });
  });

  it('reports GET /healthz and GET /readyz as PASS against a real running server', async () => {
    let server: RealtimeServerHandle | undefined;
    try {
      server = createRealtimeServer(
        loadRealtimeConfig({ REALTIME_HOST: '127.0.0.1', REALTIME_PORT: '0' }),
      );
      const address = await server.start();

      const results = await runDoctorChecks({
        DISCO_VOADOR_SERVER_CONFIG_PATH: path.join(dir, 'does-not-exist.json'),
        DISCO_VOADOR_SERVER_DATA_DIR: dir,
        REALTIME_HOST: '127.0.0.1',
        REALTIME_PORT: String(address.port),
      });

      expect(findCheck(results, 'GET /healthz')).toMatchObject({
        status: 'PASS',
        message: 'status: ok',
      });
      expect(findCheck(results, 'GET /readyz').status).toBe('PASS');
    } finally {
      await server?.stop();
    }
  });

  it('treats a bind-all host (0.0.0.0) as reachable via 127.0.0.1', async () => {
    let server: RealtimeServerHandle | undefined;
    try {
      server = createRealtimeServer(
        loadRealtimeConfig({ REALTIME_HOST: '0.0.0.0', REALTIME_PORT: '0' }),
      );
      const address = await server.start();

      const results = await runDoctorChecks({
        DISCO_VOADOR_SERVER_CONFIG_PATH: path.join(dir, 'does-not-exist.json'),
        DISCO_VOADOR_SERVER_DATA_DIR: dir,
        REALTIME_HOST: '0.0.0.0',
        REALTIME_PORT: String(address.port),
      });

      expect(findCheck(results, 'GET /healthz').status).toBe('PASS');
    } finally {
      await server?.stop();
    }
  });

  it('reports every TURN check as informational when TURN is not configured', async () => {
    const notConfigured = await runDoctorChecks({
      DISCO_VOADOR_SERVER_CONFIG_PATH: path.join(dir, 'does-not-exist.json'),
      DISCO_VOADOR_SERVER_DATA_DIR: dir,
      REALTIME_PORT: '0',
    });

    for (const name of [
      'TURN URL configured',
      'TURN credential generation',
      'TURN local listener',
      'TURN advertised endpoint',
      'External TURN reachability',
    ]) {
      expect(findCheck(notConfigured, name).status).toBe('INFO');
    }
  });

  it('reports TURN credential generation as PASS with a real minted credential', async () => {
    const configured = await runDoctorChecks({
      DISCO_VOADOR_SERVER_CONFIG_PATH: path.join(dir, 'does-not-exist.json'),
      DISCO_VOADOR_SERVER_DATA_DIR: dir,
      REALTIME_PORT: '0',
      DISCO_VOADOR_TURN_SHARED_SECRET: 'a-real-test-shared-secret',
      DISCO_VOADOR_TURN_URLS: 'turn:turn.example.com:3478',
    });

    const turnResult = findCheck(configured, 'TURN credential generation');
    expect(turnResult.status).toBe('PASS');
    expect(turnResult.message).toMatch(/Minted 1 ICE server credential/u);
    expect(findCheck(configured, 'TURN URL configured').status).toBe('PASS');
    expect(findCheck(configured, 'TURN URL configured').message).toContain(
      'turn:turn.example.com:3478',
    );
  });

  it('delegates the TURN listener probe to the host-level wrapper instead of guessing from here', async () => {
    // Real Docker-fixture finding: probing 127.0.0.1 from this process FAILs on a correct Compose
    // deployment, because Coturn runs in the host's network namespace and this process does not.
    const configured = await runDoctorChecks({
      DISCO_VOADOR_SERVER_CONFIG_PATH: path.join(dir, 'does-not-exist.json'),
      DISCO_VOADOR_SERVER_DATA_DIR: dir,
      REALTIME_PORT: '0',
      DISCO_VOADOR_TURN_SHARED_SECRET: 'a-real-test-shared-secret',
      DISCO_VOADOR_TURN_URLS: 'turns:turn.example.com:5349',
    });

    const listener = findCheck(configured, 'TURN local listener');
    expect(listener.status).toBe('INFO');
    expect(listener.message).toContain('port 5349');
    expect(listener.message).toContain("'chantivo-server doctor' wrapper");
  });
});

/**
 * T15 follow-up — the checks that would have caught the real production incident: a public
 * Dedicated Server advertising `turn:127.0.0.1:3478` to every remote client as their only ICE
 * server. `TURN local listener` is reported as INFO here by design (the real TCP probe lives in the
 * `chantivo-server` wrapper, which runs on the host in both deployment modes — see that check's own
 * doc comment and `tests/repository/installer-turn-endpoint.test.mjs`).
 */
describe('runDoctorChecks: TURN advertised endpoint', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dv-cli-doctor-turn-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function baseEnv(overrides: Record<string, string>): Record<string, string> {
    return {
      DISCO_VOADOR_SERVER_CONFIG_PATH: path.join(dir, 'does-not-exist.json'),
      DISCO_VOADOR_SERVER_DATA_DIR: dir,
      REALTIME_PORT: '0',
      DISCO_VOADOR_TURN_SHARED_SECRET: 'a-real-test-shared-secret',
      ...overrides,
    };
  }

  it('FAILs a public deployment advertising a loopback TURN address — the real incident', async () => {
    const results = await runDoctorChecks(
      baseEnv({
        DISCO_VOADOR_SERVER_PUBLIC_HOST: 'voice.example.com',
        DISCO_VOADOR_DEPLOYMENT_SCOPE: 'public',
        DISCO_VOADOR_TURN_URLS: 'turn:127.0.0.1:3478',
      }),
    );

    const check = findCheck(results, 'TURN advertised endpoint');
    expect(check.status).toBe('FAIL');
    expect(check.message).toContain('loopback address');
    expect(check.message).toContain('Configured deployment: public');
    expect(check.message).toContain('Expected: turn:<public-hostname-or-public-ip>:3478');
  });

  it('FAILs a public deployment advertising turn:localhost', async () => {
    const results = await runDoctorChecks(
      baseEnv({
        DISCO_VOADOR_SERVER_PUBLIC_HOST: 'voice.example.com',
        DISCO_VOADOR_DEPLOYMENT_SCOPE: 'public',
        DISCO_VOADOR_TURN_URLS: 'turn:localhost:3478',
      }),
    );

    expect(findCheck(results, 'TURN advertised endpoint')).toMatchObject({ status: 'FAIL' });
  });

  it('FAILs a public deployment advertising a Docker-internal service name', async () => {
    const results = await runDoctorChecks(
      baseEnv({
        DISCO_VOADOR_SERVER_PUBLIC_HOST: 'voice.example.com',
        DISCO_VOADOR_DEPLOYMENT_SCOPE: 'public',
        DISCO_VOADOR_TURN_URLS: 'turn:coturn:3478',
      }),
    );

    const check = findCheck(results, 'TURN advertised endpoint');
    expect(check.status).toBe('FAIL');
    expect(check.message).toContain('not publicly resolvable');
  });

  it('does NOT fail a deliberate local/dev deployment with a loopback TURN address', async () => {
    const results = await runDoctorChecks(
      baseEnv({
        DISCO_VOADOR_DEPLOYMENT_SCOPE: 'local',
        DISCO_VOADOR_TURN_URLS: 'turn:127.0.0.1:3478',
      }),
    );

    const check = findCheck(results, 'TURN advertised endpoint');
    expect(check.status).toBe('PASS');
    expect(check.message).toContain('Configured deployment: local');
  });

  it('infers local scope from an unset public host, so an existing deployment is never newly failed', async () => {
    const results = await runDoctorChecks(
      baseEnv({ DISCO_VOADOR_TURN_URLS: 'turn:127.0.0.1:3478' }),
    );

    expect(findCheck(results, 'TURN advertised endpoint').status).toBe('PASS');
  });

  it('infers public scope from a public-looking DISCO_VOADOR_SERVER_PUBLIC_HOST alone', async () => {
    const results = await runDoctorChecks(
      baseEnv({
        DISCO_VOADOR_SERVER_PUBLIC_HOST: 'voice.example.com',
        DISCO_VOADOR_TURN_URLS: 'turn:127.0.0.1:3478',
      }),
    );

    expect(findCheck(results, 'TURN advertised endpoint').status).toBe('FAIL');
  });

  it('PASSes a public deployment advertising a real public hostname, without claiming it is reachable', async () => {
    const results = await runDoctorChecks(
      baseEnv({
        DISCO_VOADOR_SERVER_PUBLIC_HOST: 'voice.example.com',
        DISCO_VOADOR_DEPLOYMENT_SCOPE: 'public',
        DISCO_VOADOR_TURN_URLS: 'turn:voice.example.com:3478',
      }),
    );

    const check = findCheck(results, 'TURN advertised endpoint');
    expect(check.status).toBe('PASS');
    expect(check.message).toContain('not verified from outside');
  });

  it('never claims external TURN reachability is verified', async () => {
    const results = await runDoctorChecks(
      baseEnv({
        DISCO_VOADOR_SERVER_PUBLIC_HOST: 'voice.example.com',
        DISCO_VOADOR_DEPLOYMENT_SCOPE: 'public',
        DISCO_VOADOR_TURN_URLS: 'turn:voice.example.com:3478',
      }),
    );

    const check = findCheck(results, 'External TURN reachability');
    expect(check.message.startsWith('NOT VERIFIED')).toBe(true);
    expect(check.status).not.toBe('PASS');
  });

  it('never surfaces the TURN shared secret in any check result or in the printed report', async () => {
    const secret = 'SENTINEL-TURN-SHARED-SECRET-abcdef0123456789';
    const results = await runDoctorChecks(
      baseEnv({
        DISCO_VOADOR_SERVER_PUBLIC_HOST: 'voice.example.com',
        DISCO_VOADOR_DEPLOYMENT_SCOPE: 'public',
        DISCO_VOADOR_TURN_SHARED_SECRET: secret,
        DISCO_VOADOR_TURN_URLS: 'turn:voice.example.com:3478',
      }),
    );

    for (const result of results) {
      expect(result.message).not.toContain(secret);
      expect(result.name).not.toContain(secret);
    }

    const printed: string[] = [];
    const original = console.info;
    console.info = (...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    };
    try {
      printDoctorReport(results);
    } finally {
      console.info = original;
    }
    expect(printed.join('\n')).not.toContain(secret);
  });
});

describe('TURN host classification', () => {
  // The shared case table (tests/turn-host-classification-cases.json) is asserted against this
  // TypeScript implementation here and against install-chantivo.sh's Bash `host_is_non_public` in
  // tests/repository/installer-turn-endpoint.test.mjs — the two must agree exactly, since the
  // installer decides what gets written and this decides what doctor complains about.
  const cases = (
    JSON.parse(readFileSync('tests/turn-host-classification-cases.json', 'utf8')) as {
      cases: { host: string; nonPublic: boolean; reason?: string }[];
    }
  ).cases;

  it.each(cases)('classifies $host as nonPublic=$nonPublic', ({ host, nonPublic, reason }) => {
    const classified = classifyTurnHost(host);
    expect(classified !== undefined).toBe(nonPublic);
    if (reason !== undefined) expect(classified).toBe(reason);
  });

  it.each([
    ['turn:voice.example.com:3478', 'voice.example.com', 3478],
    ['turns:voice.example.com:5349', 'voice.example.com', 5349],
    ['turn:voice.example.com', 'voice.example.com', 3478],
    ['turn://voice.example.com:3478', 'voice.example.com', 3478],
    ['turn:voice.example.com:3478?transport=udp', 'voice.example.com', 3478],
    ['turn:[2001:db8::1]:3478', '2001:db8::1', 3478],
  ])('parses %s as host %s port %d', (url, host, port) => {
    expect(turnUrlHost(url)).toBe(host);
    expect(turnUrlPort(url)).toBe(port);
  });

  it('rejects a non-TURN scheme', () => {
    expect(turnUrlHost('https://voice.example.com')).toBeUndefined();
  });
});

describe('printDoctorReport', () => {
  it('prints one line per check plus a correct N passed, N warnings, N failed summary', () => {
    const infoSpy: string[] = [];
    const original = console.info;
    console.info = (...args: unknown[]) => {
      infoSpy.push(args.map(String).join(' '));
    };
    try {
      printDoctorReport([
        { name: 'Config', status: 'PASS', message: 'ok' },
        { name: 'Data directory', status: 'WARN', message: 'careful' },
        { name: 'GET /healthz', status: 'FAIL', message: 'unreachable' },
        { name: 'TURN', status: 'INFO', message: 'not configured' },
      ]);
    } finally {
      console.info = original;
    }

    expect(infoSpy).toContain('[PASS] Config: ok');
    expect(infoSpy).toContain('[WARN] Data directory: careful');
    expect(infoSpy).toContain('[FAIL] GET /healthz: unreachable');
    expect(infoSpy).toContain('[INFO] TURN: not configured');
    expect(infoSpy).toContain('1 passed, 1 warnings, 1 failed');
  });
});

describe('resolvesToSameRealPath', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dv-cli-doctor-realpath-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('treats a plain non-symlinked path as matching itself', () => {
    const target = path.join(dir, 'target.js');
    writeFileSync(target, '// real file\n');
    expect(resolvesToSameRealPath(target, target)).toBe(true);
  });

  it('returns false for two genuinely different real files', () => {
    const a = path.join(dir, 'a.js');
    const b = path.join(dir, 'b.js');
    writeFileSync(a, '// a\n');
    writeFileSync(b, '// b\n');
    expect(resolvesToSameRealPath(a, b)).toBe(false);
  });

  it('returns false for a nonexistent path rather than throwing', () => {
    expect(resolvesToSameRealPath(path.join(dir, 'nope.js'), path.join(dir, 'also-nope.js'))).toBe(
      false,
    );
  });

  // T15 — the real bug: native deployments invoke this script through /opt/chantivo/current, a
  // symlinked directory, while `import.meta.url` resolves to the real (symlink-traversed) release
  // path underneath it. This proves the exact fixed comparison against a real symlink on the real
  // filesystem, not just the reasoning in the source comment. `symlinkSync(..., 'junction')` is used
  // for the directory link specifically because Windows directory junctions (unlike file symlinks or
  // `'dir'`-type symlinks) do not require `SeCreateSymbolicLinkPrivilege`/admin/Developer Mode — this
  // keeps the test runnable in this repo's normal dev environment without elevation. On POSIX,
  // `'junction'` behaves as an ordinary directory symlink.
  it('treats a file reached through a symlinked directory as matching its real path — the exact native-deployment shape (/opt/chantivo/current -> releases/<version>)', () => {
    const releasesRoot = path.join(dir, 'releases', '0.1.0');
    mkdirSync(releasesRoot, { recursive: true });
    const realFile = path.join(releasesRoot, 'cli-doctor.js');
    writeFileSync(realFile, '// compiled entrypoint\n');

    const currentLink = path.join(dir, 'current');
    symlinkSync(releasesRoot, currentLink, 'junction');
    const pathThroughSymlink = path.join(currentLink, 'cli-doctor.js');

    // The bug: naive `path.resolve` comparison would see these as two different strings
    // (`.../current/cli-doctor.js` vs. `.../releases/0.1.0/cli-doctor.js`) and never match.
    expect(path.resolve(pathThroughSymlink)).not.toBe(path.resolve(realFile));
    // The fix: realpath-based comparison correctly identifies them as the same file.
    expect(resolvesToSameRealPath(pathThroughSymlink, realFile)).toBe(true);
  });
});
