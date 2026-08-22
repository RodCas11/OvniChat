import { useState, type FormEvent, type ReactElement } from 'react';

import type { TokenKind } from '@disco-voador/protocol';

import { Button } from '../ui/Button.js';
import type { VoiceChannelActions, VoiceChannelState } from './use-voice-channel.js';
import styles from './AuthorizationPanel.module.css';

interface TokensSectionProps {
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
}

/**
 * T9/T13.2 — extracted from `AuthorizationPanel.tsx` (unchanged behavior/markup) so both the
 * existing "Authorization" modal and the new Server Settings "Invites" page can render the exact
 * same token-generation UI without duplicating any of its `actions.createToken`/state-reading logic.
 * Self-hides entirely (returns `null`) without `authorization.tokens.manage` — a UX courtesy, not a
 * security boundary; the server re-validates regardless.
 */
export function TokensSection({ state, actions }: TokensSectionProps): ReactElement | null {
  const [tokenGroupId, setTokenGroupId] = useState('');
  const [tokenKind, setTokenKind] = useState<TokenKind>('invite');

  if (!state.myPermissions.includes('authorization.tokens.manage')) return null;

  function handleCreateToken(event: FormEvent): void {
    event.preventDefault();
    if (!tokenGroupId) return;
    actions.createToken(tokenKind, tokenGroupId);
  }

  return (
    <section className={styles.section}>
      <h4 className={styles.sectionTitle}>Tokens</h4>
      <form onSubmit={handleCreateToken} className={styles.form}>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Kind</span>
          <select
            className={styles.select}
            value={tokenKind}
            onChange={(event) => {
              setTokenKind(event.target.value as TokenKind);
            }}
          >
            <option value="invite">Invite</option>
            <option value="privilege">Privilege</option>
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.fieldLabel}>Group after redemption</span>
          <select
            className={styles.select}
            value={tokenGroupId}
            onChange={(event) => {
              setTokenGroupId(event.target.value);
            }}
          >
            <option value="">Select a group…</option>
            {(state.groups ?? []).map((group) => (
              <option key={group.groupId} value={group.groupId}>
                {group.name}
              </option>
            ))}
          </select>
        </label>
        <Button variant="secondary" type="submit" disabled={!tokenGroupId}>
          Generate
        </Button>
      </form>
      {state.lastCreatedToken && (
        <p className={styles.tokenReveal}>
          <code>{state.lastCreatedToken.token}</code>
          <br />
          Shown once — copy it now.
        </p>
      )}
    </section>
  );
}
