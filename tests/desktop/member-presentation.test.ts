// T13.3 — `buildMemberGroups`'s bucketing/fallback logic, mirroring `channel-tree.test.ts`'s own
// precedent of unit-testing a pure grouping/derivation function directly rather than relying solely
// on a live E2E run or a component test to exercise it.
import { describe, expect, it } from 'vitest';

import type { MemberPresence } from '@disco-voador/protocol';

import {
  buildMemberGroups,
  isMemberCurrentlySpeaking,
  resolveParticipantAvatars,
} from '../../apps/desktop/src/renderer/workspace/member-presentation.js';
import { createMemberPanelEntry, createParticipant } from './fixtures/voice-state.js';

function member(overrides: Partial<MemberPresence> = {}): MemberPresence {
  return { memberRef: 'member-a', displayName: 'Alice', presence: 'online', ...overrides };
}

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

// T13.4 (UI consistency follow-up) — `isMemberCurrentlySpeaking`'s pure correlation logic: bridges
// `MemberPanelEntry.key` (a `memberRef`) to `state.speakingParticipantIds` (participantId-keyed) via
// `VoiceParticipantView.memberRef`, without ever computing speech itself. The privacy tests here are
// the load-bearing ones — they prove the *only* way a member can ever show as speaking is if a
// matching, currently-known voice participant (i.e. one from a channel this client is itself already
// joined to) is in `speakingParticipantIds`, never anything reachable from a channel this client
// cannot see.
describe('isMemberCurrentlySpeaking (T13.4)', () => {
  it('is false when no participant matches the memberRef at all', () => {
    const participants = [createParticipant({ participantId: 'p1', memberRef: 'member-a' })];
    expect(isMemberCurrentlySpeaking('member-b', participants, new Set(['p1']))).toBe(false);
  });

  it('is true when the matching participant is in speakingParticipantIds', () => {
    const participants = [createParticipant({ participantId: 'p1', memberRef: 'member-a' })];
    expect(isMemberCurrentlySpeaking('member-a', participants, new Set(['p1']))).toBe(true);
  });

  it('is false when the matching participant exists but is not currently speaking', () => {
    const participants = [createParticipant({ participantId: 'p1', memberRef: 'member-a' })];
    expect(isMemberCurrentlySpeaking('member-a', participants, new Set())).toBe(false);
  });

  it('clears to false the moment the participant is removed from speakingParticipantIds (silence transition)', () => {
    const participants = [createParticipant({ participantId: 'p1', memberRef: 'member-a' })];
    expect(isMemberCurrentlySpeaking('member-a', participants, new Set(['p1']))).toBe(true);
    expect(isMemberCurrentlySpeaking('member-a', participants, new Set())).toBe(false);
  });

  it('multiple simultaneous sessions of the same identity: any one of them speaking is enough', () => {
    const participants = [
      createParticipant({ participantId: 'p1', memberRef: 'member-a' }),
      createParticipant({ participantId: 'p2', memberRef: 'member-a' }),
    ];
    expect(isMemberCurrentlySpeaking('member-a', participants, new Set(['p2']))).toBe(true);
  });

  it('two independently-speaking members both resolve true — no artificial single-speaker limit', () => {
    const participants = [
      createParticipant({ participantId: 'p1', memberRef: 'member-a' }),
      createParticipant({ participantId: 'p2', memberRef: 'member-b' }),
    ];
    const speaking = new Set(['p1', 'p2']);
    expect(isMemberCurrentlySpeaking('member-a', participants, speaking)).toBe(true);
    expect(isMemberCurrentlySpeaking('member-b', participants, speaking)).toBe(true);
  });

  it('PRIVACY: a member speaking only in a voice channel this client is not joined to never resolves true — there is no participant to correlate against, because the client structurally never receives one for a channel it cannot see', () => {
    // The member panel lists someone the client can see server-wide (T13.3 presence), but that
    // person's *voice* activity is happening in a channel this client never joined — so `participants`
    // (always scoped to the one channel this client is itself in, per T3) simply never contains them,
    // regardless of what `speakingParticipantIds` might independently contain for other reasons.
    const participants: ReturnType<typeof createParticipant>[] = [];
    const speaking = new Set(['some-participant-in-a-channel-i-cannot-see']);
    expect(isMemberCurrentlySpeaking('hidden-channel-member-ref', participants, speaking)).toBe(
      false,
    );
  });

  it('returns false for an empty participants list (voice left / server switch / reconnect reset)', () => {
    expect(isMemberCurrentlySpeaking('member-a', [], new Set(['p1']))).toBe(false);
  });
});

