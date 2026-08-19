import { afterEach, describe, expect, it, vi } from 'vitest';

import { acquireScreen } from '../../packages/media-core/src/screen.js';
import { ScreenAccessError } from '../../packages/media-core/src/screen-errors.js';

/**
 * `getDisplayMedia` is a platform (Chromium/Electron Renderer) capability with no real
 * implementation under Node — these tests stub `navigator.mediaDevices.getDisplayMedia` to
 * exercise this package's own orchestration (constraint defaulting, fallback-on-overconstrained,
 * track/stream wiring, the content-hint assignment, the full-stop-releases-capture lifecycle, error
 * classification wiring) deterministically. They do not, and cannot, prove a real screen/window is
 * captured, or that Electron's `session.setDisplayMediaRequestHandler()` actually fulfills the
 * call — see the T3 microphone report and T4 camera report for what that would require of a real
 * Electron runtime, which applies identically here.
 */

function fakeVideoTrack(overrides: Partial<MediaStreamTrack> = {}): MediaStreamTrack {
  const track = {
    id: 'track-1',
    kind: 'video',
    enabled: true,
    contentHint: '',
    readyState: 'live' as MediaStreamTrackState,
    stop: vi.fn(function (this: { readyState: MediaStreamTrackState }) {
      this.readyState = 'ended';
    }),
    ...overrides,
  } as unknown as MediaStreamTrack;
  return track;
}

function fakeAudioTrack(overrides: Partial<MediaStreamTrack> = {}): MediaStreamTrack {
  const track = {
    id: 'audio-track-1',
    kind: 'audio',
    enabled: true,
    readyState: 'live' as MediaStreamTrackState,
    stop: vi.fn(function (this: { readyState: MediaStreamTrackState }) {
      this.readyState = 'ended';
    }),
    ...overrides,
  } as unknown as MediaStreamTrack;
  return track;
}

function fakeStream(
  videoTracks: MediaStreamTrack[],
  audioTracks: MediaStreamTrack[] = [],
): MediaStream {
  return {
    getVideoTracks: () => videoTracks,
    getAudioTracks: () => audioTracks,
    getTracks: () => [...videoTracks, ...audioTracks],
  } as unknown as MediaStream;
}

function stubGetDisplayMedia(
  impl: (constraints: MediaStreamConstraints) => Promise<MediaStream>,
): void {
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn(impl) } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('acquireScreen — default constraints', () => {
  it('requests video-only access with the 1080p/30fps ideal defaults and never requests audio', async () => {
    const track = fakeVideoTrack();
    let seenConstraints: MediaStreamConstraints | undefined;
    stubGetDisplayMedia((constraints) => {
      seenConstraints = constraints;
      return Promise.resolve(fakeStream([track]));
    });

    await acquireScreen();

    expect(seenConstraints).toEqual({
      video: { width: 1920, height: 1080, frameRate: 30 },
      audio: false,
    });
  });

  it('lets a caller override individual constraints without losing the others', async () => {
    const track = fakeVideoTrack();
    let seenConstraints: MediaStreamConstraints | undefined;
    stubGetDisplayMedia((constraints) => {
      seenConstraints = constraints;
      return Promise.resolve(fakeStream([track]));
    });

    await acquireScreen({ frameRate: 60 });

    expect(seenConstraints).toEqual({
      video: { width: 1920, height: 1080, frameRate: 60 },
      audio: false,
    });
  });

  it('requests audio: false by default when shareAudio is omitted', async () => {
    const track = fakeVideoTrack();
    let seenConstraints: MediaStreamConstraints | undefined;
    stubGetDisplayMedia((constraints) => {
      seenConstraints = constraints;
      return Promise.resolve(fakeStream([track]));
    });

    await acquireScreen({});

    expect(seenConstraints?.audio).toBe(false);
  });

  it('requests audio: true when shareAudio is explicitly true', async () => {
    const track = fakeVideoTrack();
    let seenConstraints: MediaStreamConstraints | undefined;
    stubGetDisplayMedia((constraints) => {
      seenConstraints = constraints;
      return Promise.resolve(fakeStream([track]));
    });

    await acquireScreen({}, true);

    expect(seenConstraints?.audio).toBe(true);
  });
});

