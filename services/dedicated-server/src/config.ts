import { envNonEmptyString, parseConfig } from '@disco-voador/config';
import {
  DEFAULT_VOICE_CHANNELS,
  loadRealtimeConfig,
  type RealtimeConfig,
} from '@disco-voador/realtime';
import { serverNameSchema, type VoiceChannelSummary } from '@disco-voador/protocol';
import { z } from 'zod';

import { readServerConfigFile, type ServerConfigFile } from './server-config-file.js';

/**
 * Configuration precedence (T8 Section 9): `defaults < config file < environment variables`.
 * Implemented by converting whatever the config file supplies for `host`/`port`/`maxConnections`
 * into the exact env-var keys `@disco-voador/realtime`'s own `loadRealtimeConfig` already
 * validates (`REALTIME_HOST`/`REALTIME_PORT`/`REALTIME_MAX_CONNECTIONS`), then merging that
 * *underneath* the real `process.env` (spread last, so a real environment variable always wins) —
 * this reuses 100% of the already-tested realtime config validation instead of a second, parallel
 * implementation, and keeps exactly one source of truth for what those three fields mean and how
 * they're bounded.
 *
 * `name` and `voiceChannels` have no realtime-config env-var equivalent (a structured channel list
 * does not map onto a flat scalar env var); `DISCO_VOADOR_SERVER_NAME` is the one additional env
 * override this module defines itself. `voiceChannels` is config-file-only, defaulting to
 * {@link DEFAULT_VOICE_CHANNELS} when no file (or no `voiceChannels` key in it) is given.
 */

const DEFAULT_SERVER_NAME = 'OvniChat Server';
export const DEFAULT_SERVER_CONFIG_PATH = 'disco-voador-server.config.json';
/** T9 — relative to the process's working directory, matching the config file's own default-path
 * convention. Never the repository source tree by design (this is a `.gitignore`d-by-pattern
 * runtime data directory, the same posture `%APPDATA%/DiscoVoador/` has for the desktop client). */
export const DEFAULT_DATA_DIR = 'disco-voador-server-data';

const overrideSchema = z.object({
  // Reuses the same wire-protocol `serverNameSchema` the config file's own `name` field now uses
  // (see `server-config-file.ts`) — an env-supplied name that fails this can never reach a real
  // `server:hello` message, so it must fail loudly here at config-load time instead of silently
  // producing a server every client's own strict-mode parser then rejects.
  DISCO_VOADOR_SERVER_NAME: serverNameSchema.optional(),
  DISCO_VOADOR_SERVER_CONFIG_PATH: envNonEmptyString().optional(),
  DISCO_VOADOR_SERVER_ACCESS_MODE: z.enum(['open', 'invite-only']).optional(),
  DISCO_VOADOR_SERVER_DATA_DIR: envNonEmptyString().optional(),
});

export interface DedicatedServerConfig {
  readonly name: string;
  readonly realtime: RealtimeConfig;
  readonly voiceChannels: readonly VoiceChannelSummary[];
  /** T9 — see `docs/architecture/SERVER_AUTHORIZATION.md`. */
  readonly accessMode: 'open' | 'invite-only';
  readonly dataDir: string;
  /** The config file path actually used, and whether one was actually found there — purely for
   * the startup banner/log, never used for any behavioral branch. */
  readonly configFilePath: string;
  readonly configFileFound: boolean;
}

function fileValuesAsRealtimeEnvSource(file: ServerConfigFile | undefined): Record<string, string> {
  if (!file) return {};
  const source: Record<string, string> = {};
  if (file.host !== undefined) source.REALTIME_HOST = file.host;
  if (file.port !== undefined) source.REALTIME_PORT = String(file.port);
  if (file.maxConnections !== undefined) {
    source.REALTIME_MAX_CONNECTIONS = String(file.maxConnections);
  }
  return source;
}

/**
 * Loads and validates the full Dedicated Server configuration: the config file (if present, see
 * {@link readServerConfigFile} for its own strict-validation/corruption behavior), then env vars
 * on top per the precedence documented above. `source` defaults to `process.env` but is
 * injectable for tests, matching every other `load*Config` function in this codebase.
 */
export async function loadDedicatedServerConfig(
  source: Record<string, string | undefined> = process.env,
): Promise<DedicatedServerConfig> {
  const {
    DISCO_VOADOR_SERVER_NAME,
    DISCO_VOADOR_SERVER_CONFIG_PATH,
    DISCO_VOADOR_SERVER_ACCESS_MODE,
    DISCO_VOADOR_SERVER_DATA_DIR,
  } = parseConfig(overrideSchema, source);

  const configFilePath = DISCO_VOADOR_SERVER_CONFIG_PATH ?? DEFAULT_SERVER_CONFIG_PATH;
  const file = await readServerConfigFile(configFilePath);

  const realtime = loadRealtimeConfig({
    ...fileValuesAsRealtimeEnvSource(file),
    ...source,
  });

  return {
    name: DISCO_VOADOR_SERVER_NAME ?? file?.name ?? DEFAULT_SERVER_NAME,
    realtime,
    voiceChannels: file?.voiceChannels ?? DEFAULT_VOICE_CHANNELS,
    accessMode: DISCO_VOADOR_SERVER_ACCESS_MODE ?? file?.accessMode ?? 'open',
    dataDir: DISCO_VOADOR_SERVER_DATA_DIR ?? file?.dataDir ?? DEFAULT_DATA_DIR,
    configFilePath,
    configFileFound: file !== undefined,
  };
}
