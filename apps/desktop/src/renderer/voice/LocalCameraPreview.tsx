import { useEffect, useRef, type ReactElement } from 'react';

interface LocalCameraPreviewProps {
  readonly stream: MediaStream;
}

/**
 * The local camera preview uses the same captured `MediaStream` that gets published — never a
 * second capture just for display. Muted and with no audio track expected (camera acquisition is
 * video-only, see `packages/media-core/src/camera.ts`), so this never plays back local audio.
 */
export function LocalCameraPreview({ stream }: LocalCameraPreviewProps): ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return undefined;
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  return <video ref={videoRef} autoPlay playsInline muted data-role="local-camera-preview" />;
}
