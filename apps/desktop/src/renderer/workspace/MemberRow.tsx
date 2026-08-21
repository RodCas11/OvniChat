import type { ReactElement } from 'react';

import type { VoiceParticipantView } from '../voice/use-voice-channel.js';
import { Avatar } from '../ui/Avatar.js';
import styles from './MemberRow.module.css';

interface MemberRowProps {
  readonly member: VoiceParticipantView;
  readonly isSelf: boolean;
}

/** One row per real, currently-connected member — Avatar + displayName only. Status/role-badge are
 * prepared, empty slots for a future task (T13.3), never fabricated today. */
export function MemberRow({ member, isSelf }: MemberRowProps): ReactElement {
  return (
    <li className={styles.row}>
      <Avatar name={member.displayName} colorSeed={member.participantId} size="small" />
      <span className={styles.name}>
        {member.displayName}
        {isSelf && <span className={styles.you}> (you)</span>}
      </span>
      {/* Prepared, empty slot for a future status/role-badge (T13.3) — intentionally renders
          nothing today. */}
      <span className={styles.badgeSlot} aria-hidden="true" />
    </li>
  );
}
