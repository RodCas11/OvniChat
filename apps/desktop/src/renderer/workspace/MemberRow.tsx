import type { ReactElement } from 'react';

import { UserAvatar } from '../ui/UserAvatar.js';
import type { MemberPanelEntry } from './member-presentation.js';
import styles from './MemberRow.module.css';

const ROLE_BADGE_LABEL: Record<'admin' | 'moderator', string> = {
  admin: 'Admin',
  moderator: 'Mod',
};

const PRESENCE_DOT_CLASS: Record<MemberPanelEntry['presence'], string | undefined> = {
  online: styles.presenceOnline,
  away: styles.presenceAway,
  dnd: styles.presenceDnd,
  // Offline members are never shown in this panel at all (T13.3 — no offline directory), so this
  // case is structurally unreachable; included only so the mapping is total, never a fallthrough.
  offline: undefined,
};

interface MemberRowProps {
  readonly member: MemberPanelEntry;
  readonly avatarCache: ReadonlyMap<string, string>;
  readonly onRequestAvatar: () => void;
  readonly onSelect: () => void;
}

/** One row per real, currently-online member — real avatar, presence dot, truncated custom status,
 * and (if present) a role-bucket badge. Clicking opens the caller's member-profile popover (or, for
 * the local user, the Profile Editor). */
export function MemberRow({
  member,
  avatarCache,
  onRequestAvatar,
  onSelect,
}: MemberRowProps): ReactElement {
  return (
    <li className={styles.row}>
      <button
        type="button"
        className={styles.button}
        onClick={onSelect}
        data-testid={`member-row-${member.key}`}
      >
        <span className={styles.avatarWrap}>
          <UserAvatar
            name={member.displayName}
            colorSeed={member.key}
            size="small"
            avatarRef={member.avatarRef}
            avatarCache={avatarCache}
            onRequestAvatar={onRequestAvatar}
            speaking={member.isSpeaking}
            testId={`member-row-avatar-wrap-${member.key}`}
          />
          {PRESENCE_DOT_CLASS[member.presence] && (
            <span
              className={`${styles.presenceDot} ${PRESENCE_DOT_CLASS[member.presence] ?? ''}`}
              aria-hidden="true"
            />
          )}
        </span>
        <span className={styles.textColumn}>
          <span className={styles.name}>
            {member.displayName}
            {member.isSelf && <span className={styles.you}> (you)</span>}
          </span>
          {member.customStatus && <span className={styles.status}>{member.customStatus}</span>}
        </span>
        {member.roleBucket && (
          <span className={styles.roleBadge}>{ROLE_BADGE_LABEL[member.roleBucket]}</span>
        )}
      </button>
    </li>
  );
}
