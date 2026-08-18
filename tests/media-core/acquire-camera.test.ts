import { afterEach, describe, expect, it, vi } from 'vitest';

import { acquireCamera } from '../../packages/media-core/src/camera.js';
import { CameraAccessError } from '../../packages/media-core/src/camera-errors.js';

/**
 * `getUserMedia` is a platform (Chromium/Electron Renderer) capability with no real implementation
 * under Node — these tests stub `navigator.mediaDevices.getUserMedia` to exercise this package's
 * own orchestration (constraint defaulting, fallback-on-overconstrained, track/stream wiring, the
 * full-stop-releases-the-device lifecycle, error classification wiring) deterministically. They do
 * not, and cannot, prove a real camera is captured or that real browser constraint negotiation
 * succeeds — see the T3 microphone report for what that would require of a real Electron runtime,
 * which applies identically here.
 */

function fakeVideoTrack(overrides: Partial<MediaStreamTrack> = {}): MediaStreamTrack {
  const track = {
    id: 'track-1',
    kind: 'video',
    enabled: true,
    readyState: 'live' as MediaStreamTrackState,
    stop: vi.fn(function (this: { readyState: MediaStreamTrackState }) {
      this.readyState = 'ended';
    }),
    ...overrides,
  } as unknown as MediaStreamTrack;
  return track;
}

function fakeStream(tracks: MediaStreamTrack[]): MediaStream {
  return {
    getVideoTracks: () => tracks,
    getTracks: () => tracks,
  } as unknown as MediaStream;
}

function stubGetUserMedia(
  impl: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
): void {
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: vi.fn(impl) } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('acquireCamera — default constraints', () => {
  it('requests video-only access with the 720p/30fps ideal defaults and never requests audio', async () => {
    const track = fakeVideoTrack();
    let seenConstraints: MediaStreamConstraints | undefined;
    stubGetUserMedia((constraints) => {
      seenConstraints = constraints;
      return Promise.resolve(fakeStream([track]));
    });

    await acquireCamera();

    expect(seenConstraints).toEqual({
      video: { width: 1280, height: 720, frameRate: 30 },
      audio: false,
    });
  });

  it('lets a caller override individual constraints without losing the others', async () => {
    const track = fakeVideoTrack();
    let seenConstraints: MediaStreamConstraints | undefined;
    stubGetUserMedia((constraints) => {
      seenConstraints = constraints;
      return Promise.resolve(fakeStream([track]));
    });

    await acquireCamera({ frameRate: 15 });

    expect(seenConstraints).toEqual({
      video: { width: 1280, height: 720, frameRate: 15 },
      audio: false,
    });
  });

  it('includes an explicit deviceId in the request when provided', async () => {
    const track = fakeVideoTrack();
    let seenConstraints: MediaStreamConstraints | undefined;
    stubGetUserMedia((constraints) => {
      seenConstraints = constraints;
      return Promise.resolve(fakeStream([track]));
    });

    await acquireCamera({ deviceId: 'device-42' });

    expect(seenConstraints).toEqual({
      video: { width: 1280, height: 720, frameRate: 30, deviceId: 'device-42' },
      audio: false,
    });
  });
});

