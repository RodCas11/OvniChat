import type { Screen } from '@disco-voador/media-core';
import type { MediaTransport } from '@disco-voador/rtc-core';

type ScreenPublishingTransport = Pick<MediaTransport, 'unpublishTrack'>;

/**
 * Removes both independently-published screen tracks before releasing the shared capture session.
 * Keeping this operation in one place prevents a leave/reconnect or native capture-end path from
 * forgetting screen-audio while handling screen-video.
 */
export function releasePublishedScreen(transport: ScreenPublishingTransport, screen: Screen): void {
  transport.unpublishTrack(screen.track);
  if (screen.audioTrack) transport.unpublishTrack(screen.audioTrack);
  screen.stop();
}
