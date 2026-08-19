import { useEffect, useRef, type ReactElement } from 'react';

interface LocalScreenPreviewProps {
  readonly stream: MediaStream;
}

/**
 * The local screen-share preview uses the same captured `MediaStream` that gets published — never
 * a second capture just for display, mirroring `LocalCameraPreview.tsx`. Muted and with no audio
 * track expected (`acquireScreen` is video-only — system/game audio is out of scope until a future
 * task), so this never plays back local audio. Rendered separately from the camera preview so a
 * screen share and a camera can both show at once without competing for the same tile.
 */
export function LocalScreenPreview({ stream }: LocalScreenPreviewProps): ReactElement {
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
    <video
      ref={videoRef}
      autoPlay
      playsInline
      muted
      data-role="local-screen-preview"
      style={{ maxWidth: '100%', objectFit: 'contain' }}
    />
  );
}
