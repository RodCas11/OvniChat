import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * T15 follow-up — the installer's Public Server Endpoint / TURN-URL derivation, exercised against
 * the REAL `infrastructure/install/install-chantivo.sh` by sourcing it in a real Bash shell, not a
 * transcription of its logic. `install-chantivo.sh` guards its own `main "$@"` invocation with a
 * `BASH_SOURCE[0] = $0` check exactly so this is possible: sourcing defines the functions and
 * touches nothing on the host.
 *
 * Why this exists: a real production incident. A live Dedicated Server advertised
 * `turn:127.0.0.1:3478` — the *client's* own loopback address — to every remote client as their only
 * ICE server, and every relay-dependent client silently failed. Nothing generated, validated, or
 * noticed that value. These tests pin the generation half; `tests/dedicated-server/cli-doctor.test.ts`
 * pins the detection half.
 *
 * Skipped (never silently passed) where Bash is unavailable — the assertion is about a Bash script's
 * real behavior, and a fabricated substitute would be worse than an honest skip.
 */

const repositoryRoot = process.cwd();
const installerPath = path.join(repositoryRoot, 'infrastructure/install/install-chantivo.sh');

function bashAvailable() {
  try {
    execFileSync('bash', ['-c', 'exit 0'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

const hasBash = bashAvailable();

/**
 * Runs `lines` in a Bash shell that has sourced the real installer. Variables are assigned by the
 * caller AFTER the source, because the script (correctly) initializes every one of its own globals
 * at load time — the same reason a real invocation always goes through `parse_args`.
 */
function runInInstaller(lines) {
  const script = [
    'set -Eeuo pipefail',
    `source "${installerPath.replaceAll('\\', '/')}" >/dev/null 2>&1`,
    ...lines,
  ].join('\n');
  return execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: 'pipe' });
}

function runExpectingFailure(lines) {
  try {
    runInInstaller(lines);
    return undefined;
  } catch (error) {
    return String(error.stderr ?? '');
  }
}

/** Resolves the endpoint + TURN URL exactly as `main()` does, and reports the three resolved values. */
function resolve({ hostname = '', turnUrl = '', stubHostnameOutput = '' } = {}) {
  const lines = [];
  if (stubHostnameOutput !== '') {
    // Overriding `hostname` as a shell function (functions win over binaries in Bash's lookup order)
    // gives detect_public_ipv4/detect_primary_ipv4 real, deterministic input on any OS, including a
    // Windows dev machine whose `hostname` has no `-I` flag at all.
    lines.push(`hostname() { printf '%s\\n' '${stubHostnameOutput}'; }`);
  }
  lines.push(
    `HOSTNAME_ARG='${hostname}'`,
    `TURN_URL_ARG='${turnUrl}'`,
    'INSTALL_COTURN=1',
    'resolve_public_endpoint',
    'resolve_turn_url',
    'printf "%s|%s|%s" "$PUBLIC_ENDPOINT" "$DEPLOYMENT_SCOPE" "$TURN_URL"',
  );
  const [endpoint, scope, turn] = runInInstaller(lines).split('|');
  return { endpoint, scope, turn };
}

describe.skipIf(!hasBash)('install-chantivo.sh Public Server Endpoint derivation', () => {
  it('derives the TURN URL from --hostname for a native public install', () => {
    expect(resolve({ hostname: 'voice.example.com' })).toEqual({
      endpoint: 'voice.example.com',
      scope: 'public',
      turn: 'turn:voice.example.com:3478',
    });
  });

  it('derives the same TURN URL in docker mode — derivation is mode-independent by design', () => {
    const lines = [
      "MODE='docker'",
      "HOSTNAME_ARG='voice.example.com'",
      'INSTALL_COTURN=1',
      'resolve_public_endpoint',
      'resolve_turn_url',
      'printf "%s" "$TURN_URL"',
    ];
    expect(runInInstaller(lines)).toBe('turn:voice.example.com:3478');
  });

  it('both env-writing paths take the URL from the single resolved variable, never build their own', () => {
    // The original defect shape: each mode formatted its own `turn:<something>:3478` string, so a
    // fix in one path could miss the other. Both must now emit `$TURN_URL` verbatim.
    const source = readFileSync(installerPath, 'utf8');
    const assignments = [...source.matchAll(/DISCO_VOADOR_TURN_URLS=([^\s']*)/gu)].map(
      (match) => match[1],
    );
    expect(assignments).toEqual(['%s\\n', '%s\\n']);
    expect(source).not.toMatch(/DISCO_VOADOR_TURN_URLS=turn:/u);
    // The old fallback (`turn:REPLACE_WITH_YOUR_HOSTNAME:3478`) validated fine, started fine, and
    // silently broke every relay-dependent client. It must not survive as executable code — the
    // script's own explanatory comments about it are exactly where it should still be mentioned.
    const executableLines = source
      .split(/\r?\n/u)
      .filter((line) => !line.trimStart().startsWith('#'));
    expect(executableLines.join('\n')).not.toContain('REPLACE_WITH_YOUR_HOSTNAME');
  });

  it('derives a TURN URL from a public IPv4 given as --hostname (TURN needs no domain name)', () => {
    expect(resolve({ hostname: '203.0.113.10' })).toEqual({
      endpoint: '203.0.113.10',
      scope: 'public',
      turn: 'turn:203.0.113.10:3478',
    });
  });

  it('auto-detects this host’s public IPv4 when no --hostname is given', () => {
    expect(resolve({ stubHostnameOutput: '203.0.113.7 172.17.0.2' })).toEqual({
      endpoint: '203.0.113.7',
      scope: 'public',
      turn: 'turn:203.0.113.7:3478',
    });
  });

  it('falls back to this host’s LAN address as a local deployment when there is no public address', () => {
    expect(resolve({ stubHostnameOutput: '192.168.1.50' })).toEqual({
      endpoint: '',
      scope: 'local',
      turn: 'turn:192.168.1.50:3478',
    });
  });

  it('treats a private --hostname as a deliberate LAN deployment, not a public one', () => {
    expect(resolve({ hostname: '192.168.1.10' })).toEqual({
      endpoint: '192.168.1.10',
      scope: 'local',
      turn: 'turn:192.168.1.10:3478',
    });
  });

  it('lets an explicit --turn-url win over the derived default (Coturn on a separate machine)', () => {
    expect(
      resolve({ hostname: 'voice.example.com', turnUrl: 'turn:relay.example.net:3478' }),
    ).toEqual({
      endpoint: 'voice.example.com',
      scope: 'public',
      turn: 'turn:relay.example.net:3478',
    });
  });

  it('refuses a loopback --turn-url for a public deployment', () => {
    const stderr = runExpectingFailure([
      "HOSTNAME_ARG='voice.example.com'",
      "TURN_URL_ARG='turn:127.0.0.1:3478'",
      'INSTALL_COTURN=1',
      'resolve_public_endpoint',
      'resolve_turn_url',
    ]);
    expect(stderr).toMatch(/Refusing to advertise TURN endpoint 'turn:127\.0\.0\.1:3478'/u);
  });

  it('refuses a Docker-internal service name as the client-facing TURN URL for a public deployment', () => {
    const stderr = runExpectingFailure([
      "HOSTNAME_ARG='voice.example.com'",
      "TURN_URL_ARG='turn:coturn:3478'",
      'INSTALL_COTURN=1',
      'resolve_public_endpoint',
      'resolve_turn_url',
    ]);
    expect(stderr).toMatch(/Refusing to advertise TURN endpoint 'turn:coturn:3478'/u);
  });

  it('allows a loopback --turn-url for a deliberate local/LAN deployment', () => {
    expect(resolve({ hostname: '192.168.1.10', turnUrl: 'turn:127.0.0.1:3478' })).toEqual({
      endpoint: '192.168.1.10',
      scope: 'local',
      turn: 'turn:127.0.0.1:3478',
    });
  });

  it('never derives a placeholder: no hostname, no public IP, and no local address at all fails loudly', () => {
    const stderr = runExpectingFailure([
      'hostname() { return 1; }',
      "HOSTNAME_ARG=''",
      'INSTALL_COTURN=1',
      'resolve_public_endpoint',
      'resolve_turn_url',
    ]);
    expect(stderr).toMatch(/needs an address to advertise to clients/u);
  });
});

describe.skipIf(!hasBash)('install-chantivo.sh --turn-url validation', () => {
  function isValid(value) {
    const output = runInInstaller([
      `if validate_turn_url_arg '${value}'; then printf yes; else printf no; fi`,
    ]);
    return output === 'yes';
  }

  it.each([
    'turn:voice.example.com:3478',
    'turns:voice.example.com:5349',
    'turn:203.0.113.10:3478',
  ])('accepts %s', (value) => {
    expect(isValid(value)).toBe(true);
  });

  it.each([
    'https://voice.example.com',
    'voice.example.com:3478',
    'turn:',
    'turn:voice.example.com:3478 { evil }',
  ])('rejects %s', (value) => {
    expect(isValid(value)).toBe(false);
  });
});

describe.skipIf(!hasBash)('install-chantivo.sh final summary', () => {
  it('shows the public server, client address, and TURN URL — and never the TURN shared secret', () => {
    const output = runInInstaller([
      "PUBLIC_ENDPOINT='voice.example.com'",
      "DEPLOYMENT_SCOPE='public'",
      "TURN_URL='turn:voice.example.com:3478'",
      "TURN_URL_SOURCE='derived from the Public Server Endpoint (voice.example.com)'",
      'INSTALL_COTURN=1',
      "TURN_SECRET_FOR_COTURN_CONF='SENTINEL-TURN-SECRET-NEVER-PRINT-ME'",
      "TLS_STATUS='OK (https://voice.example.com, wss://voice.example.com)'",
      'print_endpoint_summary_block',
    ]);

    expect(output).toContain('Public server:');
    expect(output).toContain('voice.example.com');
    expect(output).toContain('wss://voice.example.com');
    expect(output).toContain('turn:voice.example.com:3478');
    expect(output).not.toContain('SENTINEL-TURN-SECRET-NEVER-PRINT-ME');
  });

  it('shows a plain ws:// client address when TLS did not succeed', () => {
    const output = runInInstaller([
      "PUBLIC_ENDPOINT='voice.example.com'",
      "DEPLOYMENT_SCOPE='public'",
      'INSTALL_COTURN=0',
      "TLS_STATUS='FAILED (a real WebSocket upgrade did not succeed)'",
      'print_endpoint_summary_block',
    ]);

    expect(output).toContain('ws://voice.example.com:8090');
    expect(output).not.toContain('wss://');
  });
});

/**
 * The host-level TURN listener probe lives in the operator CLI dispatcher, not in cli-doctor.js:
 * real Docker-fixture evidence showed the Node doctor runs inside the app container while Coturn
 * runs in the host's network namespace, so a probe from there FAILed on a correct Docker install.
 * This dispatcher runs on the host in both deployment modes.
 */
describe.skipIf(!hasBash)('chantivo-server doctor: TURN listener port resolution', () => {
  const dispatcherPath = path
    .join(repositoryRoot, 'infrastructure/install/chantivo-server')
    .replaceAll('\\', '/');

  function port(urls) {
    const script = [
      'set -Eeuo pipefail',
      // The dispatcher `die`s at load time if it cannot find lib/fetch-verify.sh; it sits right
      // next to it in this checkout, which is exactly the "running straight from a repository
      // checkout" case the dispatcher's own header documents.
      `source "${dispatcherPath}" >/dev/null 2>&1 || true`,
      `if turn_listener_port '${urls}'; then :; else printf NONE; fi`,
    ].join('\n');
    return execFileSync('bash', ['-c', script], { encoding: 'utf8', stdio: 'pipe' });
  }

  it.each([
    ['turn:voice.example.com:3478', '3478'],
    ['turns:voice.example.com:5349', '5349'],
    ['turn:voice.example.com', '3478'],
    ['turn:voice.example.com:3478?transport=udp', '3478'],
    ['turn:voice.example.com:3478,turns:voice.example.com:5349', '3478'],
    ['turn:[2001:db8::1]:3478', '3478'],
    ['', 'NONE'],
  ])('resolves %s to %s', (urls, expected) => {
    expect(port(urls)).toBe(expected);
  });
});

describe.skipIf(!hasBash)('install-chantivo.sh host_is_non_public', () => {
  const cases = JSON.parse(
    readFileSync(path.join(repositoryRoot, 'tests/turn-host-classification-cases.json'), 'utf8'),
  ).cases;

  // The shared case table (see that file's own header) — the same rows are asserted against the
  // TypeScript implementation in tests/dedicated-server/cli-doctor.test.ts, so the installer's Bash
  // copy and the runtime's copy cannot drift apart.
  it.each(cases)('classifies $host as nonPublic=$nonPublic', ({ host, nonPublic }) => {
    const output = runInInstaller([
      `if host_is_non_public '${host}'; then printf true; else printf false; fi`,
    ]);
    expect(output).toBe(String(nonPublic));
  });

  it.each([
    ['turn:voice.example.com:3478', 'voice.example.com'],
    ['turns:voice.example.com:5349', 'voice.example.com'],
    ['turn:voice.example.com', 'voice.example.com'],
    ['turn://voice.example.com:3478', 'voice.example.com'],
    ['turn:voice.example.com:3478?transport=udp', 'voice.example.com'],
    ['turn:[2001:db8::1]:3478', '2001:db8::1'],
    ['turn:127.0.0.1:3478', '127.0.0.1'],
  ])('extracts the host of %s as %s', (url, expectedHost) => {
    expect(runInInstaller([`turn_url_host '${url}'`])).toBe(expectedHost);
  });
});
