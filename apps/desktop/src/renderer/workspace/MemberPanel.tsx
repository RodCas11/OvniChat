import { useState, type ReactElement } from 'react';
import { ChevronsRight, Users } from 'lucide-react';

import type { VoiceParticipantView } from '../voice/use-voice-channel.js';
import { EmptyState } from '../ui/EmptyState.js';
import { IconButton } from '../ui/IconButton.js';
import { MemberRow } from './MemberRow.js';
import styles from './MemberPanel.module.css';

export interface MemberGroup {
  readonly label: string;
  readonly members: readonly VoiceParticipantView[];
}

interface MemberPanelProps {
  readonly inChannel: boolean;
  readonly participants: readonly VoiceParticipantView[];
  readonly selfParticipantId: string | undefined;
  /** Shaped for a future real role/group grouping (T13.3) — when omitted, a single neutral
   * "Members" group is built from `participants`, since there is currently no safe way to derive
   * real per-member role grouping from `GroupBadge` alone (see this component's own task doc). */
  readonly groups?: readonly MemberGroup[] | undefined;
}

/** Right workspace column (T13.1) — Discord-style, collapsible (local-only state), built from real
 * participant data only. Only ever shows *currently-connected* participants of the channel the
 * local user is joined to — never a persistent offline-member directory (that is a future task). */
export function MemberPanel({
  inChannel,
  participants,
  selfParticipantId,
  groups,
}: MemberPanelProps): ReactElement {
  const [collapsed, setCollapsed] = useState(false);

  if (collapsed) {
    return (
      <div className={styles.collapsedRail}>
        <IconButton
          icon={Users}
          ariaLabel="Show members panel"
          onClick={() => {
            setCollapsed(false);
          }}
          data-testid="member-panel-expand-toggle"
        />
      </div>
    );
  }

  const effectiveGroups: readonly MemberGroup[] =
    groups ?? (participants.length > 0 ? [{ label: 'Members', members: participants }] : []);

  return (
    <aside className={styles.panel} aria-label="Members" data-testid="member-panel">
      <div className={styles.header}>
        <span className={styles.title} data-testid="member-panel-title">
          Members — {participants.length}
        </span>
        <IconButton
          icon={ChevronsRight}
          ariaLabel="Hide members panel"
          size="small"
          onClick={() => {
            setCollapsed(true);
          }}
          data-testid="member-panel-collapse-toggle"
        />
      </div>

      <div className={styles.scroll}>
        {!inChannel ? (
          <EmptyState
            icon={Users}
            title="Not in a voice channel"
            description="Join a channel to see who is connected."
          />
        ) : effectiveGroups.length === 0 ? (
          <EmptyState icon={Users} title="No one else is here" />
        ) : (
          effectiveGroups.map((group) => (
            <div key={group.label} className={styles.group}>
              <div className={styles.groupLabel}>
                {group.label} — {group.members.length}
              </div>
              <ul className={styles.list}>
                {group.members.map((member) => (
                  <MemberRow
                    key={member.participantId}
                    member={member}
                    isSelf={member.participantId === selfParticipantId}
                  />
                ))}
              </ul>
            </div>
          ))
        )}
      </div>
    </aside>
  );
}
