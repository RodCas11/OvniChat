import { MAX_CHANNEL_PARTICIPANTS } from '@disco-voador/protocol';
import { describe, expect, it } from 'vitest';

import { VoiceRegistry } from '../../services/realtime/src/voice/registry.js';

function registry(): VoiceRegistry {
  return new VoiceRegistry();
}

describe('VoiceRegistry.join', () => {
  it('joining an empty channel returns no existing participants', () => {
    const outcome = registry().join(
      'conn-a',
      'general',
      'Rodrigo',
      'identity-a',
      MAX_CHANNEL_PARTICIPANTS,
    );
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.existingParticipants).toEqual([]);
      expect(outcome.existingMemberConnectionIds).toEqual([]);
      expect(outcome.previous).toBeUndefined();
    }
  });

  it('joining a populated channel returns the existing participants and their connection ids', () => {
    const r = registry();
    r.join('conn-a', 'general', 'Rodrigo', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    const outcome = r.join('conn-b', 'general', 'Arthur', 'identity-b', MAX_CHANNEL_PARTICIPANTS);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      // T9: existingParticipants now carries the full server-side record (including identityId,
      // never sent on the wire directly — see registry.ts's own doc comment), so this checks a
      // subset rather than an exact shape.
      expect(outcome.existingParticipants).toMatchObject([
        { participantId: expect.any(String) as unknown as string, displayName: 'Rodrigo' },
      ]);
      expect(outcome.existingMemberConnectionIds).toEqual(['conn-a']);
    }
  });

  it('assigns unique participant ids per join, server-side, never client-controlled', () => {
    const r = registry();
    const a = r.join('conn-a', 'general', 'Same Name', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    const b = r.join('conn-b', 'general', 'Same Name', 'identity-b', MAX_CHANNEL_PARTICIPANTS);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      expect(a.participantId).not.toBe(b.participantId);
    }
  });

  it('a single connection is never in two channels at once (re-join replaces membership)', () => {
    const r = registry();
    r.join('conn-a', 'general', 'Rodrigo', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    const outcome = r.join('conn-a', 'games', 'Rodrigo', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.previous).toMatchObject({ channelId: 'general' });
    }
    // No longer resolvable as a signaling target in "general".
    r.join('conn-b', 'general', 'Someone', 'identity-b', MAX_CHANNEL_PARTICIPANTS);
    const resolved = r.resolveSignalingTarget('conn-b', outcome.ok ? outcome.participantId : '');
    expect(resolved).toMatchObject({ ok: false, code: 'SIGNALING_TARGET_INVALID' });
  });

  it('a duplicate join to the same channel is treated as a clean re-join (no ghost duplicate self-entry)', () => {
    const r = registry();
    const first = r.join('conn-a', 'general', 'Rodrigo', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    const second = r.join('conn-a', 'general', 'Rodrigo', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      // Re-joining the same channel should not see itself as an "existing participant".
      expect(second.existingParticipants).toEqual([]);
      expect(second.previous).toMatchObject({
        channelId: 'general',
        participantId: first.participantId,
      });
    }
  });

  it('participants in different channels are isolated from each other', () => {
    const r = registry();
    r.join('conn-a', 'general', 'A', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    const outcome = r.join('conn-b', 'games', 'B', 'identity-b', MAX_CHANNEL_PARTICIPANTS);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.existingParticipants).toEqual([]);
    }
  });

  it(`rejects the ${String(MAX_CHANNEL_PARTICIPANTS + 1)}th join to a full channel`, () => {
    const r = registry();
    for (let i = 0; i < MAX_CHANNEL_PARTICIPANTS; i += 1) {
      const outcome = r.join(
        `conn-${String(i)}`,
        'general',
        `Member ${String(i)}`,
        `identity-${String(i)}`,
        MAX_CHANNEL_PARTICIPANTS,
      );
      expect(outcome.ok).toBe(true);
    }

    const overflow = r.join(
      'conn-overflow',
      'general',
      'One Too Many',
      'identity-overflow',
      MAX_CHANNEL_PARTICIPANTS,
    );
    expect(overflow).toMatchObject({ ok: false, code: 'CHANNEL_FULL' });
  });

  it('a full channel still accepts a re-join from an existing member (not a net-new slot)', () => {
    const r = registry();
    for (let i = 0; i < MAX_CHANNEL_PARTICIPANTS; i += 1) {
      r.join(
        `conn-${String(i)}`,
        'general',
        `Member ${String(i)}`,
        `identity-${String(i)}`,
        MAX_CHANNEL_PARTICIPANTS,
      );
    }

    const rejoin = r.join(
      'conn-0',
      'general',
      'Member 0 again',
      'identity-0',
      MAX_CHANNEL_PARTICIPANTS,
    );
    expect(rejoin.ok).toBe(true);
  });

  it('a full channel rejects a connection switching in from a different channel (its old membership does not count toward the new channel)', () => {
    const r = registry();
    for (let i = 0; i < MAX_CHANNEL_PARTICIPANTS; i += 1) {
      r.join(
        `conn-${String(i)}`,
        'general',
        `Member ${String(i)}`,
        `identity-${String(i)}`,
        MAX_CHANNEL_PARTICIPANTS,
      );
    }
    r.join('conn-switcher', 'games', 'Switcher', 'identity-switcher', MAX_CHANNEL_PARTICIPANTS);

    const switched = r.join(
      'conn-switcher',
      'general',
      'Switcher',
      'identity-switcher',
      MAX_CHANNEL_PARTICIPANTS,
    );
    expect(switched).toMatchObject({ ok: false, code: 'CHANNEL_FULL' });
    // Still a member of "games" — the rejected switch did not leave it.
    expect(r.getParticipant('conn-switcher')).toMatchObject({ channelId: 'games' });
  });

  it('T13.2: capacityLimit is caller-supplied per join, not a single global constant', () => {
    const r = registry();
    expect(r.join('conn-a', 'small-room', 'A', 'identity-a', 2).ok).toBe(true);
    expect(r.join('conn-b', 'small-room', 'B', 'identity-b', 2).ok).toBe(true);
    expect(r.join('conn-c', 'small-room', 'C', 'identity-c', 2)).toMatchObject({
      ok: false,
      code: 'CHANNEL_FULL',
    });
    // A different channel with a higher limit is unaffected.
    expect(r.join('conn-d', 'big-room', 'D', 'identity-d', 10).ok).toBe(true);
  });

  it('T13.2: someone already a member is never blocked by a newly-lowered limit', () => {
    const r = registry();
    r.join('conn-a', 'shrinking-room', 'A', 'identity-a', 5);
    r.join('conn-b', 'shrinking-room', 'B', 'identity-b', 5);
    // The limit is now lowered to 1, below current occupancy (2) — re-joining as an existing
    // member must still succeed (the `alreadyMember` exemption).
    const rejoin = r.join('conn-a', 'shrinking-room', 'A', 'identity-a', 1);
    expect(rejoin.ok).toBe(true);
    // A brand-new join against the same lowered limit is correctly rejected.
    const newcomer = r.join('conn-c', 'shrinking-room', 'C', 'identity-c', 1);
    expect(newcomer).toMatchObject({ ok: false, code: 'CHANNEL_FULL' });
  });
});

