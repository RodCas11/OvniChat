export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

/**
 * A small structured logger: one JSON line per event to stdout/stderr, filtered by level. No
 * dependency was justified for this — it's the entire feature set T2 needs (stable event names,
 * a connection ID where relevant, level filtering). Never pass raw message payloads, secrets, or
 * future credentials as fields; callers are responsible for keeping logged fields safe.
 */
export function createLogger(level: LogLevel): Logger {
  const write = (messageLevel: LogLevel, event: string, fields?: LogFields): void => {
    if (LEVEL_ORDER[messageLevel] < LEVEL_ORDER[level]) return;

    const line = JSON.stringify({
      time: new Date().toISOString(),
      level: messageLevel,
      event,
      ...fields,
    });

    if (messageLevel === 'error') console.error(line);
    else if (messageLevel === 'warn') console.warn(line);
    else console.info(line);
  };

  return {
    debug: (event, fields) => write('debug', event, fields),
    info: (event, fields) => write('info', event, fields),
    warn: (event, fields) => write('warn', event, fields),
    error: (event, fields) => write('error', event, fields),
  };
}

/** A logger that discards everything. Useful as a default in tests that don't assert on logs. */
export function createNoopLogger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}
