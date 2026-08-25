import { realpathSync } from 'node:fs';
import { access, constants as fsConstants } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigValidationError } from '@disco-voador/config';

import { loadDedicatedServerConfig, type DedicatedServerConfig } from './config.js';
import { ServerConfigFileError } from './server-config-file.js';
import { mintTurnCredentials } from './turn/mint-turn-credentials.js';
import {
  classifyTurnHost,
  describeNonPublicReason,
  turnUrlHost,
  turnUrlPort,
} from './turn/public-endpoint.js';

/**
 * T15 — `chantivo-server doctor`: local diagnostic checks a single Node process can determine about
 * this Dedicated Server's own state (config validity, data-directory health, SQLite file integrity,
 * the realtime service's health endpoints, and the TURN check family below). Deliberately does
 * **not** implement systemd/Docker-state checks or an `--external-check-url` option — those are
 * shell-level concerns the Bash `chantivo-server doctor` wrapper layers on top of this file's
 * output; this module never shells out to `systemctl`/`docker` itself. It *does* apply that
 * wrapper's own honesty discipline to TURN: local evidence is reported as local evidence, and
 * external reachability is reported as NOT VERIFIED rather than inferred (see
 * `checkExternalTurnReachability`).
 */

const HEALTH_CHECK_TIMEOUT_MS = 3_000;
const SQLITE_STORE_FILES = [
  'authorization.sqlite',
  'chat.sqlite',
  'channels.sqlite',
  'profiles.sqlite',
] as const;

export type DoctorCheckStatus = 'PASS' | 'WARN' | 'FAIL' | 'INFO';

export interface DoctorCheckResult {
  readonly name: string;
  readonly status: DoctorCheckStatus;
  readonly message: string;
}

function pass(name: string, message: string): DoctorCheckResult {
  return { name, status: 'PASS', message };
}
function warn(name: string, message: string): DoctorCheckResult {
  return { name, status: 'WARN', message };
}
function fail(name: string, message: string): DoctorCheckResult {
  return { name, status: 'FAIL', message };
}
function info(name: string, message: string): DoctorCheckResult {
  return { name, status: 'INFO', message };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A bind-all address (`0.0.0.0`/`::`) is not itself something an HTTP client can connect *to* —
 * probe the loopback address instead, matching what "the server is reachable on this machine"
 * actually means for a bind-all listener. Any other configured host (a real interface IP or
 * hostname) is used verbatim. */
function healthCheckHost(host: string): string {
  return host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
}

async function checkDataDirectory(dataDir: string): Promise<DoctorCheckResult> {
  if (dataDir === ':memory:') {
    return info('Data directory', 'In-memory data directory (:memory:) — no filesystem to check.');
  }
  try {
    await access(dataDir, fsConstants.W_OK);
    return pass('Data directory', `"${dataDir}" exists and is writable.`);
  } catch (error) {
    return fail(
      'Data directory',
      `"${dataDir}" is missing or not writable: ${errorMessage(error)}`,
    );
  }
}

async function checkSqliteFile(dataDir: string, fileName: string): Promise<DoctorCheckResult> {
  const name = `SQLite: ${fileName}`;
  const filePath = path.join(dataDir, fileName);

  try {
    await access(filePath, fsConstants.F_OK);
  } catch {
    return info(name, 'Not present yet (fresh install — server has never been started here).');
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(filePath, { readOnly: true });
  } catch (error) {
    return fail(name, `Could not open: ${errorMessage(error)}`);
  }

  try {
    // A real read, not just a successful open — a truncated/corrupted file can open fine and only
    // fail once SQLite actually walks a page.
    db.prepare('SELECT count(*) AS count FROM sqlite_master').get();
    return pass(name, 'Opens and reads cleanly.');
  } catch (error) {
    return fail(name, `Could not read: ${errorMessage(error)}`);
  } finally {
    db.close();
  }
}

async function checkHealthRoute(
  baseUrl: string,
  route: '/healthz' | '/readyz',
): Promise<DoctorCheckResult> {
  const name = `GET ${route}`;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}${route}`, {
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
  } catch (error) {
    return fail(name, `Server not reachable at ${baseUrl}${route}: ${errorMessage(error)}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return fail(name, `Response was not valid JSON: ${errorMessage(error)}`);
  }
  const parsedStatus = (body as { status?: unknown } | null)?.status;

  if (route === '/healthz') {
    if (response.status === 200 && parsedStatus === 'ok') {
      return pass(name, 'status: ok');
    }
    return fail(
      name,
      `Unexpected response: HTTP ${String(response.status)} ${JSON.stringify(body)}`,
    );
  }

  // GET /readyz: "ready" (200) is a clean pass. The documented "not-ready" (503) shape means the
  // server is correctly *responding*, but is currently at `REALTIME_MAX_CONNECTIONS` capacity — a
  // real, actionable condition worth flagging to the operator without treating the doctor run
  // itself as failed. Anything else is an unrecognized shape/status — a genuine FAIL.
  if (response.status === 200 && parsedStatus === 'ready') {
    return pass(name, `status: ready (HTTP 200)`);
  }
  if (response.status === 503 && parsedStatus === 'not-ready') {
    return warn(name, 'status: not-ready — server is at REALTIME_MAX_CONNECTIONS capacity');
  }
  return fail(name, `Unexpected response: HTTP ${String(response.status)} ${JSON.stringify(body)}`);
}

