import { useCallback, useState, type ReactElement } from 'react';

import { Button } from '../ui/Button.js';
import { UserAvatar } from '../ui/UserAvatar.js';
import { useToast } from '../ui/ToastProvider.js';
import type { VoiceChannelActions, VoiceChannelState } from '../voice/use-voice-channel.js';
import type { MemberPanelEntry } from './member-presentation.js';
import { describeProfileError } from './profile-error-copy.js';
import styles from './ChannelAdminForm.module.css';

interface MemberProfilePopoverProps {
  readonly member: MemberPanelEntry;
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
}

const ROLE_LABEL: Record<'admin' | 'moderator', string> = {
  admin: 'Admin',
  moderator: 'Moderator',
};

const PRESENCE_LABEL: Record<MemberPanelEntry['presence'], string> = {
  online: 'Online',
  away: 'Away',
  dnd: 'Do Not Disturb',
  offline: 'Offline',
};

/**
 * T13.3 — a read-mostly member profile view: avatar, display name, presence, custom status, and a
 * `roleBucket` badge if present. Deliberately has **no** DM/friend/message affordance of any kind —
 * Chantivo has no DM/social-graph system, a hard product boundary. A viewer holding
 * `moderation.profile.clear` additionally sees "Clear avatar"/"Clear status" actions for this member
 * — clear-only, matching the honest-limits doctrine (there is no way to set someone else's content).
 */
export function MemberProfilePopover({
  member,
  state,
  actions,
}: MemberProfilePopoverProps): ReactElement {
  const { showToast } = useToast();
  const [clearingAvatar, setClearingAvatar] = useState(false);
  const [clearingStatus, setClearingStatus] = useState(false);

  const requestAvatar = useCallback(() => {
    actions.requestAvatar('member', member.key);
  }, [actions, member.key]);

  const handleClearAvatar = useCallback(() => {
    setClearingAvatar(true);
    actions
      .clearMemberAvatar(member.key)
      .then(() => {
        showToast('Avatar cleared.', 'success');
      })
      .catch((error: unknown) => {
        showToast(describeProfileError(error), 'error');
      })
      .finally(() => {
        setClearingAvatar(false);
      });
  }, [actions, member.key, showToast]);

  const handleClearStatus = useCallback(() => {
    setClearingStatus(true);
    actions
      .clearMemberStatus(member.key)
      .then(() => {
        showToast('Status cleared.', 'success');
      })
      .catch((error: unknown) => {
        showToast(describeProfileError(error), 'error');
      })
      .finally(() => {
        setClearingStatus(false);
      });
  }, [actions, member.key, showToast]);

  return (
    <div className={styles.form}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--chantivo-space-4)' }}>
        <UserAvatar
          name={member.displayName}
          colorSeed={member.key}
          size="large"
          avatarRef={member.avatarRef}
          avatarCache={state.avatarCache}
          onRequestAvatar={requestAvatar}
        />
        <div>
          <p className={styles.confirmText} data-testid="member-popover-name">
            {member.displayName}
          </p>
          <p className={styles.hint}>
            {PRESENCE_LABEL[member.presence]}
            {member.roleBucket && ` · ${ROLE_LABEL[member.roleBucket]}`}
          </p>
        </div>
      </div>

      {member.customStatus && <p className={styles.hint}>{member.customStatus}</p>}

      {member.canModerate && (
        <div className={styles.section}>
          <h3 className={styles.sectionTitle}>Moderation</h3>
          <div className={styles.footer}>
            {member.avatarRef && (
              <Button
                variant="secondary"
                disabled={clearingAvatar}
                onClick={handleClearAvatar}
                data-testid="member-popover-clear-avatar"
              >
                Clear avatar
              </Button>
            )}
            {member.customStatus && (
              <Button
                variant="secondary"
                disabled={clearingStatus}
                onClick={handleClearStatus}
                data-testid="member-popover-clear-status"
              >
                Clear status
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
