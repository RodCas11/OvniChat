import { useState, type FormEvent, type ReactElement } from 'react';

import { Button } from '../ui/Button.js';
import type { VoiceChannelActions, VoiceChannelState } from './use-voice-channel.js';
import styles from './AuthorizationPanel.module.css';

interface BansSectionProps {
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
}

/** T9/T13.2 — extracted from `AuthorizationPanel.tsx` (unchanged behavior/markup); see
 * `TokensSection.tsx`'s own doc comment for why this extraction exists. */
export function BansSection({ state, actions }: BansSectionProps): ReactElement | null {
  const [unbanIdentityId, setUnbanIdentityId] = useState('');

  if (!state.myPermissions.includes('moderation.ban')) return null;

  function handleUnban(event: FormEvent): void {
    event.preventDefault();
    if (!unbanIdentityId.trim()) return;
    actions.unban(unbanIdentityId.trim());
    setUnbanIdentityId('');
    actions.listBans();
  }

  return (
    <section className={styles.section}>
      <h4 className={styles.sectionTitle}>Bans</h4>
      <Button
        variant="ghost"
        onClick={() => {
          actions.listBans();
        }}
      >
        Refresh bans
      </Button>
      <ul className={styles.list}>
        {(state.bans ?? []).map((ban) => (
          <li key={ban.identityId} className={styles.listRow}>
            <span>
              {ban.identityId} {ban.expiresAt ? '(temporary)' : '(permanent)'}
            </span>
            <Button
              variant="secondary"
              onClick={() => {
                actions.unban(ban.identityId);
                actions.listBans();
              }}
            >
              Unban
            </Button>
          </li>
        ))}
      </ul>
      <form onSubmit={handleUnban} className={styles.form}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Unban by identity id</span>
          <input
            className={styles.input}
            value={unbanIdentityId}
            onChange={(event) => {
              setUnbanIdentityId(event.target.value);
            }}
          />
        </label>
        <Button variant="secondary" type="submit" disabled={unbanIdentityId.trim().length === 0}>
          Unban
        </Button>
      </form>
    </section>
  );
}