// T13.4 (UI consistency follow-up) — `resolveParticipantAvatars`'s pure `memberRef -> avatarRef`
// correlation, the same logic `VoiceChannelView.tsx`'s `participantsWithSelf` memo calls on every
// render. Exercised here directly (not only through a full component render) so the correctness of
// the correlation itself — independent of React re-rendering — is proven in isolation.
describe('resolveParticipantAvatars (T13.4)', () => {
  it('resolves a real avatarRef when the memberRef matches an entry in members', () => {
    const avatarRef = { revision: 1, hash: 'a'.repeat(64) };
    const participants = [createParticipant({ participantId: 'p1', memberRef: 'member-a' })];
    const members = new Map([['member-a', member({ avatarRef })]]);

    const [resolved] = resolveParticipantAvatars(participants, members);
    expect(resolved?.avatarRef).toEqual(avatarRef);
  });

  it('resolves undefined (fallback) when the member has no avatar set', () => {
    const participants = [createParticipant({ participantId: 'p1', memberRef: 'member-a' })];
    const members = new Map([['member-a', member({ avatarRef: undefined })]]);

    const [resolved] = resolveParticipantAvatars(participants, members);
    expect(resolved?.avatarRef).toBeUndefined();
  });

  it('resolves undefined when the participant has no memberRef at all (e.g. a not-yet-enriched self entry)', () => {
    const participants = [createParticipant({ participantId: 'p1' })];
    const members = new Map([
      ['member-a', member({ avatarRef: { revision: 1, hash: 'a'.repeat(64) } })],
    ]);

    const [resolved] = resolveParticipantAvatars(participants, members);
    expect(resolved?.avatarRef).toBeUndefined();
  });

  it('resolves undefined when the memberRef has no corresponding members entry (never throws)', () => {
    const participants = [createParticipant({ participantId: 'p1', memberRef: 'member-ghost' })];
    expect(() => resolveParticipantAvatars(participants, new Map())).not.toThrow();
    expect(resolveParticipantAvatars(participants, new Map())[0]?.avatarRef).toBeUndefined();
  });

  it('a profile update (avatarRef change in members) is reflected live on the next call — no rejoin needed', () => {
    const participants = [createParticipant({ participantId: 'p1', memberRef: 'member-a' })];
    const avatarA = { revision: 1, hash: 'a'.repeat(64) };
    const avatarB = { revision: 2, hash: 'b'.repeat(64) };

    const firstResolved = resolveParticipantAvatars(
      participants,
      new Map([['member-a', member({ avatarRef: avatarA })]]),
    );
    expect(firstResolved[0]?.avatarRef).toEqual(avatarA);

    const secondResolved = resolveParticipantAvatars(
      participants,
      new Map([['member-a', member({ avatarRef: avatarB })]]),
    );
    expect(secondResolved[0]?.avatarRef).toEqual(avatarB);
  });

  it('avatar removal (avatarRef cleared in members) returns to fallback live, never a stale reference', () => {
    const participants = [createParticipant({ participantId: 'p1', memberRef: 'member-a' })];
    const avatarA = { revision: 1, hash: 'a'.repeat(64) };

    const withAvatar = resolveParticipantAvatars(
      participants,
      new Map([['member-a', member({ avatarRef: avatarA })]]),
    );
    expect(withAvatar[0]?.avatarRef).toEqual(avatarA);

    const afterRemoval = resolveParticipantAvatars(
      participants,
      new Map([['member-a', member({ avatarRef: undefined })]]),
    );
    expect(afterRemoval[0]?.avatarRef).toBeUndefined();
  });

  it('a changed participantId (leave/rejoin) with the same memberRef still resolves the same avatar', () => {
    const avatarRef = { revision: 1, hash: 'a'.repeat(64) };
    const members = new Map([['member-a', member({ avatarRef })]]);

    const beforeRejoin = resolveParticipantAvatars(
      [createParticipant({ participantId: 'participant-old', memberRef: 'member-a' })],
      members,
    );
    const afterRejoin = resolveParticipantAvatars(
      [createParticipant({ participantId: 'participant-new', memberRef: 'member-a' })],
      members,
    );

    expect(beforeRejoin[0]?.avatarRef).toEqual(avatarRef);
    expect(afterRejoin[0]?.avatarRef).toEqual(avatarRef);
  });

  it('multiple simultaneous sessions of the same identity resolve the exact same avatar (no per-session divergence)', () => {
    const avatarRef = { revision: 1, hash: 'a'.repeat(64) };
    const participants = [
      createParticipant({ participantId: 'p1', memberRef: 'member-a' }),
      createParticipant({ participantId: 'p2', memberRef: 'member-a' }),
    ];
    const members = new Map([['member-a', member({ avatarRef })]]);

    const resolved = resolveParticipantAvatars(participants, members);
    expect(resolved[0]?.avatarRef).toEqual(avatarRef);
    expect(resolved[1]?.avatarRef).toEqual(avatarRef);
  });

  it('Server A/B isolation: the exact same memberRef resolves independently against each server-scoped members map', () => {
    const participants = [createParticipant({ participantId: 'p1', memberRef: 'member-a' })];
    const avatarOnServerA = { revision: 1, hash: 'a'.repeat(64) };
    const avatarOnServerB = { revision: 1, hash: 'b'.repeat(64) };

    const onServerA = resolveParticipantAvatars(
      participants,
      new Map([['member-a', member({ avatarRef: avatarOnServerA })]]),
    );
    const onServerB = resolveParticipantAvatars(
      participants,
      new Map([['member-a', member({ avatarRef: avatarOnServerB })]]),
    );

    expect(onServerA[0]?.avatarRef).toEqual(avatarOnServerA);
    expect(onServerB[0]?.avatarRef).toEqual(avatarOnServerB);
  });
});
