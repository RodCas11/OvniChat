import { ScreenAccessError, toScreenAccessError } from './screen-errors.js';

export interface ScreenConstraints {
  readonly width?: number;
  readonly height?: number;
  readonly frameRate?: number;
}

/** A named, ready-made quality/frame-rate trade-off a source-picker UI can offer a user. */
export type ScreenQualityPreset = 'standard' | 'high' | 'smooth' | 'smooth720';

/**
 * Named presets a future picker UI (built outside this package — see
 * `docs/tasks/T5_SCREEN_SHARE.md`) can reference directly instead of re-deriving numbers. All
 * three numeric fields are `ideal` (not `exact`) constraints per the Media Capture and Streams
 * specification, matching `camera.ts`'s existing rationale: a source that cannot honor a given
 * resolution/frame-rate simply captures at whatever it can rather than failing `getDisplayMedia()`
 * outright.
 */
export const SCREEN_QUALITY_PRESETS: Record<ScreenQualityPreset, Required<ScreenConstraints>> = {
  standard: { width: 1280, height: 720, frameRate: 30 },
  high: { width: 1920, height: 1080, frameRate: 30 },
  smooth: { width: 1920, height: 1080, frameRate: 60 },
  smooth720: { width: 1280, height: 720, frameRate: 60 },
};

/**
 * Default constraints when no argument is passed: 1080p/30fps ("high"). Reasonable quality for a
 * shared screen's typically text/UI-heavy content, without the sustained bitrate 60fps would demand
 * from every peer's link in a P2P mesh.
 */
const DEFAULT_SCREEN_CONSTRAINTS: Required<ScreenConstraints> = SCREEN_QUALITY_PRESETS.high;

export interface Screen {
  readonly track: MediaStreamTrack;
  /**
   * System-audio track, present only when the caller both requested audio (T6's explicit `Share
   * audio` opt-in — see `acquireScreen`) and the platform/session actually supplied one.
   * `undefined` is a normal, expected outcome — not requested, not available for this source, or
   * declined by the platform — never treated as a failure of the screen share itself (see
   * `docs/architecture/WEBRTC_SCREEN_AUDIO.md`'s "Audio is optional, video is not" section). This
   * is video-first modeling: a caller must never treat `Screen` as one opaque combined stream —
   * `track` (video) and `audioTrack` are two independent, separately observable sources sharing
   * one capture session and one `stop()` lifecycle, mirroring `ScreenCaptureSession`'s design.
   */
  readonly audioTrack: MediaStreamTrack | undefined;
  readonly stream: MediaStream;
  /** True once `stop()` has run — the underlying track(s) are stopped and capture released. */
  readonly stopped: boolean;
  /**
   * Stops every track on the stream (video and, if present, audio), releasing the OS-level
   * screen/window capture (`track.readyState === 'ended'` for both). Idempotent. Same model as
   * `Camera`, not `Microphone`: there is no mute-in-place — "screen share off" always fully
   * releases capture.
   */
  stop(): void;
}

class ScreenImpl implements Screen {
  readonly track: MediaStreamTrack;
  readonly audioTrack: MediaStreamTrack | undefined;
  readonly stream: MediaStream;
  private _stopped = false;

  constructor(
    track: MediaStreamTrack,
    audioTrack: MediaStreamTrack | undefined,
    stream: MediaStream,
  ) {
    this.track = track;
    this.audioTrack = audioTrack;
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
 * Requests screen/window video (and, optionally, system audio) via `getDisplayMedia()` — the
 * standard Web API for screen capture, distinct from `getUserMedia()`. Real failures are classified
 * into a small closed set (see `screen-errors.ts`) instead of leaking a raw `DOMException` to
 * callers.
 *
 * `shareAudio` (default `false`) is the caller's explicit intent, always traced back to a user's own
 * "Share audio" choice (see `ScreenSourcePicker.tsx`) — this function never defaults it to `true` on
 * its own. When `true`, `audio: true` is passed to `getDisplayMedia()`, which on this app's Windows-
 * only target is fulfilled by Electron Main's `setDisplayMediaRequestHandler` resolving with
 * `audio: 'loopback'` (system audio capture — see `docs/architecture/WEBRTC_SCREEN_AUDIO.md` for the
 * researched platform mechanism and why the legacy `chromeMediaSource` constraint form is not used).
 * Requesting audio never turns a failure to supply it into a rejection of the whole call: whether
 * Main actually included an audio track is read back from the resolved stream after the fact
 * (`stream.getAudioTracks()[0]`, `undefined` if absent) — video-only screen sharing remains fully
 * supported and unaffected by audio's availability either way.
 *
 * This function has no notion of *which* screen or window is captured. Unlike `acquireCamera`,
 * there is no `deviceId`-equivalent parameter: source selection happens entirely on the Electron
 * Main-process side via `session.setDisplayMediaRequestHandler()`, which fulfills whatever
 * `getDisplayMedia()` call this function makes. This function only supplies quality constraints and
 * returns whatever stream Electron's Main-process handler resolves it with.
 *
 * If the default constraints specifically cause an `OverconstrainedError`, this retries once with
 * `{ video: true, audio: shareAudio }` — no quality constraints at all, `shareAudio` preserved
 * across the fallback (unlike `deviceId` for camera, which has no equivalent here at all, source
 * selection is not a constraint on this call).
 */
export async function acquireScreen(
  constraints: ScreenConstraints = {},
  shareAudio = false,
): Promise<Screen> {
  const merged: Required<ScreenConstraints> = { ...DEFAULT_SCREEN_CONSTRAINTS, ...constraints };

  const stream = await requestScreenStream(merged, shareAudio);
  const track = stream.getVideoTracks()[0];
  if (!track) {
    for (const staleTrack of stream.getTracks()) staleTrack.stop();
    throw new ScreenAccessError('unknown', 'getDisplayMedia resolved without a video track');
  }

  // The WebRTC/Media Capture content-hint guidance recommends 'detail' for screen/desktop capture:
  // it favors sharp edges and consistent color over smooth motion, matching typical screen-share
  // content (text, UI, slides) rather than the 'motion' hint appropriate for a camera feed.
  track.contentHint = 'detail';

  const audioTrack = stream.getAudioTracks()[0];
  return new ScreenImpl(track, audioTrack, stream);
}

async function requestScreenStream(
  constraints: Required<ScreenConstraints>,
  shareAudio: boolean,
): Promise<MediaStream> {
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video: constraints, audio: shareAudio });
  } catch (error) {
    if (!isOverconstrainedError(error)) throw toScreenAccessError(error);

    try {
      return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: shareAudio });
    } catch (fallbackError) {
      throw toScreenAccessError(fallbackError);
    }
  }
}

function isOverconstrainedError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'OverconstrainedError';
}
