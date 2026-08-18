import { ConfigValidationError } from '@disco-voador/config';

import { loadRealtimeConfig } from './config.js';
import { createLogger } from './logging.js';
import { createRealtimeServer } from './server.js';

function bootstrap(): void {
  let config;
  try {
    config = loadRealtimeConfig();
  } catch (error) {
    if (error instanceof ConfigValidationError) {
      console.error(error.message);
    } else {
      console.error('Failed to load realtime service configuration', error);
    }
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(config.logLevel);
  const server = createRealtimeServer(config, { logger });

  // Last-resort safety net. Per-message handling in `Connection` already contains an unexpected
  // throw to just that one connection (see connection.ts), so this should never fire in normal
  // operation — it exists for a genuinely unexpected failure elsewhere in the process. Node's own
  // guidance is that resuming after `uncaughtException` is not safe, so this logs and exits
  // rather than trying to keep serving other connections from a possibly-inconsistent state.
  process.on('uncaughtException', (error) => {
    logger.error('uncaught_exception', { error: error.message });
    process.exit(1);
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('unhandled_rejection', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
    process.exit(1);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server_shutdown_signal', { signal });
    server
      .stop()
      .then(() => {
        process.exit(0);
      })
      .catch((error: unknown) => {
        logger.error('server_shutdown_failed', {
          error: error instanceof Error ? error.message : String(error),
        });
        process.exit(1);
      });
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  server
    .start()
    .then((address) => {
      logger.info('server_listening', { ...address });
      console.info(`Realtime server listening on ${address.host}:${String(address.port)}`);
    })
    .catch((error: unknown) => {
      logger.error('server_start_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      process.exitCode = 1;
    });
}

bootstrap();
