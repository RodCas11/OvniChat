// T13.2 — direct unit coverage for the new admin-facing helpers added to `channel-tree.ts`
// (`collectSubtreeIds`/`countDescendants`/`flattenTreeForPicker`/`sameGroupIds`), mirroring this
// module's own precedent of keeping pure, display-only tree logic independently testable.
import { describe, expect, it } from 'vitest';

import {
  collectSubtreeIds,
  countDescendants,
  flattenTreeForPicker,
  sameGroupIds,
} from '../../apps/desktop/src/renderer/workspace/channel-tree.js';
import { createChannel } from './fixtures/voice-state.js';

const TREE = [
  createChannel({ nodeId: 'games', name: 'GAMES', kind: 'category' }),
  createChannel({ nodeId: 'poe', name: 'Path of Exile', kind: 'voice', parentId: 'games' }),
  createChannel({ nodeId: 'bossing', name: 'Bossing', kind: 'voice', parentId: 'poe' }),
  createChannel({ nodeId: 'lounge', name: 'Lounge', kind: 'voice' }),
];

describe('collectSubtreeIds (T13.2)', () => {
  it('includes the node itself and every descendant, nothing else', () => {
    expect(collectSubtreeIds(TREE, 'poe')).toEqual(new Set(['poe', 'bossing']));
    expect(collectSubtreeIds(TREE, 'games')).toEqual(new Set(['games', 'poe', 'bossing']));
    expect(collectSubtreeIds(TREE, 'lounge')).toEqual(new Set(['lounge']));
  });
});

describe('countDescendants (T13.2)', () => {
  it('counts descendants only, not the node itself', () => {
    expect(countDescendants(TREE, 'games')).toBe(2);
    expect(countDescendants(TREE, 'lounge')).toBe(0);
  });
});

describe('flattenTreeForPicker (T13.2)', () => {
  it('excludes the given subtree entirely — not even as a disabled option', () => {
    const entries = flattenTreeForPicker(TREE, { excludeSubtreeOf: 'poe', maxDepth: 3 });
    const ids = entries.map((entry) => entry.nodeId);
    expect(ids).not.toContain('poe');
    expect(ids).not.toContain('bossing');
    expect(ids).toContain('games');
    expect(ids).toContain('lounge');
  });

  it('marks an entry at maxDepth as disabled (cannot accept a further child), never hidden', () => {
    // `bossing` sits at depth 2 (games -> poe -> bossing); with maxDepth 2, a node at depth 2 would
    // give any child depth 3, so it is disabled as a target — but still listed, not hidden.
    const entries = flattenTreeForPicker(TREE, { maxDepth: 2 });
    const bossing = entries.find((entry) => entry.nodeId === 'bossing');
    const poe = entries.find((entry) => entry.nodeId === 'poe');
    expect(poe?.disabled).toBe(false);
    expect(bossing?.disabled).toBe(true);
    expect(bossing).toBeDefined();
  });

  it('reports depth correctly for indentation', () => {
    const entries = flattenTreeForPicker(TREE, { maxDepth: 3 });
    expect(entries.find((e) => e.nodeId === 'games')?.depth).toBe(0);
    expect(entries.find((e) => e.nodeId === 'poe')?.depth).toBe(1);
    expect(entries.find((e) => e.nodeId === 'bossing')?.depth).toBe(2);
  });
});

describe('sameGroupIds (T13.2)', () => {
  it('is order-insensitive', () => {
    expect(sameGroupIds(['a', 'b'], ['b', 'a'])).toBe(true);
  });

  it('detects a real difference', () => {
    expect(sameGroupIds(['a'], ['a', 'b'])).toBe(false);
    expect(sameGroupIds(['a'], ['b'])).toBe(false);
  });
});
