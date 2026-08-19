// Real screen capture (unlike the synthetic fake camera device `e2e-video-probe.ts` waits on) can
// take noticeably longer to produce and deliver frames — OS-level capture pipeline warm-up, encoder
// throttling for near-static content, and (in the old two-simultaneous-local-capture E2E topology)
// real CPU contention from two Electron instances each capturing their own screen. T5
// stabilization's one-publisher/one-viewer topology (see `docs/architecture/WEBRTC_SCREEN_SHARE.md`)
// removes the viewer-side capture load entirely, but the publisher side is still real screen
// capture, so this stays generous rather than reverting to camera's 3s bar.
const MAX_WAIT_MS = 20_000;
// See `e2e-video-probe.ts`'s `MIN_FRAME_DELTA` doc comment for why a frame *delta*, not a one-shot
// decoded frame, is the actual proof of continuing delivery.
const MIN_FRAME_DELTA = 2;

/**
 * Automated-verification-only: proves a remote screen-share `MediaStream` is carrying real,
 * *continuing* decoded video frames — not just that a track object exists, and not just that a
 * single frame was ever decoded — by driving `HTMLVideoElement.requestVideoFrameCallback` and
 * requiring its `presentedFrames` counter to advance by `MIN_FRAME_DELTA` while `track.readyState`
 * stays `'live'`. Mirrors `e2e-video-probe.ts`'s `probeRemoteVideoFrames` exactly, but deliberately
 * kept as a separate function with its own marker family (`E2E_REMOTE_SCREEN_OK`/
 * `E2E_REMOTE_SCREEN_SILENT`, distinct from camera's `E2E_REMOTE_VIDEO_OK`/`E2E_REMOTE_VIDEO_SILENT`)
 * rather than a shared parameterized probe — T5 must prove camera and screen-video are never
 * confused with each other, so even the E2E proof machinery for the two stays visibly, structurally
 * separate rather than merged behind a `source` flag that a routing bug could silently mislabel.
 *
 * `apps/desktop/scripts/e2e-screen-smoke.mjs` and `main/index.ts`'s `armE2EScreenSmokeExit` watch
 * the Electron console for these lines.
 */
export function probeRemoteScreenFrames(
  stream: MediaStream,
  remoteParticipantId: string,
  localParticipantId: string | undefined,
): void {
  if (localParticipantId !== undefined && remoteParticipantId === localParticipantId) {
    console.error(`E2E_REMOTE_SCREEN_MISROUTED:${remoteParticipantId}`);
    return;
  }

  try {
    const track = stream.getVideoTracks()[0];
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.play().catch((error: unknown) => {
      console.error('E2E screen probe failed to start playback', error);
    });

    let settled = false;
    let baselineFrames: number | undefined;

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.info(`E2E_REMOTE_SCREEN_SILENT:${remoteParticipantId}`);
    }, MAX_WAIT_MS);

    const onFrame = (_now: number, metadata: VideoFrameCallbackMetadata): void => {
      if (settled) return;
      baselineFrames ??= metadata.presentedFrames;

      const delta = metadata.presentedFrames - baselineFrames;
      const hasDimensions = metadata.width > 0 && metadata.height > 0;
      const trackLive = track?.readyState === 'live';

      if (trackLive && hasDimensions && delta >= MIN_FRAME_DELTA) {
        settled = true;
        clearTimeout(timeoutId);
        console.info(
          `E2E_REMOTE_SCREEN_OK:${remoteParticipantId}:${String(metadata.width)}x${String(metadata.height)}:frames=${String(delta)}`,
        );
        return;
      }

      video.requestVideoFrameCallback(onFrame);
    };

    video.requestVideoFrameCallback(onFrame);
  } catch (error) {
    console.error('E2E screen probe failed', error);
  }
}
