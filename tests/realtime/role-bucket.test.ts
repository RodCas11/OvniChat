import type { PermissionKey } from '@disco-voador/protocol';
import { describe, expect, it } from 'vitest';

import { deriveMemberRoleBucket } from '../../services/realtime/src/presence/role-bucket.js';

/** Pure unit tests for `deriveMemberRoleBucket` — no sockets, no SQLite. Real-server, real-group
 * coverage (a custom group granting `moderation.kick`, not just the built-in `server-admin`) lives
 * in `tests/dedicated-server/profile-integration.test.ts`. */

function canFrom(held: readonly PermissionKey[]): (permission: PermissionKey) => boolean {
  return (permission) => held.includes(permission);
}

describe('deriveMemberRoleBucket', () => {
  it('returns undefined (plain member) for an identity with no relevant permissions or groups', () => {
    expect(deriveMemberRoleBucket([], canFrom(['voice.channel.join']))).toBeUndefined();
    expect(deriveMemberRoleBucket(['member'], canFrom(['chat.server.send']))).toBeUndefined();
  });

  it('returns "admin" for membership in the built-in server-admin group, even with no explicit permission check passing', () => {
    expect(deriveMemberRoleBucket(['server-admin'], canFrom([]))).toBe('admin');
  });

  it.each<PermissionKey>([
    'channels.manage',
    'authorization.groups.manage',
    'authorization.memberships.manage',
    'authorization.tokens.manage',
    'server.manage',
    'channels.create',
    'channels.delete',
  ])('returns "admin" for holding %s globally, via any group', (permission) => {
    expect(deriveMemberRoleBucket(['some-custom-group'], canFrom([permission]))).toBe('admin');
  });

  it.each<PermissionKey>(['moderation.kick', 'moderation.ban'])(
    'returns "moderator" for holding %s globally, via any group',
    (permission) => {
      expect(deriveMemberRoleBucket(['some-custom-group'], canFrom([permission]))).toBe(
        'moderator',
      );
    },
  );

  it('prefers "admin" over "moderator" when both sets of permissions are held', () => {
    expect(
      deriveMemberRoleBucket(['some-group'], canFrom(['server.manage', 'moderation.kick'])),
    ).toBe('admin');
  });

  it('never reveals which specific group grants the permission — only the derived bucket', () => {
    const bucket = deriveMemberRoleBucket(
      ['a-secret-custom-group-name'],
      canFrom(['moderation.ban']),
    );
    expect(bucket).toBe('moderator');
    expect(typeof bucket).toBe('string');
    // `bucket` itself carries no group name/id — the function's return type structurally cannot.
  });
});
