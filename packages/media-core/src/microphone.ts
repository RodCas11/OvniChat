import { MicrophoneAccessError, toMicrophoneAccessError } from './microphone-errors.js';

export interface MicrophoneConstraints {
  readonly echoCancellation?: boolean;
  readonly noiseSuppression?: boolean;
  readonly autoGainControl?: boolean;
  /**
   * Optional — mirrors `CameraConstraints.deviceId` (`camera.ts`): this layer never hardcodes a
   * permanent device, but accepting one here lets a device-picker caller (T11) select a specific
   * microphone, including switching to a different one mid-session (see `rtc-core`'s
   * `MediaTransport.replaceTrack`), without a capture-layer redesign.
   */
  readonly deviceId?: string;
}

/**
 * All three processing constraints default to enabled — this matches ordinary voice-chat
 * expectations (see `docs/PRODUCT.md`'s "low-latency microphone communication") and every
 * constraint here is a bare boolean, which the Media Capture and Streams specification defines as
 * an `ideal` (not `exact`) constraint: a device that cannot honor one simply captures without it
 * rather than failing `getUserMedia` outright. `deviceId` has no default (see `requestMicrophoneStream`).
 */
const DEFAULT_MICROPHONE_CONSTRAINTS: Required<
  Pick<MicrophoneConstraints, 'echoCancellation' | 'noiseSuppression' | 'autoGainControl'>
> = {
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
 * only `deviceId` (if the caller supplied one) and no other constraints, mirroring `camera.ts`'s
 * `acquireCamera` fallback exactly. Per spec, the bare-boolean processing defaults above are
 * `ideal`, not `exact`, so a spec-compliant implementation should not actually reject on them —
 * this fallback exists for a caller-supplied `exact`/stricter constraint object and for platform
 * implementations that do not follow the ideal-vs-exact distinction precisely, rather than for an
 * expected everyday failure mode.
 *
 * **`deviceId` is preserved across the fallback** — this was not always true: before T11 added
 * `deviceId` to this function at all, the fallback dropped every constraint unconditionally
 * (`{ audio: true }`), which was fine when there was no `deviceId` to lose. Now that `deviceId`
 * exists here, the same reasoning `camera.ts` already documents applies identically: `deviceId` is
 * an equality/selection constraint, not a quality trade-off like echo cancellation or noise
 * suppression, so dropping it on fallback would risk capturing from the wrong microphone instead of
 * just relaxing the request that actually overconstrained.
 */
export async function acquireMicrophone(
  constraints: MicrophoneConstraints = {},
): Promise<Microphone> {
  const merged: Required<
    Pick<MicrophoneConstraints, 'echoCancellation' | 'noiseSuppression' | 'autoGainControl'>
  > &
    Pick<MicrophoneConstraints, 'deviceId'> = {
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
  constraints: Required<
    Pick<MicrophoneConstraints, 'echoCancellation' | 'noiseSuppression' | 'autoGainControl'>
  > &
    Pick<MicrophoneConstraints, 'deviceId'>,
): Promise<MediaStream> {
  const { deviceId, ...idealConstraints } = constraints;
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: deviceId === undefined ? idealConstraints : { ...idealConstraints, deviceId },
      video: false,
    });
  } catch (error) {
    if (!isOverconstrainedError(error)) throw toMicrophoneAccessError(error);

    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: deviceId === undefined ? true : { deviceId },
        video: false,
      });
    } catch (fallbackError) {
      throw toMicrophoneAccessError(fallbackError);
    }
  }
}

function isOverconstrainedError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'OverconstrainedError';
}
