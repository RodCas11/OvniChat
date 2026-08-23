import { useCallback, useState, type ReactElement } from 'react';

import { CUSTOM_STATUS_MAX_LENGTH, type PresenceStatus } from '@disco-voador/protocol';

import { Button } from '../ui/Button.js';
import { UserAvatar } from '../ui/UserAvatar.js';
import { useToast } from '../ui/ToastProvider.js';
import type { VoiceChannelActions, VoiceChannelState } from '../voice/use-voice-channel.js';
import { describeProfileError } from './profile-error-copy.js';
import styles from './ChannelAdminForm.module.css';

interface ProfileEditorProps {
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
  readonly displayName: string;
  readonly serverName: string;
}

const PRESENCE_OPTIONS: readonly { readonly value: PresenceStatus; readonly label: string }[] = [
  { value: 'online', label: 'Online' },
  { value: 'away', label: 'Away' },
  { value: 'dnd', label: 'Do Not Disturb' },
];

/**
 * T13.3 — the current user's own Profile editor: avatar upload/remove, custom status (bounded,
 * self-service only), and the manual Online/Away/Do Not Disturb presence selector. Deliberately no
 * "Invisible" option — this wire protocol has only three manual presence values (see
 * `PresenceStatus`) and no automatic idle/away/Rich-Presence detection of any kind. Uses "Profile"
 * terminology throughout, and makes the current-server context explicit (`Profile on {serverName}`)
 * so it is never mistaken for a global/cross-server identity — this is visual-profile state, wholly
 * distinct from `identityId` (never read, displayed, or editable here).
 */
export function ProfileEditor({
  state,
  actions,
  displayName,
  serverName,
}: ProfileEditorProps): ReactElement {
  const { showToast } = useToast();
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | undefined>(undefined);
  const [statusDraft, setStatusDraft] = useState(state.selfCustomStatus ?? '');
  const [statusSubmitting, setStatusSubmitting] = useState(false);
  const [statusError, setStatusError] = useState<string | undefined>(undefined);

  const requestSelfAvatar = useCallback(() => {
    actions.requestAvatar('self');
  }, [actions]);

  const handleChangeAvatar = useCallback(() => {
    setAvatarError(undefined);
    setAvatarBusy(true);
    void (async () => {
      try {
        const picked = await window.desktopApp.selectAvatarImageFile(512);
        if (!picked) return; // user dismissed the picker
        if (!picked.ok) {
          setAvatarError(picked.message);
          return;
        }
        await actions.setAvatar('self', picked.format, picked.base64);
      } catch (error) {
        setAvatarError(describeProfileError(error));
      } finally {
        setAvatarBusy(false);
      }
    })();
  }, [actions]);

  const handleRemoveAvatar = useCallback(() => {
    setAvatarError(undefined);
    setAvatarBusy(true);
    actions
      .clearSelfAvatar()
      .catch((error: unknown) => {
        setAvatarError(describeProfileError(error));
      })
      .finally(() => {
        setAvatarBusy(false);
      });
  }, [actions]);

  const handleSaveStatus = useCallback(() => {
    setStatusError(undefined);
    setStatusSubmitting(true);
    const trimmed = statusDraft.trim();
    actions
      .setCustomStatus(trimmed.length > 0 ? trimmed : undefined)
      .then(() => {
        showToast('Status updated.', 'success');
      })
      .catch((error: unknown) => {
        setStatusError(describeProfileError(error));
      })
      .finally(() => {
        setStatusSubmitting(false);
      });
  }, [actions, statusDraft, showToast]);

  const handlePresenceChange = useCallback(
    (presence: PresenceStatus) => {
      actions.setPresence(presence).catch((error: unknown) => {
        showToast(describeProfileError(error), 'error');
      });
    },
    [actions, showToast],
  );

  return (
    <div className={styles.form}>
      <p className={styles.hint} data-testid="profile-editor-server-context">
        Profile on {serverName}
      </p>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Avatar</h3>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--ovni-space-4)' }}>
          <UserAvatar
            name={displayName}
            size="large"
            avatarRef={state.selfAvatarRef}
            avatarCache={state.avatarCache}
            onRequestAvatar={requestSelfAvatar}
          />
          <div style={{ display: 'flex', gap: 'var(--ovni-space-2)' }}>
            <Button
              variant="secondary"
              disabled={avatarBusy}
              onClick={handleChangeAvatar}
              data-testid="profile-editor-change-avatar"
            >
              Change
            </Button>
            {state.selfAvatarRef && (
              <Button
                variant="ghost"
                disabled={avatarBusy}
                onClick={handleRemoveAvatar}
                data-testid="profile-editor-remove-avatar"
              >
                Remove
              </Button>
            )}
          </div>
        </div>
        {avatarError && <p className={styles.error}>{avatarError}</p>}
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Status</h3>
        <div className={styles.field}>
          <label className={styles.fieldLabel} htmlFor="profile-editor-status">
            Custom status
          </label>
          <input
            id="profile-editor-status"
            className={styles.input}
            type="text"
            value={statusDraft}
            maxLength={CUSTOM_STATUS_MAX_LENGTH}
            onChange={(event) => {
              setStatusDraft(event.target.value);
            }}
            data-testid="profile-editor-status-input"
          />
          <p className={styles.hint}>
            {statusDraft.length}/{CUSTOM_STATUS_MAX_LENGTH}
          </p>
        </div>
        {statusError && <p className={styles.error}>{statusError}</p>}
        <div className={styles.footer}>
          <Button
            variant="primary"
            disabled={statusSubmitting}
            onClick={handleSaveStatus}
            data-testid="profile-editor-save-status"
          >
            Save status
          </Button>
        </div>
      </div>

      <div className={styles.section}>
        <h3 className={styles.sectionTitle}>Presence</h3>
        <div className={styles.radioGroup} role="radiogroup" aria-label="Presence">
          {PRESENCE_OPTIONS.map((option) => (
            <label key={option.value} className={styles.radioOption}>
              <input
                type="radio"
                name="profile-editor-presence"
                checked={state.selfPresence === option.value}
                onChange={() => {
                  handlePresenceChange(option.value);
                }}
                data-testid={`profile-editor-presence-${option.value}`}
              />
              {option.label}
            </label>
          ))}
        </div>
      </div>
    </div>
  );
}
