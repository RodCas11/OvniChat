/**
 * T13.2 — every distinct channel/category administration action reachable from a context menu or
 * the Channels admin page, expressed as one discriminated union so `VoiceChannelView.tsx` can own a
 * single `channelModal`-shaped piece of state (per this task's own suggested pattern) instead of one
 * boolean/id pair per modal.
 */
export type ChannelAdminIntent =
  | { readonly type: 'create-category' }
  | { readonly type: 'create-channel'; readonly parentId?: string; readonly parentLocked: boolean }
  | { readonly type: 'edit-channel'; readonly nodeId: string }
  | { readonly type: 'edit-category'; readonly nodeId: string }
  | { readonly type: 'move-channel'; readonly nodeId: string }
  | { readonly type: 'delete-node'; readonly nodeId: string };
