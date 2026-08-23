import type { ReactElement } from 'react';

import type { AvatarRef } from '@disco-voador/protocol';

import { Avatar, type AvatarSize } from './Avatar.js';
import { useAvatarUrl } from './use-avatar-url.js';

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
}

/** Thin wrapper over the generic `Avatar` primitive (T13.1) for a user (self or another member)'s
 * avatar — resolves `avatarRef` to a cached `data:` URI, lazily requesting it at most once per
 * distinct hash. Never forks `Avatar`'s own initials/color-fallback logic. */
export function UserAvatar({
  name,
  colorSeed,
  size,
  selected,
  avatarRef,
  avatarCache,
  onRequestAvatar,
}: UserAvatarProps): ReactElement {
  const imageUrl = useAvatarUrl(avatarRef, avatarCache, onRequestAvatar);
  return (
    <Avatar
      name={name}
      {...(colorSeed !== undefined ? { colorSeed } : {})}
      {...(size !== undefined ? { size } : {})}
      {...(selected !== undefined ? { selected } : {})}
      {...(imageUrl !== undefined ? { imageUrl } : {})}
    />
  );
}
