import type {
  AvatarRef,
  EffectivePresence,
  MemberPresence,
  MemberRoleBucket,
} from '@disco-voador/protocol';

import type { VoiceParticipantView } from '../voice/use-voice-channel.js';

/**
 * T13.3 — one row's worth of real, already-resolved presentation data for the redesigned
 * `MemberPanel`/`MemberRow`/member-profile-popover surfaces. Built by `VoiceChannelView.tsx` from
 * `VoiceChannelState.members` (server-wide presence, T13.3) plus one synthesized self entry — never
 * fabricated: every field here traces back to a real `MemberPresence` the server broadcast, or (for
 * `isSelf`) this connection's own `server:profile-self-updated`-sourced state.
 */
export interface MemberPanelEntry {
  /** `memberRef` for another member, or the literal `'self'` for the local user — `memberRef` is
   * session-scoped and reassigned on reconnect (see `packages/protocol/src/profile.ts`'s own doc
   * comment), so this is only ever used as a React list key / popover-target correlation, never
   * persisted. */
  readonly key: string;
  readonly displayName: string;
  readonly isSelf: boolean;
  readonly presence: EffectivePresence;
  readonly customStatus: string | undefined;
  /** The real `AvatarRef` this member/self currently has, if any — passed straight through to
   * `UserAvatar`, which resolves it against `VoiceChannelState.avatarCache` itself; never resolved
   * to a `data:` URI here (that would duplicate `UserAvatar`'s own cache-lookup/lazy-fetch logic). */
  readonly avatarRef: AvatarRef | undefined;
  readonly roleBucket: MemberRoleBucket | undefined;
  /** Only ever `true` for another member, when this connection holds `moderation.profile.clear` —
   * self can never be its own moderation target, and `MemberPanel`/the popover must never rely on
   * anything else to decide whether to show a clear-avatar/clear-status action. */
  readonly canModerate: boolean;
  /** T13.4 (UI consistency follow-up) — real, currently-transmitted speech only, reusing the exact
   * same `state.speakingParticipantIds`/`state.selfSpeaking` source `ParticipantRow` already uses —
   * never a second speaking detector. `false` (never fabricated `true`) whenever this member has no
   * safely-correlatable, currently-visible voice participant: the local client only ever learns
   * `state.participants`/`state.speakingParticipantIds` for the *one* voice channel it is itself
   * currently joined to (T3: a connection belongs to zero or one voice channel), so a member speaking
   * in a channel this client is not part of structurally never reaches this field at all — this is
   * not a filter this code has to apply, it is a fact about what data ever exists to correlate
   * against. See `VoiceChannelView.tsx`'s `memberPanelEntries` for exactly how this is derived. */
  readonly isSpeaking: boolean;
}

export interface MemberGroup {
  readonly label: string;
  readonly members: readonly MemberPanelEntry[];
}

const BUCKET_LABEL: Record<MemberRoleBucket, string> = {
  admin: 'Admins',
  moderator: 'Moderators',
};

/**
 * Groups `entries` into "Admins" / "Moderators" / "Members" buckets by `roleBucket`, skipping any
 * bucket with zero members, and skipping the bucket header/grouping entirely (falling back to one
 * flat "Members" list) when *no* entry has a `roleBucket` at all — mirrors `MemberPanel.tsx`'s own
 * pre-T13.3 `hasRealGroups` fallback logic exactly, now driven by real presence data instead of a
 * prop's mere presence.
 */
export function buildMemberGroups(entries: readonly MemberPanelEntry[]): {
  readonly groups: readonly MemberGroup[];
  readonly hasRealGroups: boolean;
} {
  const hasRealGroups = entries.some((entry) => entry.roleBucket !== undefined);
  if (!hasRealGroups) {
    return {
      groups: entries.length > 0 ? [{ label: 'Members', members: entries }] : [],
      hasRealGroups: false,
    };
  }

  const admins = entries.filter((entry) => entry.roleBucket === 'admin');
  const moderators = entries.filter((entry) => entry.roleBucket === 'moderator');
  const plainMembers = entries.filter((entry) => entry.roleBucket === undefined);

  const groups: MemberGroup[] = [];
  if (admins.length > 0) groups.push({ label: BUCKET_LABEL.admin, members: admins });
  if (moderators.length > 0) groups.push({ label: BUCKET_LABEL.moderator, members: moderators });
  if (plainMembers.length > 0) groups.push({ label: 'Members', members: plainMembers });
  return { groups, hasRealGroups: true };
}

/**
 * T13.4 (UI consistency follow-up) — `true` iff at least one currently-known voice participant
 * (`participants` — always scoped to the *one* voice channel this client is itself currently joined
 * to, per T3's "zero or one voice channel" rule) both belongs to this `memberRef` and is in
 * `speakingParticipantIds` (`state.speakingParticipantIds`, populated only by
 * `remote-audio-graph.ts`'s real `AnalyserNode` detection — never fabricated here). `.some(...)`
 * rather than a single lookup deliberately covers T13.3's multiple-simultaneous-connections-per-
 * identity case: if more than one of this member's own sessions is in the channel, any one of them
 * speaking is enough. Returns `false` — never throws, never guesses — for a member with no matching
 * participant at all, which is also exactly what happens for a member speaking in a *different*
 * voice channel this client cannot see: `participants` structurally never contains them, so there is
 * nothing to leak, not merely something this function declines to show.
 */
/**
 * T13.4 (UI consistency follow-up) — resolves each participant's real server-local `avatarRef` by
 * looking their `memberRef` up in `members` (the exact same T13.3 presence map Member Panel already
 * reads `avatarRef` from — never a second, voice-specific avatar system). Pure, so
 * `VoiceChannelView.tsx`'s own memo and this module's own tests share one implementation. A
 * participant with no `memberRef` (the synthesized local-self entry, which resolves its own avatar
 * from `state.selfAvatarRef` directly instead — see `VoiceParticipantView.avatarRef`'s own doc
 * comment) or whose `memberRef` has no corresponding `members` entry (should not happen for a real
 * online participant, but never throws either way) resolves to `undefined` — the ordinary "no
 * avatar" fallback, never a stale reference. Because this looks up fresh from `members` on every
 * call, the exact same participant automatically gets the exact same avatar after a `participantId`
 * change (leave/rejoin) or across multiple simultaneous sessions of one identity, and never carries
 * a `members` entry from a different server scope forward (a genuine server switch always resets
 * `members` to a fresh, empty map first — see `use-voice-channel.ts`'s own connection-teardown reset).
 */
export function resolveParticipantAvatars(
  participants: readonly VoiceParticipantView[],
  members: ReadonlyMap<string, MemberPresence>,
): readonly VoiceParticipantView[] {
  return participants.map((participant) => ({
    ...participant,
    avatarRef: participant.memberRef ? members.get(participant.memberRef)?.avatarRef : undefined,
  }));
}

export function isMemberCurrentlySpeaking(
  memberRef: string,
  participants: readonly VoiceParticipantView[],
  speakingParticipantIds: ReadonlySet<string>,
): boolean {
  return participants.some(
    (participant) =>
      participant.memberRef === memberRef && speakingParticipantIds.has(participant.participantId),
  );
}
