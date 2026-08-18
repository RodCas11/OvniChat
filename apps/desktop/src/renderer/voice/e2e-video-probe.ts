const CHECK_INTERVAL_MS = 100;
const MAX_CHECKS = 30; // ~3s

/**
 * Automated-verification-only: proves a remote camera `MediaStream` is carrying real, decoded
 * video frames — not just that a track object exists — by attaching it to an offscreen `<video>`
 * element and polling until `videoWidth`/`videoHeight` are both positive (which only happens once
 * at least one frame has actually been decoded) while the track's own `readyState` stays `'live'`.
 * Logs `E2E_REMOTE_VIDEO_OK:<remoteParticipantId>:<width>x<height>` on success or
 * `E2E_REMOTE_VIDEO_SILENT:<remoteParticipantId>` on timeout;
 * `apps/desktop/scripts/e2e-camera-smoke.mjs` and `main/index.ts`'s `armE2ECameraSmokeExit` watch
 * the Electron console for these lines.
 *
 * Takes both the remote and local participant id and refuses to probe if they match
 * (`E2E_REMOTE_VIDEO_MISROUTED`) — a deliberate explicit assertion that the stream handed to this
 * probe is genuinely the *other* participant's, not a local-stream-into-a-remote-slot misrouting
 * bug (see `docs/tasks/T3_VOICE_WEBRTC.md`'s QA note on this exact class of gap for audio).
 *
 * Only ever invoked when the E2E auto-join config is present (see `VoiceChannelView.tsx`), which is
 * itself gated to non-packaged builds — this never runs for a real user.
 */
export function probeRemoteVideoFrames(
  stream: MediaStream,
  remoteParticipantId: string,
  localParticipantId: string | undefined,
): void {
  if (localParticipantId !== undefined && remoteParticipantId === localParticipantId) {
    console.error(`E2E_REMOTE_VIDEO_MISROUTED:${remoteParticipantId}`);
    return;
  }

  try {
    const track = stream.getVideoTracks()[0];
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.play().catch((error: unknown) => {
      console.error('E2E video probe failed to start playback', error);
    });

    let checks = 0;
    const intervalId = setInterval(() => {
      checks += 1;
      const hasDecodedFrame = video.videoWidth > 0 && video.videoHeight > 0;
      const trackLive = track?.readyState === 'live';

      if (hasDecodedFrame && trackLive) {
        clearInterval(intervalId);
        console.info(
          `E2E_REMOTE_VIDEO_OK:${remoteParticipantId}:${String(video.videoWidth)}x${String(video.videoHeight)}`,
        );
        return;
      }

      if (checks >= MAX_CHECKS) {
        clearInterval(intervalId);
        console.info(`E2E_REMOTE_VIDEO_SILENT:${remoteParticipantId}`);
      }
    }, CHECK_INTERVAL_MS);
  } catch (error) {
    console.error('E2E video probe failed', error);
  }
}
