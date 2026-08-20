/**
 * Small, closed set of machine-readable reasons `createProcessAudioTrack` (T12 — see
 * `process-audio-track.ts`) can fail for — mirrors this package's existing pattern
 * (`camera-errors.ts`, `screen-errors.ts`) of a closed error-code set at a package boundary rather
 * than leaking an unclassified exception to callers.
 *
 * Unlike `camera-errors.ts`/`screen-errors.ts`, there is no `DOMException` from `getUserMedia`/
 * `getDisplayMedia` to classify here — every reason below originates either from this module's own
 * runtime-support check, its own PCM-to-track synthesis code, or an explicit `error` message the
 * Main-process side sent over the `MessagePort` (see the wire-contract doc comment in
 * `process-audio-track.ts`). Reasons are therefore constructed directly at each throw/reject site
 * instead of through a `classify...` mapping function.
 */
export type ProcessAudioErrorReason =
  'unsupported-runtime' | 'unsupported-format' | 'synthesis-failed' | 'source-error' | 'unknown';

export class ProcessAudioTrackError extends Error {
  constructor(
    public readonly reason: ProcessAudioErrorReason,
    message: string,
    public override readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'ProcessAudioTrackError';
  }
}
