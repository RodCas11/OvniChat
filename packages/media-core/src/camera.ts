import { CameraAccessError, toCameraAccessError } from './camera-errors.js';

export interface CameraConstraints {
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
  /**
   * Optional — this layer never hardcodes a permanent device. T4 does not build a device-picker
   * UI, but accepting an optional `deviceId` here means one can be added later (`apps/desktop`)
   * without a capture-layer redesign.
   */
  readonly deviceId?: string;
}

/**
 * All three numeric constraints default to `ideal` (not `exact`) values, matching
 * `microphone.ts`'s existing rationale: the Media Capture and Streams specification defines a bare
 * number as an `ideal` constraint, so a device that cannot honor 1280x720@30 simply captures at
 * whatever it can rather than failing `getUserMedia` outright. 1280x720 (720p) at 30fps is a
 * reasonable default resolution/frame-rate for a voice-call camera tile — not so high it saturates
 * a P2P mesh link, not so low it looks broken on a full-size remote tile.
 */
const DEFAULT_CAMERA_CONSTRAINTS: Required<
  Pick<CameraConstraints, 'width' | 'height' | 'frameRate'>
> = {
  width: 1280,
  height: 720,
  frameRate: 30,
};

export interface Camera {
  readonly track: MediaStreamTrack;
  readonly stream: MediaStream;
  /** True once `stop()` has run — the underlying track(s) are stopped and the device released. */
  readonly stopped: boolean;
  /**
   * Stops every track on the stream, releasing the physical camera device
   * (`track.readyState === 'ended'`). Idempotent. Unlike `Microphone`, there is no mute-in-place:
   * "camera off" always fully releases the device — see `docs/tasks/T4_CAMERA_STREAMING.md`.
   */
  stop(): void;
}

class CameraImpl implements Camera {
  readonly track: MediaStreamTrack;
  readonly stream: MediaStream;
  private _stopped = false;

  constructor(track: MediaStreamTrack, stream: MediaStream) {
    this.track = track;
    this.stream = stream;
  }

  get stopped(): boolean {
    return this._stopped;
  }

  stop(): void {
    if (this._stopped) return;
    this._stopped = true;
    for (const track of this.stream.getTracks()) track.stop();
  }
}

/**
 * Requests video-only camera access via `getUserMedia`. Real device/permission failures are
 * classified into a small closed set (see `camera-errors.ts`) instead of leaking a raw
 * `DOMException` to callers.
 *
 * Deliberately never requests audio (`audio: false`, always, unconditionally) — the microphone
 * track stays owned entirely by `microphone.ts`'s independent `getUserMedia` call. Camera and
 * microphone are two independent sources with two independent tracks; this function must never be
 * the one that conflates them, even implicitly (see `docs/tasks/T4_CAMERA_STREAMING.md`).
 *
 * If the default constraints specifically cause an `OverconstrainedError`, this retries once with
 * only `deviceId` (if the caller supplied one) and no other constraints, mirroring
 * `microphone.ts`'s existing ideal-constraints-should-not-really-reject fallback rationale: per
 * spec these are `ideal`, not `exact`, so a compliant implementation should not reject on them —
 * this exists for platforms that do not honor that distinction precisely, or a future caller-
 * supplied stricter constraint. `deviceId` (an equality/selection constraint, not a quality
 * trade-off like resolution/frame-rate) is preserved across the fallback: it identifies *which*
 * device to use, not what quality to request from it, so dropping it on fallback would risk
 * capturing from the wrong camera instead of relaxing the request that actually overconstrained.
 */
export async function acquireCamera(constraints: CameraConstraints = {}): Promise<Camera> {
  const merged: Required<Pick<CameraConstraints, 'width' | 'height' | 'frameRate'>> &
    Pick<CameraConstraints, 'deviceId'> = {
    ...DEFAULT_CAMERA_CONSTRAINTS,
    ...constraints,
  };

  const stream = await requestCameraStream(merged);
  const track = stream.getVideoTracks()[0];
  if (!track) {
    for (const staleTrack of stream.getTracks()) staleTrack.stop();
    throw new CameraAccessError('unknown', 'getUserMedia resolved without a video track');
  }

  return new CameraImpl(track, stream);
}

async function requestCameraStream(
  constraints: Required<Pick<CameraConstraints, 'width' | 'height' | 'frameRate'>> &
    Pick<CameraConstraints, 'deviceId'>,
): Promise<MediaStream> {
  const { deviceId, ...idealConstraints } = constraints;
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: deviceId === undefined ? idealConstraints : { ...idealConstraints, deviceId },
      audio: false,
    });
  } catch (error) {
    if (!isOverconstrainedError(error)) throw toCameraAccessError(error);

    try {
      return await navigator.mediaDevices.getUserMedia({
        video: deviceId === undefined ? true : { deviceId },
        audio: false,
      });
    } catch (fallbackError) {
      throw toCameraAccessError(fallbackError);
    }
  }
}

function isOverconstrainedError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'OverconstrainedError';
}