/**
 * T15 follow-up — the TURN check family. Deliberately five separate, independently-reported checks
 * rather than one collapsed boolean, because the production incident this exists for passed every
 * check that existed at the time: the secret was valid, credentials minted fine, and Coturn was
 * listening locally — the *advertised address* was the only broken thing, and nothing looked at it.
 *
 * Check names are part of this module's contract (`chantivo-server doctor` output an operator
 * reads, and what the tests assert on):
 *
 *   TURN URL configured        — is `DISCO_VOADOR_TURN_URLS` set at all?
 *   TURN credential generation — does the shared secret actually mint a credential? (pre-existing)
 *   TURN local listener        — delegated to the Bash wrapper, which runs on the actual host
 *   TURN advertised endpoint   — could a remote client plausibly reach what we advertise?
 *   External TURN reachability — VERIFIED / NOT VERIFIED, never inferred from the local listener.
 *
 * No check in this family ever prints `sharedSecret`, a minted username, or a minted credential —
 * only counts, expiry timestamps, and the (non-secret, already client-visible) URLs themselves.
 */
const TURN_CHECK_NAMES = {
  configured: 'TURN URL configured',
  credentials: 'TURN credential generation',
  listener: 'TURN local listener',
  advertised: 'TURN advertised endpoint',
  external: 'External TURN reachability',
} as const;

/** Every TURN check reported as INFO, for a deployment that deliberately runs no TURN relay at all
 * (STUN/P2P-only — a fully supported, documented posture, not an error). Reported as the same five
 * named checks rather than one, so the report shape never depends on configuration. */
function turnNotConfiguredResults(): DoctorCheckResult[] {
  return [
    info(
      TURN_CHECK_NAMES.configured,
      'DISCO_VOADOR_TURN_URLS is not set — this deployment runs no TURN relay (STUN/P2P only). That is a supported configuration; peers behind symmetric NAT may fail to connect.',
    ),
    info(TURN_CHECK_NAMES.credentials, 'Not applicable — TURN is not configured.'),
    info(TURN_CHECK_NAMES.listener, 'Not applicable — TURN is not configured.'),
    info(TURN_CHECK_NAMES.advertised, 'Not applicable — TURN is not configured.'),
    info(TURN_CHECK_NAMES.external, 'Not applicable — TURN is not configured.'),
  ];
}

function checkTurnCredentialGeneration(config: DedicatedServerConfig): DoctorCheckResult {
  if (!config.turn) return info(TURN_CHECK_NAMES.credentials, 'Not applicable.');
  try {
    const minted = mintTurnCredentials(config.turn);
    // Count and expiry only — never the minted username/credential themselves.
    return pass(
      TURN_CHECK_NAMES.credentials,
      `Minted ${String(minted.iceServers.length)} ICE server credential(s), expiring ${minted.expiresAt}.`,
    );
  } catch (error) {
    return fail(TURN_CHECK_NAMES.credentials, `Credential minting failed: ${errorMessage(error)}`);
  }
}

