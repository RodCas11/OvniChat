import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';

import { MAX_CHANNEL_NAME_LENGTH } from '@disco-voador/protocol';

import { Button } from '../ui/Button.js';
import { Modal } from '../ui/Modal.js';
import { useToast } from '../ui/ToastProvider.js';
import type { ChannelUpdatePatch } from '../realtime/realtime-client.js';
import type { VoiceChannelActions, VoiceChannelState } from '../voice/use-voice-channel.js';
import { ChannelAclEditor, type ChannelAclValue } from './ChannelAclEditor.js';
import { describeChannelAdminError } from './channel-error-copy.js';
import { sameGroupIds } from './channel-tree.js';
import styles from './ChannelAdminForm.module.css';

export type CategoryModalMode =
  | { readonly type: 'create'; readonly parentId?: undefined }
  | { readonly type: 'edit'; readonly nodeId: string };

interface CategoryModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
  readonly mode: CategoryModalMode;
}

const DEFAULT_ACL: ChannelAclValue = {
  visibilityPolicy: 'inherit',
  visibilityGroupIds: [],
  joinPolicy: 'inherit',
  joinGroupIds: [],
  managePolicy: 'inherit',
  manageGroupIds: [],
};

/**
 * T13.2 — Create Category / Edit Category. Categories are always top-level (`client:channel-
 * create-category` with a non-`undefined` `parentId` is rejected server-side with
 * `CHANNEL_PARENT_INVALID` — see `handleChannelCreateCategory`), so this never shows a parent
 * picker. Categories do own real ACL fields (`channelNodeSchema` does not distinguish category vs.
 * voice for policy fields), so the three ACL radios are included; password/user-limit/temporary are
 * voice-only concepts and are entirely omitted, not merely disabled.
 */
export function CategoryModal({
  open,
  onClose,
  state,
  actions,
  mode,
}: CategoryModalProps): ReactElement | null {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [acl, setAcl] = useState<ChannelAclValue>(DEFAULT_ACL);
  const [loading, setLoading] = useState(mode.type === 'edit');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  /** T13.2 — mirrors `ChannelModal.tsx`'s own `initialRef`: the loaded snapshot for Edit mode, so
   * submit sends only the fields the admin actually changed. */
  const initialRef = useRef<{ readonly name: string; readonly acl: ChannelAclValue } | undefined>(
    undefined,
  );
  /** T13.2 — see `ChannelModal.tsx`'s identical `onCloseRef`/`showToastRef` doc comment: lets the
   * load effect below close this modal on a race without needing either in its dependency array. */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    if (mode.type === 'create') {
      setName('');
      setAcl(DEFAULT_ACL);
      setLoading(false);
      return;
    }
    setLoading(true);
    let cancelled = false;
    actions
      .getEditableChannelNode(mode.nodeId)
      .then((node) => {
        if (cancelled) return;
        const loadedAcl: ChannelAclValue = {
          visibilityPolicy: node.visibilityPolicy,
          visibilityGroupIds: node.visibilityGroupIds,
          joinPolicy: node.joinPolicy,
          joinGroupIds: node.joinGroupIds,
          managePolicy: node.managePolicy,
          manageGroupIds: node.manageGroupIds,
        };
        setName(node.name);
        setAcl(loadedAcl);
        initialRef.current = { name: node.name, acl: loadedAcl };
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        // T13.2 — this is only reachable via a race (the menu item that opened this modal shouldn't
        // have been shown at all without Manage rights) — handle it gracefully by closing rather
        // than leaving a broken, permanently-loading form open.
        showToastRef.current(describeChannelAdminError(error), 'error');
        onCloseRef.current();
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, mode, actions]);

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    setSubmitting(true);
    setError(undefined);
    try {
      if (mode.type === 'create') {
        const node = await actions.createCategory(trimmed);
        const patch = aclPatch(acl, DEFAULT_ACL);
        if (Object.keys(patch).length > 0) {
          await actions.updateChannel(node.nodeId, patch);
        }
        showToast(`Created category "${trimmed}"`, 'success');
      } else {
        const initial = initialRef.current;
        const patch: Partial<ChannelUpdatePatch> = {
          ...(!initial || trimmed !== initial.name ? { name: trimmed } : {}),
          ...aclPatch(acl, initial?.acl ?? DEFAULT_ACL),
        };
        if (Object.keys(patch).length > 0) {
          await actions.updateChannel(mode.nodeId, patch);
        }
        showToast(`Updated "${trimmed}"`, 'success');
      }
      onClose();
    } catch (thrown) {
      setError(describeChannelAdminError(thrown));
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  return (
    <Modal
      open
      onClose={onClose}
      title={mode.type === 'create' ? 'Create Category' : 'Edit Category'}
      size="medium"
      testId="category-modal"
    >
      {loading ? (
        <p className={styles.hint}>Loading…</p>
      ) : (
        <form
          className={styles.form}
          onSubmit={(event) => {
            void handleSubmit(event);
          }}
        >
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Name</span>
            <input
              className={styles.input}
              value={name}
              maxLength={MAX_CHANNEL_NAME_LENGTH}
              onChange={(event) => {
                setName(event.target.value);
              }}
              data-testid="category-modal-name"
              autoFocus
            />
          </label>

          <ChannelAclEditor
            state={state}
            actions={actions}
            kind="category"
            parentId={undefined}
            value={acl}
            onChange={(patch) => {
              setAcl((prev) => ({ ...prev, ...patch }));
            }}
          />

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
              type="submit"
              disabled={name.trim().length === 0 || submitting}
              data-testid="category-modal-submit"
            >
              {mode.type === 'create' ? 'Create' : 'Save'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

function aclPatch(acl: ChannelAclValue, baseline: ChannelAclValue): Partial<ChannelUpdatePatch> {
  return {
    ...(acl.visibilityPolicy !== baseline.visibilityPolicy ||
    !sameGroupIds(acl.visibilityGroupIds, baseline.visibilityGroupIds)
      ? { visibilityPolicy: acl.visibilityPolicy, visibilityGroupIds: acl.visibilityGroupIds }
      : {}),
    ...(acl.joinPolicy !== baseline.joinPolicy ||
    !sameGroupIds(acl.joinGroupIds, baseline.joinGroupIds)
      ? { joinPolicy: acl.joinPolicy, joinGroupIds: acl.joinGroupIds }
      : {}),
    ...(acl.managePolicy !== baseline.managePolicy ||
    !sameGroupIds(acl.manageGroupIds, baseline.manageGroupIds)
      ? { managePolicy: acl.managePolicy, manageGroupIds: acl.manageGroupIds }
      : {}),
  };
}
