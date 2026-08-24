import { ConfigValidationError } from '@disco-voador/config';
import { CURRENT_PROTOCOL_VERSION } from '@disco-voador/protocol';
import { createLogger } from '@disco-voador/realtime';

import { loadDedicatedServerConfig } from './config.js';
import { createDedicatedServer, ensureDataDirExists } from './create-dedicated-server.js';
import { ServerConfigFileError } from './server-config-file.js';
import { acquireDataDirLock, DataDirLockError, type DataDirLock } from './storage/data-dir-lock.js';

/** Product-facing startup banner (T8 Section 7) — an operator's first signal the server is
 * actually running and how it's configured, without printing anything sensitive (no client keys;
 * T9's one deliberate exception — the one-time bootstrap token — is printed separately by
 * {@link printBootstrapToken}, never folded into this routine banner so it can never be mistaken
 * for something printed on every restart). */
/**
 * `bootstrapToken` (T9 Section 10/11) is folded into this *same* banner — printed exactly once,
 * only on the very first startup against a brand-new authorization store, as a visually distinct
 * trailing block (never repeated on a later restart, never written to the structured logger; the
 * raw token is not persisted anywhere, so this is the operator's only chance to ever see it) —
 * rather than a second separate `console.info` call, specifically so a reader watching stdout (a
 * human, or a smoke-test script) can rely on "Ready." having appeared meaning the bootstrap block
 * already has too, with no risk of the two being split across separate, out-of-order writes to a
 * piped (non-TTY) stdout.
 */
function printStartupBanner(
  config: Awaited<ReturnType<typeof loadDedicatedServerConfig>>,
  address: { readonly host: string; readonly port: number },
  bootstrapToken: string | undefined,
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

  if (bootstrapToken) {
    lines.push(
      '',
      '================================================================',
      'Authorization store initialized for the first time.',
      '',
      'Initial Server Admin privilege key:',
      '',
      `  ${bootstrapToken}`,
      '',
      'Save this key now — it will not be shown again. Redeem it from the',
      'client (or "Use Privilege Key" once connected) to become Server Admin.',
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
      printStartupBanner(config, address, server.bootstrapToken);
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
