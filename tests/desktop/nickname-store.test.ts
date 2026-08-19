import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let userDataDir = '';

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir },
}));

/** `nickname-store.ts` caches the loaded nickname in module-level state, so each test needs a
 * fresh module instance to avoid leaking a previous test's value across an unrelated
 * `userDataDir` — mirrors `identity-service.test.ts`'s same pattern. */
async function freshNicknameStore() {
  vi.resetModules();
  return import('../../apps/desktop/src/main/identity/nickname-store.js');
}

describe('nickname-store', () => {
  beforeEach(() => {
    userDataDir = mkdtempSync(path.join(tmpdir(), 'dv-nickname-test-'));
  });

  afterEach(() => {
    rmSync(userDataDir, { recursive: true, force: true });
  });

  it('returns an empty string before any nickname has ever been set (first-run signal)', async () => {
    const { getNickname } = await freshNicknameStore();
    expect(await getNickname()).toBe('');
  });

  it('persists a valid nickname so a fresh module instance loads it back', async () => {
    const first = await freshNicknameStore();
    expect(await first.setNickname('Ana')).toBe(true);

    const second = await freshNicknameStore();
    expect(await second.getNickname()).toBe('Ana');
  });

  it('rejects a blank nickname without persisting anything', async () => {
    const { getNickname, setNickname } = await freshNicknameStore();
    expect(await setNickname('')).toBe(false);
    expect(await getNickname()).toBe('');
  });

  it('rejects a nickname over the shared display-name length bound', async () => {
    const { setNickname } = await freshNicknameStore();
    expect(await setNickname('x'.repeat(33))).toBe(false);
  });

  it('rejects a nickname containing control characters', async () => {
    const { setNickname } = await freshNicknameStore();
    expect(await setNickname('Ana\tBob')).toBe(false);
  });

  it('trims a nickname the same way the wire displayNameSchema does', async () => {
    const { getNickname, setNickname } = await freshNicknameStore();
    expect(await setNickname('  Ana  ')).toBe(true);
    expect(await getNickname()).toBe('Ana');
  });

  it('changing the nickname never touches the identity file', async () => {
    const { setNickname } = await freshNicknameStore();
    await setNickname('Ana');
    await setNickname('Bob');

    const { existsSync } = await import('node:fs');
    expect(existsSync(path.join(userDataDir, 'identity'))).toBe(false);
  });

  it('treats a corrupted preferences file as "no nickname yet" rather than throwing', async () => {
    mkdirSync(userDataDir, { recursive: true });
    writeFileSync(path.join(userDataDir, 'preferences.json'), '{not valid json');

    const { getNickname } = await freshNicknameStore();
    await expect(getNickname()).resolves.toBe('');
  });
});
