import { useEffect, useRef, type ReactElement } from 'react';
import { PictureInPicture2 } from 'lucide-react';

import type { AvatarRef } from '@disco-voador/protocol';

import { IconButton } from '../ui/IconButton.js';
import { UserAvatar } from '../ui/UserAvatar.js';
import styles from './MediaTile.module.css';

interface MediaTileProps {
  readonly participantId: string;
  readonly displayName: string;
  readonly avatarRef: AvatarRef | undefined;
  readonly avatarCache: ReadonlyMap<string, string>;
  readonly onRequestAvatar: () => void;
  readonly speaking: boolean;
  /** `undefined` — camera off (or, for a screen tile, never valid; a screen tile only ever exists
   * while actually sharing, so `stream` is always defined there) — renders the avatar fallback
   * instead of a black rectangle (Section 23). */
  readonly stream: MediaStream | undefined;
  readonly kind: 'camera' | 'screen';
  readonly focused?: boolean;
  /** Omitted entirely for a tile that cannot be focused (e.g. the sole tile already shown large) —
   * never a disabled button for an action that structurally cannot apply. */
  readonly onFocus?: (() => void) | undefined;
  /** Native `HTMLVideoElement.requestPictureInPicture()` — see `MediaStage.tsx`'s own doc comment
   * for why this, not a secondary Electron window, is this app's PiP strategy. Omitted when this
   * tile has no video to show (camera-off avatar tile) — PiP only ever applies to a real stream. */
  readonly pipSupported?: boolean;
  readonly testId?: string;
}

/**
 * T13.5 — the one shared "real video, or a real avatar fallback" media tile, used by both the
 * camera grid and the focused screen/camera view. Reuses the exact same `UserAvatar`/`avatarCache`/
 * speaking-ring presentation `ParticipantRow`/`MemberRow` already use (Section 23: never a duplicate
 * avatar resolver) — this component owns no WebRTC lifecycle of its own, only attaching the given
 * `stream` to a `<video>` element (mirrors `RemoteCamera.tsx`/`RemoteScreen.tsx`'s own established,
 * minimal pattern) and detaching it on unmount/stream change.
 */
export function MediaTile({
  participantId,
  displayName,
  avatarRef,
  avatarCache,
  onRequestAvatar,
  speaking,
  stream,
  kind,
  focused = false,
  onFocus,
  pipSupported = false,
  testId,
}: MediaTileProps): ReactElement {
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !stream) return undefined;
    video.srcObject = stream;
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  const label = kind === 'screen' ? `${displayName}’s screen` : displayName;

  function handlePip(): void {
    const video = videoRef.current;
    if (!video) return;
    video.requestPictureInPicture().catch((error: unknown) => {
      console.error('media tile: Picture-in-Picture request failed', error);
    });
  }

  return (
    <figure
      className={`${styles.tile} ${focused ? styles.tileFocused : ''} ${
        speaking && stream ? styles.tileSpeaking : ''
      }`}
      data-participant-id={participantId}
      data-role={kind === 'screen' ? 'media-tile-screen' : 'media-tile-camera'}
      data-speaking={speaking}
      data-testid={testId}
    >
      {stream ? (
        <button
          type="button"
          className={styles.videoButton}
          onClick={onFocus}
          disabled={!onFocus}
          aria-label={onFocus ? `Focus ${label}` : label}
        >
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={kind === 'screen' ? styles.videoContain : styles.videoCover}
            data-role={kind === 'screen' ? 'media-tile-video-screen' : 'media-tile-video-camera'}
          />
        </button>
      ) : (
        <div className={styles.avatarFallback} data-role="media-tile-avatar-fallback">
          <UserAvatar
            name={displayName}
            colorSeed={participantId}
            size="large"
            avatarRef={avatarRef}
            avatarCache={avatarCache}
            onRequestAvatar={onRequestAvatar}
            speaking={speaking}
            testId={`media-tile-avatar-${participantId}`}
          />
        </div>
      )}

      <figcaption className={styles.caption}>
        <span className={styles.captionName}>{label}</span>
        {pipSupported && stream && (
          <IconButton
            icon={PictureInPicture2}
            ariaLabel={`Picture-in-Picture — ${label}`}
            tooltip="Picture-in-Picture"
            size="small"
            onClick={handlePip}
            data-testid={`media-tile-pip-${participantId}`}
          />
        )}
      </figcaption>
    </figure>
  );
}
