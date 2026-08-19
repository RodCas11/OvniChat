import { useEffect, useRef, type ReactElement } from 'react';

interface RemoteScreenProps {
  readonly participantId: string;
  readonly displayName: string;
  readonly stream: MediaStream;
}

/**
 * Renders one remote participant's screen share. Deliberately a separate component from
 * `RemoteCamera.tsx`, not a shared "remote video" component with a variant prop — the two are
 * rendered in visually distinct places (see `VoiceChannelView.tsx`) and screen shares are shown
 * larger, with `object-fit: contain` rather than camera's default (a screen capture's aspect ratio
 * varies with the source monitor/window and must never be stretched or cropped to fit a fixed tile,
 * unlike a camera feed). Audio stays owned entirely by `RemoteAudio.tsx` — this element has no
 * audio playback path (a screen-share `MediaStream` is video-only; see
 * `packages/media-core/src/screen.ts`).
 */
export function RemoteScreen({
  participantId,
  displayName,
  stream,
}: RemoteScreenProps): ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  return (
    <figure data-participant-id={participantId} data-role="remote-screen-tile">
      <video
        ref={videoRef}
        autoPlay
        playsInline
        data-role="remote-screen"
        style={{ width: '100%', maxHeight: '70vh', objectFit: 'contain' }}
      />
      <figcaption>{displayName}&rsquo;s screen</figcaption>
    </figure>
  );
}
