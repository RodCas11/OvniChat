import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));

/** `settings-service.ts` caches the loaded settings in module-level state, mirroring
 * `identity-service.test.ts`/`nickname-store.test.ts`'s established pattern for avoiding a
 * previous test's cached value leaking across an unrelated `userDataDir`. */
async function freshSettingsService() {
  vi.resetModules();
  return import('../../apps/desktop/src/main/settings/settings-service.js');
}

async function freshSettingsFile() {
  vi.resetModules();
  return import('../../apps/desktop/src/main/settings/settings-file.js');
}

function settingsPath(): string {
  return path.join(userDataDir, 'settings.json');
}

describe('settings-service', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(path.join(tmpdir(), 'dv-settings-test-'));
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it('returns sane defaults before any settings file exists (first run)', async () => {
    const { getClientSettings } = await freshSettingsService();
    const settings = await getClientSettings();

    expect(settings).toEqual({
      version: 1,
      audio: { inputDeviceId: null, outputDeviceId: null },
      video: { cameraDeviceId: null },
      screenShare: { qualityPreset: 'high' },
      voice: { startMuted: false, startDeafened: false },
      bookmarks: [],
      lastServerAddress: null,
      connectOnStartup: false,
    });
    expect(existsSync(settingsPath())).toBe(false);
  });

  it('persists an update so a fresh module instance loads it back', async () => {
    const first = await freshSettingsService();
    await first.updateClientSettings({ audio: { inputDeviceId: 'mic-123' } });

    const second = await freshSettingsService();
    const settings = await second.getClientSettings();
    expect(settings.audio.inputDeviceId).toBe('mic-123');
    expect(settings.audio.outputDeviceId).toBeNull();
  });

  it('a patch only touches the fields it names, leaving sibling fields untouched', async () => {
    const service = await freshSettingsService();
    await service.updateClientSettings({ audio: { inputDeviceId: 'mic-1' } });
    await service.updateClientSettings({ audio: { outputDeviceId: 'speaker-1' } });

    const settings = await service.getClientSettings();
    expect(settings.audio).toEqual({ inputDeviceId: 'mic-1', outputDeviceId: 'speaker-1' });
  });

  it('can patch a device preference explicitly back to null (system default)', async () => {
    const service = await freshSettingsService();
    await service.updateClientSettings({ audio: { inputDeviceId: 'mic-1' } });
    await service.updateClientSettings({ audio: { inputDeviceId: null } });

    const settings = await service.getClientSettings();
    expect(settings.audio.inputDeviceId).toBeNull();
  });

  it('treats an explicit undefined patch value the same as an omitted field, not as a real value', async () => {
    const service = await freshSettingsService();
    await service.updateClientSettings({ audio: { inputDeviceId: 'mic-1' } });
    // Simulates an IPC caller sending a structured-clone object with an explicit `undefined`
    // property rather than omitting it entirely (JSON can't represent this, but Electron's
    // structured-clone IPC transport can).
    await service.updateClientSettings({
      audio: { inputDeviceId: undefined, outputDeviceId: 'x' },
    });

    const settings = await service.getClientSettings();
    expect(settings.audio.inputDeviceId).toBe('mic-1');
    expect(settings.audio.outputDeviceId).toBe('x');
  });

  it('adds, updates, and removes a bookmark', async () => {
    const service = await freshSettingsService();
    const bookmark = await service.addBookmark({
      displayName: 'Rodrigo Server',
      serverAddress: 'voice.rodrigo.com:8090',
    });
    expect(bookmark.bookmarkId).toEqual(expect.any(String));

    let settings = await service.getClientSettings();
    expect(settings.bookmarks).toEqual([bookmark]);

    const updated = { ...bookmark, displayName: 'Renamed Server' };
    expect(await service.updateBookmark(updated)).toBe(true);
    settings = await service.getClientSettings();
    expect(settings.bookmarks[0]?.displayName).toBe('Renamed Server');

    expect(await service.removeBookmark(bookmark.bookmarkId)).toBe(true);
    settings = await service.getClientSettings();
    expect(settings.bookmarks).toEqual([]);
  });

  it('updateBookmark/removeBookmark return false (never throw) for an unknown bookmarkId', async () => {
    const service = await freshSettingsService();
    expect(
      await service.updateBookmark({
        bookmarkId: 'does-not-exist',
        displayName: 'X',
        serverAddress: 'x:1',
      }),
    ).toBe(false);
    expect(await service.removeBookmark('does-not-exist')).toBe(false);
  });

  it('never persists an invite/privilege token as part of a bookmark', async () => {
    const service = await freshSettingsService();
    // BookmarkInput has no token-shaped field at all — this asserts the actual on-disk shape,
    // not just the type, in case a future edit widens the input type carelessly.
    await service.addBookmark({ displayName: 'X', serverAddress: 'x:1' });

    const onDisk = JSON.parse(readFileSync(settingsPath(), 'utf8')) as Record<string, unknown>;
    const bookmarks = onDisk.bookmarks as Array<Record<string, unknown>>;
    expect(Object.keys(bookmarks[0] ?? {}).sort()).toEqual([
      'bookmarkId',
      'displayName',
      'serverAddress',
    ]);
  });

  it('a garbled (non-JSON) settings file is preserved aside and recovered as defaults', async () => {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(settingsPath(), '{not valid json');

    const service = await freshSettingsService();
    const settings = await service.getClientSettings();

    expect(settings).toEqual(
      expect.objectContaining({ audio: { inputDeviceId: null, outputDeviceId: null } }),
    );
    const entries = readdirSync(userDataDir);
    expect(entries.some((name) => name.startsWith('settings.json.corrupted-'))).toBe(true);
    expect(entries).toContain('settings.json');
  });

  it('a partially corrupted settings file salvages the sections that are still valid', async () => {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(
      settingsPath(),
      JSON.stringify({
        version: 1,
        // Malformed: qualityPreset is not one of the closed enum values.
        screenShare: { qualityPreset: 'ultra-8k' },
        audio: { inputDeviceId: null, outputDeviceId: null },
        video: { cameraDeviceId: null },
        voice: { startMuted: false, startDeafened: false },
        bookmarks: [{ bookmarkId: 'b1', displayName: 'Kept Server', serverAddress: 'kept:1' }],
        lastServerAddress: 'kept:1',
        connectOnStartup: false,
      }),
    );

    const service = await freshSettingsService();
    const settings = await service.getClientSettings();

    // The malformed section falls back to its own default...
    expect(settings.screenShare.qualityPreset).toBe('high');
    // ...but the still-valid bookmark list and lastServerAddress are NOT wiped out alongside it.
    expect(settings.bookmarks).toEqual([
      { bookmarkId: 'b1', displayName: 'Kept Server', serverAddress: 'kept:1' },
    ]);
    expect(settings.lastServerAddress).toBe('kept:1');

    const entries = readdirSync(userDataDir);
    expect(entries.some((name) => name.startsWith('settings.json.corrupted-'))).toBe(true);
  });

  it('the salvaged/recovered settings survive a second restart, not only the current session', async () => {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(settingsPath(), 'not json at all');

    const first = await freshSettingsService();
    await first.getClientSettings();

    const second = await freshSettingsService();
    const settings = await second.getClientSettings();
    expect(settings.bookmarks).toEqual([]);
    // No further ".corrupted-" file should be added the second time — the recovered file is now
    // itself valid.
    const corruptedEntries = readdirSync(userDataDir).filter((name) =>
      name.startsWith('settings.json.corrupted-'),
    );
    expect(corruptedEntries).toHaveLength(1);
  });

  it('writeClientSettingsFile leaves no partial file behind (atomic rename)', async () => {
    const { writeClientSettingsFile, readClientSettingsFile, DEFAULT_CLIENT_SETTINGS } =
      await freshSettingsFile();
    await writeClientSettingsFile(DEFAULT_CLIENT_SETTINGS);

    const entries = readdirSync(userDataDir);
    expect(entries).toEqual(['settings.json']);

    const readBack = await readClientSettingsFile();
    expect(readBack).toEqual(DEFAULT_CLIENT_SETTINGS);
  });
});
