import type { ErrorCode } from '@disco-voador/protocol';

/**
 * T13.2 — the single, centralized error-code-to-human-copy mapping for channel/voice join and
 * channel-administration failures (see `docs/tasks/T13_2_CHANNEL_ADMINISTRATION.md`'s own mapping
 * table). Every component that surfaces one of these codes to a user must go through this function
 * rather than hand-rolling its own copy — keeps the wording consistent and makes it impossible for a
 * raw protocol error code to leak into the UI verbatim.
 *
 * `CHANNEL_PASSWORD_REQUIRED` deliberately has no entry — it never produces a toast/inline error; it
 * opens the password-prompt dialog instead (see `use-voice-channel.ts`'s `channelPasswordPrompt`
 * state). `CHANNEL_PASSWORD_INVALID` also has a distinct in-dialog rendering, but is included here
 * too since the same code can, in principle, arrive outside the dialog's own lifecycle (e.g. a race).
 */
const CHANNEL_ERROR_COPY: Partial<Record<ErrorCode, string>> = {
  CHANNEL_FULL: 'This channel is full.',
  CHANNEL_ACCESS_DENIED: "You don't have permission to join this channel.",
  CHANNEL_PASSWORD_INVALID: 'Incorrect channel password.',
  CHANNEL_PASSWORD_RATE_LIMITED: 'Too many password attempts. Try again in a moment.',
  CHANNEL_NOT_FOUND: 'This channel no longer exists.',
  CHANNEL_PARENT_INVALID: "That location isn't valid for this channel.",
  CHANNEL_TREE_LIMIT_EXCEEDED: 'This server has reached its channel limit.',
  GROUP_IN_USE_BY_CHANNEL_POLICY:
    "This group is used by a channel's access policy and can't be deleted yet.",
  AUTHORIZATION_DENIED: 'You do not have permission to do that.',
};

/** Returns human-readable copy for a known channel-domain error code, or `undefined` for a code this
 * table does not cover (the caller should fall back to the server's own `message` in that case —
 * never a raw code, but a server-authored, already-human-readable string is an acceptable fallback,
 * unlike surfacing `error.code` itself). */
export function channelErrorMessage(code: ErrorCode): string | undefined {
  return CHANNEL_ERROR_COPY[code];
}

/**
 * T13.2 — the admin-modal-flavored counterpart to {@link channelErrorMessage}. The server reuses
 * `CHANNEL_ACCESS_DENIED` for both "you can't join this channel" and "you don't have Manage rights
 * for this administration action" (`handleChannelUpdate`/`handleChannelMove`/`handleChannelDelete`/
 * etc. in `services/realtime/src/protocol-handlers.ts`) — `channelErrorMessage`'s join-flavored copy
 * for that code ("You don't have permission to join this channel.") would be actively misleading in
 * an admin modal that never attempted to join anything. Every admin action
 * (`createCategory`/`createVoiceChannel`/`updateChannel`/`moveChannel`/`reorderChannels`/
 * `deleteChannel`/`setChannelPassword`/`removeChannelPassword`/`getEditableChannelNode`) should route
 * its `ChannelRequestError` through this function instead, never `channelErrorMessage` directly.
 */
export function channelManageErrorMessage(error: {
  readonly code: ErrorCode;
  readonly message: string;
}): string {
  if (error.code === 'CHANNEL_ACCESS_DENIED') {
    return "You don't have permission to manage this channel.";
  }
  return channelErrorMessage(error.code) ?? error.message;
}

/**
 * T13.2 — every admin modal's catch-block funnel: turns whatever an admin action's rejected Promise
 * threw (almost always a `ChannelRequestError` — see `use-voice-channel.ts`'s own doc comment on
 * that class — but defensively handles a plain `Error`, e.g. "Not connected."/"Disconnected before
 * the server replied.", too) into display copy via {@link channelManageErrorMessage}. Duck-types
 * `.code` rather than importing `ChannelRequestError` directly to avoid a circular import
 * (`use-voice-channel.ts` already imports from this module).
 */
export function describeChannelAdminError(error: unknown): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return channelManageErrorMessage({
      code: (error as { code: ErrorCode }).code,
      message: error.message,
    });
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}
