import type { ReactElement } from 'react';
import { FolderPlus, Move, Pencil, Plus, Trash2 } from 'lucide-react';

import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';
import { IconButton } from '../ui/IconButton.js';
import type { VoiceChannelActions, VoiceChannelState } from '../voice/use-voice-channel.js';
import type { ChannelAdminIntent } from './channel-admin-intent.js';
import { buildChannelTree, type ChannelTreeNode } from './channel-tree.js';
import { useEditableNodeCheck } from './use-editable-node-check.js';
import styles from './ChannelAdminForm.module.css';

interface ChannelsAdminPageProps {
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
  readonly onAdminIntent: (intent: ChannelAdminIntent) => void;
}

/**
 * T13.2 — the discoverable, always-reachable tree-management view inside Server Settings (item J).
 * Context menus (`ChannelContextMenu.tsx`) remain the other path to the same actions — this page
 * exists so an admin does not have to know right-click is available at all. Only ever renders an
 * admin affordance the current identity can actually use, via the same optimistic
 * `getEditableChannelNode` gating `ChannelContextMenu.tsx` uses (see `use-editable-node-check.ts`).
 */
export function ChannelsAdminPage({
  state,
  actions,
  onAdminIntent,
}: ChannelsAdminPageProps): ReactElement {
  const canCreateRoot = state.myPermissions.includes('channels.create');
  const tree = buildChannelTree(state.channelTree);

  return (
    <div className={styles.form}>
      <div className={styles.footer} style={{ justifyContent: 'flex-start' }}>
        {canCreateRoot && (
          <>
            <Button
              variant="secondary"
              onClick={() => {
                onAdminIntent({ type: 'create-category' });
              }}
              data-testid="channels-admin-create-category"
            >
              <FolderPlus size={14} aria-hidden="true" />
              Create Category
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                onAdminIntent({ type: 'create-channel', parentLocked: false });
              }}
              data-testid="channels-admin-create-channel"
            >
              <Plus size={14} aria-hidden="true" />
              Create Channel
            </Button>
          </>
        )}
      </div>

      {tree.length === 0 ? (
        <EmptyState
          icon={FolderPlus}
          title="No channels yet"
          description="This server has no categories or voice channels configured."
        />
      ) : (
        <div className={styles.tree}>
          {tree.map((node) => (
            <ChannelAdminTreeRow
              key={node.nodeId}
              node={node}
              depth={0}
              state={state}
              actions={actions}
              onAdminIntent={onAdminIntent}
            />
          ))}
        </div>
      )}
    </div>
  );
}

interface ChannelAdminTreeRowProps {
  readonly node: ChannelTreeNode;
  readonly depth: number;
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
  readonly onAdminIntent: (intent: ChannelAdminIntent) => void;
}

function ChannelAdminTreeRow({
  node,
  depth,
  state,
  actions,
  onAdminIntent,
}: ChannelAdminTreeRowProps): ReactElement {
  const can = (permission: 'channels.manage' | 'channels.delete'): boolean =>
    state.myPermissions.includes(permission);

  const manageHere = useEditableNodeCheck(actions, node.nodeId, can('channels.manage'));
  const manageParentForDelete = useEditableNodeCheck(
    actions,
    node.parentId,
    can('channels.delete'),
  );
  // Move gates on Manage over the node's *parent*, matching `handleChannelMove`'s real
  // authorization (source-parent Manage, never the node's own) — see
  // `ChannelContextMenu.tsx`'s identical fix/doc comment for the full explanation.
  const manageParentForMove = useEditableNodeCheck(actions, node.parentId, can('channels.manage'));

  return (
    <>
      <div
        className={styles.treeRow}
        style={{ marginLeft: depth * 20 }}
        data-testid={`channels-admin-row-${node.nodeId}`}
      >
        <span className={styles.treeRowName}>
          {node.name}
          {node.kind === 'category' ? ' (category)' : ''}
        </span>
        <div className={styles.treeRowActions}>
          {manageHere === 'allowed' && (
            <IconButton
              icon={node.kind === 'category' ? Plus : FolderPlus}
              ariaLabel={
                node.kind === 'category'
                  ? `Create channel in ${node.name}`
                  : `Create subchannel in ${node.name}`
              }
              size="small"
              onClick={() => {
                onAdminIntent({
                  type: 'create-channel',
                  parentId: node.nodeId,
                  parentLocked: true,
                });
              }}
              data-testid={`channels-admin-create-in-${node.nodeId}`}
            />
          )}
          {manageHere === 'allowed' && (
            <IconButton
              icon={Pencil}
              ariaLabel={`Edit ${node.name}`}
              size="small"
              onClick={() => {
                onAdminIntent(
                  node.kind === 'category'
                    ? { type: 'edit-category', nodeId: node.nodeId }
                    : { type: 'edit-channel', nodeId: node.nodeId },
                );
              }}
              data-testid={`channels-admin-edit-${node.nodeId}`}
            />
          )}
          {manageParentForMove === 'allowed' && node.kind === 'voice' && (
            <IconButton
              icon={Move}
              ariaLabel={`Move ${node.name}`}
              size="small"
              onClick={() => {
                onAdminIntent({ type: 'move-channel', nodeId: node.nodeId });
              }}
              data-testid={`channels-admin-move-${node.nodeId}`}
            />
          )}
          {manageParentForDelete === 'allowed' && (
            <IconButton
              icon={Trash2}
              ariaLabel={`Delete ${node.name}`}
              danger
              size="small"
              onClick={() => {
                onAdminIntent({ type: 'delete-node', nodeId: node.nodeId });
              }}
              data-testid={`channels-admin-delete-${node.nodeId}`}
            />
          )}
        </div>
      </div>
      {node.children.map((child) => (
        <ChannelAdminTreeRow
          key={child.nodeId}
          node={child}
          depth={depth + 1}
          state={state}
          actions={actions}
          onAdminIntent={onAdminIntent}
        />
      ))}
    </>
  );
}
