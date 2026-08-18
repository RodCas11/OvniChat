import { describe, expect, it } from 'vitest';

import { buildElectronE2EEnvironment } from '../../apps/desktop/scripts/lib/electron-e2e-env.mjs';

describe('buildElectronE2EEnvironment', () => {
  it('removes ELECTRON_RUN_AS_NODE entirely, even when the parent environment sets it', () => {
    const parentEnv = { ELECTRON_RUN_AS_NODE: '1', PATH: '/usr/bin' };

    const childEnv = buildElectronE2EEnvironment(parentEnv, {});

    expect('ELECTRON_RUN_AS_NODE' in childEnv).toBe(false);
  });

  it('does not merely blank the variable out — it must be absent, not an empty string', () => {
    const parentEnv = { ELECTRON_RUN_AS_NODE: '1' };

    const childEnv = buildElectronE2EEnvironment(parentEnv, {});

    // A present-but-empty ELECTRON_RUN_AS_NODE is still observable to Electron's native bootstrap
    // (it checks presence, not truthiness) — this is the exact regression this test guards.
    expect(childEnv.ELECTRON_RUN_AS_NODE).not.toBe('');
    expect(childEnv).not.toHaveProperty('ELECTRON_RUN_AS_NODE');
  });

  it('leaves ELECTRON_RUN_AS_NODE absent when the parent environment never had it', () => {
    const parentEnv = { PATH: '/usr/bin' };

    const childEnv = buildElectronE2EEnvironment(parentEnv, {});

    expect('ELECTRON_RUN_AS_NODE' in childEnv).toBe(false);
  });

  it('preserves the rest of the parent environment untouched', () => {
    const parentEnv = { PATH: '/usr/bin', SYSTEMROOT: 'C:\\Windows', TEMP: 'C:\\Temp' };

    const childEnv = buildElectronE2EEnvironment(parentEnv, {});

    expect(childEnv).toMatchObject(parentEnv);
  });

  it('applies the E2E overrides on top of the parent environment', () => {
    const parentEnv = { PATH: '/usr/bin' };

    const childEnv = buildElectronE2EEnvironment(parentEnv, {
      DISCO_VOADOR_REALTIME_URL: 'ws://127.0.0.1:12345',
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Instance-A',
      DISCO_VOADOR_E2E_VOICE_SMOKE: '1',
    });

    expect(childEnv).toMatchObject({
      PATH: '/usr/bin',
      DISCO_VOADOR_REALTIME_URL: 'ws://127.0.0.1:12345',
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Instance-A',
      DISCO_VOADOR_E2E_VOICE_SMOKE: '1',
    });
  });

  it('an override cannot reintroduce ELECTRON_RUN_AS_NODE', () => {
    const parentEnv = {};

    const childEnv = buildElectronE2EEnvironment(parentEnv, { ELECTRON_RUN_AS_NODE: '1' });

    expect('ELECTRON_RUN_AS_NODE' in childEnv).toBe(false);
  });
});
