import { useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';

import type { AclPolicyKind, ChannelNodeAdminView, ManagePolicyKind } from '@disco-voador/protocol';

import type { VoiceChannelActions, VoiceChannelState } from '../voice/use-voice-channel.js';
import {
  resolveJoinPolicy,
  resolveManagePolicy,
  resolveVisibilityPolicy,
  type ResolvedPolicy,
} from './channel-tree.js';
import styles from './ChannelAdminForm.module.css';

export interface ChannelAclValue {
  readonly visibilityPolicy: AclPolicyKind;
  readonly visibilityGroupIds: readonly string[];
  readonly joinPolicy: AclPolicyKind;
  readonly joinGroupIds: readonly string[];
  readonly managePolicy: ManagePolicyKind;
  readonly manageGroupIds: readonly string[];
}

interface ChannelAclEditorProps {
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
  /** The node's real parent (Edit), or the intended parent (Create) — `undefined` for a top-level
   * node. Used only to resolve what "Same as parent" would currently mean, exactly mirroring
   * `ChannelPort`'s own nearest-non-inherit-ancestor walk via `channel-tree.ts`'s read-only mirror
   * of that algorithm (see that module's own doc comment) — this never makes or influences a real
   * access decision. */
  readonly parentId: string | undefined;
  readonly value: ChannelAclValue;
  readonly onChange: (patch: Partial<ChannelAclValue>) => void;
}

/**
 * T13.2 — the three real ACL axes a category or voice channel owns: Visibility, Join, Manage.
 * Deliberately has no "Who can speak?" control of any kind — the P2P mesh has no enforcement point
 * for it (see `services/realtime/src/channel-port.ts`'s file-level doc comment, "Deliberately
 * omitted: who may speak").
 */
export function ChannelAclEditor({
  state,
  actions,
  parentId,
  value,
  onChange,
}: ChannelAclEditorProps): ReactElement {
  const groupsRequestedRef = useRef(false);
  useEffect(() => {
    if (state.groups === undefined && !groupsRequestedRef.current) {
      groupsRequestedRef.current = true;
      actions.listGroups();
    }
  }, [state.groups, actions]);

  // Simulates "what would a fresh inherit-child of `parentId` resolve to" — see this module's own
  // `parentId` doc comment above for why resolving *at* the parent (rather than at some real
  // nodeId) is the correct simulation for both Create (no real node yet) and Edit (the node's own
  // current stored value must never pollute this, since the note should reflect the live *draft*
  // choice, not necessarily what happens to already be saved).
  const visibilityResolved: ResolvedPolicy<AclPolicyKind> = parentId
    ? resolveVisibilityPolicy(state.channelTree, parentId)
    : { source: undefined, policy: 'everyone' };
  const joinResolved: ResolvedPolicy<AclPolicyKind> = parentId
    ? resolveJoinPolicy(state.channelTree, parentId)
    : { source: undefined, policy: 'everyone' };
  const manageResolved: ResolvedPolicy<ManagePolicyKind> = parentId
    ? resolveManagePolicy(state.channelTree, parentId)
    : { source: undefined, policy: 'inherit' };

  const visibilityAncestor = useAncestorAdminView(
    actions,
    visibilityResolved.policy === 'selected-groups' ? visibilityResolved.source?.nodeId : undefined,
  );
  const joinAncestor = useAncestorAdminView(
    actions,
    joinResolved.policy === 'selected-groups' ? joinResolved.source?.nodeId : undefined,
  );
  const manageAncestor = useAncestorAdminView(
    actions,
    manageResolved.policy === 'selected-groups' ? manageResolved.source?.nodeId : undefined,
  );

  const groupName = (groupId: string): string | undefined =>
    state.groups?.find((group) => group.groupId === groupId)?.name;

  function toggleGroupId(
    axis: 'visibilityGroupIds' | 'joinGroupIds' | 'manageGroupIds',
    groupId: string,
  ): void {
    const current = value[axis];
    const next = current.includes(groupId)
      ? current.filter((id) => id !== groupId)
      : [...current, groupId];
    onChange({ [axis]: next } as Partial<ChannelAclValue>);
  }

  return (
    <div className={styles.section}>
      <h4 className={styles.sectionTitle}>Permissions</h4>

      <AclAxis
        legend="Who can see this channel?"
        options={[
          {
            value: 'inherit',
            label: parentId
              ? 'Same as parent'
              : 'Same as parent (defaults to Everyone — no parent)',
          },
          { value: 'everyone', label: 'Everyone' },
          { value: 'selected-groups', label: 'Selected groups' },
        ]}
        selected={value.visibilityPolicy}
        onSelect={(policy) => {
          onChange({ visibilityPolicy: policy as AclPolicyKind });
        }}
        name="visibilityPolicy"
      >
        {value.visibilityPolicy === 'selected-groups' && (
          <GroupCheckboxList
            groups={state.groups}
            selectedIds={value.visibilityGroupIds}
            onToggle={(groupId) => {
              toggleGroupId('visibilityGroupIds', groupId);
            }}
          />
        )}
        {value.visibilityPolicy === 'inherit' && (
          <InheritNote
            resolved={visibilityResolved}
            ancestorAdminView={visibilityAncestor}
            groupName={groupName}
          />
        )}
      </AclAxis>

      <AclAxis
        legend="Who can join this channel?"
        options={[
          {
            value: 'inherit',
            label: parentId
              ? 'Same as parent'
              : 'Same as parent (defaults to Everyone — no parent)',
          },
          { value: 'everyone', label: 'Everyone' },
          { value: 'selected-groups', label: 'Selected groups' },
        ]}
        selected={value.joinPolicy}
        onSelect={(policy) => {
          onChange({ joinPolicy: policy as AclPolicyKind });
        }}
        name="joinPolicy"
      >
        {value.joinPolicy === 'selected-groups' && (
          <GroupCheckboxList
            groups={state.groups}
            selectedIds={value.joinGroupIds}
            onToggle={(groupId) => {
              toggleGroupId('joinGroupIds', groupId);
            }}
          />
        )}
        {value.joinPolicy === 'inherit' && (
          <InheritNote
            resolved={joinResolved}
            ancestorAdminView={joinAncestor}
            groupName={groupName}
          />
        )}
      </AclAxis>

      <AclAxis
        legend="Who can manage this channel?"
        options={[
          {
            value: 'inherit',
            label: parentId
              ? 'Same as parent'
              : 'Same as parent (no parent — only Server Admins with the global Manage permission)',
          },
          { value: 'selected-groups', label: 'Selected groups' },
        ]}
        selected={value.managePolicy}
        onSelect={(policy) => {
          onChange({ managePolicy: policy as ManagePolicyKind });
        }}
        name="managePolicy"
      >
        {value.managePolicy === 'selected-groups' && (
          <GroupCheckboxList
            groups={state.groups}
            selectedIds={value.manageGroupIds}
            onToggle={(groupId) => {
              toggleGroupId('manageGroupIds', groupId);
            }}
          />
        )}
        {value.managePolicy === 'inherit' && (
          <InheritNote
            resolved={manageResolved}
            ancestorAdminView={manageAncestor}
            groupName={groupName}
          />
        )}
      </AclAxis>
    </div>
  );
}

interface AclAxisOption {
  readonly value: string;
  readonly label: string;
}

function AclAxis({
  legend,
  options,
  selected,
  onSelect,
  name,
  children,
}: {
  readonly legend: string;
  readonly options: readonly AclAxisOption[];
  readonly selected: string;
  readonly onSelect: (value: string) => void;
  readonly name: string;
  readonly children?: ReactNode;
}): ReactElement {
  return (
    <fieldset className={styles.field} style={{ border: 'none', margin: 0, padding: 0 }}>
      <legend className={styles.fieldLabel}>{legend}</legend>
      <div className={styles.radioGroup}>
        {options.map((option) => (
          <label key={option.value} className={styles.radioOption}>
            <input
              type="radio"
              name={name}
              value={option.value}
              checked={selected === option.value}
              onChange={() => {
                onSelect(option.value);
              }}
            />
            {option.label}
          </label>
        ))}
      </div>
      {children}
    </fieldset>
  );
}

function GroupCheckboxList({
  groups,
  selectedIds,
  onToggle,
}: {
  readonly groups: VoiceChannelState['groups'];
  readonly selectedIds: readonly string[];
  readonly onToggle: (groupId: string) => void;
}): ReactElement {
  if (groups === undefined) {
    return <p className={styles.hint}>Loading groups…</p>;
  }
  if (groups.length === 0) {
    return <p className={styles.hint}>No groups exist on this server yet.</p>;
  }
  return (
    <div className={styles.checkboxGrid}>
      {groups.map((group) => (
        <label key={group.groupId} className={styles.checkboxField}>
          <input
            type="checkbox"
            checked={selectedIds.includes(group.groupId)}
            onChange={() => {
              onToggle(group.groupId);
            }}
          />
          {group.name}
        </label>
      ))}
    </div>
  );
}

/** Shows where an "Inherit" axis actually resolves from, using real group names when this identity
 * can see them — never a raw group id, and never a guessed name (see this module's own file-level
 * doc comment on the "identity can't see the ancestor's group-id list" edge case). */
function InheritNote({
  resolved,
  ancestorAdminView,
  groupName,
}: {
  readonly resolved: ResolvedPolicy<string>;
  readonly ancestorAdminView: ChannelNodeAdminView | 'denied' | undefined;
  readonly groupName: (groupId: string) => string | undefined;
}): ReactElement {
  if (!resolved.source) {
    return (
      <p className={styles.inheritNote}>
        {resolved.policy === 'everyone'
          ? 'No ancestor sets this — resolves to Everyone.'
          : 'No ancestor sets this.'}
      </p>
    );
  }
  if (resolved.policy !== 'selected-groups') {
    return (
      <p className={styles.inheritNote}>
        Inherited from &lsquo;{resolved.source.name}&rsquo; —{' '}
        {resolved.policy === 'everyone' ? 'Everyone' : resolved.policy}.
      </p>
    );
  }
  if (ancestorAdminView === undefined) {
    return (
      <p className={styles.inheritNote}>Inherited from &lsquo;{resolved.source.name}&rsquo;…</p>
    );
  }
  if (ancestorAdminView === 'denied') {
    // Never guess — this identity cannot see that ancestor's own group-id list.
    return (
      <p className={styles.inheritNote}>Inherited from &lsquo;{resolved.source.name}&rsquo;.</p>
    );
  }
  const groupIds = resolveMatchingGroupIds(ancestorAdminView, resolved) ?? [];
  const names = groupIds.map(groupName).filter((name): name is string => Boolean(name));
  return (
    <p className={styles.inheritNote}>
      Inherited from &lsquo;{resolved.source.name}&rsquo;
      {names.length > 0 ? ` — Allowed: ${names.join(', ')}` : ''}
    </p>
  );
}

/** Picks the one group-id list on `adminView` that actually corresponds to the axis `resolved` was
 * computed for, by matching which of the ancestor's own three policy fields equals the resolved
 * policy kind at that ancestor. Ambiguous only if an ancestor happens to set more than one axis to
 * `'selected-groups'` with the exact same resolved kind — in that rare case this still returns a
 * real (not fabricated) group-id list, just not guaranteed to be the *intended* axis; never worth
 * more complexity than passing the axis name through explicitly would cost, given this only feeds a
 * read-only inheritance hint, never a security decision. */
function resolveMatchingGroupIds(
  adminView: ChannelNodeAdminView,
  resolved: ResolvedPolicy<string>,
): readonly string[] | undefined {
  if (resolved.policy !== 'selected-groups') return undefined;
  if (adminView.visibilityPolicy === 'selected-groups') return adminView.visibilityGroupIds;
  if (adminView.joinPolicy === 'selected-groups') return adminView.joinGroupIds;
  if (adminView.managePolicy === 'selected-groups') return adminView.manageGroupIds;
  return undefined;
}

/** Opportunistically fetches an ancestor's own admin view (only ever for a node whose resolved axis
 * is `'selected-groups'`, to list real group names) — a denial is expected and silent (this
 * identity may hold delegated Manage on the node being edited without holding it on some unrelated
 * ancestor higher up the chain), never surfaced as an error toast. */
function useAncestorAdminView(
  actions: VoiceChannelActions,
  nodeId: string | undefined,
): ChannelNodeAdminView | 'denied' | undefined {
  const [result, setResult] = useState<ChannelNodeAdminView | 'denied' | undefined>(undefined);
  const requestedRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!nodeId) {
      requestedRef.current = undefined;
      setResult(undefined);
      return;
    }
    if (requestedRef.current === nodeId) return;
    requestedRef.current = nodeId;
    let cancelled = false;
    actions
      .getEditableChannelNode(nodeId)
      .then((node) => {
        if (!cancelled) setResult(node);
      })
      .catch(() => {
        if (!cancelled) setResult('denied');
      });
    return () => {
      cancelled = true;
    };
  }, [actions, nodeId]);

  return result;
}
