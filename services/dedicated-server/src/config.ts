import { envNonEmptyString, parseConfig } from '@disco-voador/config';
import {
  DEFAULT_VOICE_CHANNELS,
  loadRealtimeConfig,
  type RealtimeConfig,
} from '@disco-voador/realtime';
import { serverNameSchema, type VoiceChannelSummary } from '@disco-voador/protocol';
import { z } from 'zod';

import { readServerConfigFile, type ServerConfigFile } from './server-config-file.js';
import { inferDeploymentScope, type DeploymentScope } from './turn/public-endpoint.js';

/**
 * T14 — TURN is optional (`docs/references/COTURN.md`); `turn` is `undefined` whenever it is not
 * configured. `sharedSecret` is the Coturn `use-auth-secret` REST shared secret — never
 * client-visible, never persisted anywhere but process memory, and never sourced from the hand-
 * edited config file (see `server-config-file.ts`'s own doc comment: no secret state belongs
 * there). `credentialTtlSeconds` bounds how long a minted username/credential pair remains valid
 * (see `turn/mint-turn-credentials.ts`). `urls` is the operator's own `turn:`/`turns:` endpoint
 * list, handed back verbatim as each minted `RTCIceServer.urls`.
 */
export interface TurnConfig {
  readonly sharedSecret: string;
  readonly credentialTtlSeconds: number;
  readonly urls: readonly string[];
}

/**
 * 6 hours. Do not lower this below one hour without re-reading the history: a 300-second default
 * shipped once and made every voice join more than ~5 minutes after connecting fail against real
 * Coturn (`401 Unauthorized`, zero relay candidates gathered). T15.2's periodic re-mint/re-push
 * (`services/realtime`'s `turn-credential-refresh.ts`) means the value no longer has to cover a
 * whole session on its own — the refresh interval is half of whatever this is — but the floor is
 * enforced by a test (`tests/dedicated-server/config.test.ts`) rather than left to this comment.
 */
const DEFAULT_TURN_CREDENTIAL_TTL_SECONDS = 21_600;

function isTurnUrl(value: string): boolean {
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'turn:' || protocol === 'turns:';
  } catch {
    return false;
  }
}

/** Mirrors `apps/desktop/src/main/desktop-config.ts`'s `stunUrlsSchema` validation shape
 * (comma-separated, per-entry scheme check) — replicated locally rather than imported, since that
 * module lives in a different workspace (`apps/desktop`) this package must not depend on. Unlike
 * `stunUrlsSchema`, an unset value stays `undefined` here (never coerced to `[]`) so
 * `overrideSchema`'s own `superRefine` below can distinguish "not set" from "set to nothing". */
const turnUrlsSchema = z
  .string()
  .min(1)
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .pipe(z.array(z.string().refine(isTurnUrl, 'must be a turn: or turns: URL')).min(1))
  .optional();

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

const DEFAULT_SERVER_NAME = 'Chantivo Server';
export const DEFAULT_SERVER_CONFIG_PATH = 'disco-voador-server.config.json';
/** T9 — relative to the process's working directory, matching the config file's own default-path
 * convention. Never the repository source tree by design (this is a `.gitignore`d-by-pattern
 * runtime data directory, the same posture `%APPDATA%/DiscoVoador/` has for the desktop client). */
export const DEFAULT_DATA_DIR = 'disco-voador-server-data';

