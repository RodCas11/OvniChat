import type { ReactElement } from 'react';
import { FolderPlus, LogOut, MessageSquare, Move, Pencil, Phone, Plus, Trash2 } from 'lucide-react';

import type { ChannelNodeView, PermissionKey } from '@disco-voador/protocol';

import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu.js';
import type { VoiceChannelActions, VoiceChannelState } from '../voice/use-voice-channel.js';
import type { ChannelAdminIntent } from './channel-admin-intent.js';
import { useEditableNodeCheck } from './use-editable-node-check.js';

export interface ChannelContextMenuTarget {
  readonly node: ChannelNodeView;
  readonly x: number;
  readonly y: number;
}

interface ChannelContextMenuProps {
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
  readonly target: ChannelContextMenuTarget;
  readonly canJoin: boolean;
  readonly onClose: () => void;
  readonly onOpenChat: (nodeId: string) => void;
  readonly onJoin: (nodeId: string) => void;
  readonly onLeave: () => void;
  readonly onAdminIntent: (intent: ChannelAdminIntent) => void;
}

/**
 * T13.2 — right-click menu for a channel/category row, mirroring `ServerRail.tsx`'s established
 * `onContextMenu` → local `{item, x, y}` state → `<ContextMenu>` pattern exactly. Admin items for a
 * node the caller lacks the relevant *global* permission for are merged in only once an optimistic
 * `getEditableChannelNode` check resolves — see `use-editable-node-check.ts` — so a Guest (or any
 * identity with no delegated rights on this specific node) never sees them at all, not merely
 * disabled. The base (non-admin) items render immediately; the admin items may pop in a beat later.
 */
export function ChannelContextMenu({
  state,
  actions,
  target,
  canJoin,
  onClose,
  onOpenChat,
  onJoin,
  onLeave,
  onAdminIntent,
}: ChannelContextMenuProps): ReactElement {
  const { node } = target;
  const can = (permission: PermissionKey): boolean => state.myPermissions.includes(permission);

  // "Create Subchannel"/category "Create Channel"/Edit all gate on Manage rights over the
  // right-clicked node itself (see this task's own gating-rules doc comment) — one shared check.
  const manageHere = useEditableNodeCheck(actions, node.nodeId, can('channels.manage'));
  // Delete gates on Manage over the node's *parent* (filesystem-directory-permission semantics,
  // never Manage on the node itself) — `node.parentId` is `undefined` for a top-level node, which
  // the hook resolves to `'denied'` immediately (nothing to check against) unless the global
  // `channels.delete` permission already covers it.
  const manageParentForDelete = useEditableNodeCheck(
    actions,
    node.parentId,
    can('channels.delete'),
  );
  // Move gates on Manage over the node's *current* parent too (`handleChannelMove`'s real
  // authorization requires Manage on the source parent *and* the destination parent — never Manage
  // on the node being moved itself; see `services/realtime/src/protocol-handlers.ts`). This mirrors
  // `manageParentForDelete` exactly rather than reusing `manageHere`, which checks the wrong node —
  // a bug found during T13.2 final QA: a node's own delegated Manage grant (its `managePolicy`) does
  // not, by itself, authorize moving it out from under its parent. Only the source side can be
  // checked here (the destination isn't chosen yet); `MoveChannelDialog.tsx` surfaces a real
  // rejection if the caller cannot manage whatever destination they end up picking.
  const manageParentForMove = useEditableNodeCheck(actions, node.parentId, can('channels.manage'));

  const isJoined = node.kind === 'voice' && node.nodeId === state.currentChannelId;

  const items: ContextMenuItem[] = [];

  if (node.kind === 'voice') {
    items.push({
      label: 'Open Chat',
      icon: MessageSquare,
      onSelect: () => {
        onOpenChat(node.nodeId);
      },
    });
    if (isJoined) {
      items.push({
        label: 'Leave Voice',
        icon: LogOut,
        onSelect: onLeave,
      });
    } else {
      items.push({
        label: 'Join Voice',
        icon: Phone,
        disabled: !canJoin,
        onSelect: () => {
          onJoin(node.nodeId);
        },
      });
    }

    if (manageHere === 'allowed') {
      items.push({
        label: 'Create Subchannel',
        icon: FolderPlus,
        onSelect: () => {
          onAdminIntent({ type: 'create-channel', parentId: node.nodeId, parentLocked: true });
        },
      });
      items.push({
        label: 'Edit Channel',
        icon: Pencil,
        onSelect: () => {
          onAdminIntent({ type: 'edit-channel', nodeId: node.nodeId });
        },
      });
    }
    if (manageParentForMove === 'allowed') {
      items.push({
        label: 'Move Channel',
        icon: Move,
        onSelect: () => {
          onAdminIntent({ type: 'move-channel', nodeId: node.nodeId });
        },
      });
    }
    if (manageParentForDelete === 'allowed') {
      items.push({
        label: 'Delete Channel',
        icon: Trash2,
        danger: true,
        onSelect: () => {
          onAdminIntent({ type: 'delete-node', nodeId: node.nodeId });
        },
      });
    }
  } else {
    if (manageHere === 'allowed') {
      items.push({
        label: 'Create Channel',
        icon: Plus,
        onSelect: () => {
          onAdminIntent({ type: 'create-channel', parentId: node.nodeId, parentLocked: true });
        },
      });
      items.push({
        label: 'Edit Category',
        icon: Pencil,
        onSelect: () => {
          onAdminIntent({ type: 'edit-category', nodeId: node.nodeId });
        },
      });
    }
    if (manageParentForDelete === 'allowed') {
      items.push({
        label: 'Delete Category',
        icon: Trash2,
        danger: true,
        onSelect: () => {
          onAdminIntent({ type: 'delete-node', nodeId: node.nodeId });
        },
      });
    }
  }

  return (
    <ContextMenu open position={{ x: target.x, y: target.y }} items={items} onClose={onClose} />
  );
}
