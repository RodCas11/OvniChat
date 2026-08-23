// T13.3 — `buildMemberGroups`'s bucketing/fallback logic, mirroring `channel-tree.test.ts`'s own
// precedent of unit-testing a pure grouping/derivation function directly rather than relying solely
// on a live E2E run or a component test to exercise it.
import { describe, expect, it } from 'vitest';

import { buildMemberGroups } from '../../apps/desktop/src/renderer/workspace/member-presentation.js';
import { createMemberPanelEntry } from './fixtures/voice-state.js';

describe('buildMemberGroups (T13.3)', () => {
  it('falls back to one flat "Members" group when no entry has a roleBucket', () => {
    const alice = createMemberPanelEntry({ key: 'a', displayName: 'Alice' });
    const bob = createMemberPanelEntry({ key: 'b', displayName: 'Bob' });

    const { groups, hasRealGroups } = buildMemberGroups([alice, bob]);

    expect(hasRealGroups).toBe(false);
    expect(groups).toEqual([{ label: 'Members', members: [alice, bob] }]);
  });

  it('returns no groups at all for an empty entry list (never a fabricated empty "Members" group)', () => {
    const { groups, hasRealGroups } = buildMemberGroups([]);
    expect(hasRealGroups).toBe(false);
    expect(groups).toEqual([]);
  });

  it('buckets into Admins/Moderators/Members, in that order, skipping empty buckets', () => {
    const admin = createMemberPanelEntry({ key: 'a', displayName: 'Admin', roleBucket: 'admin' });
    const plain = createMemberPanelEntry({ key: 'p', displayName: 'Plain' });

    const { groups, hasRealGroups } = buildMemberGroups([plain, admin]);

    expect(hasRealGroups).toBe(true);
    // Admins first, then Members — never Moderators (empty, skipped) — regardless of input order.
    expect(groups).toEqual([
      { label: 'Admins', members: [admin] },
      { label: 'Members', members: [plain] },
    ]);
  });

  it('includes a Moderators bucket only when at least one entry actually holds it', () => {
    const admin = createMemberPanelEntry({ key: 'a', roleBucket: 'admin' });
    const moderator = createMemberPanelEntry({ key: 'm', roleBucket: 'moderator' });
    const plain = createMemberPanelEntry({ key: 'p' });

    const { groups } = buildMemberGroups([plain, moderator, admin]);

    expect(groups.map((group) => group.label)).toEqual(['Admins', 'Moderators', 'Members']);
  });

  it('renders no group at all for a bucket every real member happens to hold (no empty stub group)', () => {
    const admin = createMemberPanelEntry({ key: 'a', roleBucket: 'admin' });
    const { groups } = buildMemberGroups([admin]);
    expect(groups).toEqual([{ label: 'Admins', members: [admin] }]);
  });
});