describe('VoiceRegistry.leave', () => {
  it('leaving returns the channel/participant and remaining members', () => {
    const r = registry();
    r.join('conn-a', 'general', 'A', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    r.join('conn-b', 'general', 'B', 'identity-b', MAX_CHANNEL_PARTICIPANTS);

    const left = r.leave('conn-a');
    expect(left).toMatchObject({ channelId: 'general' });
    expect(left?.remainingMemberConnectionIds).toEqual(['conn-b']);
  });

  it('leaving when not in any channel returns undefined', () => {
    expect(registry().leave('conn-a')).toBeUndefined();
  });

  it('leaving twice in a row is safe (second call is a no-op)', () => {
    const r = registry();
    r.join('conn-a', 'general', 'A', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    expect(r.leave('conn-a')).toBeDefined();
    expect(r.leave('conn-a')).toBeUndefined();
  });

  it('disconnect cleanup uses the same leave() path and removes the participant entirely', () => {
    const r = registry();
    r.join('conn-a', 'general', 'A', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    r.leave('conn-a'); // simulates Connection's cleanupVoiceMembership on socket close
    expect(r.getParticipant('conn-a')).toBeUndefined();
  });
});

describe('VoiceRegistry.resolveSignalingTarget', () => {
  it('resolves a target in the same channel', () => {
    const r = registry();
    r.join('conn-a', 'general', 'A', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    const b = r.join('conn-b', 'general', 'B', 'identity-b', MAX_CHANNEL_PARTICIPANTS);
    if (!b.ok) throw new Error('setup failed');

    const resolved = r.resolveSignalingTarget('conn-a', b.participantId);
    expect(resolved).toMatchObject({ ok: true, targetConnectionId: 'conn-b' });
  });

  it('rejects when the sender is not in any channel', () => {
    const resolved = registry().resolveSignalingTarget('conn-a', 'whoever');
    expect(resolved).toMatchObject({ ok: false, code: 'NOT_IN_VOICE_CHANNEL' });
  });

  it('rejects when the target is in a different channel', () => {
    const r = registry();
    r.join('conn-a', 'general', 'A', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    const c = r.join('conn-c', 'games', 'C', 'identity-c', MAX_CHANNEL_PARTICIPANTS);
    if (!c.ok) throw new Error('setup failed');

    const resolved = r.resolveSignalingTarget('conn-a', c.participantId);
    expect(resolved).toMatchObject({ ok: false, code: 'SIGNALING_TARGET_INVALID' });
  });

  it('rejects when the target participant id does not exist at all', () => {
    const r = registry();
    r.join('conn-a', 'general', 'A', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    const resolved = r.resolveSignalingTarget('conn-a', 'nonexistent-participant');
    expect(resolved).toMatchObject({ ok: false, code: 'SIGNALING_TARGET_INVALID' });
  });

  it('a participant cannot resolve itself as a signaling target', () => {
    const r = registry();
    const a = r.join('conn-a', 'general', 'A', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    if (!a.ok) throw new Error('setup failed');
    const resolved = r.resolveSignalingTarget('conn-a', a.participantId);
    expect(resolved).toMatchObject({ ok: false, code: 'SIGNALING_TARGET_INVALID' });
  });
});
