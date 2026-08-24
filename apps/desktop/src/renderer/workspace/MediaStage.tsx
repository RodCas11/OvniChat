import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { LayoutGrid } from 'lucide-react';

import { Button } from '../ui/Button.js';
import type {
  VoiceChannelActions,
  VoiceChannelState,
  VoiceParticipantView,
} from '../voice/use-voice-channel.js';
import { MediaTile } from './MediaTile.js';
import styles from './MediaStage.module.css';

interface MediaStageProps {
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
  /** Already avatar-resolved (`VoiceChannelView.tsx`'s `participantsWithSelf`) — never re-resolved
   * here (Section 23/57: no duplicate avatar resolver, no WebRTC/business logic inside a tile
   * component). */
  readonly participants: readonly VoiceParticipantView[];
}

interface StreamEntry {
  readonly participantId: string;
  readonly displayName: string;
  readonly avatarRef: VoiceParticipantView['avatarRef'];
  readonly stream: MediaStream | undefined;
  readonly speaking: boolean;
}

/** `HTMLVideoElement.requestPictureInPicture()` support — checked once, not per tile. This is the
 * "smallest robust architecture" T13.5's own brief calls for (Section 53): real Chromium-native PiP
 * for a single focused stream, rather than a second Electron window with its own trust-boundary
 * surface to secure. `false` in a context where the API genuinely does not exist (never assumed). */
function detectPipSupport(): boolean {
  return typeof document !== 'undefined' && 'pictureInPictureEnabled' in document;
}

/**
 * T13.5 — the media stage: what `MainContent.tsx` renders in place of (never alongside, when there
 * is truly nothing to show — Section 80) plain chat once at least one real camera or screen stream
 * is active. Renders real video via the shared `MediaTile` (never a second capture/attach path — see
 * `MediaTile.tsx`'s own doc comment); this component owns no WebRTC negotiation, capture lifecycle,
 * or renegotiation of any kind (Section 57/58) — grid/focus/filmstrip switching here is presentation
 * state only (`useState`), never a reason for `use-voice-channel.ts` to touch a peer connection.
 *
 * Screen share, when present, is always the primary content (Section 21) — camera-only mode falls
 * back to an adaptive grid of every voice participant (Section 22/80: only participants with an
 * actually active stream ever reach here at all, camera-off participants render as a real avatar
 * tile via `MediaTile`, never a black rectangle).
 */
