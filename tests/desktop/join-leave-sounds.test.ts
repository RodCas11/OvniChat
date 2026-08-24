import { describe, expect, it } from 'vitest';

import { diffParticipantsForSound } from '../../apps/desktop/src/renderer/voice/join-leave-sounds.js';

/**
 * T13.4 — `diffParticipantsForSound`'s dedup semantics, exercised as pure data (no real audio
 * playback, no real voice session — per this task's own "must not require real audible speaker
 * output" testing constraint).
 */

describe('diffParticipantsForSound', () => {
  it('the first observation after a (re)join establishes a silent baseline (no sounds at all)', () => {
    const result = diffParticipantsForSound(undefined, new Set(['a', 'b', 'c']));
    expect(result).toEqual({ joined: [], left: [] });
  });

  it('a genuinely new participant after the baseline is established produces a join', () => {
    const result = diffParticipantsForSound(new Set(['a', 'b']), new Set(['a', 'b', 'c']));
    expect(result.joined).toEqual(['c']);
    expect(result.left).toEqual([]);
  });

  it('a participant departing after the baseline is established produces a leave', () => {
    const result = diffParticipantsForSound(new Set(['a', 'b', 'c']), new Set(['a', 'b']));
    expect(result.joined).toEqual([]);
    expect(result.left).toEqual(['c']);
  });

  it('simultaneous joins and leaves are both reported independently', () => {
    const result = diffParticipantsForSound(new Set(['a', 'b']), new Set(['b', 'c']));
    expect(result.joined).toEqual(['c']);
    expect(result.left).toEqual(['a']);
  });

  it('no change produces no sounds', () => {
    const result = diffParticipantsForSound(new Set(['a', 'b']), new Set(['a', 'b']));
    expect(result).toEqual({ joined: [], left: [] });
  });

  it('the room legitimately becoming empty while still known produces a leave for the last departure', () => {
    const result = diffParticipantsForSound(new Set(['a']), new Set());
    expect(result.left).toEqual(['a']);
  });

  it('a reconnect that restores the same channel (baseline reset to undefined, then the same roster) never replays a storm', () => {
    // Simulates `use-voice-channel.ts`'s own reset-to-undefined at `onReconnecting`, followed by
    // `onReconnected`'s restore `join()` delivering the same roster as before the loss.
    const roomBefore = new Set(['a', 'b', 'c']);
    // 1. Baseline established silently on first join.
    expect(diffParticipantsForSound(undefined, roomBefore)).toEqual({ joined: [], left: [] });
    // 2. Connection drops — `use-voice-channel.ts` resets its baseline ref back to `undefined`.
    // 3. Reconnected, same roster restored — this must be silent too, not a "3 people joined" storm.
    const result = diffParticipantsForSound(undefined, roomBefore);
    expect(result).toEqual({ joined: [], left: [] });
  });

  it('self is never part of this diff at all (VoiceChannelState.participants already excludes self)', () => {
    // Documents the structural guarantee this module relies on rather than re-implementing —
    // `use-voice-channel.ts` never includes the local participantId in the set it passes in here.
    const result = diffParticipantsForSound(new Set(['self-would-never-be-here']), new Set());
    expect(result.left).toEqual(['self-would-never-be-here']);
  });
});
