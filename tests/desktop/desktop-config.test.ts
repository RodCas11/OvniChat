import { describe, expect, it } from 'vitest';

import { loadDesktopConfig } from '../../apps/desktop/src/main/desktop-config.js';

/**
 * `loadDesktopConfig` itself has no `app.isPackaged` awareness — that gate is applied one layer
 * up, in `main/window.ts`, where `!app.isPackaged ? config.e2eVoiceAutoJoin : undefined` decides
 * whether a packaged build ever sees this at all (see that file, and `docs/SECURITY.md`'s
 * reusable-pattern note). What's testable here, deterministically and without an Electron
 * process, is that parsing itself is correct — the `!app.isPackaged` gate is exercised instead by
 * the E2E scripts, matching the existing precedent: no other env var this module parses (e.g.
 * `DISCO_VOADOR_E2E_VOICE_AUTO_CAMERA`) has a unit-level `app.isPackaged` test either.
 */
describe('loadDesktopConfig — T5 screen-share env vars', () => {
  const baseEnv = {
    DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
  };

  it('defaults autoScreenShare to false and autoScreenShareOffAfterMs to undefined when unset', () => {
    const config = loadDesktopConfig(baseEnv);

    expect(config.e2eVoiceAutoJoin).toMatchObject({
      autoScreenShare: false,
      autoScreenShareOffAfterMs: undefined,
    });
  });

  it('parses DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE=1 as true', () => {
    const config = loadDesktopConfig({
      ...baseEnv,
      DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE: '1',
    });

    expect(config.e2eVoiceAutoJoin?.autoScreenShare).toBe(true);
  });

  it('parses DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE=0 as false', () => {
    const config = loadDesktopConfig({
      ...baseEnv,
      DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE: '0',
    });

    expect(config.e2eVoiceAutoJoin?.autoScreenShare).toBe(false);
  });

  it('rejects an invalid DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE value', () => {
    expect(() =>
      loadDesktopConfig({ ...baseEnv, DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE: 'yes' }),
    ).toThrow();
  });

  it('parses DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_OFF_MS as a positive integer', () => {
    const config = loadDesktopConfig({
      ...baseEnv,
      DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE: '1',
      DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_OFF_MS: '5000',
    });

    expect(config.e2eVoiceAutoJoin?.autoScreenShareOffAfterMs).toBe(5000);
  });

  it('rejects a non-positive DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_OFF_MS', () => {
    expect(() =>
      loadDesktopConfig({
        ...baseEnv,
        DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_OFF_MS: '0',
      }),
    ).toThrow();
  });

  it('parses DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_RESHARE_AFTER_MS as a positive integer', () => {
    const config = loadDesktopConfig({
      ...baseEnv,
      DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE: '1',
      DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_OFF_MS: '5000',
      DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_RESHARE_AFTER_MS: '3000',
    });

    expect(config.e2eVoiceAutoJoin?.autoScreenShareReshareAfterMs).toBe(3000);
  });

  it('defaults autoScreenShareReshareAfterMs to undefined when unset', () => {
    const config = loadDesktopConfig(baseEnv);

    expect(config.e2eVoiceAutoJoin?.autoScreenShareReshareAfterMs).toBeUndefined();
  });

  it('rejects a non-positive DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_RESHARE_AFTER_MS', () => {
    expect(() =>
      loadDesktopConfig({
        ...baseEnv,
        DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_RESHARE_AFTER_MS: '0',
      }),
    ).toThrow();
  });

  it('parses DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_AUDIO=1 as true', () => {
    const config = loadDesktopConfig({
      ...baseEnv,
      DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE: '1',
      DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE_AUDIO: '1',
    });

    expect(config.e2eVoiceAutoJoin?.autoScreenShareAudio).toBe(true);
  });

  it('defaults autoScreenShareAudio to false when unset', () => {
    const config = loadDesktopConfig(baseEnv);

    expect(config.e2eVoiceAutoJoin?.autoScreenShareAudio).toBe(false);
  });

  it('leaves e2eVoiceAutoJoin undefined (and the new fields unreachable) with no auto-join channel configured', () => {
    const config = loadDesktopConfig({ DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE: '1' });

    expect(config.e2eVoiceAutoJoin).toBeUndefined();
  });
});
