import { realpathSync } from 'node:fs';
import { access, constants as fsConstants } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigValidationError } from '@disco-voador/config';

import { AuthorizationStore } from './authorization/store.js';
import { SERVER_ADMIN_GROUP_ID } from './authorization/permissions.js';
import { loadDedicatedServerConfig, type DedicatedServerConfig } from './config.js';
import { ServerConfigFileError } from './server-config-file.js';

/**
 * T15 — `chantivo-server admin-token create`: the **sole** mechanism by which a Dedicated Server
 * ever gets a Server Admin credential, both for the very first claim on a brand-new server and for
 * every later recovery. There used to be a separate first-boot "bootstrap" token minted and printed
 * automatically by `cli.ts` on fresh startup — removed (T15 security fix) because that print
 * happened inside the same long-running, systemd/Docker-supervised server process whose stdout is
 * captured wholesale into infrastructure logs (`journalctl -u chantivo-server`, `docker compose
 * logs`), leaking a raw admin-equivalent secret into them on every fresh install. This command
 * mints a brand-new `privilege` token bound to the built-in Server Admin group
 * (`SERVER_ADMIN_GROUP_ID`) as its own distinct, one-shot process — invoked once by the installer
 * immediately after a fresh server first reports healthy (for the initial claim), and again later
 * by an operator whenever a previously-minted token was lost before being redeemed (recovery). Both
 * cases go through the exact same code path deliberately — there is no special-cased "first ever"
 * behavior, since the whole point of this mechanism is that it is always safely re-runnable.
 *
 * Deliberately opens its own short-lived {@link AuthorizationStore} directly against
 * `config.dataDir`, WITHOUT going through `storage/data-dir-lock.ts`'s `acquireDataDirLock` — that
 * lock exists to keep two full server *processes* from sharing a data directory, not to block a
 * single short-lived administrative open of the same kind `sqlite-store-utils.ts`'s `WAL` journal
 * mode already supports (one writer, many readers, safely, at the SQLite level). Acquiring the
 * process-instance lock here would incorrectly fail while the real server this command targets is
 * still running, which is exactly the scenario this command exists to support.
 */

const RECOVERY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours — long enough for an operator (or the
// installer, for the very first claim) to act on it without hunting for a shell session, short
// enough that a token nobody redeems doesn't sit as a standing admin-equivalent credential
// indefinitely. Deliberately the SAME TTL for both the first-ever call on a fresh server and every
// later recovery call — one uniform, always-safely-re-runnable code path, no special-casing "first
// call ever" vs "later recovery," since whoever can run this command already has privileged shell
// access to the host in both cases.

export class AdminTokenCliError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminTokenCliError';
  }
}

export interface MintedRecoveryToken {
  /** The raw, unhashed bearer token — only ever held in process memory, never persisted. */
  readonly token: string;
  readonly expiresAt: number | undefined;
}

function resolveAuthorizationPath(dataDir: string): string {
  return dataDir === ':memory:' ? ':memory:' : path.join(dataDir, 'authorization.sqlite');
}

/**
 * Mints a new Server Admin privilege token against an already-initialized authorization store at
 * `config.dataDir`. Fails loudly (never silently creates a fresh store) when no authorization store
 * has ever been initialized there — `node:sqlite`'s `DatabaseSync` would otherwise happily create
 * (and group-seed, per `seedFreshDatabase`) a brand-new, empty database file at that path, which
 * would be a genuine "accidentally re-initialize a live server's authorization state" bug for
 * exactly the operator (or installer) this command is meant to help.
 */