/**
 * Deliberately NOT a TCP probe from this process.
 *
 * Real Docker-fixture evidence (T15 follow-up): in a Compose deployment the Node doctor runs
 * *inside* the `chantivo-server` container, while Coturn runs with `network_mode: host`
 * (`infrastructure/docker/compose.turn.example.yaml`) — so `127.0.0.1:3478` as this process sees it
 * is the app container's own loopback, where Coturn is not and never will be. A probe from here
 * FAILed on a completely correct Docker install, every time. The port lives on the *host*, and the
 * host is exactly where the Bash `chantivo-server doctor` wrapper runs in both deployment modes —
 * which is also this module's own documented boundary (see the file header: deployment-shape
 * concerns belong to the wrapper, not here). The wrapper performs the real probe and prints
 * `TURN LISTENER (local): PASS/FAIL`; this check points the operator at it rather than reporting a
 * result it cannot honestly determine.
 */
function checkTurnLocalListener(port: number): DoctorCheckResult {
  return info(
    TURN_CHECK_NAMES.listener,
    `Checked by the 'chantivo-server doctor' wrapper on the host (expected TURN listener port ${String(port)}), not from inside this process — in a Docker deployment Coturn runs in the host's network namespace, so this process's own 127.0.0.1 is not where the listener is. See the "TURN LISTENER (local)" line in that command's output.`,
  );
}

/**
 * The check the production incident needed: is what we hand to remote clients something a remote
 * client could plausibly reach? Loopback/private/container-only addresses are legitimate for a
 * `local` deployment and are passed through without complaint there; for a `public` deployment
 * they are a hard FAIL.
 */
function checkTurnAdvertisedEndpoint(config: DedicatedServerConfig): DoctorCheckResult {
  const turn = config.turn;
  if (!turn) return info(TURN_CHECK_NAMES.advertised, 'Not applicable.');

  const unreachable = turn.urls
    .map((url) => {
      const host = turnUrlHost(url);
      if (host === undefined) return { url, host: url, reason: 'container-only-name' as const };
      const reason = classifyTurnHost(host);
      return reason === undefined ? undefined : { url, host, reason };
    })
    .filter((entry) => entry !== undefined);

  if (config.deploymentScope === 'local') {
    return pass(
      TURN_CHECK_NAMES.advertised,
      `Configured deployment: local. A loopback, private-network, or LAN address is legitimate here, so the advertised endpoint is not checked for public reachability. Set DISCO_VOADOR_DEPLOYMENT_SCOPE=public (install-chantivo.sh does this automatically for a --hostname/public-IP install) if remote clients are meant to reach this server.`,
    );
  }

  if (unreachable.length === 0) {
    return pass(
      TURN_CHECK_NAMES.advertised,
      `Configured deployment: public. Advertised to clients: ${turn.urls.join(', ')} — plausibly reachable from the internet (not verified from outside; see "${TURN_CHECK_NAMES.external}" below).`,
    );
  }

  const details = unreachable
    .map(
      (entry) => `${entry.url} points to ${describeNonPublicReason(entry.reason)} (${entry.host})`,
    )
    .join('; ');
  return fail(
    TURN_CHECK_NAMES.advertised,
    [
      `The configured TURN address ${details}.`,
      'Remote Chantivo clients cannot reach it — it is handed to every client verbatim as their ICE server.',
      'Configured deployment: public',
      `Expected: turn:<public-hostname-or-public-ip>:${String(turnUrlPort(unreachable[0]?.url ?? ''))}`,
      "Fix DISCO_VOADOR_TURN_URLS in this server's environment (native: /etc/chantivo/server.env; docker: infrastructure/docker/.env), then restart the server.",
    ].join('\n'),
  );
}

/**
 * Honesty discipline, matching the `chantivo-server` dispatcher's existing
 * `EXTERNALLY VERIFIED: cannot verify` line for the HTTP health check: a host cannot confirm its
 * own external reachability by inspecting itself, so this never reports VERIFIED. A local listener
 * being up says nothing about NAT, firewall rules, cloud security groups, or routing.
 */
function checkExternalTurnReachability(): DoctorCheckResult {
  return info(
    TURN_CHECK_NAMES.external,
    'NOT VERIFIED — this server cannot confirm its own external reachability by inspecting itself, and a local listener proves nothing about NAT/firewall/routing. Verify from a different network with a real TURN allocation (turnutils_uclient) or a forced-relay WebRTC test; only that counts as VERIFIED.',
  );
}

