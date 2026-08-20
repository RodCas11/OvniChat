import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  parseServerConfigFile,
  readServerConfigFile,
  ServerConfigFileError,
} from '../../services/dedicated-server/src/server-config-file.js';

describe('parseServerConfigFile', () => {
  it('accepts a fully-specified valid config', () => {
    const config = parseServerConfigFile(
      JSON.stringify({
        name: 'Rodrigo Server',
        host: '0.0.0.0',
        port: 8090,
        maxConnections: 64,
        voiceChannels: [
          { channelId: 'general', name: 'General' },
          { channelId: 'games', name: 'Games' },
        ],
      }),
    );
    expect(config.name).toBe('Rodrigo Server');
    expect(config.voiceChannels).toHaveLength(2);
  });

  it('accepts an empty object — every field is optional', () => {
    expect(() => parseServerConfigFile('{}')).not.toThrow();
  });

  it('accepts a config that only sets voiceChannels', () => {
    const config = parseServerConfigFile(
      JSON.stringify({ voiceChannels: [{ channelId: 'general', name: 'General' }] }),
    );
    expect(config.name).toBeUndefined();
    expect(config.voiceChannels).toEqual([{ channelId: 'general', name: 'General' }]);
  });

  it('rejects malformed JSON', () => {
    expect(() => parseServerConfigFile('{not valid json')).toThrow(ServerConfigFileError);
  });

  it('rejects an invalid port', () => {
    expect(() => parseServerConfigFile(JSON.stringify({ port: 70_000 }))).toThrow(
      ServerConfigFileError,
    );
    expect(() => parseServerConfigFile(JSON.stringify({ port: -1 }))).toThrow(
      ServerConfigFileError,
    );
  });

  it('rejects a name containing control characters (matches the wire serverNameSchema)', () => {
    expect(() => parseServerConfigFile(JSON.stringify({ name: 'Evil\nServer' }))).toThrow(
      ServerConfigFileError,
    );
  });

  it('rejects a name longer than the wire protocol allows (100 chars)', () => {
    expect(() => parseServerConfigFile(JSON.stringify({ name: 'x'.repeat(101) }))).toThrow(
      ServerConfigFileError,
    );
  });

  it('rejects a blank host', () => {
    expect(() => parseServerConfigFile(JSON.stringify({ host: '' }))).toThrow(
      ServerConfigFileError,
    );
  });

  it('rejects an invalid maxConnections', () => {
    expect(() => parseServerConfigFile(JSON.stringify({ maxConnections: 0 }))).toThrow(
      ServerConfigFileError,
    );
    expect(() => parseServerConfigFile(JSON.stringify({ maxConnections: -5 }))).toThrow(
      ServerConfigFileError,
    );
  });

  it('rejects duplicate voice channel ids', () => {
    expect(() =>
      parseServerConfigFile(
        JSON.stringify({
          voiceChannels: [
            { channelId: 'general', name: 'General' },
            { channelId: 'general', name: 'General 2' },
          ],
        }),
      ),
    ).toThrow(/duplicate/i);
  });

  it('rejects an invalid channel id (wrong pattern)', () => {
    expect(() =>
      parseServerConfigFile(
        JSON.stringify({ voiceChannels: [{ channelId: 'Not Valid!', name: 'x' }] }),
      ),
    ).toThrow(ServerConfigFileError);
  });

  it('rejects an empty channel name', () => {
    expect(() =>
      parseServerConfigFile(
        JSON.stringify({ voiceChannels: [{ channelId: 'general', name: '' }] }),
      ),
    ).toThrow(ServerConfigFileError);
  });

  it('rejects more than the maximum allowed channels', () => {
    const voiceChannels = Array.from({ length: 65 }, (_, i) => ({
      channelId: `channel-${String(i)}`,
      name: `Channel ${String(i)}`,
    }));
    expect(() => parseServerConfigFile(JSON.stringify({ voiceChannels }))).toThrow(
      ServerConfigFileError,
    );
  });

  it('rejects unknown top-level fields', () => {
    expect(() => parseServerConfigFile(JSON.stringify({ name: 'x', password: 'secret' }))).toThrow(
      ServerConfigFileError,
    );
  });

  it('rejects a config that is valid JSON but not an object (e.g. an array)', () => {
    expect(() => parseServerConfigFile(JSON.stringify(['not', 'an', 'object']))).toThrow(
      ServerConfigFileError,
    );
  });
});

describe('readServerConfigFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dv-server-config-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns undefined when the file does not exist (first-run / no config file)', async () => {
    const result = await readServerConfigFile(path.join(dir, 'does-not-exist.json'));
    expect(result).toBeUndefined();
  });

  it('reads and validates a real file from disk', async () => {
    const filePath = path.join(dir, 'server.config.json');
    writeFileSync(filePath, JSON.stringify({ name: 'Test Server' }));
    const result = await readServerConfigFile(filePath);
    expect(result?.name).toBe('Test Server');
  });

  it('throws for a real file that fails validation, never silently falling back to defaults', async () => {
    const filePath = path.join(dir, 'server.config.json');
    writeFileSync(filePath, JSON.stringify({ port: 'not-a-number' }));
    await expect(readServerConfigFile(filePath)).rejects.toThrow(ServerConfigFileError);
  });
});
