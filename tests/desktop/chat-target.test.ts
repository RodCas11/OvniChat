// T13.2 — `resolveChatTargetAfterCatalogUpdate` falls back to Server Chat exactly when the selected
// channel is no longer present on the live catalog (deleted, or hidden by a live ACL change), and
// never touches Server Chat or a still-present channel selection.
import { describe, expect, it } from 'vitest';

import {
  chatTargetsEqual,
  resolveChatTargetAfterCatalogUpdate,
} from '../../apps/desktop/src/renderer/workspace/chat-target.js';

describe('resolveChatTargetAfterCatalogUpdate (T13.2)', () => {
  it('falls back to Server Chat when the selected channel disappears from the catalog', () => {
    const result = resolveChatTargetAfterCatalogUpdate(
      { scope: 'channel', channelId: 'general' },
      new Set(['other']),
    );
    expect(chatTargetsEqual(result, { scope: 'server' })).toBe(true);
  });

  it('leaves the selection untouched when the channel is still present', () => {
    const target = { scope: 'channel', channelId: 'general' } as const;
    const result = resolveChatTargetAfterCatalogUpdate(target, new Set(['general', 'other']));
    expect(result).toEqual(target);
  });

  it('never changes a Server Chat selection', () => {
    const target = { scope: 'server' } as const;
    expect(resolveChatTargetAfterCatalogUpdate(target, new Set())).toEqual(target);
  });
});
