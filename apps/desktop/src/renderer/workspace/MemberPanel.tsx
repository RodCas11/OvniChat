import { useState, type ReactElement } from 'react';
import { ChevronsRight, Users } from 'lucide-react';

import { EmptyState } from '../ui/EmptyState.js';
import { IconButton } from '../ui/IconButton.js';
import type { MemberGroup, MemberPanelEntry } from './member-presentation.js';
import { MemberRow } from './MemberRow.js';
import styles from './MemberPanel.module.css';

interface MemberPanelProps {
  /** T13.3 — widened from "in this voice channel" (pre-T13.3) to "connected to this server at
   * all," sourced from server-wide presence rather than voice-channel participation — see
   * `VoiceChannelView.tsx`'s own doc comment on this decision. */
  readonly connected: boolean;
  readonly groups: readonly MemberGroup[];
  /** Whether `groups` reflects real role-bucket grouping (at least one member holds a `roleBucket`)
   * — when `false`, `groups` is a single flat "Members" bucket and its own label is never repeated
   * as a redundant group header (mirrors this component's pre-T13.3 `hasRealGroups` logic exactly,
   * now driven by real presence data instead of a prop's mere presence). */
  readonly hasRealGroups: boolean;
  readonly totalCount: number;
  readonly avatarCache: ReadonlyMap<string, string>;
  readonly onRequestAvatar: (entry: MemberPanelEntry) => void;
  readonly onSelectMember: (entry: MemberPanelEntry) => void;
}

/** Right workspace column (T13.1, widened T13.3) — Discord-style, collapsible (local-only state),
 * built from real server-wide presence data only. Shows every currently-online member of the
 * connected server, grouped into "Admins"/"Moderators"/"Members" buckets when real role-bucket data
 * exists — never a persistent offline-member directory (an explicit, accepted T13.3 architecture
 * decision: no nickname persistence, no "endless anonymous Guest directory"). */
export function MemberPanel({
  connected,
  groups,
  hasRealGroups,
  totalCount,
  avatarCache,
  onRequestAvatar,
  onSelectMember,
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

  return (
    <aside className={styles.panel} aria-label="Members" data-testid="member-panel">
      <div className={styles.header}>
        <span className={styles.title} data-testid="member-panel-title">
          Members — {totalCount}
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
        {!connected ? (
          <EmptyState
            icon={Users}
            title="Not connected"
            description="Connect to a server to see who is here."
          />
        ) : groups.length === 0 ? (
          <EmptyState icon={Users} title="No one else is here" />
        ) : (
          groups.map((group) => (
            <div key={group.label} className={styles.group}>
              {hasRealGroups && (
                <div className={styles.groupLabel}>
                  {group.label} — {group.members.length}
                </div>
              )}
              <ul className={styles.list}>
                {group.members.map((member) => (
                  <MemberRow
                    key={member.key}
                    member={member}
                    avatarCache={avatarCache}
                    onRequestAvatar={() => {
                      onRequestAvatar(member);
                    }}
                    onSelect={() => {
                      onSelectMember(member);
                    }}
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
