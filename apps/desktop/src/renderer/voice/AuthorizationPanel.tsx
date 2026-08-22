import { useState, type FormEvent, type ReactElement } from 'react';

import type { PermissionKey, TokenKind } from '@disco-voador/protocol';

import { Button } from '../ui/Button.js';
import type { VoiceChannelActions, VoiceChannelState } from './use-voice-channel.js';
import styles from './AuthorizationPanel.module.css';

interface AuthorizationPanelProps {
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
}

const PERMISSION_LABELS: Record<PermissionKey, string> = {
  'voice.channel.join': 'Join voice channels',
  'moderation.kick': 'Kick',
  'moderation.ban': 'Ban',
  'authorization.groups.manage': 'Manage groups',
  'authorization.memberships.manage': 'Manage memberships',
  'authorization.tokens.manage': 'Manage tokens',
  'server.manage': 'Manage server',
  'chat.server.send': 'Send server chat',
  'chat.channel.send': 'Send channel chat',
};
const ALL_PERMISSION_KEYS = Object.keys(PERMISSION_LABELS) as readonly PermissionKey[];

/**
 * T9 minimal server administration UI (Section 40-46/83-84): functional, not polished — plain
 * forms, no styling. Every action here is presentation-only convenience; the Dedicated Server
 * re-validates every request itself regardless of what this panel chooses to show (Section 35).
 * Sections a caller lacks the corresponding permission for are simply omitted, which is a UX
 * courtesy, not a security boundary — a denied request still surfaces as an ordinary
 * `state.lastError` if somehow attempted anyway.
 */
export function AuthorizationPanel({ state, actions }: AuthorizationPanelProps): ReactElement {
  const [tokenInput, setTokenInput] = useState('');
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupPermissions, setNewGroupPermissions] = useState<readonly PermissionKey[]>([]);
  const [tokenGroupId, setTokenGroupId] = useState('');
  const [tokenKind, setTokenKind] = useState<TokenKind>('invite');
  const [unbanIdentityId, setUnbanIdentityId] = useState('');

  const can = (permission: PermissionKey): boolean => state.myPermissions.includes(permission);

  function handleRedeem(event: FormEvent): void {
    event.preventDefault();
    if (!tokenInput.trim()) return;
    actions.redeemToken(tokenInput.trim());
    setTokenInput('');
  }

  function handleCreateGroup(event: FormEvent): void {
    event.preventDefault();
    if (!newGroupName.trim()) return;
    actions.createGroup(newGroupName.trim(), newGroupPermissions);
    setNewGroupName('');
    setNewGroupPermissions([]);
  }

  function handleCreateToken(event: FormEvent): void {
    event.preventDefault();
    if (!tokenGroupId) return;
    actions.createToken(tokenKind, tokenGroupId);
  }

  function handleUnban(event: FormEvent): void {
    event.preventDefault();
    if (!unbanIdentityId.trim()) return;
    actions.unban(unbanIdentityId.trim());
    setUnbanIdentityId('');
    actions.listBans();
  }

  function togglePermission(permission: PermissionKey): void {
    setNewGroupPermissions((prev) =>
      prev.includes(permission) ? prev.filter((p) => p !== permission) : [...prev, permission],
    );
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

      {can('authorization.tokens.manage') && (
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
      )}

      {can('authorization.groups.manage') && (
        <section className={styles.section}>
          <h4 className={styles.sectionTitle}>Groups</h4>
          <Button
            variant="ghost"
            onClick={() => {
              actions.listGroups();
            }}
          >
            Refresh groups
          </Button>
          <ul className={styles.list}>
            {(state.groups ?? []).map((group) => (
              <li key={group.groupId} className={styles.listRow}>
                <span>
                  {group.name} ({group.permissions.join(', ') || 'no permissions'})
                </span>
                {!group.protectedGroup && (
                  <Button
                    variant="danger"
                    onClick={() => {
                      actions.deleteGroup(group.groupId);
                    }}
                  >
                    Delete
                  </Button>
                )}
              </li>
            ))}
          </ul>

          <form onSubmit={handleCreateGroup} className={styles.form}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Name</span>
              <input
                className={styles.input}
                value={newGroupName}
                onChange={(event) => {
                  setNewGroupName(event.target.value);
                }}
                maxLength={64}
              />
            </label>
            <div className={styles.checkboxGrid}>
              {ALL_PERMISSION_KEYS.map((permission) => (
                <label key={permission} className={styles.checkboxField}>
                  <input
                    type="checkbox"
                    checked={newGroupPermissions.includes(permission)}
                    onChange={() => {
                      togglePermission(permission);
                    }}
                  />
                  {PERMISSION_LABELS[permission]}
                </label>
              ))}
            </div>
            <Button variant="secondary" type="submit" disabled={newGroupName.trim().length === 0}>
              Create Group
            </Button>
          </form>
        </section>
      )}

      {can('moderation.ban') && (
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
            <Button
              variant="secondary"
              type="submit"
              disabled={unbanIdentityId.trim().length === 0}
            >
              Unban
            </Button>
          </form>
        </section>
      )}

      {state.currentChannelId &&
        (can('authorization.memberships.manage') ||
          can('moderation.kick') ||
          can('moderation.ban')) && (
          <section className={styles.section}>
            <h4 className={styles.sectionTitle}>Participants</h4>
            <ul className={styles.list}>
              {state.participants.map((participant) => (
                <li key={participant.participantId} className={styles.listRow}>
                  <span>
                    {participant.displayName}
                    {participant.groups.length > 0 &&
                      ` [${participant.groups.map((g) => g.name).join(', ')}]`}
                  </span>
                  <div className={styles.listRowActions}>
                    {can('authorization.memberships.manage') && (state.groups ?? []).length > 0 && (
                      <select
                        className={styles.select}
                        onChange={(event) => {
                          if (event.target.value) {
                            actions.grantGroup(participant.participantId, event.target.value);
                            event.target.value = '';
                          }
                        }}
                        defaultValue=""
                      >
                        <option value="" disabled>
                          Grant group…
                        </option>
                        {(state.groups ?? []).map((group) => (
                          <option key={group.groupId} value={group.groupId}>
                            {group.name}
                          </option>
                        ))}
                      </select>
                    )}
                    {can('moderation.kick') && (
                      <Button
                        variant="secondary"
                        onClick={() => {
                          actions.kick(participant.participantId);
                        }}
                      >
                        Kick
                      </Button>
                    )}
                    {can('moderation.ban') && (
                      <Button
                        variant="danger"
                        onClick={() => {
                          actions.ban(participant.participantId);
                        }}
                      >
                        Ban
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
    </div>
  );
}
