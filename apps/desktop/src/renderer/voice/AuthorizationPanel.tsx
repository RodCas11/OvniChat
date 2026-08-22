import { useState, type FormEvent, type ReactElement } from 'react';

import { Button } from '../ui/Button.js';
import { BansSection } from './BansSection.js';
import { GroupsSection } from './GroupsSection.js';
import { TokensSection } from './TokensSection.js';
import type { VoiceChannelActions, VoiceChannelState } from './use-voice-channel.js';
import styles from './AuthorizationPanel.module.css';

interface AuthorizationPanelProps {
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
}

/**
 * T9/T13.2 — the redeem-token form (always available, admin or not) plus the Tokens/Groups/
 * Participants/Bans admin sections, each of which self-hides without the relevant permission (a UX
 * courtesy, not a security boundary — the Dedicated Server re-validates every request itself
 * regardless of what this panel chooses to show, T9 Section 35). T13.2 extracted the three admin
 * sections into `TokensSection.tsx`/`GroupsSection.tsx`/`BansSection.tsx` so the new Server Settings
 * shell (`ServerSettingsModal.tsx`) can mount the exact same presentation on its own "Invites"/
 * "Groups & Permissions"/"Bans" pages without duplicating any of this state/network logic — this
 * component's own rendered output is unchanged by that extraction.
 */
export function AuthorizationPanel({ state, actions }: AuthorizationPanelProps): ReactElement {
  const [tokenInput, setTokenInput] = useState('');

  function handleRedeem(event: FormEvent): void {
    event.preventDefault();
    if (!tokenInput.trim()) return;
    actions.redeemToken(tokenInput.trim());
    setTokenInput('');
  }

  return (
    <div className={styles.container}>
      <p className={styles.myGroups}>
        My groups:{' '}
        <strong>
          {state.myGroups.length > 0 ? state.myGroups.map((g) => g.name).join(', ') : 'Guest'}
        </strong>
      </p>

      <form onSubmit={handleRedeem} className={styles.redeemForm}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Privilege key / invite token</span>
          <input
            className={styles.input}
            value={tokenInput}
            onChange={(event) => {
              setTokenInput(event.target.value);
            }}
            placeholder="DV-..."
          />
        </label>
        <Button variant="primary" type="submit" disabled={tokenInput.trim().length === 0}>
          Redeem
        </Button>
      </form>
      {state.lastRedeemedGroup && (
        <p className={styles.success}>Success — now: {state.lastRedeemedGroup.name}</p>
      )}

      <TokensSection state={state} actions={actions} />
      <GroupsSection state={state} actions={actions} />
      <BansSection state={state} actions={actions} />
    </div>
  );
}
