import type { ReactElement } from 'react';

import type { AvatarRef } from '@disco-voador/protocol';

import { Avatar, type AvatarSize } from './Avatar.js';
import { useAvatarUrl } from './use-avatar-url.js';

interface ServerAvatarProps {
  readonly serverName: string;
  readonly size?: AvatarSize;
  readonly shape?: 'circle' | 'square';
  readonly selected?: boolean;
  /** `undefined` means this server has no avatar set. */
  readonly avatarRef?: AvatarRef | undefined;
  readonly avatarCache: ReadonlyMap<string, string>;
  /** Calls `actions.requestAvatar('server')`. */
  readonly onRequestAvatar: () => void;
}

/** Thin wrapper over the generic `Avatar` primitive (T13.1) for the connected Dedicated Server's own
 * avatar — mirrors `UserAvatar` exactly, keyed by server name/id for the initials/color fallback
 * instead of a member's display name. */
export function ServerAvatar({
  serverName,
  size,
  shape,
  selected,
  avatarRef,
  avatarCache,
  onRequestAvatar,
}: ServerAvatarProps): ReactElement {
  const imageUrl = useAvatarUrl(avatarRef, avatarCache, onRequestAvatar);
  return (
    <Avatar
      name={serverName}
      {...(size !== undefined ? { size } : {})}
      {...(shape !== undefined ? { shape } : {})}
      {...(selected !== undefined ? { selected } : {})}
      {...(imageUrl !== undefined ? { imageUrl } : {})}
    />
  );
}
