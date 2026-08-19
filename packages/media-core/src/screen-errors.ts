/**
 * Small, closed set of machine-readable reasons `acquireScreen` can fail for — mirrors this
 * package's existing pattern (`camera-errors.ts`, `microphone-errors.ts`) of a closed error-code
 * set at a package boundary rather than exposing a raw `DOMException` to callers.
 *
 * Deliberately independent of `camera-errors.ts` rather than a shared refactor: `getDisplayMedia()`
 * has a materially different error surface than `getUserMedia()` (see `classifyScreenErrorReason`
 * below), so a shared reason type would either miscount reasons that cannot occur for one capture
 * kind or hide the ones that only apply to the other.
 */
export type ScreenErrorReason =
  'permission-denied' | 'no-source-available' | 'capture-failed' | 'unknown';

export class ScreenAccessError extends Error {
  constructor(
    public readonly reason: ScreenErrorReason,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ScreenAccessError';
  }
}

/**
 * Classifies a `getDisplayMedia()` failure by inspecting `DOMException.name` only — never a message
 * string a platform could rephrase — and treats anything unrecognized as `'unknown'` rather than
 * guessing. Sources for this mapping:
 *
 * - The [Screen Capture specification](https://www.w3.org/TR/screen-capture/) and
 *   [MDN's `getDisplayMedia()` exceptions reference](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia#exceptions),
 *   which document `NotAllowedError`, `NotFoundError`, `NotReadableError`, `AbortError`,
 *   `InvalidStateError`, `OverconstrainedError`, and `TypeError` as the possible rejections.
 * - Electron's own `setDisplayMediaRequestHandler` test suite
 *   (`spec/api-media-handler-spec.ts`, `'does not crash when providing no streams'`, pinned at
 *   revision `main` as of 2026-08-18), which confirms that invoking the Main-process handler's
 *   callback with an empty object (`callback({})`) — Electron's documented "deny cleanly" pattern
 *   when no source is available — causes the renderer's `getDisplayMedia()` promise to reject
 *   rather than resolve. That suite asserts on the rejection and on `error.message`, not on
 *   `error.name`; Chromium's screen-capture permission/denial path (corroborated by
 *   `discuss-webrtc`/Chromium issue-tracker reports that Chrome rejects with `NotAllowedError` both
 *   when a human presses Cancel/Escape on the picker and, generally, for any denial of the capture
 *   request) uses `NotAllowedError` as its one denial code for `getDisplayMedia()` — unlike
 *   `getUserMedia()`, there is no separate "user cancelled" exception name to distinguish from "the
 *   handler simply produced no source". This function therefore maps `NotAllowedError` to
 *   `'permission-denied'` for both cases; a caller cannot and should not try to tell them apart.
 *
 * - `NotAllowedError` -> `'permission-denied'`: the user cancelled the Electron picker (or a
 *   Permissions Policy/OS-level restriction applies), or the Main-process
 *   `setDisplayMediaRequestHandler` resolved with no source — both surface identically.
 * - `NotFoundError` -> `'no-source-available'`: the Screen Capture spec's own wording — "no sources
 *   of screen video are available for capture" — a real, distinct rejection from cancellation.
 * - `NotReadableError` -> `'capture-failed'`: a source was selected, but a hardware/OS-level error
 *   or lockout prevented capture from actually starting.
 * - Anything else (`AbortError`, `InvalidStateError`, `OverconstrainedError` surviving the
 *   no-constraints fallback, `TypeError`, or an unrecognized name) -> `'unknown'`. Unlike camera,
 *   there is no `deviceId` concept and thus no literal "missing physical device" — `OverconstrainedError`
 *   is not given its own reason because `acquireScreen`'s fallback drops every constraint
 *   (`{ video: true, audio: false }`), which per spec cannot itself be overconstrained.
 */
export function classifyScreenErrorReason(error: unknown): ScreenErrorReason {
  switch (domExceptionName(error)) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'permission-denied';
    case 'NotFoundError':
      return 'no-source-available';
    case 'NotReadableError':
      return 'capture-failed';
    default:
      return 'unknown';
  }
}

function domExceptionName(error: unknown): string | undefined {
  if (error instanceof DOMException) return error.name;
  if (typeof error === 'object' && error !== null && 'name' in error) {
    const name = (error as { name: unknown }).name;
    if (typeof name === 'string') return name;
  }
  return undefined;
}

const MESSAGE_BY_REASON: Record<ScreenErrorReason, string> = {
  'permission-denied': 'Screen share access was denied or cancelled.',
  'no-source-available': 'No screen or window is available to share.',
  'capture-failed': 'The selected screen or window could not be captured.',
  unknown: 'Screen share access failed for an unknown reason.',
};

/** Wraps a raw `getDisplayMedia()` rejection into the closed, classified error this package exposes. */
export function toScreenAccessError(error: unknown): ScreenAccessError {
  const reason = classifyScreenErrorReason(error);
  return new ScreenAccessError(reason, MESSAGE_BY_REASON[reason], error);
}
