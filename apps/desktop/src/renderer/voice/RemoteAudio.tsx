import { useEffect, useRef, type ReactElement } from 'react';

interface RemoteAudioProps {
  readonly participantId: string;
  readonly stream: MediaStream;
  readonly muted: boolean;
}

/**
 * Plays one remote participant's audio track. `srcObject` has no React prop equivalent, so it is
 * set imperatively; `muted` implements deafen as a purely local-playback concern — the peer
 * connection and remote track keep flowing regardless (see `docs/architecture/WEBRTC_VOICE.md`).
 */
export function RemoteAudio({ participantId, stream, muted }: RemoteAudioProps): ReactElement {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    audio.srcObject = stream;
    return () => {
      audio.srcObject = null;
    };
  }, [stream]);

  useEffect(() => {
    const audio = audioRef.current;
    if (audio) audio.muted = muted;
  }, [muted]);

  return <audio ref={audioRef} autoPlay data-participant-id={participantId} />;
}
