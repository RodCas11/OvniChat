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
