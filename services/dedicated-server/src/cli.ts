import { ConfigValidationError } from '@disco-voador/config';
import { CURRENT_PROTOCOL_VERSION } from '@disco-voador/protocol';
import { createLogger } from '@disco-voador/realtime';

import { loadDedicatedServerConfig } from './config.js';
import { createDedicatedServer, ensureDataDirExists } from './create-dedicated-server.js';
import { ServerConfigFileError } from './server-config-file.js';
import { acquireDataDirLock, DataDirLockError, type DataDirLock } from './storage/data-dir-lock.js';

/**
 * Product-facing startup banner (T8 Section 7) — an operator's first signal the server is actually
 * running and how it's configured, without printing anything sensitive (no client keys, and —
 * since T15's security fix — never a raw admin/privilege token either). This function runs inside
 * the same long-running, supervised server process whose stdout systemd/Docker capture wholesale
 * (`journalctl -u chantivo-server`, `docker compose logs`), so nothing printed here can ever be
 * treated as secret; genuinely secret material (a minted admin token) is only ever printed by the
 * distinct, one-shot `chantivo-server admin-token create` process (`cli-admin-token.ts`), whose
 * stdout is never part of this stream.
 *
 * When the authorization store has no claimed Server Admin yet, this appends a safe, non-secret
 * hint block pointing the operator at that command — gated on `hasAnyServerAdmin` (computed fresh
 * at composition time by `createDedicatedServer`) so it only ever appears while the server is
 * genuinely unclaimed, never on every restart of an already-claimed server.
 */
function printStartupBanner(
  config: Awaited<ReturnType<typeof loadDedicatedServerConfig>>,
  address: { readonly host: string; readonly port: number },
  hasAnyServerAdmin: boolean,
): void {
  const lines = [
    'Chantivo Dedicated Server',
    `Server name:   ${config.name}`,
    `Listening:     ${address.host}:${String(address.port)}`,
    `Protocol:      v${String(CURRENT_PROTOCOL_VERSION)}`,
    'Identity auth: enabled',
    `Access mode:   ${config.accessMode}`,
    `Voice channels: ${String(config.voiceChannels.length)}`,
    `Data dir:      ${config.dataDir}`,
    config.configFileFound
      ? `Config file:   ${config.configFilePath}`
      : `Config file:   ${config.configFilePath} (not found — using defaults/environment)`,
    '',
    'Ready.',
  ];

  if (!hasAnyServerAdmin) {
    lines.push(
      '',
      '================================================================',
      'No administrator has claimed this server yet.',
      'Run:',
      '  sudo chantivo-server admin-token create',
      '================================================================',
    );
  }

  console.info(lines.join('\n'));
}

async function bootstrap(): Promise<void> {
  let config;
  let dataDirLock: DataDirLock | undefined;
  try {
    config = await loadDedicatedServerConfig();
    await ensureDataDirExists(config.dataDir);
    dataDirLock = acquireDataDirLock(config.dataDir);
  } catch (error) {
    if (
      error instanceof ConfigValidationError ||
      error instanceof ServerConfigFileError ||
      error instanceof DataDirLockError
    ) {
      console.error(error.message);
    } else {
      console.error('Failed to load Dedicated Server configuration', error);
    }
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config.realtime.logLevel);

  let server;
  try {
    server = createDedicatedServer(config, { logger });
  } catch (error) {
    // Fail-closed on authorization-store corruption (T9 Section 69) — never silently discard
    // admins/bans/memberships and start an unprotected server.
    console.error(
      `Failed to open the authorization store: ${error instanceof Error ? error.message : String(error)}`,
    );
    // The data-dir lock was already acquired above; release it so a corrected retry isn't itself
    // blocked by this failed attempt's own lock file.
    dataDirLock?.release();
    process.exitCode = 1;
    return;
  }

  // Same last-resort safety net `services/realtime/src/cli.ts` uses — see its own doc comment for
  // why resuming after `uncaughtException` is not attempted. The data-dir lock is released here too
  // (T14) — without this, a handled crash (as opposed to a hard SIGKILL) would leave a stale `.lock`
  // file even though the process exited through a code path capable of cleaning up after itself.
  process.on('uncaughtException', (error) => {
    logger.error('uncaught_exception', { error: error.message });
    dataDirLock?.release();
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled_rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
    dataDirLock?.release();
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server_shutdown_signal', { signal });
    console.info(`\nShutting down (${signal})...`);
    server
      .stop()
      .then(() => {
        dataDirLock?.release();
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error('server_shutdown_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        dataDirLock?.release();
        process.exit(1);
      });
  };

  // SIGINT (Ctrl+C) and SIGTERM (the standard graceful-stop signal on both Windows and POSIX
  // process managers) are the two T8 Section 32 asks for; Windows does not deliver POSIX signals
  // identically to Linux, but Node's `process.on('SIGINT'/'SIGTERM', ...)` is documented to work
  // on Windows for the Ctrl+C/taskkill cases this covers — a full Windows Service wrapper (T14) is
  // a distinct, later concern.
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  server
    .start()
    .then((address) => {
      logger.info('server_listening', { ...address, name: config.name });
      printStartupBanner(config, address, server.hasAnyServerAdmin);
    })
    .catch((error: unknown) => {
      logger.error('server_start_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      console.error(
        `Failed to start Dedicated Server: ${error instanceof Error ? error.message : String(error)}`,
      );
      // The server never reached a listening state, so the SIGINT/SIGTERM handlers above won't get
      // a meaningful `server.stop()` to call — release the lock directly so a corrected retry isn't
      // blocked by this failed attempt's own lock file.
      dataDirLock?.release();
      process.exitCode = 1;
    });
}

bootstrap().catch((error: unknown) => {
  console.error('Disco Voador Dedicated Server failed to start', error);
  process.exitCode = 1;
});