const overrideSchema = z
  .object({
    // Reuses the same wire-protocol `serverNameSchema` the config file's own `name` field now uses
    // (see `server-config-file.ts`) — an env-supplied name that fails this can never reach a real
    // `server:hello` message, so it must fail loudly here at config-load time instead of silently
    // producing a server every client's own strict-mode parser then rejects.
    DISCO_VOADOR_SERVER_NAME: serverNameSchema.optional(),
    DISCO_VOADOR_SERVER_CONFIG_PATH: envNonEmptyString().optional(),
    DISCO_VOADOR_SERVER_ACCESS_MODE: z.enum(['open', 'invite-only']).optional(),
    DISCO_VOADOR_SERVER_DATA_DIR: envNonEmptyString().optional(),
    // T14 — display-only (see `DedicatedServerConfig.publicHost`'s own doc comment); never used
    // for binding.
    DISCO_VOADOR_SERVER_PUBLIC_HOST: envNonEmptyString().optional(),
    // T15 follow-up — does this deployment intend to serve remote clients over the internet
    // (`public`), or is it a development/integration/LAN-only deployment (`local`)? Purely a
    // diagnostic signal: nothing binds, routes, or authenticates differently because of it. It
    // exists so `chantivo-server doctor` can tell "a loopback TURN address, deliberately, on a
    // developer's laptop" apart from "a loopback TURN address advertised to every remote client of
    // a real public server" — the exact production incident this field was added for. Optional and
    // inferred from `DISCO_VOADOR_SERVER_PUBLIC_HOST` when unset (see `inferDeploymentScope`), so
    // no existing deployment has to set anything.
    DISCO_VOADOR_DEPLOYMENT_SCOPE: z.enum(['public', 'local']).optional(),
    // T14 — TURN (see `TurnConfig`'s own doc comment above). Both of these must be set together or
    // neither at all — enforced by the `superRefine` below, not left as a silently-partial config.
    DISCO_VOADOR_TURN_SHARED_SECRET: envNonEmptyString().optional(),
    DISCO_VOADOR_TURN_URLS: turnUrlsSchema,
    DISCO_VOADOR_TURN_CREDENTIAL_TTL_SECONDS: z.coerce.number().int().positive().optional(),
  })
  .superRefine((data, ctx) => {
    const hasSecret = data.DISCO_VOADOR_TURN_SHARED_SECRET !== undefined;
    const hasUrls = data.DISCO_VOADOR_TURN_URLS !== undefined;
    if (hasSecret === hasUrls) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [hasUrls ? 'DISCO_VOADOR_TURN_SHARED_SECRET' : 'DISCO_VOADOR_TURN_URLS'],
      message: hasUrls
        ? 'DISCO_VOADOR_TURN_URLS is set but DISCO_VOADOR_TURN_SHARED_SECRET is missing — TURN requires both'
        : 'DISCO_VOADOR_TURN_SHARED_SECRET is set but DISCO_VOADOR_TURN_URLS is missing — TURN requires both',
    });
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
  /** T14 — a display-only value: the address this server tells operators/docs it's reachable at
   * (e.g. for a client's manual "server address" field, or generated invite text). **Never** used
   * for binding — `REALTIME_HOST`/`REALTIME_PORT` (via `realtime.host`/`realtime.port`) remain the
   * sole bind authority, unaffected by this field's presence or value. `undefined` when the
   * operator hasn't set one. */
  readonly publicHost: string | undefined;
  /** T15 follow-up — `'public'` when this deployment serves remote clients over the internet,
   * `'local'` for development/integration/LAN-only deployments. Diagnostic only (see the env
   * schema's own comment); resolved from `DISCO_VOADOR_DEPLOYMENT_SCOPE` when set, otherwise
   * inferred from {@link publicHost}. */
  readonly deploymentScope: DeploymentScope;
  /** T14 — Coturn `use-auth-secret` REST credential minting configuration (see `TurnConfig`'s own
   * doc comment above). `undefined` whenever TURN is not configured — a self-hosted deployment with
   * no TURN relay (STUN/P2P only) is a fully supported, documented configuration, not an error. */
  readonly turn: TurnConfig | undefined;
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
    DISCO_VOADOR_SERVER_PUBLIC_HOST,
    DISCO_VOADOR_DEPLOYMENT_SCOPE,
    DISCO_VOADOR_TURN_SHARED_SECRET,
    DISCO_VOADOR_TURN_URLS,
    DISCO_VOADOR_TURN_CREDENTIAL_TTL_SECONDS,
  } = parseConfig(overrideSchema, source);

  const configFilePath = DISCO_VOADOR_SERVER_CONFIG_PATH ?? DEFAULT_SERVER_CONFIG_PATH;
  const file = await readServerConfigFile(configFilePath);

  const realtime = loadRealtimeConfig({
    ...fileValuesAsRealtimeEnvSource(file),
    ...source,
  });

  // The `superRefine` above already rejected any partial (secret-only or urls-only) configuration,
  // so by this point either both are present or neither is — safe to gate construction on either
  // one alone.
  const turn: TurnConfig | undefined =
    DISCO_VOADOR_TURN_SHARED_SECRET !== undefined && DISCO_VOADOR_TURN_URLS !== undefined
      ? {
          sharedSecret: DISCO_VOADOR_TURN_SHARED_SECRET,
          credentialTtlSeconds:
            DISCO_VOADOR_TURN_CREDENTIAL_TTL_SECONDS ?? DEFAULT_TURN_CREDENTIAL_TTL_SECONDS,
          urls: DISCO_VOADOR_TURN_URLS,
        }
      : undefined;

  const publicHost = DISCO_VOADOR_SERVER_PUBLIC_HOST ?? file?.publicHost ?? undefined;

  return {
    name: DISCO_VOADOR_SERVER_NAME ?? file?.name ?? DEFAULT_SERVER_NAME,
    realtime,
    voiceChannels: file?.voiceChannels ?? DEFAULT_VOICE_CHANNELS,
    accessMode: DISCO_VOADOR_SERVER_ACCESS_MODE ?? file?.accessMode ?? 'open',
    dataDir: DISCO_VOADOR_SERVER_DATA_DIR ?? file?.dataDir ?? DEFAULT_DATA_DIR,
    configFilePath,
    configFileFound: file !== undefined,
    publicHost,
    deploymentScope: inferDeploymentScope(DISCO_VOADOR_DEPLOYMENT_SCOPE, publicHost),
    turn,
  };
}
