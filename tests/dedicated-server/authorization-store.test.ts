import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AuthorizationStore } from '../../services/dedicated-server/src/authorization/store.js';
import {
  GUEST_GROUP_ID,
  MEMBER_GROUP_ID,
  SERVER_ADMIN_GROUP_ID,
} from '../../services/dedicated-server/src/authorization/permissions.js';

/**
 * Real, non-mocked `node:sqlite` storage throughout — matching this repository's real-network/
 * real-storage testing philosophy (T2's real WebSocket sockets, T8's real ephemeral ports). Most
 * tests use `:memory:` for speed; the restart-persistence tests deliberately use a real file on
 * disk to prove state survives closing and reopening the store, not just staying alive in one
 * process's memory.
 */

function openStore(
  overrides: Partial<{ accessMode: 'open' | 'invite-only'; now: () => number }> = {},
): AuthorizationStore {
  return new AuthorizationStore(':memory:', {
    accessMode: overrides.accessMode ?? 'open',
    ...(overrides.now ? { now: overrides.now } : {}),
  });
}

/** T15 — the exact same mechanism `chantivo-server admin-token create` uses
 * (`mintServerAdminRecoveryToken`): mints a `privilege` token targeting the built-in Server Admin
 * group directly via the store's own `createToken`, never a second/parallel minting path. Used
 * throughout this suite anywhere a test previously relied on the removed `bootstrapToken` field to
 * get itself an initial admin. */
function mintAdminToken(store: AuthorizationStore): string {
  const result = store.createToken({
    tokenKind: 'privilege',
    groupId: SERVER_ADMIN_GROUP_ID,
    expiresInMs: undefined,
  });
  if (!result.ok) throw new Error(`expected admin token minting to succeed: ${result.message}`);
  return result.token;
}

