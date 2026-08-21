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

describe('loadDesktopConfig — T12 process-audio env vars', () => {
  const baseEnv = {
    DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
  };

  it('defaults every process-audio field to undefined/false when unset', () => {
    const config = loadDesktopConfig(baseEnv);

    expect(config.e2eVoiceAutoJoin).toMatchObject({
      processAudioTargetPid: undefined,
      processAudioTargetExe: undefined,
      processAudioExpectedHz: undefined,
      processAudioRejectedHz: undefined,
      processAudioLifecycleScenario: false,
    });
  });

  it('parses DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_PID as a positive integer', () => {
    const config = loadDesktopConfig({
      ...baseEnv,
      DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_PID: '4242',
    });

    expect(config.e2eVoiceAutoJoin?.processAudioTargetPid).toBe(4242);
  });

  it('rejects a non-positive DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_PID', () => {
    expect(() =>
      loadDesktopConfig({ ...baseEnv, DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_PID: '0' }),
    ).toThrow();
    expect(() =>
      loadDesktopConfig({ ...baseEnv, DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_PID: '-1' }),
    ).toThrow();
  });

  it('rejects a non-integer DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_PID', () => {
    expect(() =>
      loadDesktopConfig({ ...baseEnv, DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_PID: '1.5' }),
    ).toThrow();
  });

  it('parses DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_EXE through unchanged', () => {
    const config = loadDesktopConfig({
      ...baseEnv,
      DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_EXE: 'game.exe',
    });

    expect(config.e2eVoiceAutoJoin?.processAudioTargetExe).toBe('game.exe');
  });

  it('rejects an empty DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_EXE', () => {
    expect(() =>
      loadDesktopConfig({ ...baseEnv, DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_EXE: '' }),
    ).toThrow();
  });

  it('parses DISCO_VOADOR_E2E_PROCESS_AUDIO_EXPECTED_HZ/REJECTED_HZ as positive numbers', () => {
    const config = loadDesktopConfig({
      ...baseEnv,
      DISCO_VOADOR_E2E_PROCESS_AUDIO_EXPECTED_HZ: '500',
      DISCO_VOADOR_E2E_PROCESS_AUDIO_REJECTED_HZ: '750',
    });

    expect(config.e2eVoiceAutoJoin?.processAudioExpectedHz).toBe(500);
    expect(config.e2eVoiceAutoJoin?.processAudioRejectedHz).toBe(750);
  });

  it('rejects a non-positive DISCO_VOADOR_E2E_PROCESS_AUDIO_EXPECTED_HZ', () => {
    expect(() =>
      loadDesktopConfig({ ...baseEnv, DISCO_VOADOR_E2E_PROCESS_AUDIO_EXPECTED_HZ: '0' }),
    ).toThrow();
  });

  it('rejects a non-positive DISCO_VOADOR_E2E_PROCESS_AUDIO_REJECTED_HZ', () => {
    expect(() =>
      loadDesktopConfig({ ...baseEnv, DISCO_VOADOR_E2E_PROCESS_AUDIO_REJECTED_HZ: '-750' }),
    ).toThrow();
  });

  it('parses DISCO_VOADOR_E2E_PROCESS_AUDIO_LIFECYCLE_SCENARIO=1 as true and =0 as false', () => {
    expect(
      loadDesktopConfig({
        ...baseEnv,
        DISCO_VOADOR_E2E_PROCESS_AUDIO_LIFECYCLE_SCENARIO: '1',
      }).e2eVoiceAutoJoin?.processAudioLifecycleScenario,
    ).toBe(true);
    expect(
      loadDesktopConfig({
        ...baseEnv,
        DISCO_VOADOR_E2E_PROCESS_AUDIO_LIFECYCLE_SCENARIO: '0',
      }).e2eVoiceAutoJoin?.processAudioLifecycleScenario,
    ).toBe(false);
  });

  it('rejects an invalid DISCO_VOADOR_E2E_PROCESS_AUDIO_LIFECYCLE_SCENARIO value', () => {
    expect(() =>
      loadDesktopConfig({
        ...baseEnv,
        DISCO_VOADOR_E2E_PROCESS_AUDIO_LIFECYCLE_SCENARIO: 'yes',
      }),
    ).toThrow();
  });

  it('leaves e2eVoiceAutoJoin undefined (and the new fields unreachable) with no auto-join channel configured', () => {
    const config = loadDesktopConfig({ DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_PID: '4242' });

    expect(config.e2eVoiceAutoJoin).toBeUndefined();
  });
});

describe('loadDesktopConfig — T10 persistent text chat env vars', () => {
  const baseEnv = {
    DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
  };

  it('defaults autoChatSendServerBody/autoChatSendChannelBody to undefined when unset', () => {
    const config = loadDesktopConfig(baseEnv);

    expect(config.e2eVoiceAutoJoin).toMatchObject({
      autoChatSendServerBody: undefined,
      autoChatSendChannelBody: undefined,
    });
  });

  it('parses DISCO_VOADOR_E2E_CHAT_SEND_SERVER through unchanged', () => {
    const config = loadDesktopConfig({
      ...baseEnv,
      DISCO_VOADOR_E2E_CHAT_SEND_SERVER: 'PERSIST_A_1',
    });

    expect(config.e2eVoiceAutoJoin?.autoChatSendServerBody).toBe('PERSIST_A_1');
  });

  it('parses DISCO_VOADOR_E2E_CHAT_SEND_CHANNEL through unchanged', () => {
    const config = loadDesktopConfig({
      ...baseEnv,
      DISCO_VOADOR_E2E_CHAT_SEND_CHANNEL: 'GAME_HISTORY_1',
    });

    expect(config.e2eVoiceAutoJoin?.autoChatSendChannelBody).toBe('GAME_HISTORY_1');
  });
});

describe('loadDesktopConfig — T11 settings-persistence E2E env vars', () => {
  it('leaves e2eSettingsPersistence undefined when unset', () => {
    const config = loadDesktopConfig({});
    expect(config.e2eSettingsPersistence).toBeUndefined();
  });

  it('is independent of the voice auto-join flag — no channel needed', () => {
    const config = loadDesktopConfig({ DISCO_VOADOR_E2E_SETTINGS_PERSISTENCE: '1' });
    expect(config.e2eSettingsPersistence).toEqual({ write: false });
    expect(config.e2eVoiceAutoJoin).toBeUndefined();
  });

  it('defaults write to false when only the persistence flag is set', () => {
    const config = loadDesktopConfig({ DISCO_VOADOR_E2E_SETTINGS_PERSISTENCE: '1' });
    expect(config.e2eSettingsPersistence?.write).toBe(false);
  });

  it('parses the write flag as true when both env vars are set', () => {
    const config = loadDesktopConfig({
      DISCO_VOADOR_E2E_SETTINGS_PERSISTENCE: '1',
      DISCO_VOADOR_E2E_SETTINGS_PERSISTENCE_WRITE: '1',
    });
    expect(config.e2eSettingsPersistence).toEqual({ write: true });
  });

  it('ignores the write flag when the persistence flag itself is unset', () => {
    const config = loadDesktopConfig({ DISCO_VOADOR_E2E_SETTINGS_PERSISTENCE_WRITE: '1' });
    expect(config.e2eSettingsPersistence).toBeUndefined();
  });

  it('rejects an invalid DISCO_VOADOR_E2E_SETTINGS_PERSISTENCE value', () => {
    expect(() => loadDesktopConfig({ DISCO_VOADOR_E2E_SETTINGS_PERSISTENCE: 'yes' })).toThrow();
  });
});
