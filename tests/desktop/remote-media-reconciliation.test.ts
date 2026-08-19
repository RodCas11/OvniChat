import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteMediaReconciler } from '../../apps/desktop/src/renderer/voice/remote-media-reconciliation.js';
import type {
  RemoteMediaReconcilerCallbacks,
  RemoteMediaStreamsState,
} from '../../apps/desktop/src/renderer/voice/remote-media-reconciliation.js';

/**
 * `MediaStreamTrack` extends `EventTarget` in a real browser — Node's built-in `EventTarget` is
 * enough to exercise the reconciler's `'ended'`/`'mute'`/`'unmute'` wiring deterministically,
 * without a DOM. Mirrors this repo's established pattern of stubbing only the platform surface a
 * unit actually touches (see `tests/media-core/acquire-screen.test.ts`).
 */
function fakeTrack(kind: 'audio' | 'video'): MediaStreamTrack {
  const target = new EventTarget();
  Object.defineProperty(target, 'kind', { value: kind });
  return target as unknown as MediaStreamTrack;
}

function fakeEvent(participantId: string, mid: string | null, kind: 'audio' | 'video' = 'video') {
  const track = fakeTrack(kind);
  const stream = { id: `stream-${participantId}-${mid ?? 'nomid'}` } as unknown as MediaStream;
  return { participantId, track, stream, mid };
}

function fire(track: MediaStreamTrack, type: 'ended' | 'mute' | 'unmute'): void {
  track.dispatchEvent(new Event(type));
}

function createHarness(): {
  reconciler: RemoteMediaReconciler;
  snapshots: RemoteMediaStreamsState[];
  current(): RemoteMediaStreamsState;
  missingAnnouncements: { participantId: string; mid: string; kind: 'audio' | 'video' }[];
} {
  const empty: RemoteMediaStreamsState = {
    remoteAudioStreams: new Map(),
    remoteCameraStreams: new Map(),
    remoteScreenStreams: new Map(),
    remoteScreenAudioStreams: new Map(),
  };
  const snapshots: RemoteMediaStreamsState[] = [empty];
  const missingAnnouncements: { participantId: string; mid: string; kind: 'audio' | 'video' }[] =
    [];

  const callbacks: RemoteMediaReconcilerCallbacks = {
    updateStreams: (updater) => {
      snapshots.push(updater(snapshots[snapshots.length - 1] as RemoteMediaStreamsState));
    },
    onMissingAnnouncement: (participantId, mid, kind) => {
      missingAnnouncements.push({ participantId, mid, kind });
    },
  };

  return {
    reconciler: new RemoteMediaReconciler(callbacks),
    snapshots,
    current: () => snapshots[snapshots.length - 1] as RemoteMediaStreamsState,
    missingAnnouncements,
  };
}

describe('RemoteMediaReconciler — basic wiring, both arrival orders', () => {
  it('wires a track once its announcement arrives (track first, then announcement)', () => {
    const { reconciler, current } = createHarness();
    const event = fakeEvent('p1', '0', 'audio');

    reconciler.handleRemoteTrack(event);
    expect(current().remoteAudioStreams.size).toBe(0);

    reconciler.handleMediaTrackSource('p1', '0', 'microphone');
    expect(current().remoteAudioStreams.get('p1')).toBe(event.stream);
  });

  it('wires a track immediately when the announcement already arrived first', () => {
    const { reconciler, current } = createHarness();

    reconciler.handleMediaTrackSource('p1', '2', 'camera');
    const event = fakeEvent('p1', '2', 'video');
    reconciler.handleRemoteTrack(event);

    expect(current().remoteCameraStreams.get('p1')).toBe(event.stream);
  });

  it('drops a track with mid === null without touching any map', () => {
    const { reconciler, current, snapshots } = createHarness();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    reconciler.handleRemoteTrack(fakeEvent('p1', null, 'video'));

    expect(snapshots).toHaveLength(1);
    expect(current().remoteCameraStreams.size).toBe(0);
    expect(consoleErrorSpy).toHaveBeenCalled();
    consoleErrorSpy.mockRestore();
  });
});

