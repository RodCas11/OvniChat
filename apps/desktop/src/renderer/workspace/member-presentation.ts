import type { AvatarRef, EffectivePresence, MemberRoleBucket } from '@disco-voador/protocol';

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
