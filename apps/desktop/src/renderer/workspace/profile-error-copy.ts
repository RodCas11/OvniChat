import type { ErrorCode } from '@disco-voador/protocol';

/**
 * T13.3 — the single, centralized error-code-to-human-copy mapping for profile/avatar/presence
 * mutation failures, mirroring `channel-error-copy.ts`'s own exact pattern (a `Partial<Record<...>>`
 * table plus one lookup function) — every profile-mutation call site must go through this rather
 * than hand-rolling its own copy, so a raw protocol error code never leaks into the UI verbatim.
 *
 * `MEMBER_NOT_FOUND` deliberately has **no** entry here for the avatar-fetch (`requestAvatar`) path
 * — a `memberRef` naming a currently-offline/unknown member, or a target with no avatar currently
 * set, is a normal, silent "nothing to show" case (initials fallback), never a visible error (see
 * `use-voice-channel.ts`'s own avatar-request handling). The entry below is only ever reached for a
 * *mutation* (e.g. a moderator's clear action) targeting a member who just went offline mid-action —
 * a real, if rare, failure worth surfacing there.
 */
const PROFILE_ERROR_COPY: Partial<Record<ErrorCode, string>> = {
  AVATAR_TOO_LARGE: 'That image is too large for an avatar.',
  AVATAR_INVALID_FORMAT: 'Only PNG, JPEG, or WebP images can be used as an avatar.',
  AVATAR_DIMENSIONS_TOO_LARGE: 'That image is too large — try a smaller picture.',
  AVATAR_ANIMATED_NOT_ALLOWED: "Animated images aren't allowed for an avatar.",
  CUSTOM_STATUS_TOO_LONG: 'That status is too long.',
  PROFILE_RATE_LIMITED: 'Too many profile changes. Try again in a moment.',
  MEMBER_NOT_FOUND: 'That member is no longer online.',
  AUTHORIZATION_DENIED: 'You do not have permission to do that.',
};

/** Returns human-readable copy for a known profile-domain error code, or `undefined` for a code this
 * table does not cover (the caller should fall back to the server's own `message` in that case). */
export function profileErrorMessage(code: ErrorCode): string | undefined {
  return PROFILE_ERROR_COPY[code];
}

/** The catch-block funnel every profile-mutation call site should use — mirrors
 * `channel-error-copy.ts`'s `describeChannelAdminError` exactly, duck-typing `.code` to avoid a
 * circular import with `use-voice-channel.ts` (which defines `ProfileRequestError`). */
export function describeProfileError(error: unknown): string {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    const code = (error as { code: ErrorCode }).code;
    return profileErrorMessage(code) ?? error.message;
  }
  return error instanceof Error ? error.message : 'Something went wrong.';
}
