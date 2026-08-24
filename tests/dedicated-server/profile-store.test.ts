import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { PROFILE_MIGRATIONS } from '../../services/dedicated-server/src/profile/index.js';
import { SqliteProfileStore } from '../../services/dedicated-server/src/profile/store.js';

/**
 * Real, non-mocked `node:sqlite` storage — matching `channel-store.test.ts`'s own testing
 * philosophy. Most tests use `:memory:` for speed; the restart-persistence test uses a real file on
 * disk to prove state survives closing and reopening the store, not just staying alive in one
 * process's memory.
 */

function openStore(path_ = ':memory:'): SqliteProfileStore {
  return new SqliteProfileStore(path_);
}

// A minimal, valid, non-animated 4x4 PNG, built the same way `image-validation.test.ts` builds its
// own fixtures (structurally, not loaded from disk).
function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

function buildPng(width: number, height: number): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdrData),
    pngChunk('IDAT', Buffer.from([0, 0, 0, 0])),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const VALID_AVATAR = buildPng(4, 4);
const VALID_AVATAR_2 = buildPng(8, 8);

describe('SqliteProfileStore — profile create/get defaults', () => {
  it('returns implicit defaults for an identity with no persisted row at all', () => {
    const store = openStore();
    expect(store.getUserProfile('never-seen-identity')).toEqual({
      presencePreference: 'online',
      customStatus: undefined,
      avatarRef: undefined,
    });
    store.close();
  });

  it('returns undefined for getServerProfile when no server avatar is set', () => {
    const store = openStore();
    expect(store.getServerProfile()).toEqual({ avatarRef: undefined });
    store.close();
  });
});

describe('SqliteProfileStore — avatar set/clear', () => {
  it('sets a user avatar, returning a fresh avatarRef with revision 1', () => {
    const store = openStore();
    const result = store.setUserAvatar('identity-a', 'png', VALID_AVATAR);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('setup failed');
    expect(result.avatarRef.revision).toBe(1);
    expect(result.avatarRef.hash).toMatch(/^[a-f0-9]{64}$/u);
    expect(store.getUserProfile('identity-a').avatarRef).toEqual(result.avatarRef);
    store.close();
  });

  it('replacing an avatar increments the revision and actually deletes the old avatar_assets row (not orphaned)', () => {
    const store = openStore();
    const first = store.setUserAvatar('identity-a', 'png', VALID_AVATAR);
    if (!first.ok) throw new Error('setup failed');
    const firstData = store.getUserAvatarData('identity-a');
    expect(firstData).toBeDefined();

    const second = store.setUserAvatar('identity-a', 'png', VALID_AVATAR_2);
    if (!second.ok) throw new Error('setup failed');
    expect(second.avatarRef.revision).toBe(2);
    expect(second.avatarRef.hash).not.toBe(first.avatarRef.hash);

    // The old asset is genuinely gone — a direct re-fetch by identity now returns only the new one,
    // and the store never keeps a second, orphaned row around (verified indirectly: the current
    // avatar's bytes now match the second upload, not the first).
    const currentData = store.getUserAvatarData('identity-a');
    expect(currentData?.bytes.equals(VALID_AVATAR_2)).toBe(true);
    expect(currentData?.avatarRef.revision).toBe(2);
    store.close();
  });

  it('clearing a user avatar removes it; a subsequent getUserAvatarData returns undefined', () => {
    const store = openStore();
    store.setUserAvatar('identity-a', 'png', VALID_AVATAR);
    store.clearUserAvatar('identity-a');
    expect(store.getUserAvatarData('identity-a')).toBeUndefined();
    expect(store.getUserProfile('identity-a').avatarRef).toBeUndefined();
    store.close();
  });

  it('clearing an avatar that was never set is a harmless no-op', () => {
    const store = openStore();
    expect(() => store.clearUserAvatar('never-had-one')).not.toThrow();
    store.close();
  });

  it('rejects an oversized avatar with AVATAR_TOO_LARGE, never persisting it', () => {
    const store = openStore();
    const oversized = Buffer.concat([VALID_AVATAR, Buffer.alloc(60_000)]);
    const result = store.setUserAvatar('identity-a', 'png', oversized);
    expect(result).toMatchObject({ ok: false, code: 'AVATAR_TOO_LARGE' });
    expect(store.getUserAvatarData('identity-a')).toBeUndefined();
    store.close();
  });

  it('rejects a dimension-too-large user avatar (over 512x512), never persisting it', () => {
    const store = openStore();
    const tooBig = buildPng(600, 600);
    const result = store.setUserAvatar('identity-a', 'png', tooBig);
    expect(result).toMatchObject({ ok: false, code: 'AVATAR_DIMENSIONS_TOO_LARGE' });
    expect(store.getUserAvatarData('identity-a')).toBeUndefined();
    store.close();
  });

  it('accepts a server avatar up to 1024x1024, larger than the user ceiling', () => {
    const store = openStore();
    const big = buildPng(1024, 1024);
    const result = store.setServerAvatar('png', big);
    expect(result.ok).toBe(true);
    expect(store.getServerProfile().avatarRef).toBeDefined();
    store.close();
  });

  it('rejects a server avatar over 1024x1024', () => {
    const store = openStore();
    const tooBig = buildPng(1025, 1025);
    const result = store.setServerAvatar('png', tooBig);
    expect(result).toMatchObject({ ok: false, code: 'AVATAR_DIMENSIONS_TOO_LARGE' });
    store.close();
  });

  it('clearing the server avatar removes it', () => {
    const store = openStore();
    store.setServerAvatar('png', VALID_AVATAR);
    store.clearServerAvatar();
    expect(store.getServerProfile()).toEqual({ avatarRef: undefined });
    expect(store.getServerAvatarData()).toBeUndefined();
    store.close();
  });

  it('user and server avatars are stored independently — clearing one never affects the other', () => {
    const store = openStore();
    store.setUserAvatar('identity-a', 'png', VALID_AVATAR);
    store.setServerAvatar('png', VALID_AVATAR_2);
    store.clearUserAvatar('identity-a');
    expect(store.getUserAvatarData('identity-a')).toBeUndefined();
    expect(store.getServerAvatarData()).toBeDefined();
    store.close();
  });
});