describe('RemoteMediaReconciler — T6 four concurrent sources never cross-contaminate', () => {
  it('microphone and screen-audio coexist for one participant without interfering', () => {
    const { reconciler, current } = createHarness();
    const mic = fakeEvent('p1', '0', 'audio');
    const screenAudio = fakeEvent('p1', '3', 'audio');

    reconciler.handleMediaTrackSource('p1', '0', 'microphone');
    reconciler.handleRemoteTrack(mic);
    reconciler.handleMediaTrackSource('p1', '3', 'screen-audio');
    reconciler.handleRemoteTrack(screenAudio);

    expect(current().remoteAudioStreams.get('p1')).toBe(mic.stream);
    expect(current().remoteScreenAudioStreams.get('p1')).toBe(screenAudio.stream);
  });

  it('screen-audio ending (mute) removes only screen-audio — microphone remains', () => {
    const { reconciler, current } = createHarness();
    const mic = fakeEvent('p1', '0', 'audio');
    const screenAudio = fakeEvent('p1', '3', 'audio');
    reconciler.handleMediaTrackSource('p1', '0', 'microphone');
    reconciler.handleRemoteTrack(mic);
    reconciler.handleMediaTrackSource('p1', '3', 'screen-audio');
    reconciler.handleRemoteTrack(screenAudio);

    fire(screenAudio.track, 'mute');

    expect(current().remoteScreenAudioStreams.has('p1')).toBe(false);
    expect(current().remoteAudioStreams.get('p1')).toBe(mic.stream);
  });

  it("microphone re-adding ('unmute') does not disturb screen-audio", () => {
    const { reconciler, current } = createHarness();
    const mic = fakeEvent('p1', '0', 'audio');
    const screenAudio = fakeEvent('p1', '3', 'audio');
    reconciler.handleMediaTrackSource('p1', '0', 'microphone');
    reconciler.handleRemoteTrack(mic);
    reconciler.handleMediaTrackSource('p1', '3', 'screen-audio');
    reconciler.handleRemoteTrack(screenAudio);

    fire(mic.track, 'mute');
    expect(current().remoteAudioStreams.has('p1')).toBe(false);
    fire(mic.track, 'unmute');

    expect(current().remoteAudioStreams.get('p1')).toBe(mic.stream);
    expect(current().remoteScreenAudioStreams.get('p1')).toBe(screenAudio.stream);
  });

  it('screen-video ending does not disturb camera (mirrors the T5 stabilization bug this class fixes)', () => {
    const { reconciler, current } = createHarness();
    const camera = fakeEvent('p1', '1', 'video');
    const screenVideo = fakeEvent('p1', '2', 'video');
    reconciler.handleMediaTrackSource('p1', '1', 'camera');
    reconciler.handleRemoteTrack(camera);
    // Wiring in screen-video's initial track is exactly the operation that used to delete camera's
    // live entry as a side effect (T5 stabilization's `moveRemoteVideoStream` bug) — proves it no
    // longer does.
    reconciler.handleMediaTrackSource('p1', '2', 'screen-video');
    reconciler.handleRemoteTrack(screenVideo);
    expect(current().remoteCameraStreams.get('p1')).toBe(camera.stream);

    fire(screenVideo.track, 'ended');

    expect(current().remoteScreenStreams.has('p1')).toBe(false);
    expect(current().remoteCameraStreams.get('p1')).toBe(camera.stream);
  });

  it('all four sources can be concurrently live for one participant at once', () => {
    const { reconciler, current } = createHarness();
    const mic = fakeEvent('p1', '0', 'audio');
    const camera = fakeEvent('p1', '1', 'video');
    const screenVideo = fakeEvent('p1', '2', 'video');
    const screenAudio = fakeEvent('p1', '3', 'audio');

    reconciler.handleMediaTrackSource('p1', '0', 'microphone');
    reconciler.handleRemoteTrack(mic);
    reconciler.handleMediaTrackSource('p1', '1', 'camera');
    reconciler.handleRemoteTrack(camera);
    reconciler.handleMediaTrackSource('p1', '2', 'screen-video');
    reconciler.handleRemoteTrack(screenVideo);
    reconciler.handleMediaTrackSource('p1', '3', 'screen-audio');
    reconciler.handleRemoteTrack(screenAudio);

    expect(current().remoteAudioStreams.get('p1')).toBe(mic.stream);
    expect(current().remoteCameraStreams.get('p1')).toBe(camera.stream);
    expect(current().remoteScreenStreams.get('p1')).toBe(screenVideo.stream);
    expect(current().remoteScreenAudioStreams.get('p1')).toBe(screenAudio.stream);
  });
});

describe('RemoteMediaReconciler — mid reuse across sources', () => {
  it('reclassifies a reused mid from one source to another, moving the stream between maps', () => {
    const { reconciler, current } = createHarness();
    const firstEvent = fakeEvent('p1', '2', 'video');
    reconciler.handleMediaTrackSource('p1', '2', 'camera');
    reconciler.handleRemoteTrack(firstEvent);
    expect(current().remoteCameraStreams.get('p1')).toBe(firstEvent.stream);

    // The platform does not fire a fresh `ontrack` for a reused transceiver — only a later
    // `media:track-source` announcement with a different source for the same key.
    reconciler.handleMediaTrackSource('p1', '2', 'screen-video');

    expect(current().remoteCameraStreams.has('p1')).toBe(false);
    expect(current().remoteScreenStreams.get('p1')).toBe(firstEvent.stream);
  });

  it('reclassifies a reused mid across kinds (audio mid reused as a different audio source)', () => {
    const { reconciler, current } = createHarness();
    const firstEvent = fakeEvent('p1', '3', 'audio');
    reconciler.handleMediaTrackSource('p1', '3', 'screen-audio');
    reconciler.handleRemoteTrack(firstEvent);
    expect(current().remoteScreenAudioStreams.get('p1')).toBe(firstEvent.stream);

    reconciler.handleMediaTrackSource('p1', '3', 'microphone');

    expect(current().remoteScreenAudioStreams.has('p1')).toBe(false);
    expect(current().remoteAudioStreams.get('p1')).toBe(firstEvent.stream);
  });

  it("a subsequent 'unmute' after reclassification uses the new source, not the stale one", () => {
    const { reconciler, current } = createHarness();
    const event = fakeEvent('p1', '2', 'video');
    reconciler.handleMediaTrackSource('p1', '2', 'camera');
    reconciler.handleRemoteTrack(event);
    reconciler.handleMediaTrackSource('p1', '2', 'screen-video');

    fire(event.track, 'mute');
    expect(current().remoteScreenStreams.has('p1')).toBe(false);
    fire(event.track, 'unmute');

    expect(current().remoteScreenStreams.get('p1')).toBe(event.stream);
    expect(current().remoteCameraStreams.has('p1')).toBe(false);
  });
});