describe('acquireScreen — optional screen audio (T6)', () => {
  it('exposes audioTrack when the platform actually supplied one', async () => {
    const videoTrack = fakeVideoTrack();
    const audioTrack = fakeAudioTrack();
    stubGetDisplayMedia(() => Promise.resolve(fakeStream([videoTrack], [audioTrack])));

    const screen = await acquireScreen({}, true);

    expect(screen.audioTrack).toBe(audioTrack);
  });

  it('leaves audioTrack undefined — not an error — when audio was requested but the platform supplied none', async () => {
    const videoTrack = fakeVideoTrack();
    stubGetDisplayMedia(() => Promise.resolve(fakeStream([videoTrack])));

    const screen = await acquireScreen({}, true);

    expect(screen.audioTrack).toBeUndefined();
    expect(screen.track).toBe(videoTrack);
  });

  it('stop() stops both the video and audio tracks', async () => {
    const videoTrack = fakeVideoTrack();
    const audioTrack = fakeAudioTrack();
    stubGetDisplayMedia(() => Promise.resolve(fakeStream([videoTrack], [audioTrack])));
    const screen = await acquireScreen({}, true);

    screen.stop();

    expect(videoTrack.stop).toHaveBeenCalledTimes(1);
    expect(audioTrack.stop).toHaveBeenCalledTimes(1);
    expect(screen.stopped).toBe(true);
  });

  it('preserves shareAudio across the overconstrained-fallback retry', async () => {
    const videoTrack = fakeVideoTrack();
    const calls: MediaStreamConstraints[] = [];
    stubGetDisplayMedia((constraints) => {
      calls.push(constraints);
      if (calls.length === 1) {
        return Promise.reject(new DOMException('constraint not satisfied', 'OverconstrainedError'));
      }
      return Promise.resolve(fakeStream([videoTrack]));
    });

    await acquireScreen({}, true);

    expect(calls).toEqual([
      { video: { width: 1920, height: 1080, frameRate: 30 }, audio: true },
      { video: true, audio: true },
    ]);
  });
});

