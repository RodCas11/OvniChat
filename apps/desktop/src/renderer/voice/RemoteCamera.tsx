import { useEffect, useRef, type ReactElement } from 'react';

interface RemoteCameraProps {
  readonly participantId: string;
  readonly displayName: string;
  readonly stream: MediaStream;
}

/**
 * Renders one remote participant's camera video. Audio stays owned entirely by `RemoteAudio.tsx` —
 * this element has no audio playback path of its own (the remote video-only `MediaStream` here
 * never carries an audio track; see `use-voice-channel.ts`'s per-`track.kind` stream separation).
 */
export function RemoteCamera({
  participantId,
  displayName,
  stream,
}: RemoteCameraProps): ReactElement {
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
    <figure data-participant-id={participantId}>
      <video ref={videoRef} autoPlay playsInline data-role="remote-camera" />
      <figcaption>{displayName}</figcaption>
    </figure>
  );
}
