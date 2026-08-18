import { MicrophoneAccessError, toMicrophoneAccessError } from './microphone-errors.js';

export interface MicrophoneConstraints {
  readonly echoCancellation?: boolean;
  readonly noiseSuppression?: boolean;
  readonly autoGainControl?: boolean;
}

/**
 * All three default to enabled — this matches ordinary voice-chat expectations (see
 * `docs/PRODUCT.md`'s "low-latency microphone communication") and every constraint here is a bare
 * boolean, which the Media Capture and Streams specification defines as an `ideal` (not `exact`)
 * constraint: a device that cannot honor one simply captures without it rather than failing
 * `getUserMedia` outright.
 */
const DEFAULT_MICROPHONE_CONSTRAINTS: Required<MicrophoneConstraints> = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

export interface Microphone {
  readonly track: MediaStreamTrack;
  readonly stream: MediaStream;
  readonly muted: boolean;
  /** Sets `track.enabled` — never destroys/reacquires the underlying device just to mute. */
  setMuted(muted: boolean): void;
  /** Stops the underlying track(s). After this, the Microphone instance is dead — acquire a new one to resume. */
  stop(): void;
}

class MicrophoneImpl implements Microphone {
  readonly track: MediaStreamTrack;
  readonly stream: MediaStream;
  private _muted = false;
  private stopped = false;

  constructor(track: MediaStreamTrack, stream: MediaStream) {
    this.track = track;
    this.stream = stream;
  }

  get muted(): boolean {
    return this._muted;
  }

  setMuted(muted: boolean): void {
    if (this.stopped) return;
    this._muted = muted;
    this.track.enabled = !muted;
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const track of this.stream.getTracks()) track.stop();
  }
}

/**
 * Requests audio-only microphone access via `getUserMedia`. Real device/permission failures are
 * classified into a small closed set (see `microphone-errors.ts`) instead of leaking a raw
 * `DOMException` to callers.
 *
 * If the default constraints specifically cause an `OverconstrainedError`, this retries once with
 * no audio constraints at all (`{ audio: true }`) before giving up. Per spec, the bare-boolean
 * defaults above are `ideal`, not `exact`, so a spec-compliant implementation should not actually
 * reject on them — this fallback exists for a caller-supplied `exact`/stricter constraint object
 * and for platform implementations that do not follow the ideal-vs-exact distinction precisely,
 * rather than for an expected everyday failure mode.
 */
export async function acquireMicrophone(
  constraints: MicrophoneConstraints = {},
): Promise<Microphone> {
  const merged: Required<MicrophoneConstraints> = {
    ...DEFAULT_MICROPHONE_CONSTRAINTS,
    ...constraints,
  };

  const stream = await requestMicrophoneStream(merged);
  const track = stream.getAudioTracks()[0];
  if (!track) {
    for (const staleTrack of stream.getTracks()) staleTrack.stop();
    throw new MicrophoneAccessError('unknown', 'getUserMedia resolved without an audio track');
  }

  return new MicrophoneImpl(track, stream);
}

async function requestMicrophoneStream(
  constraints: Required<MicrophoneConstraints>,
): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: constraints, video: false });
  } catch (error) {
    if (!isOverconstrainedError(error)) throw toMicrophoneAccessError(error);

    try {
      return await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    } catch (fallbackError) {
      throw toMicrophoneAccessError(fallbackError);
    }
  }
}

function isOverconstrainedError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'OverconstrainedError';
}
