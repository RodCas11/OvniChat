import { useState, type FormEvent, type ReactElement } from 'react';

import { Button } from '../ui/Button.js';
import { Modal } from '../ui/Modal.js';
import type { VoiceChannelActions, VoiceChannelState } from '../voice/use-voice-channel.js';
import { findNode } from './channel-tree.js';
import styles from './ChannelAdminForm.module.css';

interface PasswordJoinDialogProps {
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
}

/**
 * T13.2 — renders `state.channelPasswordPrompt` (populated by `use-voice-channel.ts` for both a
 * real user-initiated join and a T11 reconnect-restore attempt — `isRestore` only changes internal
 * hook behavior, never this dialog's own UI, per that state's own doc comment). The password is
 * never persisted anywhere beyond one `submitChannelPassword` call: the local field is cleared after
 * every submit attempt regardless of outcome, on top of the hook's own guarantee never to store it.
 */
export function PasswordJoinDialog({
  state,
  actions,
}: PasswordJoinDialogProps): ReactElement | null {
  const [password, setPassword] = useState('');
  const prompt = state.channelPasswordPrompt;
  if (!prompt) return null;

  const channelName = findNode(state.channelTree, prompt.channelId)?.name ?? 'this channel';

  function handleSubmit(event: FormEvent): void {
    event.preventDefault();
    if (password.length === 0) return;
    actions.submitChannelPassword(password);
    setPassword('');
  }

  function handleCancel(): void {
    setPassword('');
    actions.dismissChannelPasswordPrompt();
  }

  return (
    <Modal
      open
      onClose={handleCancel}
      title="Password required"
      size="small"
      testId="password-join-dialog"
    >
      <form className={styles.form} onSubmit={handleSubmit}>
        <p className={styles.confirmText}>&lsquo;{channelName}&rsquo; requires a password.</p>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>Password</span>
          <input
            type="password"
            className={styles.input}
            value={password}
            maxLength={128}
            autoFocus
            onChange={(event) => {
              setPassword(event.target.value);
            }}
            data-testid="password-join-input"
          />
        </label>

        {prompt.error && (
          <p className={styles.error} role="alert">
            {prompt.error}
          </p>
        )}

        <div className={styles.footer}>
          <Button variant="secondary" type="button" onClick={handleCancel}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={password.length === 0 || prompt.submitting}
            data-testid="password-join-submit"
          >
            Join
          </Button>
        </div>
      </form>
    </Modal>
  );
}