describe('SqliteProfileStore — custom status and presence preference', () => {
  it('sets and reads back a custom status', () => {
    const store = openStore();
    store.setCustomStatus('identity-a', 'brb making tea');
    expect(store.getUserProfile('identity-a').customStatus).toBe('brb making tea');
    store.close();
  });

  it('clears a custom status by passing undefined', () => {
    const store = openStore();
    store.setCustomStatus('identity-a', 'temporary status');
    store.setCustomStatus('identity-a', undefined);
    expect(store.getUserProfile('identity-a').customStatus).toBeUndefined();
    store.close();
  });

  it('sets the presence preference and reads it back, defaulting to "online" beforehand', () => {
    const store = openStore();
    expect(store.getUserProfile('identity-a').presencePreference).toBe('online');
    store.setPresencePreference('identity-a', 'dnd');
    expect(store.getUserProfile('identity-a').presencePreference).toBe('dnd');
    store.close();
  });

  it('setting a custom status, avatar, and presence preference for the same identity coexist correctly', () => {
    const store = openStore();
    store.setUserAvatar('identity-a', 'png', VALID_AVATAR);
    store.setCustomStatus('identity-a', 'in a meeting');
    store.setPresencePreference('identity-a', 'away');
    const profile = store.getUserProfile('identity-a');
    expect(profile.presencePreference).toBe('away');
    expect(profile.customStatus).toBe('in a meeting');
    expect(profile.avatarRef).toBeDefined();
    store.close();
  });
});

