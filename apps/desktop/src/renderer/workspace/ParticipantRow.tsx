import type { ReactElement } from 'react';
import { Monitor, Video } from 'lucide-react';

import type { VoiceParticipantView } from '../voice/use-voice-channel.js';
import { Avatar } from '../ui/Avatar.js';
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
}

/** One participant row inside a joined voice channel — real displayName + connectionState only.
 * Speaking/mute/role-badge indicators are explicitly out of scope for T13.1 (deferred to T13.4/
 * T13.3) — this leaves a neutral, empty slot for them rather than fabricating a placeholder. */
export function ParticipantRow({
  participant,
  isSelf,
  hasCamera,
  hasScreen,
}: ParticipantRowProps): ReactElement {
  return (
    <li className={styles.row}>
      <Avatar name={participant.displayName} colorSeed={participant.participantId} size="small" />
      <span className={styles.name}>
        {participant.displayName}
        {isSelf && <span className={styles.you}> (you)</span>}
      </span>
      {/* Prepared, empty slot for a future speaking/mute/role-badge indicator (T13.3/T13.4) — never
          rendered with fabricated state today. */}
      <span className={styles.statusSlot} aria-hidden="true" />
      <span className={styles.mediaIcons}>
        {hasCamera && <Video size={14} aria-label={`${participant.displayName} has camera on`} />}
        {hasScreen && (
          <Monitor size={14} aria-label={`${participant.displayName} is sharing their screen`} />
        )}
      </span>
    </li>
  );
}
