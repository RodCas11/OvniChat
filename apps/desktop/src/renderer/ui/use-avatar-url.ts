import { useEffect, useRef } from 'react';

import type { AvatarRef } from '@disco-voador/protocol';

/**
 * T13.3 — shared plumbing for `UserAvatar`/`ServerAvatar`: resolves `avatarRef` to an already-cached
 * `data:` URI (`avatarCache`, keyed by `AvatarRef.hash` — see `VoiceChannelState.avatarCache`'s own
 * doc comment), and fires `onRequestAvatar` at most once per distinct hash that is not yet cached.
 * Never fetches eagerly for every member at once — only whichever `UserAvatar`/`ServerAvatar`
 * instance is actually mounted (i.e. actually visible) requests its own avatar, which naturally
 * bounds this to "currently rendered rows," not the whole (potentially 1,024-member) online roster.
 */
export function useAvatarUrl(
  avatarRef: AvatarRef | undefined,
  avatarCache: ReadonlyMap<string, string>,
  onRequestAvatar: () => void,
): string | undefined {
  const requestedHashRef = useRef<string | undefined>(undefined);
  const hash = avatarRef?.hash;
  const cachedUrl = hash ? avatarCache.get(hash) : undefined;

  useEffect(() => {
    if (!hash || cachedUrl) return;
    if (requestedHashRef.current === hash) return;
    requestedHashRef.current = hash;
    onRequestAvatar();
    // `onRequestAvatar` is deliberately not a dependency here: it is expected to be a stable-enough
    // callback (a `useCallback` from `use-voice-channel.ts`), but even if a caller passed a fresh
    // closure every render, this effect intentionally keys only on `hash`/`cachedUrl` so that can
    // never cause a request storm — `requestedHashRef` alone is what prevents a duplicate request
    // for the same hash.
  }, [hash, cachedUrl]);

  return cachedUrl;
}