export async function mintServerAdminRecoveryToken(
  config: DedicatedServerConfig,
): Promise<MintedRecoveryToken> {
  const authorizationPath = resolveAuthorizationPath(config.dataDir);

  if (authorizationPath !== ':memory:') {
    try {
      await access(authorizationPath, fsConstants.F_OK);
    } catch {
      throw new AdminTokenCliError(
        `No authorization store found at "${authorizationPath}". This server has never been ` +
          `started against data directory "${config.dataDir}" — start it at least once (so its ` +
          'authorization store is initialized) before minting a recovery token.',
      );
    }
  }

  let store: AuthorizationStore;
  try {
    store = new AuthorizationStore(authorizationPath, { accessMode: config.accessMode });
  } catch (error) {
    throw new AdminTokenCliError(
      `Could not open the authorization store at "${authorizationPath}": ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  try {
    const result = store.createToken({
      tokenKind: 'privilege',
      groupId: SERVER_ADMIN_GROUP_ID,
      expiresInMs: RECOVERY_TOKEN_TTL_MS,
    });
    // Unreachable in practice — SERVER_ADMIN_GROUP_ID is one of the three built-in groups seeded at
    // first-ever initialization and is never deletable (`PROTECTED_GROUP_IDS`) — but this store's
    // own `createToken` still returns a typed failure shape, so honor it rather than assume.
    if (!result.ok) {
      throw new AdminTokenCliError(
        `Failed to mint a Server Admin recovery token: ${result.message}`,
      );
    }
    return { token: result.token, expiresAt: result.expiresAt };
  } finally {
    store.close();
  }
}

/** The one and only place this process ever prints the raw token — a "save this now, it will not be
 * shown again" framing, `console.info` called exactly once, never the structured logger (so the raw
 * token is never written to a log file/collector). This is what makes this command's stdout safe to
 * capture: unlike `cli.ts`'s `printStartupBanner` (T15: never prints a raw token at all), this
 * function runs in a distinct, one-shot CLI process that is never the supervised service systemd/
 * Docker capture — only whoever directly invoked this command ever sees this output. */
function printRecoveryTokenBanner(token: MintedRecoveryToken): void {
  const lines = [
    '================================================================',
    'New Server Admin privilege key minted (operator recovery).',
    '',
    `  ${token.token}`,
    '',
    'Save this key now — it will not be shown again. Redeem it from the',
    'client (or "Use Privilege Key" once connected) to become Server Admin.',
    ...(token.expiresAt !== undefined
      ? [`This key expires at ${new Date(token.expiresAt).toISOString()}.`]
      : []),
    '================================================================',
  ];
  console.info(lines.join('\n'));
}

async function main(): Promise<void> {
  let config: DedicatedServerConfig;
  try {
    config = await loadDedicatedServerConfig();
  } catch (error) {
    if (error instanceof ConfigValidationError || error instanceof ServerConfigFileError) {
      console.error(error.message);
    } else {
      console.error('Failed to load Dedicated Server configuration', error);
    }
    process.exitCode = 1;
    return;
  }

  try {
    const minted = await mintServerAdminRecoveryToken(config);
    printRecoveryTokenBanner(minted);
  } catch (error) {
    if (error instanceof AdminTokenCliError) {
      console.error(error.message);
    } else {
      console.error(
        `Failed to mint a Server Admin recovery token: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    process.exitCode = 1;
  }
}

// Real VPS testing (T15) found `path.resolve` comparison alone is not enough: in the native
// deployment layout, `/opt/chantivo/current` is a symlink (deliberately, for atomic update/rollback —
// see install-chantivo.sh's flip_current_symlink) to `/opt/chantivo/releases/<version>`. Invoked as
// `node /opt/chantivo/current/dist/cli-admin-token.js`, `process.argv[1]` reflects that symlink path
// verbatim, but Node's ESM loader resolves the entry module's `import.meta.url` to the *real*
// (symlink-traversed) path — the two never matched, `isEntryPoint` was always `false` in this exact
// deployment shape, and `main()` silently never ran (exit 0, no token, no error — a locked-out
// operator following the documented recovery procedure got nothing). `realpathSync` on both sides
// makes the comparison symlink-tolerant regardless of which path either side started from. Exported
// so a test can prove this against a real symlink on the real filesystem, not just trust the reasoning.
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
    console.error('Failed to mint a Server Admin recovery token', error);
    process.exitCode = 1;
  });
}