describe('acquireScreen — the returned Screen', () => {
  it('exposes the acquired track and stream', async () => {
    const track = fakeVideoTrack();
    const stream = fakeStream([track]);
    stubGetDisplayMedia(() => Promise.resolve(stream));

    const screen = await acquireScreen();

    expect(screen.track).toBe(track);
    expect(screen.stream).toBe(stream);
    expect(screen.stopped).toBe(false);
  });

  it('sets contentHint to "detail" on the acquired track', async () => {
    const track = fakeVideoTrack();
    stubGetDisplayMedia(() => Promise.resolve(fakeStream([track])));

    await acquireScreen();

    expect(track.contentHint).toBe('detail');
  });

  it('stop() stops every track in the stream, releasing capture (readyState "ended")', async () => {
    const track = fakeVideoTrack();
    stubGetDisplayMedia(() => Promise.resolve(fakeStream([track])));
    const screen = await acquireScreen();

    screen.stop();

    expect(track.stop).toHaveBeenCalledTimes(1);
    expect(track.readyState).toBe('ended');
    expect(screen.stopped).toBe(true);
  });

  it('stop() is idempotent — a second call never re-stops the track', async () => {
    const track = fakeVideoTrack();
    stubGetDisplayMedia(() => Promise.resolve(fakeStream([track])));
    const screen = await acquireScreen();

    screen.stop();
    screen.stop();
    screen.stop();

    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('stop() stops every track when the stream carries more than one', async () => {
    const trackA = fakeVideoTrack({ id: 'a' });
    const trackB = fakeVideoTrack({ id: 'b' });
    stubGetDisplayMedia(() => Promise.resolve(fakeStream([trackA])));
    const screen = await acquireScreen();
    // Simulate a stream that (unusually) carries more than one track by stubbing getTracks after
    // acquisition — proves stop() iterates `stream.getTracks()`, not just the primary `track`.
    (screen.stream as unknown as { getTracks: () => MediaStreamTrack[] }).getTracks = () => [
      trackA,
      trackB,
    ];

    screen.stop();

    expect(trackA.stop).toHaveBeenCalledTimes(1);
    expect(trackB.stop).toHaveBeenCalledTimes(1);
  });
});

describe('acquireScreen — overconstrained fallback', () => {
  it('retries once with no quality constraints after an OverconstrainedError, then succeeds', async () => {
    const track = fakeVideoTrack();
    const calls: MediaStreamConstraints[] = [];
    stubGetDisplayMedia((constraints) => {
      calls.push(constraints);
      if (calls.length === 1) {
        return Promise.reject(new DOMException('constraint not satisfied', 'OverconstrainedError'));
      }
      return Promise.resolve(fakeStream([track]));
    });

    const screen = await acquireScreen();

    expect(calls).toEqual([
      { video: { width: 1920, height: 1080, frameRate: 30 }, audio: false },
      { video: true, audio: false },
    ]);
    expect(screen.track).toBe(track);
  });

  it('classifies the failure if the fallback also fails', async () => {
    stubGetDisplayMedia(() =>
      Promise.reject(new DOMException('still overconstrained', 'OverconstrainedError')),
    );

    await expect(acquireScreen()).rejects.toMatchObject({
      reason: 'unknown',
    });
  });

  it('does not retry for a non-constraint failure such as cancellation', async () => {
    let callCount = 0;
    stubGetDisplayMedia(() => {
      callCount += 1;
      return Promise.reject(new DOMException('denied', 'NotAllowedError'));
    });

    await expect(acquireScreen()).rejects.toBeInstanceOf(ScreenAccessError);
    expect(callCount).toBe(1);
  });
});

describe('acquireScreen — error classification end to end', () => {
  it('wraps a picker cancellation as ScreenAccessError with reason "permission-denied"', async () => {
    stubGetDisplayMedia(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));

    await expect(acquireScreen()).rejects.toMatchObject({
      reason: 'permission-denied',
    });
  });

  it('wraps no available source as ScreenAccessError with reason "no-source-available"', async () => {
    stubGetDisplayMedia(() => Promise.reject(new DOMException('none found', 'NotFoundError')));

    await expect(acquireScreen()).rejects.toMatchObject({
      reason: 'no-source-available',
    });
  });

  it('wraps a source that fails to start as ScreenAccessError with reason "capture-failed"', async () => {
    stubGetDisplayMedia(() => Promise.reject(new DOMException('busy', 'NotReadableError')));

    await expect(acquireScreen()).rejects.toMatchObject({
      reason: 'capture-failed',
    });
  });

  it('rejects with ScreenAccessError("unknown") if getDisplayMedia resolves without a video track', async () => {
    stubGetDisplayMedia(() => Promise.resolve(fakeStream([])));

    await expect(acquireScreen()).rejects.toMatchObject({ reason: 'unknown' });
  });

  it('stops any stray tracks on a stream that resolved with no video tracks', async () => {
    // `getVideoTracks()` is empty (no usable video track), but `getTracks()` still carries
    // something the platform handed back — `acquireScreen` must clean up via `getTracks()`, not
    // just check-and-abandon, so nothing keeps capture running after the rejection.
    const strayAudioTrack = {
      id: 'stray',
      kind: 'audio',
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    const stream = {
      getVideoTracks: () => [],
      getTracks: () => [strayAudioTrack],
    } as unknown as MediaStream;
    stubGetDisplayMedia(() => Promise.resolve(stream));

    await expect(acquireScreen()).rejects.toBeInstanceOf(ScreenAccessError);
    expect(strayAudioTrack.stop).toHaveBeenCalledTimes(1);
  });
});

describe('acquireScreen — late-acquisition race (documented, not exercised here)', () => {
  it('a Screen can be stopped immediately after resolving, before any caller reads its track, without error', async () => {
    // Same rationale as the equivalent camera test: acquireScreen() has no notion of whether the
    // caller is still interested by the time its promise resolves — that decision lives entirely in
    // the caller, which must check its own still-wanted flag after awaiting acquireScreen() and call
    // stop() if it no longer applies. What this layer guarantees, and what this test proves, is that
    // stop() is always safe and idempotent regardless of when the caller decides to call it.
    const track = fakeVideoTrack();
    stubGetDisplayMedia(() => Promise.resolve(fakeStream([track])));

    const screen = await acquireScreen();
    screen.stop();
    screen.stop();

    expect(screen.stopped).toBe(true);
    expect(track.readyState).toBe('ended');
    expect(track.stop).toHaveBeenCalledTimes(1);
  });
});
