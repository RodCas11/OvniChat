import type { ReactElement } from 'react';
import { Monitor, SlidersHorizontal, Video } from 'lucide-react';

import type { VoiceParticipantView } from '../voice/use-voice-channel.js';
import { IconButton } from '../ui/IconButton.js';
import { UserAvatar } from '../ui/UserAvatar.js';
import styles from './ParticipantRow.module.css';

interface ParticipantRowProps {
  readonly participant: VoiceParticipantView;
  readonly isSelf: boolean;
  /** Only ever derived from real data — `participant.participantId` being a key in
   * `state.remoteCameraStreams`/`remoteScreenStreams` (or, for the local user, the real
   * `cameraEnabled`/`screenSharingState` fields) — never inferred or guessed (T13.1 no-fabricated-
   * data rule). */
  readonly hasCamera: boolean;
  readonly hasScreen: boolean;
  /** T13.4 — real, currently-transmitted speech only: for a remote participant, membership in
   * `state.speakingParticipantIds` (itself only ever populated by `remote-audio-graph.ts`'s own
   * `AnalyserNode`-based detection on that participant's actual decoded audio); for the local user,
   * `state.selfSpeaking` (`TransmitGate.shouldTransmit && selfVoiceActivityDetected` — holding PTT
   * while silent never shows "speaking"). Never fabricated or inferred from any other signal. */
  readonly isSpeaking: boolean;
  /** T13.4 (UI consistency follow-up) — the same T13.3 `VoiceChannelState.avatarCache` Member Panel
   * already reads from; `participant.avatarRef` (already resolved by `VoiceChannelView.tsx` against
   * `state.members`/`state.selfAvatarRef`) is looked up against this cache by the shared `UserAvatar`
   * component — never a second, voice-specific avatar cache. */
  readonly avatarCache: ReadonlyMap<string, string>;
  /** Requests this participant's avatar bytes if not already cached (see `UserAvatar`'s own doc
   * comment — fires at most once per distinct, not-yet-cached hash). */
  readonly onRequestAvatar: () => void;
  /** Opens the local per-participant "User Volume"/"Mute for Me" controls (T13.4) — omitted for the
   * local user (self-mute already has its own, differently-labeled control in `UserControlBar`). */
  readonly onOpenVoiceControls?: (() => void) | undefined;
}

/** One participant row inside a joined voice channel — real displayName + connectionState, camera/
 * screen icons, and (T13.4) a speaking ring + local volume/mute entry point. */
export function ParticipantRow({
  participant,
  isSelf,
  hasCamera,
  hasScreen,
  isSpeaking,
  avatarCache,
  onRequestAvatar,
  onOpenVoiceControls,
}: ParticipantRowProps): ReactElement {
  return (
    <li className={styles.row}>
      {/* T13.4 — the speaking ring is `UserAvatar`'s own shared treatment (see that component's doc
          comment): one ring definition for every consumer, never a second copy duplicated here. */}
      <UserAvatar
        name={participant.displayName}
        colorSeed={participant.participantId}
        size="small"
        avatarRef={participant.avatarRef}
        avatarCache={avatarCache}
        onRequestAvatar={onRequestAvatar}
        speaking={isSpeaking}
        testId={`participant-row-avatar-wrap-${participant.participantId}`}
      />
      <span className={styles.name}>
        {participant.displayName}
        {isSelf && <span className={styles.you}> (you)</span>}
      </span>
      <span className={styles.mediaIcons}>
        {hasCamera && <Video size={14} aria-label={`${participant.displayName} has camera on`} />}
        {hasScreen && (
          <Monitor size={14} aria-label={`${participant.displayName} is sharing their screen`} />
        )}
        {/* T13.4 — "User Volume"/"Mute for Me" entry point, distinct in wording/iconography from the
            self-mute mic button (`UserControlBar`) and from the unrelated T13.3 moderator "clear
            avatar" feature — never shown for the local user (self-mute already exists). */}
        {onOpenVoiceControls && (
          <IconButton
            icon={SlidersHorizontal}
            ariaLabel={`Adjust volume for ${participant.displayName}`}
            tooltip="User Volume / Mute for Me"
            size="small"
            onClick={onOpenVoiceControls}
            data-testid={`participant-row-voice-controls-${participant.participantId}`}
          />
        )}
      </span>
    </li>
  );
}