export function MediaStage({ state, actions, participants }: MediaStageProps): ReactElement | null {
  const [pipSupported] = useState(detectPipSupport);
  const [focusedScreenId, setFocusedScreenId] = useState<string | undefined>(undefined);
  const [focusedCameraId, setFocusedCameraId] = useState<string | undefined>(undefined);

  function isSpeaking(participantId: string): boolean {
    return participantId === state.selfParticipantId
      ? state.selfSpeaking
      : state.speakingParticipantIds.has(participantId);
  }

  function requestAvatarFor(participant: VoiceParticipantView): void {
    if (participant.participantId === state.selfParticipantId) {
      actions.requestAvatar('self');
    } else if (participant.memberRef) {
      actions.requestAvatar('member', participant.memberRef);
    }
  }

  const screenEntries: readonly StreamEntry[] = useMemo(() => {
    const entries: StreamEntry[] = [];
    for (const participant of participants) {
      const stream =
        participant.participantId === state.selfParticipantId
          ? state.screenSharingState === 'sharing'
            ? state.localScreenStream
            : undefined
          : state.remoteScreenStreams.get(participant.participantId);
      if (!stream) continue;
      entries.push({
        participantId: participant.participantId,
        displayName: participant.displayName,
        avatarRef: participant.avatarRef,
        stream,
        speaking: isSpeaking(participant.participantId),
      });
    }
    return entries;
  }, [
    participants,
    state.selfParticipantId,
    state.screenSharingState,
    state.localScreenStream,
    state.remoteScreenStreams,
    state.selfSpeaking,
    state.speakingParticipantIds,
  ]);

  const cameraEntries: readonly StreamEntry[] = useMemo(() => {
    return participants.map((participant) => {
      const stream =
        participant.participantId === state.selfParticipantId
          ? state.cameraEnabled
            ? state.localCameraStream
            : undefined
          : state.remoteCameraStreams.get(participant.participantId);
      return {
        participantId: participant.participantId,
        displayName: participant.displayName,
        avatarRef: participant.avatarRef,
        stream,
        speaking: isSpeaking(participant.participantId),
      };
    });
  }, [
    participants,
    state.selfParticipantId,
    state.cameraEnabled,
    state.localCameraStream,
    state.remoteCameraStreams,
    state.selfSpeaking,
    state.speakingParticipantIds,
  ]);

  const activeCameraEntries = cameraEntries.filter((entry) => entry.stream !== undefined);
  const hasMedia = screenEntries.length > 0 || activeCameraEntries.length > 0;

  // A previously-focused subject that stopped streaming (track ended, participant left, screen
  // share stopped) always falls back cleanly — never a frozen/stale tile (Section 65).
  useEffect(() => {
    if (
      focusedScreenId &&
      !screenEntries.some((entry) => entry.participantId === focusedScreenId)
    ) {
      setFocusedScreenId(undefined);
    }
  }, [focusedScreenId, screenEntries]);
  useEffect(() => {
    if (
      focusedCameraId &&
      !activeCameraEntries.some((entry) => entry.participantId === focusedCameraId)
    ) {
      setFocusedCameraId(undefined);
    }
  }, [focusedCameraId, activeCameraEntries]);

  if (!hasMedia) return null;

  if (screenEntries.length > 0) {
    const focused =
      screenEntries.find((entry) => entry.participantId === focusedScreenId) ?? screenEntries[0];
    if (!focused) return null;
    return (
      <div className={styles.stage} data-role="media-stage-screen">
        <div className={styles.screenPrimary}>
          <MediaTile
            participantId={focused.participantId}
            displayName={focused.displayName}
            avatarRef={focused.avatarRef}
            avatarCache={state.avatarCache}
            onRequestAvatar={() => {
              const participant = participants.find(
                (p) => p.participantId === focused.participantId,
              );
              if (participant) requestAvatarFor(participant);
            }}
            speaking={focused.speaking}
            stream={focused.stream}
            kind="screen"
            focused
            pipSupported={pipSupported}
            testId={`media-stage-screen-${focused.participantId}`}
          />
        </div>

        {screenEntries.length > 1 && (
          <div className={styles.screenSwitcher} role="tablist" aria-label="Screen shares">
            {screenEntries.map((entry) => (
              <button
                key={entry.participantId}
                type="button"
                role="tab"
                aria-selected={entry.participantId === focused.participantId}
                className={`${styles.screenSwitcherItem} ${
                  entry.participantId === focused.participantId
                    ? styles.screenSwitcherItemActive
                    : ''
                }`}
                onClick={() => {
                  setFocusedScreenId(entry.participantId);
                }}
                data-testid={`media-stage-screen-switch-${entry.participantId}`}
              >
                {entry.displayName}’s screen
              </button>
            ))}
          </div>
        )}

        {activeCameraEntries.length > 0 && (
          <div className={styles.cameraFilmstrip} data-role="media-stage-camera-filmstrip">
            {activeCameraEntries.map((entry) => (
              <div key={entry.participantId} className={styles.filmstripTile}>
                <MediaTile
                  participantId={entry.participantId}
                  displayName={entry.displayName}
                  avatarRef={entry.avatarRef}
                  avatarCache={state.avatarCache}
                  onRequestAvatar={() => {
                    const participant = participants.find(
                      (p) => p.participantId === entry.participantId,
                    );
                    if (participant) requestAvatarFor(participant);
                  }}
                  speaking={entry.speaking}
                  stream={entry.stream}
                  kind="camera"
                  testId={`media-stage-camera-${entry.participantId}`}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // No screen share — camera grid (or a focused camera + filmstrip, when one tile was clicked).
  if (focusedCameraId) {
    const focused = activeCameraEntries.find((entry) => entry.participantId === focusedCameraId);
    if (focused) {
      const others = activeCameraEntries.filter((entry) => entry.participantId !== focusedCameraId);
      return (
        <div
          className={styles.stage}
          data-role="media-stage-focused-camera"
          data-testid="media-stage-focused-camera"
        >
          <div className={styles.stageToolbar}>
            <Button
              variant="ghost"
              type="button"
              onClick={() => {
                setFocusedCameraId(undefined);
              }}
              data-testid="media-stage-back-to-grid"
            >
              <LayoutGrid size={14} aria-hidden="true" />
              Back to grid
            </Button>
          </div>
          <div className={styles.screenPrimary}>
            <MediaTile
              participantId={focused.participantId}
              displayName={focused.displayName}
              avatarRef={focused.avatarRef}
              avatarCache={state.avatarCache}
              onRequestAvatar={() => {
                const participant = participants.find(
                  (p) => p.participantId === focused.participantId,
                );
                if (participant) requestAvatarFor(participant);
              }}
              speaking={focused.speaking}
              stream={focused.stream}
              kind="camera"
              focused
              pipSupported={pipSupported}
              testId={`media-stage-camera-${focused.participantId}`}
            />
          </div>
          {others.length > 0 && (
            <div className={styles.cameraFilmstrip} data-role="media-stage-camera-filmstrip">
              {others.map((entry) => (
                <div key={entry.participantId} className={styles.filmstripTile}>
                  <MediaTile
                    participantId={entry.participantId}
                    displayName={entry.displayName}
                    avatarRef={entry.avatarRef}
                    avatarCache={state.avatarCache}
                    onRequestAvatar={() => {
                      const participant = participants.find(
                        (p) => p.participantId === entry.participantId,
                      );
                      if (participant) requestAvatarFor(participant);
                    }}
                    speaking={entry.speaking}
                    stream={entry.stream}
                    kind="camera"
                    onFocus={() => {
                      setFocusedCameraId(entry.participantId);
                    }}
                    testId={`media-stage-camera-${entry.participantId}`}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }
  }

  return (
    <div className={styles.grid} data-role="media-stage-grid" data-testid="media-stage-grid">
      {cameraEntries.map((entry) => (
        <MediaTile
          key={entry.participantId}
          participantId={entry.participantId}
          displayName={entry.displayName}
          avatarRef={entry.avatarRef}
          avatarCache={state.avatarCache}
          onRequestAvatar={() => {
            const participant = participants.find((p) => p.participantId === entry.participantId);
            if (participant) requestAvatarFor(participant);
          }}
          speaking={entry.speaking}
          stream={entry.stream}
          kind="camera"
          onFocus={
            entry.stream
              ? () => {
                  setFocusedCameraId(entry.participantId);
                }
              : undefined
          }
          testId={`media-stage-camera-${entry.participantId}`}
        />
      ))}
    </div>
  );
}
