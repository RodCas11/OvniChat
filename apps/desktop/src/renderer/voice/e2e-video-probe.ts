// Was 3s (matching the probe's original, non-delta `videoWidth > 0` bar). Live-measured: requiring
// a `presentedFrames` *delta* (not just one decoded frame) from Chromium's fake camera device did
// not reliably reach `MIN_FRAME_DELTA` within 3s — a real, measured regression the switch to
// delta-based proof introduced, not a guess. Raised with headroom; still an order of magnitude
// under screen's window, since the fake camera device is synthetic and lightweight, unlike real
// screen capture.
const MAX_WAIT_MS = 8_000;
// Requires the frame counter to advance by at least this many frames since the first callback —
// not merely that one frame was ever decoded. `videoWidth`/`videoHeight` alone (this probe's
// original bar) only proves *a* frame was decoded once; a frozen/stalled `<video>` element still
// reports its last decoded frame's dimensions even if delivery has actually stopped. Real evidence
// of *continuing* delivery requires a delta, not a one-shot snapshot — see T5 stabilization's
// requirement for delta-based proof (framesDecoded/bytesReceived-equivalent), implemented here via
// `HTMLVideoElement.requestVideoFrameCallback`'s `presentedFrames` counter rather than a full
// `RTCStatsReport` walk, since a probe only ever receives a `MediaStream`, not the underlying
// `RTCPeerConnection`.
const MIN_FRAME_DELTA = 2;

/**
 * Automated-verification-only: proves a remote camera `MediaStream` is carrying real, *continuing*
 * decoded video frames — not just that a track object exists, and not just that a single frame was
 * ever decoded — by driving `HTMLVideoElement.requestVideoFrameCallback` and requiring its
 * `presentedFrames` counter to advance by `MIN_FRAME_DELTA` while `track.readyState` stays `'live'`.
 * Logs `<markerPrefix>_OK:<remoteParticipantId>:<width>x<height>:frames=<delta>` on success or
 * `<markerPrefix>_SILENT:<remoteParticipantId>` on timeout; `apps/desktop/scripts/e2e-camera-smoke.mjs`
 * and `main/index.ts`'s `armE2ECameraSmokeExit` watch the Electron console for these lines (using
 * the default `markerPrefix`).
 *
 * `markerPrefix` defaults to `'E2E_REMOTE_VIDEO'` (camera's existing marker family) — T5
 * stabilization reuses this same function for a *second*, distinctly-prefixed continuity re-check
 * after a remote screen share ends (`'E2E_REMOTE_VIDEO_POST_SCREEN'`, see `VoiceChannelView.tsx`),
 * so the two proofs never get confused with each other in the console log.
 *
 * Takes both the remote and local participant id and refuses to probe if they match
 * (`<markerPrefix>_MISROUTED`) — a deliberate explicit assertion that the stream handed to this
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
  markerPrefix = 'E2E_REMOTE_VIDEO',
): void {
  if (localParticipantId !== undefined && remoteParticipantId === localParticipantId) {
    console.error(`${markerPrefix}_MISROUTED:${remoteParticipantId}`);
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

    let settled = false;
    let baselineFrames: number | undefined;

    const timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      console.info(`${markerPrefix}_SILENT:${remoteParticipantId}`);
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
          `${markerPrefix}_OK:${remoteParticipantId}:${String(metadata.width)}x${String(metadata.height)}:frames=${String(delta)}`,
        );
        return;
      }

      video.requestVideoFrameCallback(onFrame);
    };

    video.requestVideoFrameCallback(onFrame);
  } catch (error) {
    console.error('E2E video probe failed', error);
  }
}
