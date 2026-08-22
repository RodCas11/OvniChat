import { useState, type ReactElement } from 'react';

import { Button } from '../ui/Button.js';
import { Modal } from '../ui/Modal.js';
import { useToast } from '../ui/ToastProvider.js';
import type { VoiceChannelActions, VoiceChannelState } from '../voice/use-voice-channel.js';
import { countDescendants, findNode } from './channel-tree.js';
import { describeChannelAdminError } from './channel-error-copy.js';
import styles from './ChannelAdminForm.module.css';

interface DeleteChannelConfirmDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
  readonly nodeId: string;
}

/**
 * T13.2 — deletion always cascades the whole subtree server-side (one tombstone transaction — there
 * is no separate "still has children" rejection code, see `handleChannelDelete`), so the
 * confirmation copy here is a truthful, client-computed descendant count (`channel-tree.ts`'s
 * `countDescendants`), never a fabricated blocking error. Deleting an occupied voice channel only
 * force-removes voice membership (`server:voice-removed-by-policy`) — it never disconnects anyone
 * from the server; this dialog says so plainly rather than implying a kick.
 */
export function DeleteChannelConfirmDialog({
  open,
  onClose,
  state,
  actions,
  nodeId,
}: DeleteChannelConfirmDialogProps): ReactElement | null {
  const { showToast } = useToast();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  if (!open) return null;
  const node = findNode(state.channelTree, nodeId);
  if (!node) return null;

  const descendantCount = countDescendants(state.channelTree, nodeId);
  const isCurrentChannel = node.kind === 'voice' && nodeId === state.currentChannelId;
  const occupantCount = isCurrentChannel ? state.participants.length : undefined;

  async function handleDelete(): Promise<void> {
    setSubmitting(true);
    setError(undefined);
    try {
      await actions.deleteChannel(nodeId);
      showToast(`Deleted "${node?.name}"`, 'success');
      onClose();
    } catch (thrown) {
      setError(describeChannelAdminError(thrown));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Modal
      open
      onClose={onClose}
      title={node.kind === 'category' ? 'Delete Category' : 'Delete Channel'}
      size="small"
      testId="delete-channel-dialog"
    >
      <div className={styles.form}>
        <p className={styles.confirmText}>
          Delete &lsquo;{node.name}&rsquo;? This cannot be undone.
        </p>

        {descendantCount > 0 && (
          <p className={styles.hint}>
            This will also delete {descendantCount} channel{descendantCount === 1 ? '' : 's'} inside
            it.
          </p>
        )}

        {node.kind === 'voice' &&
          (occupantCount !== undefined ? (
            <p className={styles.hint}>
              This channel currently has {occupantCount} participant{occupantCount === 1 ? '' : 's'}{' '}
              connected. Deleting it will remove their voice membership only — nobody will be
              disconnected from the server.
            </p>
          ) : (
            <p className={styles.hint}>
              If anyone is currently in this channel, deleting it will remove their voice membership
              only — nobody will be disconnected from the server.
            </p>
          ))}

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
            variant="danger"
            type="button"
            disabled={submitting}
            onClick={() => {
              void handleDelete();
            }}
            data-testid="delete-channel-confirm"
          >
            Delete
          </Button>
        </div>
      </div>
    </Modal>
  );
}