describe('acquireCamera — the returned Camera', () => {
  it('exposes the acquired track and stream', async () => {
    const track = fakeVideoTrack();
    const stream = fakeStream([track]);
    stubGetUserMedia(() => Promise.resolve(stream));

    const camera = await acquireCamera();

    expect(camera.track).toBe(track);
    expect(camera.stream).toBe(stream);
    expect(camera.stopped).toBe(false);
  });

  it('stop() stops every track in the stream, releasing the device (readyState "ended")', async () => {
    const track = fakeVideoTrack();
    stubGetUserMedia(() => Promise.resolve(fakeStream([track])));
    const camera = await acquireCamera();

    camera.stop();

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(track.readyState).toBe('ended');
    expect(camera.stopped).toBe(true);
  });

  it('stop() is idempotent — a second call never re-stops the track', async () => {
    const track = fakeVideoTrack();
    stubGetUserMedia(() => Promise.resolve(fakeStream([track])));
    const camera = await acquireCamera();

    camera.stop();
    camera.stop();
    camera.stop();

    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('stop() stops every track when the stream carries more than one', async () => {
    const trackA = fakeVideoTrack({ id: 'a' });
    const trackB = fakeVideoTrack({ id: 'b' });
    stubGetUserMedia(() => Promise.resolve(fakeStream([trackA])));
    const camera = await acquireCamera();
    // Simulate a stream that (unusually) carries more than one track by stubbing getTracks after
    // acquisition — proves stop() iterates `stream.getTracks()`, not just the primary `track`.
    (camera.stream as unknown as { getTracks: () => MediaStreamTrack[] }).getTracks = () => [
      trackA,
      trackB,
    ];

    camera.stop();

    expect(trackA.stop).toHaveBeenCalledTimes(1);
    expect(trackB.stop).toHaveBeenCalledTimes(1);
  });
});

describe('acquireCamera — overconstrained fallback', () => {
  it('retries once with no quality constraints after an OverconstrainedError, then succeeds', async () => {
    const track = fakeVideoTrack();
    const calls: MediaStreamConstraints[] = [];
    stubGetUserMedia((constraints) => {
      calls.push(constraints);
      if (calls.length === 1) {
        return Promise.reject(new DOMException('constraint not satisfied', 'OverconstrainedError'));
      }
      return Promise.resolve(fakeStream([track]));
    });

    const camera = await acquireCamera();

    expect(calls).toEqual([
      { video: { width: 1280, height: 720, frameRate: 30 }, audio: false },
      { video: true, audio: false },
    ]);
    expect(camera.track).toBe(track);
  });

  it('preserves an explicit deviceId across the fallback instead of dropping device selection', async () => {
    const track = fakeVideoTrack();
    const calls: MediaStreamConstraints[] = [];
    stubGetUserMedia((constraints) => {
      calls.push(constraints);
      if (calls.length === 1) {
        return Promise.reject(new DOMException('constraint not satisfied', 'OverconstrainedError'));
      }
      return Promise.resolve(fakeStream([track]));
    });

    await acquireCamera({ deviceId: 'device-42' });

    expect(calls).toEqual([
      { video: { width: 1280, height: 720, frameRate: 30, deviceId: 'device-42' }, audio: false },
      { video: { deviceId: 'device-42' }, audio: false },
    ]);
  });

  it('classifies the failure if the fallback also fails', async () => {
    stubGetUserMedia(() =>
      Promise.reject(new DOMException('still overconstrained', 'OverconstrainedError')),
    );

    await expect(acquireCamera()).rejects.toMatchObject({
      reason: 'device-not-found',
    });
  });

  it('does not retry for a non-constraint failure such as permission denial', async () => {
    let callCount = 0;
    stubGetUserMedia(() => {
      callCount += 1;
      return Promise.reject(new DOMException('denied', 'NotAllowedError'));
    });

    await expect(acquireCamera()).rejects.toBeInstanceOf(CameraAccessError);
    expect(callCount).toBe(1);
  });
});

describe('acquireCamera — error classification end to end', () => {
  it('wraps a permission denial as CameraAccessError with reason "permission-denied"', async () => {
    stubGetUserMedia(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));

    await expect(acquireCamera()).rejects.toMatchObject({
      reason: 'permission-denied',
    });
  });

  it('wraps a missing device as CameraAccessError with reason "device-not-found"', async () => {
    stubGetUserMedia(() => Promise.reject(new DOMException('none found', 'NotFoundError')));

    await expect(acquireCamera()).rejects.toMatchObject({
      reason: 'device-not-found',
    });
  });

  it('wraps a device that cannot start as CameraAccessError with reason "device-unavailable"', async () => {
    stubGetUserMedia(() => Promise.reject(new DOMException('busy', 'NotReadableError')));

    await expect(acquireCamera()).rejects.toMatchObject({
      reason: 'device-unavailable',
    });
  });

  it('rejects with CameraAccessError("unknown") if getUserMedia resolves without a video track', async () => {
    stubGetUserMedia(() => Promise.resolve(fakeStream([])));

    await expect(acquireCamera()).rejects.toMatchObject({ reason: 'unknown' });
  });

  it('stops any stray tracks on a stream that resolved with no video tracks', async () => {
    // `getVideoTracks()` is empty (no usable video track), but `getTracks()` still carries
    // something the platform handed back — `acquireCamera` must clean up via `getTracks()`, not
    // just check-and-abandon, so nothing keeps the device open after the rejection.
    const strayAudioTrack = {
      id: 'stray',
      kind: 'audio',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const stream = {
      getVideoTracks: () => [],
      getTracks: () => [strayAudioTrack],
    } as unknown as MediaStream;
    stubGetUserMedia(() => Promise.resolve(stream));

    await expect(acquireCamera()).rejects.toBeInstanceOf(CameraAccessError);
    expect(strayAudioTrack.stop).toHaveBeenCalledTimes(1);
  });
});

describe('acquireCamera — late-acquisition race (documented, not exercised here)', () => {
  it('a Camera can be stopped immediately after resolving, before any caller reads its track, without error', async () => {
    // This is as much of the "caller no longer wants it" race as this layer can prove in
    // isolation: acquireCamera() has no notion of whether the caller is still interested by the
    // time its promise resolves — that decision (e.g. "camera was disabled again while
    // getUserMedia was still pending", or "voice was left mid-acquisition") lives entirely in the
    // caller (apps/desktop's camera hook), which must check its own still-wanted flag after
    // awaiting acquireCamera() and call stop() if it no longer applies. What this layer guarantees,
    // and what this test proves, is that stop() is always safe and idempotent regardless of when
    // the caller decides to call it — including immediately.
    const track = fakeVideoTrack();
    stubGetUserMedia(() => Promise.resolve(fakeStream([track])));

    const camera = await acquireCamera();
    camera.stop();
    camera.stop();

    expect(camera.stopped).toBe(true);
    expect(track.readyState).toBe('ended');
    expect(track.stop).toHaveBeenCalledTimes(1);
  });
});