describe('AuthorizationStore — T15 initial admin claim (no pre-seeded token)', () => {
  it('a fresh store claims zero Server Admins and mints/persists no token at all', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dv-auth-no-preseed-'));
    const dbPath = path.join(dir, 'authorization.sqlite');
    try {
      const store = new AuthorizationStore(dbPath, { accessMode: 'open' });
      expect(store.hasAnyServerAdmin()).toBe(false);
      store.close();

      // Inspect the real persisted file directly, independent of the store's own read path, to
      // prove fresh initialization truly writes zero rows to `tokens` — not merely that nothing
      // currently redeemable happens to be exposed through a public getter.
      const raw = new DatabaseSync(dbPath);
      const tokenCount = raw.prepare('SELECT COUNT(*) AS count FROM tokens').get() as {
        count: number;
      };
      raw.close();
      expect(tokenCount.count).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('invite-only: a fresh server with no persistent membership and no token is rejected, never auto-admitted', () => {
    const store = openStore({ accessMode: 'invite-only' });
    expect(store.hasAnyServerAdmin()).toBe(false);
    const result = store.admit({
      identityId: 'dv1_operator',
      nickname: 'Op',
      serverToken: undefined,
    });
    expect(result).toMatchObject({ ok: false, code: 'INVITE_REQUIRED' });
    store.close();
  });

  it("invite-only: a 'privilege' token minted via admin-token create's own mechanism admits a fresh server's operator (avoids a permanent lockout)", () => {
    const store = openStore({ accessMode: 'invite-only' });
    const token = mintAdminToken(store);

    const result = store.admit({ identityId: 'dv1_admin', nickname: 'Admin', serverToken: token });
    expect(result).toMatchObject({ ok: true, groups: [{ groupId: SERVER_ADMIN_GROUP_ID }] });
    expect(store.hasAnyServerAdmin()).toBe(true);
    store.close();
  });

  it('hasAnyServerAdmin flips from false to true only once a minted admin token is actually redeemed', () => {
    const store = openStore();
    expect(store.hasAnyServerAdmin()).toBe(false);
    const token = mintAdminToken(store);
    // Minting alone must not itself claim the server — only redemption does.
    expect(store.hasAnyServerAdmin()).toBe(false);
    store.redeemToken('dv1_admin', token);
    expect(store.hasAnyServerAdmin()).toBe(true);
    store.close();
  });

  it('the minted admin token is single-use, same as every other token kind', () => {
    const store = openStore();
    const token = mintAdminToken(store);

    store.redeemToken('dv1_admin', token);
    const second = store.redeemToken('dv1_someone_else', token);
    expect(second).toMatchObject({ ok: false, code: 'TOKEN_ALREADY_USED' });
    store.close();
  });

  it('reopening an existing store still claims zero Server Admins (nothing pre-seeds one on fresh init or reopen)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dv-auth-reopen-'));
    const dbPath = path.join(dir, 'authorization.sqlite');
    try {
      const first = new AuthorizationStore(dbPath, { accessMode: 'open' });
      expect(first.hasAnyServerAdmin()).toBe(false);
      first.close();

      const second = new AuthorizationStore(dbPath, { accessMode: 'open' });
      expect(second.hasAnyServerAdmin()).toBe(false);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('AuthorizationStore — data minimization (T9 Section 8/82)', () => {
  it('a Guest admitted on an open server creates no persistent membership row', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dv-auth-guest-'));
    const dbPath = path.join(dir, 'authorization.sqlite');
    try {
      const store = new AuthorizationStore(dbPath, { accessMode: 'open' });
      const result = store.admit({
        identityId: 'dv1_passerby',
        nickname: 'Passerby',
        serverToken: undefined,
      });
      expect(result).toMatchObject({ ok: true, groups: [{ groupId: GUEST_GROUP_ID }] });
      store.close();

      // Inspect the real persisted file directly, independent of the store's own read path, to
      // prove no row was ever written for this identity — not just that the store's own getters
      // happen to report none.
      const raw = new DatabaseSync(dbPath);
      const row = raw
        .prepare('SELECT * FROM identity_group_memberships WHERE identity_id = ?')
        .get('dv1_passerby');
      expect(row).toBeUndefined();
      raw.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('AuthorizationStore — open vs invite-only admission', () => {
  it('open: any non-banned identity is admitted as Guest with no token', () => {
    const store = openStore({ accessMode: 'open' });
    const result = store.admit({ identityId: 'dv1_x', nickname: 'X', serverToken: undefined });
    expect(result).toMatchObject({
      ok: true,
      groups: [{ groupId: GUEST_GROUP_ID }],
      // T10: Guest's default permission set now also includes chat send rights (see
      // `authorization/permissions.ts`'s `BUILT_IN_GROUPS` doc comment) — sorted alphabetically,
      // matching `getGroupPermissions`'s `ORDER BY permission`.
      permissions: ['chat.channel.send', 'chat.server.send', 'voice.channel.join'],
    });
    store.close();
  });

  it('invite-only: an unknown identity with no token is rejected with INVITE_REQUIRED', () => {
    const store = openStore({ accessMode: 'invite-only' });
    const result = store.admit({ identityId: 'dv1_x', nickname: 'X', serverToken: undefined });
    expect(result).toMatchObject({ ok: false, code: 'INVITE_REQUIRED' });
    store.close();
  });

  it('invite-only: an unknown identity with a garbage token is rejected with INVITE_REQUIRED', () => {
    const store = openStore({ accessMode: 'invite-only' });
    const result = store.admit({
      identityId: 'dv1_x',
      nickname: 'X',
      serverToken: 'DV-INVITE-not-a-real-token',
    });
    expect(result).toMatchObject({ ok: false, code: 'INVITE_REQUIRED' });
    store.close();
  });

  it('invite-only: a valid invite token admits and grants its configured group', () => {
    const store = openStore({ accessMode: 'invite-only' });
    const admin = mintAdminToken(store);
    store.redeemToken('dv1_admin', admin);

    const invite = store.createToken({
      tokenKind: 'invite',
      groupId: MEMBER_GROUP_ID,
      expiresInMs: undefined,
    });
    if (!invite.ok) throw new Error('expected token creation to succeed');

    const result = store.admit({ identityId: 'dv1_x', nickname: 'X', serverToken: invite.token });
    expect(result).toMatchObject({ ok: true, groups: [{ groupId: MEMBER_GROUP_ID }] });
    store.close();
  });

  it('invite-only: reconnecting without a token succeeds once membership is persistent', () => {
    const store = openStore({ accessMode: 'invite-only' });
    const admin = mintAdminToken(store);
    store.redeemToken('dv1_admin', admin);
    const invite = store.createToken({
      tokenKind: 'invite',
      groupId: MEMBER_GROUP_ID,
      expiresInMs: undefined,
    });
    if (!invite.ok) throw new Error('expected token creation to succeed');
    store.admit({ identityId: 'dv1_x', nickname: 'X', serverToken: invite.token });

    const reconnect = store.admit({ identityId: 'dv1_x', nickname: 'X', serverToken: undefined });
    expect(reconnect).toMatchObject({ ok: true, groups: [{ groupId: MEMBER_GROUP_ID }] });
    store.close();
  });

  it('invite-only: a second identity cannot reuse an already-consumed invite', () => {
    const store = openStore({ accessMode: 'invite-only' });
    const admin = mintAdminToken(store);
    store.redeemToken('dv1_admin', admin);
    const invite = store.createToken({
      tokenKind: 'invite',
      groupId: MEMBER_GROUP_ID,
      expiresInMs: undefined,
    });
    if (!invite.ok) throw new Error('expected token creation to succeed');
    store.admit({ identityId: 'dv1_first', nickname: 'First', serverToken: invite.token });

    const second = store.admit({
      identityId: 'dv1_second',
      nickname: 'Second',
      serverToken: invite.token,
    });
    expect(second).toMatchObject({ ok: false, code: 'INVITE_REQUIRED' });
    store.close();
  });
});

describe('AuthorizationStore — bans', () => {
  it('a banned identity is rejected at admission', () => {
    const store = openStore();
    store.ban('dv1_troll', undefined, 'spamming');
    const result = store.admit({
      identityId: 'dv1_troll',
      nickname: 'Troll',
      serverToken: undefined,
    });
    expect(result).toMatchObject({ ok: false, code: 'BANNED' });
    store.close();
  });

  it('unban restores admission', () => {
    const store = openStore();
    store.ban('dv1_troll', undefined, undefined);
    store.unban('dv1_troll');
    const result = store.admit({
      identityId: 'dv1_troll',
      nickname: 'Troll',
      serverToken: undefined,
    });
    expect(result.ok).toBe(true);
    store.close();
  });

  it('unban reports whether the identity was actually banned', () => {
    const store = openStore();
    expect(store.unban('dv1_never_banned')).toMatchObject({ wasBanned: false });
    store.ban('dv1_troll', undefined, undefined);
    expect(store.unban('dv1_troll')).toMatchObject({ wasBanned: true });
    store.close();
  });

  it('a temporary ban expires and no longer applies', () => {
    let now = 1_000_000;
    const store = openStore({ now: () => now });
    store.ban('dv1_troll', 5_000, undefined);

    expect(
      store.admit({ identityId: 'dv1_troll', nickname: 'T', serverToken: undefined }),
    ).toMatchObject({
      ok: false,
      code: 'BANNED',
    });

    now += 5_001;
    expect(store.admit({ identityId: 'dv1_troll', nickname: 'T', serverToken: undefined }).ok).toBe(
      true,
    );
    store.close();
  });

  it('listBans reports only currently-active bans, never expired ones', () => {
    let now = 1_000_000;
    const store = openStore({ now: () => now });
    store.ban('dv1_permanent', undefined, undefined);
    store.ban('dv1_temporary', 5_000, undefined);

    expect(
      store
        .listBans()
        .map((b) => b.identityId)
        .sort(),
    ).toEqual(['dv1_permanent', 'dv1_temporary']);

    now += 5_001;
    expect(store.listBans().map((b) => b.identityId)).toEqual(['dv1_permanent']);
    store.close();
  });

  it('banning an online participant persists atomically (no partial state on repeated bans)', () => {
    const store = openStore();
    store.ban('dv1_x', undefined, 'first reason');
    store.ban('dv1_x', undefined, 'updated reason');
    const bans = store.listBans();
    expect(bans).toHaveLength(1);
    expect(bans[0]?.reason).toBe('updated reason');
    store.close();
  });
});

describe('AuthorizationStore — groups', () => {
  function adminStore(accessMode: 'open' | 'invite-only' = 'open'): {
    store: AuthorizationStore;
    adminId: string;
  } {
    const store = openStore({ accessMode });
    const token = mintAdminToken(store);
    store.redeemToken('dv1_admin', token);
    return { store, adminId: 'dv1_admin' };
  }

  it('lists the three built-in protected groups after fresh init', () => {
    const store = openStore();
    const groups = store.listGroups();
    expect(groups.map((g) => g.groupId).sort()).toEqual([
      GUEST_GROUP_ID,
      MEMBER_GROUP_ID,
      SERVER_ADMIN_GROUP_ID,
    ]);
    expect(groups.every((g) => g.protectedGroup === (g.groupId !== 'moderator'))).toBe(true);
    store.close();
  });

  it('creates a custom group with a slugified, unique id', () => {
    const { store } = adminStore();
    const result = store.createGroup({ name: 'Moderator', permissions: ['moderation.kick'] });
    expect(result).toMatchObject({
      ok: true,
      group: { groupId: 'moderator', name: 'Moderator', permissions: ['moderation.kick'] },
    });
    store.close();
  });

  it('two groups with colliding slugs get distinct ids', () => {
    const { store } = adminStore();
    const first = store.createGroup({ name: 'VIP!!', permissions: [] });
    const second = store.createGroup({ name: 'VIP??', permissions: [] });
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.group.groupId).not.toBe(second.group.groupId);
    }
    store.close();
  });

  it('updates a custom group name and permissions', () => {
    const { store } = adminStore();
    const created = store.createGroup({ name: 'Mod', permissions: ['moderation.kick'] });
    if (!created.ok) throw new Error('setup failed');

    const updated = store.updateGroup({
      groupId: created.group.groupId,
      name: 'Moderator',
      permissions: ['moderation.kick', 'moderation.ban'],
    });
    expect(updated).toMatchObject({
      ok: true,
      group: { name: 'Moderator', permissions: ['moderation.kick', 'moderation.ban'] },
    });
    store.close();
  });

  it('rejects updating an unknown group', () => {
    const { store } = adminStore();
    const result = store.updateGroup({ groupId: 'nonexistent', name: 'X', permissions: undefined });
    expect(result).toMatchObject({ ok: false, code: 'GROUP_NOT_FOUND' });
    store.close();
  });

  it('rejects editing Server Admin permissions (structurally cannot be edited into uselessness)', () => {
    const { store } = adminStore();
    const result = store.updateGroup({
      groupId: SERVER_ADMIN_GROUP_ID,
      name: undefined,
      permissions: [],
    });
    expect(result).toMatchObject({ ok: false, code: 'PROTECTED_GROUP' });
    store.close();
  });

  it('allows renaming Server Admin (name is not the protected part)', () => {
    const { store } = adminStore();
    const result = store.updateGroup({
      groupId: SERVER_ADMIN_GROUP_ID,
      name: 'Owner',
      permissions: undefined,
    });
    expect(result).toMatchObject({ ok: true, group: { name: 'Owner' } });
    store.close();
  });

  it('allows editing Guest/Member permissions (T9 Section 65)', () => {
    const { store } = adminStore();
    const result = store.updateGroup({
      groupId: GUEST_GROUP_ID,
      name: undefined,
      permissions: [],
    });
    expect(result).toMatchObject({ ok: true, group: { permissions: [] } });
    expect(store.can('dv1_unknown_guest', 'voice.channel.join')).toBe(false);
    store.close();
  });

  it('rejects deleting a built-in protected group', () => {
    const { store } = adminStore();
    for (const groupId of [GUEST_GROUP_ID, MEMBER_GROUP_ID, SERVER_ADMIN_GROUP_ID]) {
      expect(store.deleteGroup(groupId)).toMatchObject({ ok: false, code: 'PROTECTED_GROUP' });
    }
    store.close();
  });

  it('deletes a custom group and cascades its memberships/tokens', () => {
    const { store, adminId } = adminStore();
    const created = store.createGroup({ name: 'Temp', permissions: [] });
    if (!created.ok) throw new Error('setup failed');
    const groupId = created.group.groupId;
    store.grantGroup('dv1_member', groupId);

    const deleted = store.deleteGroup(groupId);
    expect(deleted).toMatchObject({ ok: true });
    expect(store.listGroups().some((g) => g.groupId === groupId)).toBe(false);
    // The membership row is gone too — the identity falls back to its Guest baseline.
    expect(store.getSnapshot('dv1_member').groups).toEqual([
      { groupId: GUEST_GROUP_ID, name: 'Guest' },
    ]);
    expect(store.can(adminId, 'server.manage')).toBe(true);
    store.close();
  });

  // T9 follow-up (security review): `deleteGroup` needs the same `stillAdmitted`/no-longer-admitted
  // symmetry `revokeGroup` already had — a custom group is never protected from deletion, so
  // deleting one that was an `invite-only` identity's *sole* persistent membership must be reported
  // back so the caller can force-close that identity's live connection, not leave it silently
  // evaluating against the Guest baseline for the rest of its session.
  it('deleting a custom group reports identities left with no admission basis (invite-only)', () => {
    const { store } = adminStore('invite-only');
    const created = store.createGroup({ name: 'Temp', permissions: [] });
    if (!created.ok) throw new Error('setup failed');
    const groupId = created.group.groupId;
    // dv1_sole's only membership is the deleted group; dv1_multi also holds Member, so it keeps an
    // admission basis after the deletion.
    store.grantGroup('dv1_sole', groupId);
    store.grantGroup('dv1_multi', groupId);
    store.grantGroup('dv1_multi', MEMBER_GROUP_ID);

    const result = store.deleteGroup(groupId);
    expect(result).toMatchObject({ ok: true, noLongerAdmitted: ['dv1_sole'] });
    store.close();
  });

  it('deleting a custom group on an open server reports no one as no-longer-admitted', () => {
    const { store } = adminStore();
    const created = store.createGroup({ name: 'Temp', permissions: [] });
    if (!created.ok) throw new Error('setup failed');
    const groupId = created.group.groupId;
    store.grantGroup('dv1_sole', groupId);

    const result = store.deleteGroup(groupId);
    expect(result).toMatchObject({ ok: true, noLongerAdmitted: [] });
    store.close();
  });
});

describe('AuthorizationStore — grant/revoke and last-admin protection', () => {
  function adminStore(): { store: AuthorizationStore } {
    const store = openStore();
    const token = mintAdminToken(store);
    store.redeemToken('dv1_admin', token);
    return { store };
  }

  it('grants a group to another identity', () => {
    const { store } = adminStore();
    const result = store.grantGroup('dv1_member', MEMBER_GROUP_ID);
    expect(result).toMatchObject({
      ok: true,
      snapshot: { groups: [{ groupId: MEMBER_GROUP_ID }] },
    });
    store.close();
  });

  it('rejects granting an unknown group', () => {
    const { store } = adminStore();
    const result = store.grantGroup('dv1_member', 'nonexistent');
    expect(result).toMatchObject({ ok: false, code: 'GROUP_NOT_FOUND' });
    store.close();
  });

  it('revokes a group, falling back to the Guest baseline once no membership remains', () => {
    const { store } = adminStore();
    store.grantGroup('dv1_member', MEMBER_GROUP_ID);
    const result = store.revokeGroup('dv1_member', MEMBER_GROUP_ID);
    expect(result).toMatchObject({ ok: true, snapshot: { groups: [{ groupId: GUEST_GROUP_ID }] } });
    store.close();
  });

  it('the sole Server Admin cannot have that membership revoked', () => {
    const { store } = adminStore();
    const result = store.revokeGroup('dv1_admin', SERVER_ADMIN_GROUP_ID);
    expect(result).toMatchObject({ ok: false, code: 'LAST_ADMIN' });
    expect(store.can('dv1_admin', 'server.manage')).toBe(true);
    store.close();
  });

  it('a second Server Admin can be revoked, but not the last remaining one', () => {
    const { store } = adminStore();
    store.grantGroup('dv1_admin2', SERVER_ADMIN_GROUP_ID);

    const first = store.revokeGroup('dv1_admin2', SERVER_ADMIN_GROUP_ID);
    expect(first).toMatchObject({ ok: true });

    const second = store.revokeGroup('dv1_admin', SERVER_ADMIN_GROUP_ID);
    expect(second).toMatchObject({ ok: false, code: 'LAST_ADMIN' });
    store.close();
  });

  it('revoking the only membership on an invite-only server reports stillAdmitted: false', () => {
    const store = openStore({ accessMode: 'invite-only' });
    const admin = mintAdminToken(store);
    store.redeemToken('dv1_admin', admin);
    store.grantGroup('dv1_x', MEMBER_GROUP_ID);

    const result = store.revokeGroup('dv1_x', MEMBER_GROUP_ID);
    expect(result).toMatchObject({ ok: true, stillAdmitted: false });
    store.close();
  });

  it('revoking one of several memberships on an invite-only server reports stillAdmitted: true', () => {
    const store = openStore({ accessMode: 'invite-only' });
    const admin = mintAdminToken(store);
    store.redeemToken('dv1_admin', admin);
    store.grantGroup('dv1_x', MEMBER_GROUP_ID);
    const created = store.createGroup({ name: 'Extra', permissions: [] });
    if (!created.ok) throw new Error('setup failed');
    store.grantGroup('dv1_x', created.group.groupId);

    const result = store.revokeGroup('dv1_x', MEMBER_GROUP_ID);
    expect(result).toMatchObject({ ok: true, stillAdmitted: true });
    store.close();
  });

  it('revoking a membership on an open server always reports stillAdmitted: true (Guest baseline)', () => {
    const { store } = adminStore();
    store.grantGroup('dv1_x', MEMBER_GROUP_ID);
    const result = store.revokeGroup('dv1_x', MEMBER_GROUP_ID);
    expect(result).toMatchObject({ ok: true, stillAdmitted: true });
    store.close();
  });
});

describe('AuthorizationStore — tokens', () => {
  it('creates a privilege token targeting a custom group', () => {
    const store = openStore();
    const created = store.createGroup({ name: 'VIP', permissions: [] });
    if (!created.ok) throw new Error('setup failed');
    const token = store.createToken({
      tokenKind: 'privilege',
      groupId: created.group.groupId,
      expiresInMs: undefined,
    });
    expect(token).toMatchObject({
      ok: true,
      tokenKind: 'privilege',
      groupId: created.group.groupId,
    });
    if (token.ok) expect(token.token).toMatch(/^DV-PRIV-[A-Za-z0-9_-]+$/u);
    store.close();
  });

  it('rejects creating a token for an unknown group', () => {
    const store = openStore();
    const result = store.createToken({
      tokenKind: 'privilege',
      groupId: 'nonexistent',
      expiresInMs: undefined,
    });
    expect(result).toMatchObject({ ok: false, code: 'GROUP_NOT_FOUND' });
    store.close();
  });

  it('redeeming an unknown token is rejected', () => {
    const store = openStore();
    const result = store.redeemToken('dv1_x', 'DV-PRIV-not-a-real-token-at-all');
    expect(result).toMatchObject({ ok: false, code: 'TOKEN_INVALID' });
    store.close();
  });

  it('an expired token is rejected even though it was never redeemed', () => {
    let now = 1_000_000;
    const store = openStore({ now: () => now });
    const token = store.createToken({
      tokenKind: 'privilege',
      groupId: MEMBER_GROUP_ID,
      expiresInMs: 1_000,
    });
    if (!token.ok) throw new Error('setup failed');

    now += 1_001;
    const result = store.redeemToken('dv1_x', token.token);
    expect(result).toMatchObject({ ok: false, code: 'TOKEN_EXPIRED' });
    store.close();
  });

  it('a token redeemed before expiry succeeds', () => {
    let now = 1_000_000;
    const store = openStore({ now: () => now });
    const token = store.createToken({
      tokenKind: 'privilege',
      groupId: MEMBER_GROUP_ID,
      expiresInMs: 10_000,
    });
    if (!token.ok) throw new Error('setup failed');

    now += 1_000;
    const result = store.redeemToken('dv1_x', token.token);
    expect(result).toMatchObject({ ok: true, group: { groupId: MEMBER_GROUP_ID } });
    store.close();
  });

  it('a token is single-use: exactly one of two sequential redemption attempts succeeds (T9 Section 47/80)', () => {
    const store = openStore();
    const token = store.createToken({
      tokenKind: 'privilege',
      groupId: MEMBER_GROUP_ID,
      expiresInMs: undefined,
    });
    if (!token.ok) throw new Error('setup failed');

    const first = store.redeemToken('dv1_first', token.token);
    const second = store.redeemToken('dv1_second', token.token);

    expect([first.ok, second.ok].filter(Boolean)).toHaveLength(1);
    expect(second).toMatchObject({ ok: false, code: 'TOKEN_ALREADY_USED' });
    store.close();
  });

  it('the raw token is never persisted — only its digest is discoverable in storage', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dv-auth-token-secrecy-'));
    const dbPath = path.join(dir, 'authorization.sqlite');
    try {
      const store = new AuthorizationStore(dbPath, { accessMode: 'open' });
      const token = store.createToken({
        tokenKind: 'privilege',
        groupId: MEMBER_GROUP_ID,
        expiresInMs: undefined,
      });
      if (!token.ok) throw new Error('setup failed');
      store.close();

      const raw = new DatabaseSync(dbPath);
      const rows = raw.prepare('SELECT * FROM tokens').all() as Record<string, unknown>[];
      raw.close();

      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        for (const value of Object.values(row)) {
          if (typeof value === 'string') expect(value).not.toBe(token.token);
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('AuthorizationStore — restart persistence (T9 Section 50)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dv-auth-restart-'));
    dbPath = path.join(dir, 'authorization.sqlite');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('membership, bans, and unused tokens all survive closing and reopening the store', () => {
    const first = new AuthorizationStore(dbPath, { accessMode: 'open' });
    const admin = mintAdminToken(first);
    first.redeemToken('dv1_admin', admin);
    first.grantGroup('dv1_member', MEMBER_GROUP_ID);
    first.ban('dv1_banned', undefined, 'testing');
    const unusedToken = first.createToken({
      tokenKind: 'privilege',
      groupId: MEMBER_GROUP_ID,
      expiresInMs: undefined,
    });
    if (!unusedToken.ok) throw new Error('setup failed');
    first.close();

    const second = new AuthorizationStore(dbPath, { accessMode: 'open' });
    expect(second.can('dv1_admin', 'server.manage')).toBe(true);
    expect(second.getSnapshot('dv1_member').groups).toEqual([
      { groupId: MEMBER_GROUP_ID, name: 'Member' },
    ]);
    expect(
      second.admit({ identityId: 'dv1_banned', nickname: 'B', serverToken: undefined }),
    ).toMatchObject({ ok: false, code: 'BANNED' });
    // The unused token from before restart is still valid and still single-use.
    expect(second.redeemToken('dv1_late', unusedToken.token)).toMatchObject({ ok: true });
    expect(second.redeemToken('dv1_later', unusedToken.token)).toMatchObject({
      ok: false,
      code: 'TOKEN_ALREADY_USED',
    });
    second.close();
  });

  it('a consumed token remains consumed after restart', () => {
    const first = new AuthorizationStore(dbPath, { accessMode: 'open' });
    const token = first.createToken({
      tokenKind: 'privilege',
      groupId: MEMBER_GROUP_ID,
      expiresInMs: undefined,
    });
    if (!token.ok) throw new Error('setup failed');
    first.redeemToken('dv1_x', token.token);
    first.close();

    const second = new AuthorizationStore(dbPath, { accessMode: 'open' });
    expect(second.redeemToken('dv1_y', token.token)).toMatchObject({
      ok: false,
      code: 'TOKEN_ALREADY_USED',
    });
    second.close();
  });
});

describe('AuthorizationStore — permission evaluation', () => {
  it('an unknown identity evaluates against the Guest baseline', () => {
    const store = openStore();
    expect(store.can('dv1_unknown', 'voice.channel.join')).toBe(true);
    expect(store.can('dv1_unknown', 'server.manage')).toBe(false);
    store.close();
  });

  it('a custom group grants exactly its own permissions, nothing more', () => {
    const store = openStore();
    const admin = mintAdminToken(store);
    store.redeemToken('dv1_admin', admin);
    const created = store.createGroup({
      name: 'Mod',
      permissions: ['moderation.kick', 'moderation.ban'],
    });
    if (!created.ok) throw new Error('setup failed');
    store.grantGroup('dv1_mod', created.group.groupId);

    expect(store.can('dv1_mod', 'moderation.kick')).toBe(true);
    expect(store.can('dv1_mod', 'moderation.ban')).toBe(true);
    expect(store.can('dv1_mod', 'authorization.groups.manage')).toBe(false);
    expect(store.can('dv1_mod', 'server.manage')).toBe(false);
    store.close();
  });

  it('getPublicBadges never exposes permissions, only group id/name', () => {
    const store = openStore();
    const admin = mintAdminToken(store);
    store.redeemToken('dv1_admin', admin);
    const badges = store.getPublicBadges('dv1_admin');
    expect(badges).toEqual([{ groupId: SERVER_ADMIN_GROUP_ID, name: 'Server Admin' }]);
    for (const badge of badges) {
      expect(Object.keys(badge).sort()).toEqual(['groupId', 'name']);
    }
    store.close();
  });
});