describe('RemoteMediaReconciler — missing announcement diagnostic', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a missing announcement after the grace window if none ever arrives', () => {
    const { reconciler, missingAnnouncements } = createHarness();
    reconciler.handleRemoteTrack(fakeEvent('p1', '9', 'audio'));

    vi.advanceTimersByTime(5000);

    expect(missingAnnouncements).toEqual([{ participantId: 'p1', mid: '9', kind: 'audio' }]);
  });

  it('does not report a missing announcement if one arrives before the grace window', () => {
    const { reconciler, missingAnnouncements } = createHarness();
    reconciler.handleRemoteTrack(fakeEvent('p1', '9', 'audio'));
    reconciler.handleMediaTrackSource('p1', '9', 'microphone');

    vi.advanceTimersByTime(5000);

    expect(missingAnnouncements).toEqual([]);
  });
});

describe('RemoteMediaReconciler — removeParticipant', () => {
  it('removes a leaving participant from all four remote-stream maps at once', () => {
    const { reconciler, current } = createHarness();
    const mic = fakeEvent('p1', '0', 'audio');
    const camera = fakeEvent('p1', '1', 'video');
    const screenVideo = fakeEvent('p1', '2', 'video');
    const screenAudio = fakeEvent('p1', '3', 'audio');
    reconciler.handleMediaTrackSource('p1', '0', 'microphone');
    reconciler.handleRemoteTrack(mic);
    reconciler.handleMediaTrackSource('p1', '1', 'camera');
    reconciler.handleRemoteTrack(camera);
    reconciler.handleMediaTrackSource('p1', '2', 'screen-video');
    reconciler.handleRemoteTrack(screenVideo);
    reconciler.handleMediaTrackSource('p1', '3', 'screen-audio');
    reconciler.handleRemoteTrack(screenAudio);

    reconciler.removeParticipant('p1');

    expect(current().remoteAudioStreams.has('p1')).toBe(false);
    expect(current().remoteCameraStreams.has('p1')).toBe(false);
    expect(current().remoteScreenStreams.has('p1')).toBe(false);
    expect(current().remoteScreenAudioStreams.has('p1')).toBe(false);
  });

  it('does not disturb a different participant still present in the same maps', () => {
    const { reconciler, current } = createHarness();
    const leavingMic = fakeEvent('p1', '0', 'audio');
    const stayingMic = fakeEvent('p2', '0', 'audio');
    reconciler.handleMediaTrackSource('p1', '0', 'microphone');
    reconciler.handleRemoteTrack(leavingMic);
    reconciler.handleMediaTrackSource('p2', '0', 'microphone');
    reconciler.handleRemoteTrack(stayingMic);

    reconciler.removeParticipant('p1');

    expect(current().remoteAudioStreams.has('p1')).toBe(false);
    expect(current().remoteAudioStreams.get('p2')).toBe(stayingMic.stream);
  });

  it('is a harmless no-op for a participant with no live streams', () => {
    const { reconciler, current } = createHarness();

    expect(() => {
      reconciler.removeParticipant('never-joined');
    }).not.toThrow();
    expect(current().remoteAudioStreams.size).toBe(0);
  });
});

describe('RemoteMediaReconciler — reset', () => {
  it('clears all reconciliation state, requiring a fresh announcement for a key already seen before reset', () => {
    const { reconciler, current } = createHarness();
    const before = fakeEvent('p1', '0', 'audio');
    reconciler.handleMediaTrackSource('p1', '0', 'microphone');
    reconciler.handleRemoteTrack(before);
    expect(current().remoteAudioStreams.get('p1')).toBe(before.stream);

    reconciler.reset();

    // Same key as before reset, but a brand-new track/event (a fresh join/reconnect) — must not be
    // wired until reconciled again, since `reset()` cleared the previously-known source for '0'.
    const after = fakeEvent('p1', '0', 'audio');
    reconciler.handleRemoteTrack(after);
    expect(current().remoteAudioStreams.get('p1')).toBe(before.stream); // unchanged — still pending

    reconciler.handleMediaTrackSource('p1', '0', 'microphone');
    expect(current().remoteAudioStreams.get('p1')).toBe(after.stream);
  });
});
