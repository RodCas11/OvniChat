// T13.2.1 — the presentation-layer completeness guarantee itself. `PERMISSION_PRESENTATION`'s own
// `Record<PermissionKey, ...>` type already fails a `tsc` run if a key is missing/misspelled; this
// test is the runtime half of that guarantee (see `permission-presentation.ts`'s own doc comment) —
// it enumerates the real `permissionKeySchema.options` from `@disco-voador/protocol` and asserts each
// one has a non-empty label and a category here, so a future engineer adding a new permission key to
// the protocol package without updating this file fails CI, not just a type-check a differently-timed
// change could dodge.
import { permissionKeySchema } from '@disco-voador/protocol';
import { describe, expect, it } from 'vitest';

import {
  ALL_PERMISSION_KEYS,
  allPermissionsByCategory,
  groupPermissionsByCategory,
  isFullPermissionSet,
  PERMISSION_CATEGORY_ORDER,
  PERMISSION_PRESENTATION,
} from '../../apps/desktop/src/renderer/voice/permission-presentation.js';

describe('permission-presentation (T13.2.1)', () => {
  it('has a complete, non-empty presentation entry for every real PermissionKey', () => {
    for (const key of permissionKeySchema.options) {
      const entry = PERMISSION_PRESENTATION[key];
      expect(entry, `missing presentation entry for "${key}"`).toBeDefined();
      expect(entry.label.trim().length).toBeGreaterThan(0);
      expect(PERMISSION_CATEGORY_ORDER).toContain(entry.category);
    }
  });

  it('ALL_PERMISSION_KEYS matches the real registry exactly (same set, same length)', () => {
    expect(ALL_PERMISSION_KEYS).toHaveLength(permissionKeySchema.options.length);
    for (const key of permissionKeySchema.options) {
      expect(ALL_PERMISSION_KEYS).toContain(key);
    }
  });

  it('allPermissionsByCategory covers every permission exactly once, grouped by category', () => {
    const groups = allPermissionsByCategory();
    const seen = new Set<string>();
    for (const group of groups) {
      for (const key of group.keys) {
        expect(seen.has(key)).toBe(false);
        seen.add(key);
        expect(PERMISSION_PRESENTATION[key].category).toBe(group.category);
      }
    }
    expect(seen.size).toBe(permissionKeySchema.options.length);
  });

  it('groupPermissionsByCategory omits categories with no matching permission', () => {
    const groups = groupPermissionsByCategory(['moderation.kick', 'moderation.ban']);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.category).toBe('Moderation');
    expect(groups[0]?.keys).toEqual(['moderation.kick', 'moderation.ban']);
  });

  it('groupPermissionsByCategory returns nothing for an empty permission list', () => {
    expect(groupPermissionsByCategory([])).toEqual([]);
  });

  it('isFullPermissionSet is true only when literally every registry key is present', () => {
    expect(isFullPermissionSet(ALL_PERMISSION_KEYS)).toBe(true);
    expect(isFullPermissionSet([...ALL_PERMISSION_KEYS].slice(0, -1))).toBe(false);
    expect(isFullPermissionSet([])).toBe(false);
  });
});
