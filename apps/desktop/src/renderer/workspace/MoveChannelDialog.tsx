import { useState, type ReactElement } from 'react';

import { MAX_CHANNEL_DEPTH } from '@disco-voador/protocol';

import { Button } from '../ui/Button.js';
import { Modal } from '../ui/Modal.js';
import { useToast } from '../ui/ToastProvider.js';
import type { VoiceChannelActions, VoiceChannelState } from '../voice/use-voice-channel.js';
import { ancestorChain, findNode, flattenTreeForPicker } from './channel-tree.js';
import { describeChannelAdminError } from './channel-error-copy.js';
import styles from './ChannelAdminForm.module.css';

interface MoveChannelDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
  readonly nodeId: string;
}

function selectValue(parentId: string | undefined): string {
  return parentId ?? '';
}

function parseSelectValue(value: string): string | undefined {
  return value === '' ? undefined : value;
}

/**
 * T13.2 — moving a voice channel between categories/other voice channels (never a category itself
 * — categories are always top-level, so there is nothing to move them *between*; the context menu
 * never offers "Move" for a category node at all). Excludes the node's own subtree from the target
 * list (moving a node into its own descendant is a cycle the server would also reject via
 * `CHANNEL_PARENT_INVALID`, but excluding it client-side avoids ever presenting a guaranteed-to-fail
 * option).
 */
export function MoveChannelDialog({
  open,
  onClose,
  state,
  actions,
  nodeId,
}: MoveChannelDialogProps): ReactElement | null {
  const { showToast } = useToast();
  const node = findNode(state.channelTree, nodeId);
  const [newParentId, setNewParentId] = useState<string | undefined>(node?.parentId);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  if (!open || !node) return null;

  const breadcrumb = [...ancestorChain(state.channelTree, nodeId)].reverse();
  const targets = flattenTreeForPicker(state.channelTree, {
    excludeSubtreeOf: nodeId,
    maxDepth: MAX_CHANNEL_DEPTH - 1,
  });

  async function handleMove(): Promise<void> {
    setSubmitting(true);
    setError(undefined);
    try {
      await actions.moveChannel(nodeId, newParentId);
      showToast(`Moved "${node?.name}"`, 'success');
      onClose();
    } catch (thrown) {
      setError(describeChannelAdminError(thrown));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal open onClose={onClose} title="Move Channel" size="small" testId="move-channel-dialog">
      <div className={styles.form}>
        <div className={styles.field}>
          <span className={styles.fieldLabel}>Current location</span>
          <p className={styles.hint}>{breadcrumb.map((ancestor) => ancestor.name).join(' / ')}</p>
        </div>

        <label className={styles.field}>
          <span className={styles.fieldLabel}>New location</span>
          <select
            className={styles.select}
            value={selectValue(newParentId)}
            onChange={(event) => {
              setNewParentId(parseSelectValue(event.target.value));
            }}
            data-testid="move-channel-target"
          >
            <option value="">Top level</option>
            {targets.map((entry) => (
              <option key={entry.nodeId} value={entry.nodeId} disabled={entry.disabled}>
                {' '.repeat(entry.depth * 2)}
                {entry.name}
                {entry.disabled ? ' (max depth reached)' : ''}
              </option>
            ))}
          </select>
        </label>

        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}

        <div className={styles.footer}>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            type="button"
            disabled={submitting}
            onClick={() => {
              void handleMove();
            }}
            data-testid="move-channel-submit"
          >
            Move
          </Button>
        </div>
      </div>
    </Modal>
  );
}
