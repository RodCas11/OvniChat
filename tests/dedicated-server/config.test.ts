import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ConfigValidationError } from '@disco-voador/config';
import { DEFAULT_VOICE_CHANNELS } from '@disco-voador/realtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { loadDedicatedServerConfig } from '../../services/dedicated-server/src/config.js';

describe('loadDedicatedServerConfig', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dv-dedicated-server-config-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies safe defaults with no config file and no relevant environment variables', async () => {
    const config = await loadDedicatedServerConfig({
      DISCO_VOADOR_SERVER_CONFIG_PATH: path.join(dir, 'does-not-exist.json'),
    });

    expect(config.name).toBe('Chantivo Server');
    expect(config.voiceChannels).toEqual(DEFAULT_VOICE_CHANNELS);
    expect(config.configFileFound).toBe(false);
    expect(config.realtime.host).toBe('127.0.0.1');
    expect(config.accessMode).toBe('open');
    expect(config.dataDir).toBe('disco-voador-server-data');
  });

  it('T9: a config file sets accessMode/dataDir, and an environment variable overrides them', async () => {
    const filePath = path.join(dir, 'server.config.json');
    writeFileSync(filePath, JSON.stringify({ accessMode: 'invite-only', dataDir: './file-data' }));

    const fileOnly = await loadDedicatedServerConfig({
      DISCO_VOADOR_SERVER_CONFIG_PATH: filePath,
    });
    expect(fileOnly.accessMode).toBe('invite-only');
    expect(fileOnly.dataDir).toBe('./file-data');

    const withEnvOverride = await loadDedicatedServerConfig({
      DISCO_VOADOR_SERVER_CONFIG_PATH: filePath,
      DISCO_VOADOR_SERVER_ACCESS_MODE: 'open',
      DISCO_VOADOR_SERVER_DATA_DIR: './env-data',
    });
    expect(withEnvOverride.accessMode).toBe('open');
    expect(withEnvOverride.dataDir).toBe('./env-data');
  });

  it('rejects an invalid accessMode in the config file', async () => {
    const filePath = path.join(dir, 'server.config.json');
    writeFileSync(filePath, JSON.stringify({ accessMode: 'members-only' }));

    await expect(
      loadDedicatedServerConfig({ DISCO_VOADOR_SERVER_CONFIG_PATH: filePath }),
    ).rejects.toThrow();
  });

  it('a config file overrides the defaults', async () => {
    const filePath = path.join(dir, 'server.config.json');
    writeFileSync(
      filePath,
      JSON.stringify({
        name: 'File Server',
        host: '0.0.0.0',
        port: 9000,
        maxConnections: 10,
        voiceChannels: [{ channelId: 'lobby', name: 'Lobby' }],
      }),
    );

    const config = await loadDedicatedServerConfig({
      DISCO_VOADOR_SERVER_CONFIG_PATH: filePath,
    });

    expect(config.name).toBe('File Server');
    expect(config.realtime.host).toBe('0.0.0.0');
    expect(config.realtime.port).toBe(9000);
    expect(config.realtime.maxConnections).toBe(10);
    expect(config.voiceChannels).toEqual([{ channelId: 'lobby', name: 'Lobby' }]);
    expect(config.configFileFound).toBe(true);
  });

  it('an environment variable overrides the same field set by the config file', async () => {
    const filePath = path.join(dir, 'server.config.json');
    writeFileSync(filePath, JSON.stringify({ host: '0.0.0.0', port: 9000 }));

    const config = await loadDedicatedServerConfig({
      DISCO_VOADOR_SERVER_CONFIG_PATH: filePath,
      REALTIME_HOST: '10.0.0.5',
    });

    // REALTIME_HOST (env) wins over the file's "0.0.0.0"; REALTIME_PORT was not set by env, so
    // the file's 9000 still applies — precedence is per-field, not "env replaces the whole file".
    expect(config.realtime.host).toBe('10.0.0.5');
    expect(config.realtime.port).toBe(9000);
  });

  it('DISCO_VOADOR_SERVER_NAME overrides the config file name', async () => {
    const filePath = path.join(dir, 'server.config.json');
    writeFileSync(filePath, JSON.stringify({ name: 'File Server' }));

    const config = await loadDedicatedServerConfig({
      DISCO_VOADOR_SERVER_CONFIG_PATH: filePath,
      DISCO_VOADOR_SERVER_NAME: 'Env Server',
    });

    expect(config.name).toBe('Env Server');
  });

  it('rejects an invalid environment value clearly instead of silently falling back', async () => {
    await expect(
      loadDedicatedServerConfig({
        DISCO_VOADOR_SERVER_CONFIG_PATH: path.join(dir, 'does-not-exist.json'),
        REALTIME_PORT: 'banana',
      }),
    ).rejects.toThrow(ConfigValidationError);
  });

  it(
    'rejects a DISCO_VOADOR_SERVER_NAME containing control characters instead of silently ' +
      'accepting a name the wire protocol would later reject',
    async () => {
      await expect(
        loadDedicatedServerConfig({
          DISCO_VOADOR_SERVER_CONFIG_PATH: path.join(dir, 'does-not-exist.json'),
          DISCO_VOADOR_SERVER_NAME: 'Evil\nServer',
        }),
      ).rejects.toThrow(ConfigValidationError);
    },
  );

  it('rejects a DISCO_VOADOR_SERVER_NAME longer than the wire protocol allows (100 chars)', async () => {
    await expect(
      loadDedicatedServerConfig({
        DISCO_VOADOR_SERVER_CONFIG_PATH: path.join(dir, 'does-not-exist.json'),
        DISCO_VOADOR_SERVER_NAME: 'x'.repeat(101),
      }),
    ).rejects.toThrow(ConfigValidationError);
  });

  it('rejects a config file that fails its own validation instead of silently falling back', async () => {
    const filePath = path.join(dir, 'server.config.json');
    writeFileSync(filePath, JSON.stringify({ port: 999_999 }));

    await expect(
      loadDedicatedServerConfig({ DISCO_VOADOR_SERVER_CONFIG_PATH: filePath }),
    ).rejects.toThrow();
  });
});
