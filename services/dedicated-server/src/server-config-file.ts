import { readFile } from 'node:fs/promises';

import {
  serverNameSchema,
  voiceChannelSummarySchema,
  type VoiceChannelSummary,
} from '@disco-voador/protocol';
import { z } from 'zod';

/**
 * The Dedicated Server's own hand-editable configuration file — server display name, network
 * bind, connection cap, and the voice-channel catalog this installation offers. Deliberately a
 * small, flat, strictly-validated JSON file (see `docs/architecture/DEDICATED_SERVER.md`'s
 * "Configuration" section for why JSON, not YAML/TOML: zero new dependencies, and every value
 * already needs the exact same zod-strict-validation discipline the rest of this codebase uses).
 * No field here is server-*local* state — this file is meant to be hand-edited by the operator,
 * versioned, and portable across a reinstall; contrast `identity.json`-style client-local secrets,
 * which this file must never contain (T8 Section 11/35).
 */

const MAX_VOICE_CHANNELS = 64;

const serverConfigFileSchema = z
  .object({
    // Reuses the exact wire-protocol `serverNameSchema` (see `packages/protocol/src/server-metadata.ts`)
    // rather than a separately-hand-rolled bound — a name this file accepts is always a name the
    // server's own `server:hello` message can legally carry. Before this fix, a bespoke
    // `z.string().min(1).max(100)` here silently accepted control characters `serverNameSchema`
    // rejects, so a config-file name containing one (e.g. a pasted trailing newline) would start
    // the server successfully but then be silently dropped by every real client's own
    // `parseServerMessage` validation on `server:hello`, hanging the connection with no visible
    // error anywhere (found by QA review, reproduced end-to-end with a real server + real client).
    name: serverNameSchema.optional(),
    // T14 — display-only: the address this server tells operators/docs it's reachable at. Never
    // used for binding (`host`/`REALTIME_HOST` above remain the sole bind authority) — see
    // `config.ts`'s own doc comment on `publicHost`.
    publicHost: z.string().min(1).optional(),
    host: z.string().min(1).optional(),
    port: z.number().int().min(0).max(65535).optional(),
    maxConnections: z.number().int().positive().optional(),
    voiceChannels: z.array(voiceChannelSummarySchema).max(MAX_VOICE_CHANNELS).optional(),
    // T9 — server-local authorization (see docs/architecture/SERVER_AUTHORIZATION.md). `open`
    // (default) admits any non-banned identity as a non-persistent Guest; `invite-only` requires
    // either an existing persistent membership or a valid invite token at connect time.
    accessMode: z.enum(['open', 'invite-only']).optional(),
    // Where the authorization SQLite store (groups/memberships/tokens/bans) lives — deliberately
    // separate from the desktop client's AppData (T8 Section 34) and never the repository source
    // tree by default. Relative paths resolve against the process's working directory, matching
    // this file's own path convention.
    dataDir: z.string().min(1).optional(),
  })
  .strict();

export type ServerConfigFile = z.infer<typeof serverConfigFileSchema>;

export class ServerConfigFileError extends Error {
  constructor(
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ServerConfigFileError';
  }
}

function assertNoDuplicateChannelIds(channels: readonly VoiceChannelSummary[]): void {
  const seen = new Set<string>();
  for (const channel of channels) {
    if (seen.has(channel.channelId)) {
      throw new ServerConfigFileError(`Duplicate voiceChannels.channelId "${channel.channelId}"`);
    }
    seen.add(channel.channelId);
  }
}

/** Parses and strictly validates an already-read config file string — split from
 * {@link readServerConfigFile} so tests can exercise validation without real file I/O. */
export function parseServerConfigFile(raw: string): ServerConfigFile {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (error) {
    throw new ServerConfigFileError('Server config file is not valid JSON', error);
  }

  const result = serverConfigFileSchema.safeParse(parsedJson);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      return `${path}: ${issue.message}`;
    });
    throw new ServerConfigFileError(`Invalid server config file:\n- ${issues.join('\n- ')}`);
  }

  if (result.data.voiceChannels) {
    assertNoDuplicateChannelIds(result.data.voiceChannels);
  }

  return result.data;
}

/**
 * Reads and validates the config file at `path`. Returns `undefined` only when the file genuinely
 * does not exist (no config file is a valid, documented way to run entirely on defaults/env) —
 * every other failure (unreadable, malformed JSON, fails schema validation, duplicate channel
 * ids) throws {@link ServerConfigFileError} rather than silently falling back to defaults, per the
 * same "never silently ignore a misspelled security-sensitive setting" discipline
 * `main/identity/identity-file.ts` already established for the desktop client.
 */
export async function readServerConfigFile(path: string): Promise<ServerConfigFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new ServerConfigFileError(`Failed to read server config file at "${path}"`, error);
  }
  return parseServerConfigFile(raw);
}
