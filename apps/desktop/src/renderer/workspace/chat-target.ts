/**
 * T13.1 — which chat thread the workspace is currently showing, entirely independent of voice-join
 * status (see `ChannelRow.tsx`'s own doc comment for the hard rule this exists to satisfy: a single
 * click selects/views a channel's chat and must never join its voice). Owned by `VoiceChannelView.tsx`
 * as local UI-only state, read by `ChannelSidebar.tsx` (to highlight the selected row) and
 * `MainContent.tsx`/`ChatView.tsx` (to know which thread to render) alike.
 */
export type ChatTarget =
  { readonly scope: 'server' } | { readonly scope: 'channel'; readonly channelId: string };

export function chatTargetsEqual(a: ChatTarget, b: ChatTarget): boolean {
  if (a.scope !== b.scope) return false;
  return a.scope === 'channel' && b.scope === 'channel' ? a.channelId === b.channelId : true;
}

/**
 * T13.2 — a selected channel's chat can be invalidated by something this connection had no other
 * way to observe (an admin deleted it, or a live ACL change hid it from this identity's
 * `voice:catalog` — see `ChannelNodeView`'s own "absent, never present-but-marked-hidden" privacy
 * guarantee): falls back to Server Chat rather than continuing to show a header/composer for a
 * channel that no longer exists from this connection's point of view. A pure function (rather than
 * inlined directly in `VoiceChannelView.tsx`'s effect) so this decision has direct unit coverage,
 * mirroring `chatThreadKey`/`mergeChatMessages`'s own precedent in `use-voice-channel.ts`.
 */
export function resolveChatTargetAfterCatalogUpdate(
  target: ChatTarget,
  channelIds: ReadonlySet<string>,
): ChatTarget {
  if (target.scope !== 'channel') return target;
  return channelIds.has(target.channelId) ? target : { scope: 'server' };
}
