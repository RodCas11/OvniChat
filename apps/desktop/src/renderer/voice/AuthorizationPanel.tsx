import { useState, type FormEvent, type ReactElement } from 'react';

import type { PermissionKey, TokenKind } from '@disco-voador/protocol';

import type { VoiceChannelActions, VoiceChannelState } from './use-voice-channel.js';

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
    <section>
      <h3>Authorization</h3>
      <p>
        My groups:{' '}
        {state.myGroups.length > 0 ? state.myGroups.map((g) => g.name).join(', ') : 'Guest'}
      </p>

      <form onSubmit={handleRedeem}>
        <label>
          Privilege key / invite token
          <input
            value={tokenInput}
            onChange={(event) => {
              setTokenInput(event.target.value);
            }}
            placeholder="DV-..."
          />
        </label>
        <button type="submit" disabled={tokenInput.trim().length === 0}>
          Redeem
        </button>
      </form>
      {state.lastRedeemedGroup && <p>Success — now: {state.lastRedeemedGroup.name}</p>}

      {can('authorization.tokens.manage') && (
        <section>
          <h4>Tokens</h4>
          <form onSubmit={handleCreateToken}>
            <label>
              Kind
              <select
                value={tokenKind}
                onChange={(event) => {
                  setTokenKind(event.target.value as TokenKind);
                }}
              >
                <option value="invite">Invite</option>
                <option value="privilege">Privilege</option>
              </select>
            </label>
            <label>
              Group after redemption
              <select
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
            <button type="submit" disabled={!tokenGroupId}>
              Generate
            </button>
          </form>
          {state.lastCreatedToken && (
            <p>
              {state.lastCreatedToken.token}
              <br />
              Shown once — copy it now.
            </p>
          )}
        </section>
      )}

      {can('authorization.groups.manage') && (
        <section>
          <h4>Groups</h4>
          <button
            type="button"
            onClick={() => {
              actions.listGroups();
            }}
          >
            Refresh groups
          </button>
          <ul>
            {(state.groups ?? []).map((group) => (
              <li key={group.groupId}>
                {group.name} ({group.permissions.join(', ') || 'no permissions'})
                {!group.protectedGroup && (
                  <button
                    type="button"
                    onClick={() => {
                      actions.deleteGroup(group.groupId);
                    }}
                  >
                    Delete
                  </button>
                )}
              </li>
            ))}
          </ul>

          <form onSubmit={handleCreateGroup}>
            <label>
              Name
              <input
                value={newGroupName}
                onChange={(event) => {
                  setNewGroupName(event.target.value);
                }}
                maxLength={64}
              />
            </label>
            {ALL_PERMISSION_KEYS.map((permission) => (
              <label key={permission}>
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
            <button type="submit" disabled={newGroupName.trim().length === 0}>
              Create Group
            </button>
          </form>
        </section>
      )}

      {can('moderation.ban') && (
        <section>
          <h4>Bans</h4>
          <button
            type="button"
            onClick={() => {
              actions.listBans();
            }}
          >
            Refresh bans
          </button>
          <ul>
            {(state.bans ?? []).map((ban) => (
              <li key={ban.identityId}>
                {ban.identityId} {ban.expiresAt ? '(temporary)' : '(permanent)'}
                <button
                  type="button"
                  onClick={() => {
                    actions.unban(ban.identityId);
                    actions.listBans();
                  }}
                >
                  Unban
                </button>
              </li>
            ))}
          </ul>
          <form onSubmit={handleUnban}>
            <label>
              Unban by identity id
              <input
                value={unbanIdentityId}
                onChange={(event) => {
                  setUnbanIdentityId(event.target.value);
                }}
              />
            </label>
            <button type="submit" disabled={unbanIdentityId.trim().length === 0}>
              Unban
            </button>
          </form>
        </section>
      )}

      {state.currentChannelId &&
        (can('authorization.memberships.manage') ||
          can('moderation.kick') ||
          can('moderation.ban')) && (
          <section>
            <h4>Participants</h4>
            <ul>
              {state.participants.map((participant) => (
                <li key={participant.participantId}>
                  {participant.displayName}
                  {participant.groups.length > 0 &&
                    ` [${participant.groups.map((g) => g.name).join(', ')}]`}
                  {can('authorization.memberships.manage') && (state.groups ?? []).length > 0 && (
                    <select
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
                    <button
                      type="button"
                      onClick={() => {
                        actions.kick(participant.participantId);
                      }}
                    >
                      Kick
                    </button>
                  )}
                  {can('moderation.ban') && (
                    <button
                      type="button"
                      onClick={() => {
                        actions.ban(participant.participantId);
                      }}
                    >
                      Ban
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </section>
        )}
    </section>
  );
}
