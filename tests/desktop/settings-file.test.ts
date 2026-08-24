import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T13.4 — settings-file schema tests: `deriveServerScopeKey`'s normalization, and (per the T13.4
 * task brief's explicit requirement) a dedicated round-trip test proving a pre-T13.4 (v1-shaped)
 * settings file — missing every new `voice.*` field and the whole `voicePreferences` section —
 * still parses successfully with sensible defaults filled in, with no `SETTINGS_FILE_VERSION` bump.
 * Mirrors `settings-service.test.ts`'s own `userDataDir`/mock-electron setup exactly.
 */

let userDataDir = '';

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));

async function freshSettingsFile() {
  vi.resetModules();
  return import('../../apps/desktop/src/main/settings/settings-file.js');
}

function settingsPath(): string {
  return path.join(userDataDir, 'settings.json');
}

describe('deriveServerScopeKey', () => {
  it('lowercases the host', async () => {
    const { deriveServerScopeKey } = await freshSettingsFile();
    expect(deriveServerScopeKey('MyServer.Example:8090')).toBe('myserver.example:8090');
  });

  it('makes an implicit default port explicit', async () => {
    const { deriveServerScopeKey } = await freshSettingsFile();
    expect(deriveServerScopeKey('voice.example.com')).toBe('voice.example.com:8090');
  });

  it('treats an explicit default port and an omitted port as the same key', async () => {
    const { deriveServerScopeKey } = await freshSettingsFile();
    expect(deriveServerScopeKey('voice.example.com')).toBe(
      deriveServerScopeKey('voice.example.com:8090'),
    );
  });

  it('preserves a non-default port', async () => {
    const { deriveServerScopeKey } = await freshSettingsFile();
    expect(deriveServerScopeKey('voice.example.com:9999')).toBe('voice.example.com:9999');
  });

  it('is stable/idempotent when applied twice', async () => {
    const { deriveServerScopeKey } = await freshSettingsFile();
    const once = deriveServerScopeKey('Voice.Example.com:9999');
    expect(deriveServerScopeKey(once)).toBe(once);
  });
});

describe('settings-file T13.4 backward compatibility', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(path.join(tmpdir(), 'dv-settings-file-test-'));
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  /** A byte-for-byte pre-T13.4 (v1) settings file — exactly the shape `settings-service.test.ts`'s
   * own fixtures already use, before this task added any `voice.*` field beyond `startMuted`/
   * `startDeafened` or the `voicePreferences` top-level section at all. */
  const V1_FIXTURE = {
    version: 1,
    audio: { inputDeviceId: 'mic-1', outputDeviceId: null },
    video: { cameraDeviceId: null },
    screenShare: { qualityPreset: 'high' },
    voice: { startMuted: true, startDeafened: false },
    bookmarks: [{ bookmarkId: 'b1', displayName: 'Old Server', serverAddress: 'old:8090' }],
    lastServerAddress: 'old:8090',
    connectOnStartup: false,
  };

  it('a pre-T13.4 (v1-shaped) settings file still parses successfully with new defaults filled in', async () => {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(V1_FIXTURE));

    const { readClientSettingsFile } = await freshSettingsFile();
    const settings = await readClientSettingsFile();

    expect(settings).toBeDefined();
    // No version bump — the additive/defaulted approach is the accepted T13.4 design.
    expect(settings?.version).toBe(1);
    // Every pre-existing field survives untouched.
    expect(settings?.audio).toEqual({ inputDeviceId: 'mic-1', outputDeviceId: null });
    expect(settings?.voice.startMuted).toBe(true);
    expect(settings?.bookmarks).toEqual(V1_FIXTURE.bookmarks);
    // New voice fields default sensibly.
    expect(settings?.voice.inputMode).toBe('voice-activity');
    expect(settings?.voice.pttBinding).toBeNull();
    expect(settings?.voice.voiceActivitySensitivity).toBe(0.5);
    expect(settings?.voice.joinLeaveSoundsEnabled).toBe(true);
    // New top-level section defaults to an empty map.
    expect(settings?.voicePreferences).toEqual({});
  });

  it('this must be a genuine schema-level success, not the corrupted-file salvage fallback', async () => {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(settingsPath(), JSON.stringify(V1_FIXTURE));

    const { readClientSettingsFile } = await freshSettingsFile();
    await readClientSettingsFile();

    // A whole-file salvage would have renamed the original aside as "settings.json.corrupted-*";
    // a real defaulted-field parse leaves the original file exactly where it was (untouched, until
    // the next explicit write).
    const { readdirSync } = await import('node:fs');
    const entries = readdirSync(userDataDir);
    expect(entries).toEqual(['settings.json']);
  });

  it('a settings file whose voicePreferences exceeds the entry cap salvages that section alone', async () => {
    mkdirSync(userDataDir, { recursive: true });
    const bloated: Record<
      string,
      Record<string, { volumePercent: number; locallyMuted: boolean }>
    > = {};
    for (let i = 0; i < 501; i += 1) {
      bloated[`server-${String(i)}:8090`] = {
        identity: { volumePercent: 100, locallyMuted: false },
      };
    }
    writeFileSync(settingsPath(), JSON.stringify({ ...V1_FIXTURE, voicePreferences: bloated }));

    const { readClientSettingsFile } = await freshSettingsFile();
    const settings = await readClientSettingsFile();

    // The oversized section falls back to its own default...
    expect(settings?.voicePreferences).toEqual({});
    // ...but the still-valid bookmark list is not wiped out alongside it.
    expect(settings?.bookmarks).toEqual(V1_FIXTURE.bookmarks);
  });

  it('a settings file with an out-of-bounds/non-finite volumePercent salvages that section alone (never NaN/Infinity/negative persisted)', async () => {
    mkdirSync(userDataDir, { recursive: true });
    const invalid = {
      'server-a:8090': {
        'identity-negative': { volumePercent: -5, locallyMuted: false },
        'identity-huge': { volumePercent: 999_999, locallyMuted: false },
      },
    };
    writeFileSync(settingsPath(), JSON.stringify({ ...V1_FIXTURE, voicePreferences: invalid }));

    const { readClientSettingsFile } = await freshSettingsFile();
    const settings = await readClientSettingsFile();

    // The whole section falls back to empty (zod's own bounds reject the entry, and this section's
    // salvage — see settings-file.ts's own `salvageSections` — never partially keeps a malformed
    // record) rather than persisting a negative/absurd value.
    expect(settings?.voicePreferences).toEqual({});
    expect(settings?.bookmarks).toEqual(V1_FIXTURE.bookmarks);
  });

  it('round-trips a real pttBinding through write then read', async () => {
    const { writeClientSettingsFile, readClientSettingsFile, DEFAULT_CLIENT_SETTINGS } =
      await freshSettingsFile();
    await writeClientSettingsFile({
      ...DEFAULT_CLIENT_SETTINGS,
      voice: {
        ...DEFAULT_CLIENT_SETTINGS.voice,
        inputMode: 'push-to-talk',
        pttBinding: {
          kind: 'mouseButton',
          button: 4,
          modifiers: { ctrl: false, alt: false, shift: false, meta: false },
        },
      },
    });

    const readBack = await readClientSettingsFile();
    expect(readBack?.voice.inputMode).toBe('push-to-talk');
    expect(readBack?.voice.pttBinding).toEqual({
      kind: 'mouseButton',
      button: 4,
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    });
  });
});
