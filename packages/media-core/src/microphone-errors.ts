/**
 * Small, closed set of machine-readable reasons `acquireMicrophone` can fail for — mirrors this
 * repository's existing pattern of a closed error-code set at a package boundary (see
 * `packages/protocol/src/errors.ts`) rather than exposing a raw `DOMException` to callers, who
 * should not need to know Web-platform error-name spelling to decide how to react (e.g. show a
 * permission prompt vs. a "no microphone found" message).
 */
export type MicrophoneErrorReason =
  'permission-denied' | 'device-not-found' | 'device-unavailable' | 'unknown';

export class MicrophoneAccessError extends Error {
  constructor(
    public readonly reason: MicrophoneErrorReason,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'MicrophoneAccessError';
  }
}

/**
 * Classifies a `getUserMedia` failure by inspecting `DOMException.name` (see the Media Capture and
 * Streams specification's `getUserMedia()` "Exceptions" table and MDN's `getUserMedia()` error
 * reference). Deliberately reads only `.name` — never a message string a platform could rephrase —
 * and treats anything it does not recognize as `'unknown'` rather than guessing.
 *
 * - `NotAllowedError` / `PermissionDeniedError` (legacy name) -> `'permission-denied'`: the user or
 *   the OS/Electron permission handler refused microphone access.
 * - `NotFoundError` / `OverconstrainedError` -> `'device-not-found'`: no device matches what was
 *   requested — no microphone exists, or (for `OverconstrainedError`) no device can satisfy a
 *   constraint declared `exact`.
 * - `NotReadableError` / `TrackStartError` (legacy name) -> `'device-unavailable'`: a matching
 *   device exists but the platform could not actually start capturing from it (already in use by
 *   another application, a driver-level failure, etc.).
 * - Anything else -> `'unknown'`.
 */
export function classifyMicrophoneErrorReason(error: unknown): MicrophoneErrorReason {
  switch (domExceptionName(error)) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
      return 'permission-denied';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'device-not-found';
    case 'NotReadableError':
    case 'TrackStartError':
      return 'device-unavailable';
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

const MESSAGE_BY_REASON: Record<MicrophoneErrorReason, string> = {
  'permission-denied': 'Microphone access was denied.',
  'device-not-found': 'No microphone device is available.',
  'device-unavailable': 'The microphone device could not be started.',
  unknown: 'Microphone access failed for an unknown reason.',
};

/** Wraps a raw `getUserMedia` rejection into the closed, classified error this package exposes. */
export function toMicrophoneAccessError(error: unknown): MicrophoneAccessError {
  const reason = classifyMicrophoneErrorReason(error);
  return new MicrophoneAccessError(reason, MESSAGE_BY_REASON[reason], error);
}
