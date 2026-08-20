import { useEffect, useRef, type ReactElement } from 'react';

interface RemoteAudioProps {
  readonly participantId: string;
  readonly stream: MediaStream;
  readonly muted: boolean;
  /** T11 — the user's preferred output device (`null` = system default), applied via
   * `HTMLMediaElement.setSinkId()`. Every `<audio>` element playing remote media honors this — both
   * this microphone-audio use (`VoiceChannelView.tsx`'s `remoteAudioStreams` loop) and the
   * screen-audio use (T6's `remoteScreenAudioStreams` loop, also rendered via this same component,
   * per T11 Section 80's explicit requirement that both classes of remote audio honor the setting,
   * not just microphone). Optional so this component stays usable even before the caller has loaded
   * a preference (treated identically to `null`/system default while `undefined`). */
  readonly outputDeviceId?: string | null | undefined;
}

/**
 * Plays one remote participant's audio track. `srcObject` has no React prop equivalent, so it is
 * set imperatively; `muted` implements deafen as a purely local-playback concern — the peer
 * connection and remote track keep flowing regardless (see `docs/architecture/WEBRTC_VOICE.md`).
 *
 * `setSinkId()` (T11) only changes *where* audio would play, never *whether* it is audible —
 * `audio.muted` (driven by `muted` below, itself driven by `state.deafened`) is a fully independent
 * property that stays in effect regardless of which sink is selected, per the
 * `HTMLMediaElement`/`Audio Output Devices` specification (`setSinkId` reassigns the output device
 * a *rendered* audio stream is routed to; it has no bearing on the element's own `muted`/`volume`
 * state). Changing the output device while deafened therefore cannot cause anything to audibly
 * play — verified against the specification, not by physically swapping speakers on live hardware
 * during this task (no second output device was available to test with — see the final report).
 */
export function RemoteAudio({
  participantId,
  stream,
  muted,
  outputDeviceId,
}: RemoteAudioProps): ReactElement {
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

  useEffect(() => {
    const audio = audioRef.current;
    // `setSinkId` is a real, but not universally-implemented, method — guarded defensively even
    // though it is confirmed supported on this app's pinned Electron/Chromium build (see
    // `SettingsPanel.tsx`'s doc comment for the version this was checked against). An empty string
    // is the spec-defined way to reset to the system default output device.
    if (!audio || typeof audio.setSinkId !== 'function') return;
    audio.setSinkId(outputDeviceId ?? '').catch((error: unknown) => {
      console.error('voice: failed to set audio output device', error);
    });
  }, [outputDeviceId]);

  return <audio ref={audioRef} autoPlay data-participant-id={participantId} />;
}
