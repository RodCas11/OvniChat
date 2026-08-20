import { afterEach, describe, expect, it, vi } from 'vitest';

import { acquireMicrophone } from '../../packages/media-core/src/microphone.js';
import { MicrophoneAccessError } from '../../packages/media-core/src/microphone-errors.js';

/**
 * `getUserMedia` is a platform (Chromium/Electron Renderer) capability with no real implementation
 * under Node — these tests stub `navigator.mediaDevices.getUserMedia` to exercise this package's
 * own orchestration (constraint defaulting, fallback-on-overconstrained, track/stream wiring,
 * mute/stop semantics, error classification wiring) deterministically. They do not, and cannot,
 * prove a real device is captured or that real browser constraint negotiation succeeds — see the
 * T3 report for what that would require.
 */

function fakeAudioTrack(overrides: Partial<MediaStreamTrack> = {}): MediaStreamTrack {
  return {
    id: 'track-1',
    kind: 'audio',
    enabled: true,
    stop: vi.fn(),
    ...overrides,
  } as unknown as MediaStreamTrack;
}

function fakeStream(tracks: MediaStreamTrack[]): MediaStream {
  return {
    getAudioTracks: () => tracks,
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

describe('acquireMicrophone — default constraints', () => {
  it('requests audio-only access with all three processing constraints enabled by default', async () => {
    const track = fakeAudioTrack();
    let seenConstraints: MediaStreamConstraints | undefined;
    stubGetUserMedia((constraints) => {
      seenConstraints = constraints;
      return Promise.resolve(fakeStream([track]));
    });

    await acquireMicrophone();

    expect(seenConstraints).toEqual({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
  });

  it('lets a caller override individual constraints without losing the others', async () => {
    const track = fakeAudioTrack();
    let seenConstraints: MediaStreamConstraints | undefined;
    stubGetUserMedia((constraints) => {
      seenConstraints = constraints;
      return Promise.resolve(fakeStream([track]));
    });

    await acquireMicrophone({ noiseSuppression: false });

    expect(seenConstraints).toEqual({
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: true },
      video: false,
    });
  });

  it('includes an explicit deviceId in the request when provided (T11)', async () => {
    const track = fakeAudioTrack();
    let seenConstraints: MediaStreamConstraints | undefined;
    stubGetUserMedia((constraints) => {
      seenConstraints = constraints;
      return Promise.resolve(fakeStream([track]));
    });

    await acquireMicrophone({ deviceId: 'device-42' });

    expect(seenConstraints).toEqual({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        deviceId: 'device-42',
      },
      video: false,
    });
  });

  it('omits deviceId from the request entirely when not provided', async () => {
    const track = fakeAudioTrack();
    let seenConstraints: MediaStreamConstraints | undefined;
    stubGetUserMedia((constraints) => {
      seenConstraints = constraints;
      return Promise.resolve(fakeStream([track]));
    });

    await acquireMicrophone();

    const audioConstraints = seenConstraints?.audio as Record<string, unknown>;
    expect(audioConstraints).not.toHaveProperty('deviceId');
  });
});

describe('acquireMicrophone — the returned Microphone', () => {
  it('exposes the acquired track and stream', async () => {
    const track = fakeAudioTrack();
    const stream = fakeStream([track]);
    stubGetUserMedia(() => Promise.resolve(stream));

    const microphone = await acquireMicrophone();

    expect(microphone.track).toBe(track);
    expect(microphone.stream).toBe(stream);
    expect(microphone.muted).toBe(false);
  });

  it('setMuted(true) disables the track instead of stopping it', async () => {
    const track = fakeAudioTrack();
    stubGetUserMedia(() => Promise.resolve(fakeStream([track])));
    const microphone = await acquireMicrophone();

    microphone.setMuted(true);

    expect(microphone.muted).toBe(true);
    expect(track.enabled).toBe(false);
    expect(track.stop).not.toHaveBeenCalled();
  });

  it('setMuted(false) after muting re-enables the track', async () => {
    const track = fakeAudioTrack();
    stubGetUserMedia(() => Promise.resolve(fakeStream([track])));
    const microphone = await acquireMicrophone();

    microphone.setMuted(true);
    microphone.setMuted(false);

    expect(microphone.muted).toBe(false);
    expect(track.enabled).toBe(true);
  });

  it('stop() stops every track in the stream and is idempotent', async () => {
    const track = fakeAudioTrack();
    stubGetUserMedia(() => Promise.resolve(fakeStream([track])));
    const microphone = await acquireMicrophone();

    microphone.stop();
    microphone.stop();

    expect(track.stop).toHaveBeenCalledTimes(1);
  });

  it('setMuted() after stop() is a no-op, never resurrecting a dead device', async () => {
    const track = fakeAudioTrack();
    stubGetUserMedia(() => Promise.resolve(fakeStream([track])));
    const microphone = await acquireMicrophone();

    microphone.stop();
    microphone.setMuted(true);

    expect(microphone.muted).toBe(false);
  });
});

describe('acquireMicrophone — overconstrained fallback', () => {
  it('retries once with no audio constraints after an OverconstrainedError, then succeeds', async () => {
    const track = fakeAudioTrack();
    const calls: MediaStreamConstraints[] = [];
    stubGetUserMedia((constraints) => {
      calls.push(constraints);
      if (calls.length === 1) {
        return Promise.reject(new DOMException('constraint not satisfied', 'OverconstrainedError'));
      }
      return Promise.resolve(fakeStream([track]));
    });

    const microphone = await acquireMicrophone();

    expect(calls).toEqual([
      {
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        video: false,
      },
      { audio: true, video: false },
    ]);
    expect(microphone.track).toBe(track);
  });

  it('preserves an explicit deviceId across the fallback instead of dropping device selection (T11)', async () => {
    // Mirrors `camera.ts`'s existing deviceId-preserving fallback test — see `microphone.ts`'s
    // `acquireMicrophone` doc comment for why this is a deliberate T11 behavior change from
    // microphone's pre-T11 fallback, which dropped every constraint (there was no deviceId to lose).
    const track = fakeAudioTrack();
    const calls: MediaStreamConstraints[] = [];
    stubGetUserMedia((constraints) => {
      calls.push(constraints);
      if (calls.length === 1) {
        return Promise.reject(new DOMException('constraint not satisfied', 'OverconstrainedError'));
      }
      return Promise.resolve(fakeStream([track]));
    });

    await acquireMicrophone({ deviceId: 'device-42' });

    expect(calls).toEqual([
      {
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          deviceId: 'device-42',
        },
        video: false,
      },
      { audio: { deviceId: 'device-42' }, video: false },
    ]);
  });

  it('classifies the failure if the fallback also fails', async () => {
    stubGetUserMedia(() =>
      Promise.reject(new DOMException('still overconstrained', 'OverconstrainedError')),
    );

    await expect(acquireMicrophone()).rejects.toMatchObject({
      reason: 'device-not-found',
    });
  });

  it('does not retry for a non-constraint failure such as permission denial', async () => {
    let callCount = 0;
    stubGetUserMedia(() => {
      callCount += 1;
      return Promise.reject(new DOMException('denied', 'NotAllowedError'));
    });

    await expect(acquireMicrophone()).rejects.toBeInstanceOf(MicrophoneAccessError);
    expect(callCount).toBe(1);
  });
});

describe('acquireMicrophone — error classification end to end', () => {
  it('wraps a permission denial as MicrophoneAccessError with reason "permission-denied"', async () => {
    stubGetUserMedia(() => Promise.reject(new DOMException('denied', 'NotAllowedError')));

    await expect(acquireMicrophone()).rejects.toMatchObject({
      reason: 'permission-denied',
    });
  });

  it('wraps a missing device as MicrophoneAccessError with reason "device-not-found"', async () => {
    stubGetUserMedia(() => Promise.reject(new DOMException('none found', 'NotFoundError')));

    await expect(acquireMicrophone()).rejects.toMatchObject({
      reason: 'device-not-found',
    });
  });

  it('wraps a device that cannot start as MicrophoneAccessError with reason "device-unavailable"', async () => {
    stubGetUserMedia(() => Promise.reject(new DOMException('busy', 'NotReadableError')));

    await expect(acquireMicrophone()).rejects.toMatchObject({
      reason: 'device-unavailable',
    });
  });

  it('rejects with MicrophoneAccessError("unknown") if getUserMedia resolves without an audio track', async () => {
    stubGetUserMedia(() => Promise.resolve(fakeStream([])));

    await expect(acquireMicrophone()).rejects.toMatchObject({ reason: 'unknown' });
  });
});
