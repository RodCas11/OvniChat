import { useState, type FormEvent, type ReactElement } from 'react';

import type { PermissionKey } from '@disco-voador/protocol';

import { Button } from '../ui/Button.js';
import type { VoiceChannelActions, VoiceChannelState } from './use-voice-channel.js';
import styles from './AuthorizationPanel.module.css';

interface GroupsSectionProps {
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
  'channels.create': 'Create channels',
  'channels.manage': 'Manage all channels',
  'channels.delete': 'Delete channels',
  'channels.password.bypass': 'Bypass channel passwords',
};
const ALL_PERMISSION_KEYS = Object.keys(PERMISSION_LABELS) as readonly PermissionKey[];

/**
 * T9/T13.2 — extracted from `AuthorizationPanel.tsx` (unchanged behavior/markup); see
 * `TokensSection.tsx`'s own doc comment for why this extraction exists. Bundles the Groups CRUD
 * block together with the per-participant grant/kick/ban block (T13.2 product judgment: both are
 * "who can do what" administration, and the participant roster only exists in the first place while
 * the connection is joined to a voice channel, so folding them into one Server Settings page reads
 * more coherently than inventing a fifth nav section for a roster that is not always even
 * renderable).
 */
export function GroupsSection({ state, actions }: GroupsSectionProps): ReactElement {
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupPermissions, setNewGroupPermissions] = useState<readonly PermissionKey[]>([]);

  const can = (permission: PermissionKey): boolean => state.myPermissions.includes(permission);

  function handleCreateGroup(event: FormEvent): void {
    event.preventDefault();
    if (!newGroupName.trim()) return;
    actions.createGroup(newGroupName.trim(), newGroupPermissions);
    setNewGroupName('');
    setNewGroupPermissions([]);
  }

  function togglePermission(permission: PermissionKey): void {
    setNewGroupPermissions((prev) =>
      prev.includes(permission) ? prev.filter((p) => p !== permission) : [...prev, permission],
    );
  }

  return (
    <>
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
    </>
  );
}
