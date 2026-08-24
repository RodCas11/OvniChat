import type { ReactElement } from 'react';

import type { AvatarRef } from '@disco-voador/protocol';

import { Avatar, type AvatarSize } from './Avatar.js';
import { useAvatarUrl } from './use-avatar-url.js';
import styles from './UserAvatar.module.css';

interface UserAvatarProps {
  readonly name: string;
  readonly colorSeed?: string;
  readonly size?: AvatarSize;
  readonly selected?: boolean;
  /** `undefined` means this user has no avatar set — renders the existing initials fallback,
   * exactly like omitting `Avatar`'s own `imageUrl` prop. */
  readonly avatarRef?: AvatarRef | undefined;
  readonly avatarCache: ReadonlyMap<string, string>;
  /** Calls `actions.requestAvatar('self' | 'member', memberRef)` — the caller decides which target
   * this avatar represents; this component only decides *when* to call it (once per distinct,
   * not-yet-cached `avatarRef.hash`). */
  readonly onRequestAvatar: () => void;
  /** T13.4 (UI consistency follow-up) — the single, shared speaking-ring visual treatment: a green
   * outline layered around the avatar, never replacing/hiding anything else (e.g. `MemberRow`'s own
   * presence dot, which lives on that caller's own separate wrapper, unaffected by this). Omitted
   * (`false`) by any caller with no speaking concept of its own. Defaults to `false` so every
   * existing caller — none of which passed this before it existed — is visually unaffected. */
  readonly speaking?: boolean;
  /** Applied to this component's own ring wrapper — lets a caller (e.g. `ParticipantRow`) expose a
   * stable E2E hook without reaching into `UserAvatar`'s internal structure. */
  readonly testId?: string;
}

/** Thin wrapper over the generic `Avatar` primitive (T13.1) for a user (self or another member)'s
 * avatar — resolves `avatarRef` to a cached `data:` URI, lazily requesting it at most once per
 * distinct hash, and (T13.4) applies the one shared speaking-ring treatment every consumer of a
 * *user's* avatar (as opposed to `ServerAvatar`, which has no speaking concept) should use. Never
 * forks `Avatar`'s own initials/color-fallback logic. */
export function UserAvatar({
  name,
  colorSeed,
  size,
  selected,
  avatarRef,
  avatarCache,
  onRequestAvatar,
  speaking = false,
  testId,
}: UserAvatarProps): ReactElement {
  const imageUrl = useAvatarUrl(avatarRef, avatarCache, onRequestAvatar);
  return (
    <span
      className={`${styles.ring} ${speaking ? styles.speakingRing : ''}`}
      data-testid={testId}
      data-speaking={speaking}
    >
      <Avatar
        name={name}
        {...(colorSeed !== undefined ? { colorSeed } : {})}
        {...(size !== undefined ? { size } : {})}
        {...(selected !== undefined ? { selected } : {})}
        {...(imageUrl !== undefined ? { imageUrl } : {})}
      />
    </span>
  );
}