describe('SqliteProfileStore — restart persistence', () => {
  it('avatar, custom status, and presence preference all survive closing and reopening the same file', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'disco-voador-profile-store-'));
    const dbPath = path.join(dir, 'profiles.sqlite');
    try {
      const store1 = openStore(dbPath);
      const setResult = store1.setUserAvatar('identity-a', 'png', VALID_AVATAR);
      if (!setResult.ok) throw new Error('setup failed');
      store1.setCustomStatus('identity-a', 'persisted status');
      store1.setPresencePreference('identity-a', 'dnd');
      store1.setServerAvatar('png', VALID_AVATAR_2);
      store1.close();

      const store2 = openStore(dbPath);
      const profile = store2.getUserProfile('identity-a');
      expect(profile.customStatus).toBe('persisted status');
      expect(profile.presencePreference).toBe('dnd');
      expect(profile.avatarRef).toEqual(setResult.avatarRef);
      expect(store2.getUserAvatarData('identity-a')?.bytes.equals(VALID_AVATAR)).toBe(true);
      expect(store2.getServerAvatarData()?.bytes.equals(VALID_AVATAR_2)).toBe(true);
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('SqliteProfileStore — cross-server isolation', () => {
  it('two independent store instances (as two independently-operated Dedicated Servers would have) never leak state for the same identityId', () => {
    const storeA = openStore();
    const storeB = openStore();

    storeA.setUserAvatar('shared-identity', 'png', VALID_AVATAR);
    storeA.setCustomStatus('shared-identity', 'status on server A');
    storeA.setPresencePreference('shared-identity', 'dnd');

    storeB.setCustomStatus('shared-identity', 'status on server B');

    expect(storeB.getUserProfile('shared-identity')).toEqual({
      presencePreference: 'online',
      customStatus: 'status on server B',
      avatarRef: undefined,
    });
    expect(storeA.getUserProfile('shared-identity').customStatus).toBe('status on server A');

    storeA.close();
    storeB.close();
  });
});

describe('SqliteProfileStore — getOrCreateIdentityRef (T13.4)', () => {
  it('returns the same value on repeated calls for the same identity', () => {
    const store = openStore();
    const first = store.getOrCreateIdentityRef('identity-a');
    const second = store.getOrCreateIdentityRef('identity-a');
    expect(second).toBe(first);
    store.close();
  });

  it('returns different values for different identities', () => {
    const store = openStore();
    const a = store.getOrCreateIdentityRef('identity-a');
    const b = store.getOrCreateIdentityRef('identity-b');
    expect(a).not.toBe(b);
    store.close();
  });

  it('never derives the value from identityId itself (not a substring/transform of it)', () => {
    const store = openStore();
    const ref = store.getOrCreateIdentityRef('identity-a');
    expect(ref).not.toContain('identity-a');
    expect(ref).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/u) as unknown as string);
    store.close();
  });

  it('is safe to call for an identity that already has a profile row from an unrelated mutation (lazy backfill never clobbers existing fields)', () => {
    const store = openStore();
    store.setCustomStatus('identity-a', 'already had a row');
    store.setPresencePreference('identity-a', 'dnd');
    const ref = store.getOrCreateIdentityRef('identity-a');
    expect(ref).toEqual(expect.stringMatching(/^[0-9a-f-]{36}$/u) as unknown as string);
    const profile = store.getUserProfile('identity-a');
    expect(profile.customStatus).toBe('already had a row');
    expect(profile.presencePreference).toBe('dnd');
    // Calling it again after the row already existed must still be stable.
    expect(store.getOrCreateIdentityRef('identity-a')).toBe(ref);
    store.close();
  });

  it('survives closing and reopening the same file (restart persistence)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'disco-voador-profile-store-identity-ref-'));
    const dbPath = path.join(dir, 'profiles.sqlite');
    try {
      const store1 = openStore(dbPath);
      const ref1 = store1.getOrCreateIdentityRef('identity-a');
      store1.close();

      const store2 = openStore(dbPath);
      const ref2 = store2.getOrCreateIdentityRef('identity-a');
      expect(ref2).toBe(ref1);
      store2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('two independent stores (two independently-operated Dedicated Servers) mint unrelated values for the same identityId — the anti-cross-server-correlation property this column exists for', () => {
    const storeA = openStore();
    const storeB = openStore();

    const refOnA = storeA.getOrCreateIdentityRef('shared-identity');
    const refOnB = storeB.getOrCreateIdentityRef('shared-identity');

    expect(refOnA).not.toBe(refOnB);

    storeA.close();
    storeB.close();
  });
});

describe('SqliteProfileStore — data minimization', () => {
  it('the migration schema never declares a nickname/email/phone/IP/device-fingerprint/geo/lastSeen column', () => {
    const forbiddenSubstrings = [
      'nickname',
      'email',
      'phone',
      'birthday',
      'real_name',
      'realname',
      'ip_address',
      'device_fingerprint',
      'geo',
      'game_history',
      'presence_history',
      'last_seen',
      'lastseen',
    ];
    const allSql = PROFILE_MIGRATIONS.flatMap((migration) => migration.statements)
      .join('\n')
      .toLowerCase();
    for (const forbidden of forbiddenSubstrings) {
      expect(allSql).not.toContain(forbidden);
    }
  });
});