function checkTurn(config: DedicatedServerConfig): DoctorCheckResult[] {
  const turn = config.turn;
  if (!turn) return turnNotConfiguredResults();

  const results: DoctorCheckResult[] = [
    pass(
      TURN_CHECK_NAMES.configured,
      `${String(turn.urls.length)} TURN URL(s) configured: ${turn.urls.join(', ')}`,
    ),
    checkTurnCredentialGeneration(config),
    checkTurnLocalListener(turnUrlPort(turn.urls[0] ?? '')),
    checkTurnAdvertisedEndpoint(config),
    checkExternalTurnReachability(),
  ];
  return results;
}

/**
 * Runs every doctor check in order, stopping after the config check alone if config itself fails to
 * load (nothing else is checkable without a valid, resolved `dataDir`/`realtime` address). `source`
 * mirrors `loadDedicatedServerConfig`'s own injectable-env-source convention, for tests.
 */
export async function runDoctorChecks(
  source: Record<string, string | undefined> = process.env,
): Promise<readonly DoctorCheckResult[]> {
  const results: DoctorCheckResult[] = [];

  let config: DedicatedServerConfig;
  try {
    config = await loadDedicatedServerConfig(source);
  } catch (error) {
    const message =
      error instanceof ConfigValidationError || error instanceof ServerConfigFileError
        ? error.message
        : errorMessage(error);
    results.push(fail('Config', message));
    return results;
  }
  results.push(pass('Config', `Configuration loaded (data dir: "${config.dataDir}").`));

  results.push(await checkDataDirectory(config.dataDir));

  if (config.dataDir !== ':memory:') {
    for (const fileName of SQLITE_STORE_FILES) {
      results.push(await checkSqliteFile(config.dataDir, fileName));
    }
  } else {
    for (const fileName of SQLITE_STORE_FILES) {
      results.push(
        info(`SQLite: ${fileName}`, 'In-memory data directory (:memory:) — no file to check.'),
      );
    }
  }

  const baseUrl = `http://${healthCheckHost(config.realtime.host)}:${String(config.realtime.port)}`;
  results.push(await checkHealthRoute(baseUrl, '/healthz'));
  results.push(await checkHealthRoute(baseUrl, '/readyz'));

  results.push(...checkTurn(config));

  return results;
}

export function printDoctorReport(results: readonly DoctorCheckResult[]): void {
  for (const result of results) {
    console.info(`[${result.status}] ${result.name}: ${result.message}`);
  }
  const passed = results.filter((result) => result.status === 'PASS').length;
  const warned = results.filter((result) => result.status === 'WARN').length;
  const failed = results.filter((result) => result.status === 'FAIL').length;
  console.info('');
  console.info(`${String(passed)} passed, ${String(warned)} warnings, ${String(failed)} failed`);
}

async function main(): Promise<void> {
  const results = await runDoctorChecks();
  printDoctorReport(results);
  process.exitCode = results.some((result) => result.status === 'FAIL') ? 1 : 0;
}

// Real VPS testing (T15) found `path.resolve` comparison alone is not enough: in the native
// deployment layout, `/opt/chantivo/current` is a symlink (deliberately, for atomic update/rollback —
// see install-chantivo.sh's flip_current_symlink) to `/opt/chantivo/releases/<version>`. Invoked as
// `node /opt/chantivo/current/dist/cli-doctor.js`, `process.argv[1]` reflects that symlink path
// verbatim, but Node's ESM loader resolves the entry module's `import.meta.url` to the *real* (symlink-
// traversed) path — the two never matched, `isEntryPoint` was always `false` in this exact deployment
// shape, and `main()` silently never ran (exit 0, no output). `realpathSync` on both sides makes the
// comparison symlink-tolerant regardless of which path either side started from. Exported so a test
// can prove this against a real symlink on the real filesystem, not just trust the reasoning.
export function resolvesToSameRealPath(pathA: string, pathB: string): boolean {
  try {
    return realpathSync(pathA) === realpathSync(pathB);
  } catch {
    // A path that can't be realpath'd (e.g. nonexistent) can't refer to the same file as anything —
    // fail closed to "not the same" rather than throw.
    return false;
  }
}

const isEntryPoint =
  process.argv[1] !== undefined &&
  resolvesToSameRealPath(process.argv[1], fileURLToPath(import.meta.url));

if (isEntryPoint) {
  main().catch((error: unknown) => {
    console.error('Doctor run failed unexpectedly', error);
    process.exitCode = 1;
  });
}
