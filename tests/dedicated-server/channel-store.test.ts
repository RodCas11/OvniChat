import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { MAX_CHANNEL_DEPTH, MAX_CHANNEL_TREE_NODES } from '@disco-voador/protocol';
import { describe, expect, it } from 'vitest';

import { ChannelStore } from '../../services/dedicated-server/src/channels/store.js';

/**
 * Real, non-mocked `node:sqlite` storage — matching `authorization-store.test.ts`/
 * `chat-store.test.ts`'s own testing philosophy. Most tests use `:memory:` for speed; the
 * restart-persistence tests use a real file on disk to prove the tree survives closing and
 * reopening the store, not just staying alive in one process's memory.
 */

function openStore(seed?: { channelId: string; name: string }[]): ChannelStore {
  return new ChannelStore(':memory:', seed !== undefined ? { seed } : {});
}

const LEGACY_SEED = [
  { channelId: 'general', name: 'General' },
  { channelId: 'games', name: 'Games' },
  { channelId: 'afk', name: 'AFK' },
];

describe('ChannelStore — migration/seed', () => {
  it('a fresh database with no seed has an empty tree', () => {
    const store = openStore([]);
    expect(store.getFilteredTree([])).toEqual([]);
    store.close();
  });

  it('seeds the legacy general/games/afk ids exactly, in order, at first-ever initialization', () => {
    const store = openStore(LEGACY_SEED);
    const tree = store.getFilteredTree([]);
    expect(tree.map((n) => n.nodeId)).toEqual(['general', 'games', 'afk']);
    expect(tree.every((n) => n.kind === 'voice')).toBe(true);
    store.close();
  });

  it('seeding only ever applies to a genuinely fresh database (real file reopen)', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'disco-voador-channels-'));
    const file = path.join(dir, 'channels.sqlite');
    try {
      const first = new ChannelStore(file, { seed: LEGACY_SEED });
      first.createVoiceChannel({ name: 'Custom', parentId: undefined, actorEffectiveGroupIds: [] });
      first.close();

      // Reopening with a *different* seed list must not re-seed anything — the custom channel and
      // original legacy ids must be exactly what persisted, nothing added or removed.
      const second = new ChannelStore(file, { seed: [{ channelId: 'irrelevant', name: 'X' }] });
      const ids = second.listActiveNodeIds();
      expect(ids).toContain('general');
      expect(ids).toContain('games');
      expect(ids).toContain('afk');
      expect(ids).not.toContain('irrelevant');
      expect(ids).toHaveLength(4); // 3 legacy + 1 custom
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ChannelStore — tree operations', () => {
  it('creates a category and a voice channel at root', () => {
    const store = openStore([]);
    const category = store.createCategory({
      name: 'Officers',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    expect(category.ok).toBe(true);
    const voice = store.createVoiceChannel({
      name: 'Lobby',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    expect(voice.ok).toBe(true);
    if (!category.ok || !voice.ok) return;
    expect(category.node.kind).toBe('category');
    expect(voice.node.kind).toBe('voice');
    store.close();
  });

  it('rejects a category with a non-null parent', () => {
    const store = openStore([]);
    const parent = store.createCategory({
      name: 'Parent',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;
    const nested = store.createCategory({
      name: 'Nested',
      parentId: parent.node.nodeId,
      actorEffectiveGroupIds: [],
    });
    expect(nested).toMatchObject({ ok: false, code: 'CHANNEL_PARENT_INVALID' });
    store.close();
  });

  it('creates a subchannel (voice under voice)', () => {
    const store = openStore([]);
    const parent = store.createVoiceChannel({
      name: 'Parent',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    expect(parent.ok).toBe(true);
    if (!parent.ok) return;
    const child = store.createVoiceChannel({
      name: 'Child',
      parentId: parent.node.nodeId,
      actorEffectiveGroupIds: [],
    });
    expect(child.ok).toBe(true);
    if (!child.ok) return;
    expect(child.node.parentId).toBe(parent.node.nodeId);
    store.close();
  });

  it('rejects a create against a nonexistent or tombstoned parent', () => {
    const store = openStore([]);
    const result = store.createVoiceChannel({
      name: 'Orphan',
      parentId: 'does-not-exist',
      actorEffectiveGroupIds: [],
    });
    expect(result).toMatchObject({ ok: false, code: 'CHANNEL_PARENT_INVALID' });
    store.close();
  });

  it('rejects exceeding the maximum nesting depth', () => {
    const store = openStore([]);
    let parentId: string | undefined;
    // MAX_CHANNEL_DEPTH levels (0..MAX_CHANNEL_DEPTH-1) are allowed; the next one must fail.
    for (let depth = 0; depth < MAX_CHANNEL_DEPTH; depth += 1) {
      const created = store.createVoiceChannel({
        name: `Level ${String(depth)}`,
        parentId,
        actorEffectiveGroupIds: [],
      });
      expect(created.ok).toBe(true);
      if (created.ok) parentId = created.node.nodeId;
    }
    const overflow = store.createVoiceChannel({
      name: 'Too deep',
      parentId,
      actorEffectiveGroupIds: [],
    });
    expect(overflow).toMatchObject({ ok: false, code: 'CHANNEL_PARENT_INVALID' });
    store.close();
  });

  it('rejects exceeding the maximum tree size', () => {
    const store = openStore([]);
    for (let i = 0; i < MAX_CHANNEL_TREE_NODES; i += 1) {
      const created = store.createVoiceChannel({
        name: `Node ${String(i)}`,
        parentId: undefined,
        actorEffectiveGroupIds: [],
      });
      expect(created.ok).toBe(true);
    }
    const overflow = store.createVoiceChannel({
      name: 'Overflow',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    expect(overflow).toMatchObject({ ok: false, code: 'CHANNEL_TREE_LIMIT_EXCEEDED' });
    store.close();
  }, 20_000);

  it('renames a node', () => {
    const store = openStore([]);
    const created = store.createVoiceChannel({
      name: 'Old Name',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const updated = store.updateNode({
      nodeId: created.node.nodeId,
      actorEffectiveGroupIds: [],
      name: 'New Name',
      visibilityPolicy: undefined,
      visibilityGroupIds: undefined,
      joinPolicy: undefined,
      joinGroupIds: undefined,
      managePolicy: undefined,
      manageGroupIds: undefined,
      userLimit: undefined,
    });
    expect(updated.ok).toBe(true);
    expect(store.getVisibleNode(created.node.nodeId, [])?.name).toBe('New Name');
    store.close();
  });

  it('sets and clears a user limit', () => {
    const store = openStore([]);
    const created = store.createVoiceChannel({
      name: 'Room',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!created.ok) throw new Error('setup failed');
    store.updateNode({
      nodeId: created.node.nodeId,
      actorEffectiveGroupIds: [],
      name: undefined,
      visibilityPolicy: undefined,
      visibilityGroupIds: undefined,
      joinPolicy: undefined,
      joinGroupIds: undefined,
      managePolicy: undefined,
      manageGroupIds: undefined,
      userLimit: 2,
    });
    expect(store.getVisibleNode(created.node.nodeId, [])?.userLimit).toBe(2);

    store.updateNode({
      nodeId: created.node.nodeId,
      actorEffectiveGroupIds: [],
      name: undefined,
      visibilityPolicy: undefined,
      visibilityGroupIds: undefined,
      joinPolicy: undefined,
      joinGroupIds: undefined,
      managePolicy: undefined,
      manageGroupIds: undefined,
      userLimit: null,
    });
    expect(store.getVisibleNode(created.node.nodeId, [])?.userLimit).toBeUndefined();
    store.close();
  });

  it('moves a node to a new parent', () => {
    const store = openStore([]);
    const parentA = store.createCategory({
      name: 'A',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    const parentB = store.createCategory({
      name: 'B',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!parentA.ok || !parentB.ok) throw new Error('setup failed');
    const child = store.createVoiceChannel({
      name: 'Child',
      parentId: parentA.node.nodeId,
      actorEffectiveGroupIds: [],
    });
    if (!child.ok) throw new Error('setup failed');

    const moved = store.moveNode({
      nodeId: child.node.nodeId,
      newParentId: parentB.node.nodeId,
      actorEffectiveGroupIds: [],
    });
    expect(moved.ok).toBe(true);
    expect(store.getVisibleNode(child.node.nodeId, [])?.parentId).toBe(parentB.node.nodeId);
    store.close();
  });

  it('rejects a self-parent move', () => {
    const store = openStore([]);
    const node = store.createVoiceChannel({
      name: 'A',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!node.ok) throw new Error('setup failed');
    const result = store.moveNode({
      nodeId: node.node.nodeId,
      newParentId: node.node.nodeId,
      actorEffectiveGroupIds: [],
    });
    expect(result).toMatchObject({ ok: false, code: 'CHANNEL_PARENT_INVALID' });
    store.close();
  });

  it('rejects a move that would create a cycle', () => {
    const store = openStore([]);
    const a = store.createVoiceChannel({
      name: 'A',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!a.ok) throw new Error('setup failed');
    const b = store.createVoiceChannel({
      name: 'B',
      parentId: a.node.nodeId,
      actorEffectiveGroupIds: [],
    });
    if (!b.ok) throw new Error('setup failed');
    // Moving A under its own descendant B would create a cycle.
    const result = store.moveNode({
      nodeId: a.node.nodeId,
      newParentId: b.node.nodeId,
      actorEffectiveGroupIds: [],
    });
    expect(result).toMatchObject({ ok: false, code: 'CHANNEL_PARENT_INVALID' });
    store.close();
  });

  it('reorders siblings', () => {
    const store = openStore([]);
    const a = store.createVoiceChannel({
      name: 'A',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    const b = store.createVoiceChannel({
      name: 'B',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    const c = store.createVoiceChannel({
      name: 'C',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!a.ok || !b.ok || !c.ok) throw new Error('setup failed');

    const reordered = store.reorderChildren({
      parentId: undefined,
      orderedNodeIds: [c.node.nodeId, a.node.nodeId, b.node.nodeId],
      actorEffectiveGroupIds: [],
    });
    expect(reordered.ok).toBe(true);
    const tree = store.getFilteredTree([]);
    expect(tree.map((n) => n.nodeId)).toEqual([c.node.nodeId, a.node.nodeId, b.node.nodeId]);
    store.close();
  });

  it('rejects reordering with a mismatched sibling set', () => {
    const store = openStore([]);
    const a = store.createVoiceChannel({
      name: 'A',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!a.ok) throw new Error('setup failed');
    const result = store.reorderChildren({
      parentId: undefined,
      orderedNodeIds: [a.node.nodeId, 'does-not-exist'],
      actorEffectiveGroupIds: [],
    });
    expect(result).toMatchObject({ ok: false, code: 'CHANNEL_NOT_FOUND' });
    store.close();
  });
});

describe('ChannelStore — tombstone / soft delete', () => {
  it('a deleted node is invisible through getVisibleNode/getFilteredTree', () => {
    const store = openStore([]);
    const node = store.createVoiceChannel({
      name: 'Doomed',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!node.ok) throw new Error('setup failed');
    const deleted = store.deleteNode({ nodeId: node.node.nodeId, actorEffectiveGroupIds: [] });
    expect(deleted.ok).toBe(true);
    expect(store.getVisibleNode(node.node.nodeId, [])).toBeUndefined();
    expect(store.getFilteredTree([])).toEqual([]);
    store.close();
  });

  it('a tombstoned id is never reused by a later create', () => {
    const store = openStore([]);
    const node = store.createVoiceChannel({
      name: 'Doomed',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!node.ok) throw new Error('setup failed');
    store.deleteNode({ nodeId: node.node.nodeId, actorEffectiveGroupIds: [] });

    const another = store.createVoiceChannel({
      name: 'Fresh',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    expect(another.ok).toBe(true);
    if (another.ok) expect(another.node.nodeId).not.toBe(node.node.nodeId);
    store.close();
  });

  it('deleting a node cascades the tombstone to its entire subtree', () => {
    const store = openStore([]);
    const parent = store.createCategory({
      name: 'Parent',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!parent.ok) throw new Error('setup failed');
    const child = store.createVoiceChannel({
      name: 'Child',
      parentId: parent.node.nodeId,
      actorEffectiveGroupIds: [],
    });
    if (!child.ok) throw new Error('setup failed');
    const grandchild = store.createVoiceChannel({
      name: 'Grandchild',
      parentId: child.node.nodeId,
      actorEffectiveGroupIds: [],
    });
    if (!grandchild.ok) throw new Error('setup failed');

    store.deleteNode({ nodeId: parent.node.nodeId, actorEffectiveGroupIds: [] });

    expect(store.getVisibleNode(parent.node.nodeId, [])).toBeUndefined();
    expect(store.getVisibleNode(child.node.nodeId, [])).toBeUndefined();
    expect(store.getVisibleNode(grandchild.node.nodeId, [])).toBeUndefined();
    store.close();
  });

  it('deleting an unknown node is rejected', () => {
    const store = openStore([]);
    expect(store.deleteNode({ nodeId: 'nope', actorEffectiveGroupIds: [] })).toMatchObject({
      ok: false,
      code: 'CHANNEL_NOT_FOUND',
    });
    store.close();
  });
});

describe('ChannelStore — permanent persistence across a real reopen', () => {
  it('a rename/move survives closing and reopening the store, using the same nodeId', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'disco-voador-channels-'));
    const file = path.join(dir, 'channels.sqlite');
    try {
      const first = new ChannelStore(file, { seed: LEGACY_SEED });
      const category = first.createCategory({
        name: 'Category',
        parentId: undefined,
        actorEffectiveGroupIds: [],
      });
      if (!category.ok) throw new Error('setup failed');
      first.updateNode({
        nodeId: 'general',
        actorEffectiveGroupIds: [],
        name: 'Renamed General',
        visibilityPolicy: undefined,
        visibilityGroupIds: undefined,
        joinPolicy: undefined,
        joinGroupIds: undefined,
        managePolicy: undefined,
        manageGroupIds: undefined,
        userLimit: undefined,
      });
      first.moveNode({
        nodeId: 'general',
        newParentId: category.node.nodeId,
        actorEffectiveGroupIds: [],
      });
      first.close();

      const second = new ChannelStore(file, { seed: LEGACY_SEED });
      const node = second.getVisibleNode('general', []);
      expect(node?.name).toBe('Renamed General');
      expect(node?.parentId).toBe(category.node.nodeId);
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a deleted node stays deleted across a restart', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'disco-voador-channels-'));
    const file = path.join(dir, 'channels.sqlite');
    try {
      const first = new ChannelStore(file, { seed: LEGACY_SEED });
      first.deleteNode({ nodeId: 'afk', actorEffectiveGroupIds: [] });
      first.close();

      const second = new ChannelStore(file, {});
      expect(second.getVisibleNode('afk', [])).toBeUndefined();
      second.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('ChannelStore — ACL persistence', () => {
  it('visibility/join/manage group-id lists round-trip through getEditableNode', () => {
    const store = openStore([]);
    const node = store.createVoiceChannel({
      name: 'Raid Planning',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!node.ok) throw new Error('setup failed');

    store.updateNode({
      nodeId: node.node.nodeId,
      actorEffectiveGroupIds: [],
      name: undefined,
      visibilityPolicy: 'selected-groups',
      visibilityGroupIds: ['staff'],
      joinPolicy: 'selected-groups',
      joinGroupIds: ['staff', 'raid-leaders'],
      managePolicy: 'selected-groups',
      manageGroupIds: ['staff'],
      userLimit: undefined,
    });

    const admin = store.getEditableNode(node.node.nodeId);
    expect(admin?.visibilityGroupIds).toEqual(['staff']);
    expect(admin?.joinGroupIds.sort()).toEqual(['raid-leaders', 'staff']);
    expect(admin?.manageGroupIds).toEqual(['staff']);
    store.close();
  });

  it('isGroupReferenced reflects only active nodes', () => {
    const store = openStore([]);
    const node = store.createVoiceChannel({
      name: 'Gated',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!node.ok) throw new Error('setup failed');
    expect(store.isGroupReferenced('staff')).toBe(false);

    store.updateNode({
      nodeId: node.node.nodeId,
      actorEffectiveGroupIds: [],
      name: undefined,
      visibilityPolicy: 'selected-groups',
      visibilityGroupIds: ['staff'],
      joinPolicy: undefined,
      joinGroupIds: undefined,
      managePolicy: undefined,
      manageGroupIds: undefined,
      userLimit: undefined,
    });
    expect(store.isGroupReferenced('staff')).toBe(true);

    store.deleteNode({ nodeId: node.node.nodeId, actorEffectiveGroupIds: [] });
    expect(store.isGroupReferenced('staff')).toBe(false);
    store.close();
  });
});

describe('ChannelStore — password verifier', () => {
  it('round-trips: set -> verify correct -> verify incorrect -> change -> old fails, new succeeds', () => {
    const store = openStore([]);
    const node = store.createVoiceChannel({
      name: 'Protected',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!node.ok) throw new Error('setup failed');

    store.setPassword({
      nodeId: node.node.nodeId,
      password: 'first-secret',
      actorEffectiveGroupIds: [],
    });
    expect(store.getVisibleNode(node.node.nodeId, [])?.hasPassword).toBe(true);

    const checkJoinParams = {
      nodeId: node.node.nodeId,
      effectiveGroupIds: [],
      currentMemberCount: 0,
      bypassPassword: false,
    };
    expect(store.checkJoin({ ...checkJoinParams, password: 'first-secret' })).toEqual({ ok: true });
    expect(store.checkJoin({ ...checkJoinParams, password: 'wrong' })).toMatchObject({
      ok: false,
      code: 'PASSWORD_INVALID',
    });
    expect(store.checkJoin({ ...checkJoinParams, password: undefined })).toMatchObject({
      ok: false,
      code: 'PASSWORD_REQUIRED',
    });

    store.setPassword({
      nodeId: node.node.nodeId,
      password: 'second-secret',
      actorEffectiveGroupIds: [],
    });
    expect(store.checkJoin({ ...checkJoinParams, password: 'first-secret' })).toMatchObject({
      ok: false,
      code: 'PASSWORD_INVALID',
    });
    expect(store.checkJoin({ ...checkJoinParams, password: 'second-secret' })).toEqual({
      ok: true,
    });

    store.removePassword({ nodeId: node.node.nodeId, actorEffectiveGroupIds: [] });
    expect(store.getVisibleNode(node.node.nodeId, [])?.hasPassword).toBe(false);
    expect(store.checkJoin({ ...checkJoinParams, password: undefined })).toEqual({ ok: true });
    store.close();
  });

  it('the raw password never appears in the stored verifier string', () => {
    const store = openStore([]);
    const node = store.createVoiceChannel({
      name: 'Protected',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!node.ok) throw new Error('setup failed');
    store.setPassword({
      nodeId: node.node.nodeId,
      password: 'super-secret-value',
      actorEffectiveGroupIds: [],
    });
    const admin = store.getEditableNode(node.node.nodeId);
    // The admin view never exposes a verifier/getPassword at all — structurally, not just by
    // convention (see `ChannelPort`'s own doc comment): only `hasPassword: boolean` is visible.
    expect(admin).not.toHaveProperty('password');
    expect(admin).not.toHaveProperty('passwordVerifier');
    expect(JSON.stringify(admin)).not.toContain('super-secret-value');
    store.close();
  });

  it('setPassword/removePassword are silently ignored for a category (voice-only fields)', () => {
    const store = openStore([]);
    const category = store.createCategory({
      name: 'Cat',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!category.ok) throw new Error('setup failed');
    const result = store.setPassword({
      nodeId: category.node.nodeId,
      password: 'whatever',
      actorEffectiveGroupIds: [],
    });
    expect(result.ok).toBe(true);
    expect(store.getVisibleNode(category.node.nodeId, [])?.hasPassword).toBe(false);
    store.close();
  });
});

describe('ChannelStore — ACL resolution / policy evaluator', () => {
  const GUEST: readonly string[] = ['guest'];
  const MEMBER: readonly string[] = ['member'];
  const MODERATOR: readonly string[] = ['moderator'];
  const RAID_LEADER: readonly string[] = ['raid-leaders'];
  const STAFF: readonly string[] = ['staff'];

  it('Everyone visibility/join: every group can see and join', () => {
    const store = openStore([]);
    const node = store.createVoiceChannel({
      name: 'Open Room',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!node.ok) throw new Error('setup failed');
    store.updateNode({
      nodeId: node.node.nodeId,
      actorEffectiveGroupIds: [],
      name: undefined,
      visibilityPolicy: 'everyone',
      visibilityGroupIds: undefined,
      joinPolicy: 'everyone',
      joinGroupIds: undefined,
      managePolicy: undefined,
      manageGroupIds: undefined,
      userLimit: undefined,
    });
    for (const groups of [GUEST, MEMBER, MODERATOR, []]) {
      expect(store.getVisibleNode(node.node.nodeId, groups)).toBeDefined();
      expect(
        store.checkJoin({
          nodeId: node.node.nodeId,
          effectiveGroupIds: groups,
          currentMemberCount: 0,
          password: undefined,
          bypassPassword: false,
        }),
      ).toEqual({ ok: true });
    }
    store.close();
  });

  it('Selected-groups visibility: only members of the selected group can see it at all', () => {
    const store = openStore([]);
    const node = store.createVoiceChannel({
      name: 'Staff Only',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!node.ok) throw new Error('setup failed');
    store.updateNode({
      nodeId: node.node.nodeId,
      actorEffectiveGroupIds: [],
      name: undefined,
      visibilityPolicy: 'selected-groups',
      visibilityGroupIds: ['staff'],
      joinPolicy: undefined,
      joinGroupIds: undefined,
      managePolicy: undefined,
      manageGroupIds: undefined,
      userLimit: undefined,
    });
    expect(store.getVisibleNode(node.node.nodeId, STAFF)).toBeDefined();
    expect(store.getVisibleNode(node.node.nodeId, GUEST)).toBeUndefined();
    expect(store.getVisibleNode(node.node.nodeId, [])).toBeUndefined();
    store.close();
  });

  it('Join-only restriction: visible to everyone, joinable only by a restricted group', () => {
    const store = openStore([]);
    const node = store.createVoiceChannel({
      name: 'VIP Room',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!node.ok) throw new Error('setup failed');
    store.updateNode({
      nodeId: node.node.nodeId,
      actorEffectiveGroupIds: [],
      name: undefined,
      visibilityPolicy: 'everyone',
      visibilityGroupIds: undefined,
      joinPolicy: 'selected-groups',
      joinGroupIds: ['moderator'],
      managePolicy: undefined,
      manageGroupIds: undefined,
      userLimit: undefined,
    });
    // A Guest sees it...
    expect(store.getVisibleNode(node.node.nodeId, GUEST)).toBeDefined();
    // ...but is denied on join.
    expect(
      store.checkJoin({
        nodeId: node.node.nodeId,
        effectiveGroupIds: GUEST,
        currentMemberCount: 0,
        password: undefined,
        bypassPassword: false,
      }),
    ).toMatchObject({ ok: false, code: 'ACCESS_DENIED' });
    // A Moderator joins successfully — visibility and join are genuinely separate axes.
    expect(
      store.checkJoin({
        nodeId: node.node.nodeId,
        effectiveGroupIds: MODERATOR,
        currentMemberCount: 0,
        password: undefined,
        bypassPassword: false,
      }),
    ).toEqual({ ok: true });
    store.close();
  });

  it('the STAFF/Raid-Leaders worked example from the design doc', () => {
    const store = openStore([]);
    const officers = store.createCategory({
      name: 'Officers',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!officers.ok) throw new Error('setup failed');
    store.updateNode({
      nodeId: officers.node.nodeId,
      actorEffectiveGroupIds: [],
      name: undefined,
      visibilityPolicy: 'selected-groups',
      visibilityGroupIds: ['staff'],
      joinPolicy: undefined,
      joinGroupIds: undefined,
      managePolicy: undefined,
      manageGroupIds: undefined,
      userLimit: undefined,
    });
    const raidPlanning = store.createVoiceChannel({
      name: 'Raid Planning',
      parentId: officers.node.nodeId,
      actorEffectiveGroupIds: [],
    });
    if (!raidPlanning.ok) throw new Error('setup failed');
    store.updateNode({
      nodeId: raidPlanning.node.nodeId,
      actorEffectiveGroupIds: [],
      name: undefined,
      visibilityPolicy: 'inherit',
      visibilityGroupIds: undefined,
      joinPolicy: 'selected-groups',
      joinGroupIds: ['staff', 'raid-leaders'],
      managePolicy: undefined,
      manageGroupIds: undefined,
      userLimit: undefined,
    });

    // A raid-leaders-only identity: visibility fails at "Officers" (root ancestor) -> invisible,
    // regardless of "Raid Planning" naming raid-leaders in its own join policy.
    expect(store.getVisibleNode(raidPlanning.node.nodeId, RAID_LEADER)).toBeUndefined();
    expect(
      store.checkJoin({
        nodeId: raidPlanning.node.nodeId,
        effectiveGroupIds: RAID_LEADER,
        currentMemberCount: 0,
        password: undefined,
        bypassPassword: false,
      }),
    ).toMatchObject({ ok: false, code: 'NOT_FOUND' });

    // A staff identity: visibility passes at "Officers"; "Raid Planning" is inherit for visibility
    // -> visible. Join resolves to staff+raid-leaders; staff intersects -> joinable.
    expect(store.getVisibleNode(raidPlanning.node.nodeId, STAFF)).toBeDefined();
    expect(
      store.checkJoin({
        nodeId: raidPlanning.node.nodeId,
        effectiveGroupIds: STAFF,
        currentMemberCount: 0,
        password: undefined,
        bypassPassword: false,
      }),
    ).toEqual({ ok: true });
    store.close();
  });

  it('Manage: nearest-non-inherit ancestor, never "everyone", does not bound descendants', () => {
    const store = openStore([]);
    const category = store.createCategory({
      name: 'Community',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!category.ok) throw new Error('setup failed');
    store.updateNode({
      nodeId: category.node.nodeId,
      actorEffectiveGroupIds: [],
      name: undefined,
      visibilityPolicy: undefined,
      visibilityGroupIds: undefined,
      joinPolicy: undefined,
      joinGroupIds: undefined,
      managePolicy: 'selected-groups',
      manageGroupIds: ['moderator'],
      userLimit: undefined,
    });
    const child = store.createVoiceChannel({
      name: 'Sub',
      parentId: category.node.nodeId,
      actorEffectiveGroupIds: [],
    });
    if (!child.ok) throw new Error('setup failed');

    // The child inherits the category's Manage policy by default.
    expect(store.hasManageRights(child.node.nodeId, MODERATOR)).toBe(true);
    expect(store.hasManageRights(child.node.nodeId, GUEST)).toBe(false);

    // Delegated administration: the child can set its own, different Manage policy, which does not
    // have to match (or be bounded by) the category's.
    store.updateNode({
      nodeId: child.node.nodeId,
      actorEffectiveGroupIds: [],
      name: undefined,
      visibilityPolicy: undefined,
      visibilityGroupIds: undefined,
      joinPolicy: undefined,
      joinGroupIds: undefined,
      managePolicy: 'selected-groups',
      manageGroupIds: ['raid-leaders'],
      userLimit: undefined,
    });
    expect(store.hasManageRights(child.node.nodeId, MODERATOR)).toBe(false);
    expect(store.hasManageRights(child.node.nodeId, RAID_LEADER)).toBe(true);
    // The category's own Manage is untouched by the child's override.
    expect(store.hasManageRights(category.node.nodeId, MODERATOR)).toBe(true);
    store.close();
  });

  it('an all-inherit chain has no local Manage holder at all (only a global override can manage it)', () => {
    const store = openStore([]);
    const node = store.createVoiceChannel({
      name: 'Plain',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!node.ok) throw new Error('setup failed');
    expect(store.hasManageRights(node.node.nodeId, MODERATOR)).toBe(false);
    expect(store.hasManageRights(node.node.nodeId, [])).toBe(false);
    store.close();
  });
});

describe('ChannelStore — capacity', () => {
  it('checkJoin reports FULL once currentMemberCount reaches the configured userLimit', () => {
    const store = openStore([]);
    const node = store.createVoiceChannel({
      name: 'Small Room',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!node.ok) throw new Error('setup failed');
    store.updateNode({
      nodeId: node.node.nodeId,
      actorEffectiveGroupIds: [],
      name: undefined,
      visibilityPolicy: undefined,
      visibilityGroupIds: undefined,
      joinPolicy: undefined,
      joinGroupIds: undefined,
      managePolicy: undefined,
      manageGroupIds: undefined,
      userLimit: 2,
    });
    const base = {
      nodeId: node.node.nodeId,
      effectiveGroupIds: [],
      password: undefined,
      bypassPassword: false,
    };
    expect(store.checkJoin({ ...base, currentMemberCount: 1 })).toEqual({ ok: true });
    expect(store.checkJoin({ ...base, currentMemberCount: 2 })).toMatchObject({
      ok: false,
      code: 'FULL',
    });
    store.close();
  });
});

describe('ChannelStore — categories are never joinable', () => {
  it('checkJoin always denies a category regardless of join policy', () => {
    const store = openStore([]);
    const category = store.createCategory({
      name: 'Cat',
      parentId: undefined,
      actorEffectiveGroupIds: [],
    });
    if (!category.ok) throw new Error('setup failed');
    expect(
      store.checkJoin({
        nodeId: category.node.nodeId,
        effectiveGroupIds: [],
        currentMemberCount: 0,
        password: undefined,
        bypassPassword: false,
      }),
    ).toMatchObject({ ok: false, code: 'ACCESS_DENIED' });
    store.close();
  });
});
