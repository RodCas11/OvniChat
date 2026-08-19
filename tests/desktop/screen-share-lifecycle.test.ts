import { describe, expect, it, vi } from 'vitest';

import type { Screen } from '@disco-voador/media-core';
import type { MediaTransport } from '@disco-voador/rtc-core';

import { releasePublishedScreen } from '../../apps/desktop/src/renderer/voice/screen-share-lifecycle.js';

function fakeTrack(kind: 'audio' | 'video'): MediaStreamTrack {
  return { kind } as MediaStreamTrack;
}

function fakeScreen(withAudio: boolean): Screen {
  const track = fakeTrack('video');
  const audioTrack = withAudio ? fakeTrack('audio') : undefined;
  return {
    track,
    audioTrack,
    stream: {} as MediaStream,
    stopped: false,
    stop: vi.fn(),
  };
}

function fakeTransport(): Pick<MediaTransport, 'unpublishTrack'> {
  return { unpublishTrack: vi.fn() };
}

describe('releasePublishedScreen', () => {
  it('unpublishes screen-video and screen-audio before stopping their capture session', () => {
    const transport = fakeTransport();
    const screen = fakeScreen(true);

    releasePublishedScreen(transport, screen);

    expect(transport.unpublishTrack).toHaveBeenNthCalledWith(1, screen.track);
    expect(transport.unpublishTrack).toHaveBeenNthCalledWith(2, screen.audioTrack);
    expect(transport.unpublishTrack).toHaveBeenCalledTimes(2);
    expect(screen.stop).toHaveBeenCalledTimes(1);
    expect(vi.mocked(transport.unpublishTrack).mock.invocationCallOrder[1]).toBeLessThan(
      vi.mocked(screen.stop).mock.invocationCallOrder[0] as number,
    );
  });

  it('handles a video-only screen without trying to unpublish a missing audio track', () => {
    const transport = fakeTransport();
    const screen = fakeScreen(false);

    releasePublishedScreen(transport, screen);

    expect(transport.unpublishTrack).toHaveBeenCalledOnce();
    expect(transport.unpublishTrack).toHaveBeenCalledWith(screen.track);
    expect(screen.stop).toHaveBeenCalledOnce();
  });
});
