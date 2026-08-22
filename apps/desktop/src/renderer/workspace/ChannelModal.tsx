import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';

import {
  MAX_CHANNEL_DEPTH,
  MAX_CHANNEL_NAME_LENGTH,
  MAX_CHANNEL_PARTICIPANTS,
} from '@disco-voador/protocol';

import { Button } from '../ui/Button.js';
import { Modal } from '../ui/Modal.js';
import { useToast } from '../ui/ToastProvider.js';
import type { ChannelUpdatePatch } from '../realtime/realtime-client.js';
import type { VoiceChannelActions, VoiceChannelState } from '../voice/use-voice-channel.js';
import { ChannelAclEditor, type ChannelAclValue } from './ChannelAclEditor.js';
import { describeChannelAdminError } from './channel-error-copy.js';
import { flattenTreeForPicker, sameGroupIds } from './channel-tree.js';
import styles from './ChannelAdminForm.module.css';

export type ChannelModalMode =
  | { readonly type: 'create'; readonly parentId?: string; readonly parentLocked: boolean }
  | { readonly type: 'edit'; readonly nodeId: string };

interface ChannelModalProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
  readonly mode: ChannelModalMode;
}

const DEFAULT_ACL: ChannelAclValue = {
  visibilityPolicy: 'inherit',
  visibilityGroupIds: [],
  joinPolicy: 'inherit',
  joinGroupIds: [],
  managePolicy: 'inherit',
  manageGroupIds: [],
};

function parentSelectValue(parentId: string | undefined): string {
  return parentId ?? '';
}

function parseParentSelectValue(value: string): string | undefined {
  return value === '' ? undefined : value;
}

/**
 * T13.2 — Create Channel / Create Subchannel / Edit Channel, one modal parameterized by `mode`. Per
 * this task's field-set rules: Edit omits the create-only Permanent/Temporary choice (no conversion
 * is implemented server-side) and the "which parent" concern (that lives in the separate Move
 * dialog, not here). A password is never round-tripped back into this form for an already-protected
 * channel — see the dedicated password-status section below.
 */
export function ChannelModal({
  open,
  onClose,
  state,
  actions,
  mode,
}: ChannelModalProps): ReactElement | null {
  const { showToast } = useToast();
  const [name, setName] = useState('');
  const [parentId, setParentId] = useState<string | undefined>(
    mode.type === 'create' ? mode.parentId : undefined,
  );
  const [temporary, setTemporary] = useState(false);
  const [limited, setLimited] = useState(false);
  const [userLimit, setUserLimit] = useState(10);
  const [hasPassword, setHasPassword] = useState(false);
  const [passwordMode, setPasswordMode] = useState<'none' | 'set' | 'change'>('none');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [removePasswordConfirming, setRemovePasswordConfirming] = useState(false);
  const [acl, setAcl] = useState<ChannelAclValue>(DEFAULT_ACL);
  const [loading, setLoading] = useState(mode.type === 'edit');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  /** T13.2 — the loaded snapshot for Edit mode, so submit sends only the fields the admin actually
   * changed (never a resend of every field regardless of whether it changed). `undefined` in Create
   * mode, where there is nothing to diff against — the create-time settings patch already diffs
   * against `DEFAULT_ACL` instead (a freshly created node genuinely starts there). */
  const initialRef = useRef<
    | {
        readonly name: string;
        readonly limited: boolean;
        readonly userLimit: number;
        readonly acl: ChannelAclValue;
      }
    | undefined
  >(undefined);
  /** T13.2 — a stable ref to the latest `onClose`/`showToast`, so the load effect below can close
   * this modal on a race (see its own `.catch` below) without needing either in its dependency
   * array — including them there would re-run this effect (and re-issue `getEditableChannelNode`)
   * on every render where the caller passes a fresh inline closure, which `VoiceChannelView.tsx`
   * does. */
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const showToastRef = useRef(showToast);
  showToastRef.current = showToast;

  useEffect(() => {
    if (!open) return;
    setError(undefined);
    setPassword('');
    setConfirmPassword('');
    setRemovePasswordConfirming(false);
    if (mode.type === 'create') {
      setName('');
      setParentId(mode.parentId);
      setTemporary(false);
      setLimited(false);
      setUserLimit(10);
      setHasPassword(false);
      setPasswordMode('none');
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
        const loadedLimited = node.userLimit !== undefined;
        const loadedUserLimit = node.userLimit ?? 10;
        setName(node.name);
        setParentId(node.parentId);
        setLimited(loadedLimited);
        setUserLimit(loadedUserLimit);
        setHasPassword(node.hasPassword);
        setPasswordMode('none');
        setAcl(loadedAcl);
        initialRef.current = {
          name: node.name,
          limited: loadedLimited,
          userLimit: loadedUserLimit,
          acl: loadedAcl,
        };
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

  const passwordsMismatched =
    passwordMode !== 'none' && password.length > 0 && password !== confirmPassword;

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) return;
    if (passwordMode !== 'none' && (password.length === 0 || password !== confirmPassword)) return;

    setSubmitting(true);
    setError(undefined);
    try {
      if (mode.type === 'create') {
        const node = await actions.createVoiceChannel(trimmed, parentId, temporary);
        const failures: string[] = [];
        if (passwordMode === 'set') {
          try {
            await actions.setChannelPassword(node.nodeId, password);
          } catch (thrown) {
            failures.push(`password: ${describeChannelAdminError(thrown)}`);
          }
        }
        const settingsPatch = channelPatch({ limited, userLimit, acl, defaults: DEFAULT_ACL });
        if (Object.keys(settingsPatch).length > 0) {
          try {
            await actions.updateChannel(node.nodeId, settingsPatch);
          } catch (thrown) {
            failures.push(`settings: ${describeChannelAdminError(thrown)}`);
          }
        }
        if (failures.length > 0) {
          showToast(
            `Created "${trimmed}", but some settings failed to apply — ${failures.join('; ')}. You can retry from Edit Channel.`,
            'error',
          );
        } else {
          showToast(`Created channel "${trimmed}"`, 'success');
        }
      } else {
        const initial = initialRef.current;
        const patch: Partial<ChannelUpdatePatch> = {
          ...(!initial || trimmed !== initial.name ? { name: trimmed } : {}),
          ...(!initial ||
          limited !== initial.limited ||
          (limited && userLimit !== initial.userLimit)
            ? { userLimit: limited ? userLimit : null }
            : {}),
          ...aclPatchIfChanged(acl, initial?.acl),
        };
        if (Object.keys(patch).length > 0) {
          await actions.updateChannel(mode.nodeId, patch);
        }

        if (passwordMode === 'set' || passwordMode === 'change') {
          await actions.setChannelPassword(mode.nodeId, password);
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

  async function handleRemovePassword(): Promise<void> {
    if (mode.type !== 'edit') return;
    setSubmitting(true);
    try {
      await actions.removeChannelPassword(mode.nodeId);
      setHasPassword(false);
      setRemovePasswordConfirming(false);
      showToast('Password removed', 'success');
    } catch (thrown) {
      showToast(describeChannelAdminError(thrown), 'error');
    } finally {
      setSubmitting(false);
    }
  }

  if (!open) return null;

  const showParentPicker = mode.type === 'create' && !mode.parentLocked;
  const parentOptions = showParentPicker
    ? flattenTreeForPicker(state.channelTree, { maxDepth: MAX_CHANNEL_DEPTH - 1 })
    : [];

  return (
    <Modal
      open
      onClose={onClose}
      title={mode.type === 'create' ? 'Create Channel' : 'Edit Channel'}
      size="medium"
      testId="channel-modal"
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
              data-testid="channel-modal-name"
              autoFocus
            />
          </label>

          {showParentPicker && (
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Location</span>
              <select
                className={styles.select}
                value={parentSelectValue(parentId)}
                onChange={(event) => {
                  setParentId(parseParentSelectValue(event.target.value));
                }}
                data-testid="channel-modal-parent"
              >
                <option value="">Top level</option>
                {parentOptions.map((entry) => (
                  <option key={entry.nodeId} value={entry.nodeId} disabled={entry.disabled}>
                    {' '.repeat(entry.depth * 2)}
                    {entry.name}
                    {entry.disabled ? ' (max depth reached)' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}

          {mode.type === 'create' && (
            <fieldset className={styles.field} style={{ border: 'none', margin: 0, padding: 0 }}>
              <legend className={styles.fieldLabel}>Type</legend>
              <div className={styles.radioGroup}>
                <label className={styles.radioOption}>
                  <input
                    type="radio"
                    name="channel-type"
                    checked={!temporary}
                    onChange={() => {
                      setTemporary(false);
                    }}
                  />
                  Permanent
                </label>
                <label className={styles.radioOption}>
                  <input
                    type="radio"
                    name="channel-type"
                    checked={temporary}
                    onChange={() => {
                      setTemporary(true);
                    }}
                    data-testid="channel-modal-temporary-radio"
                  />
                  Temporary
                </label>
              </div>
              {temporary && (
                <p className={styles.hint}>
                  Temporary channels exist only in memory and are automatically removed once
                  everyone leaves — they never survive a server restart.
                </p>
              )}
            </fieldset>
          )}

          <fieldset className={styles.field} style={{ border: 'none', margin: 0, padding: 0 }}>
            <legend className={styles.fieldLabel}>User limit</legend>
            <div className={styles.radioGroup}>
              <label className={styles.radioOption}>
                <input
                  type="radio"
                  name="user-limit"
                  checked={!limited}
                  onChange={() => {
                    setLimited(false);
                  }}
                />
                Unlimited
              </label>
              <label className={styles.radioRow}>
                <input
                  type="radio"
                  name="user-limit"
                  checked={limited}
                  onChange={() => {
                    setLimited(true);
                  }}
                />
                <input
                  type="number"
                  className={styles.input}
                  min={1}
                  max={MAX_CHANNEL_PARTICIPANTS}
                  value={userLimit}
                  disabled={!limited}
                  onChange={(event) => {
                    setUserLimit(Number(event.target.value));
                  }}
                  style={{ width: 80 }}
                  data-testid="channel-modal-user-limit"
                />
              </label>
            </div>
          </fieldset>

          <fieldset className={styles.field} style={{ border: 'none', margin: 0, padding: 0 }}>
            <legend className={styles.fieldLabel}>Password</legend>
            {mode.type === 'edit' && hasPassword && passwordMode === 'none' ? (
              <div className={styles.passwordStatus}>
                <span>Password protection: Enabled</span>
                <div className={styles.passwordActions}>
                  <Button
                    variant="secondary"
                    type="button"
                    onClick={() => {
                      setPasswordMode('change');
                    }}
                  >
                    Change Password
                  </Button>
                  <Button
                    variant="danger"
                    type="button"
                    onClick={() => {
                      setRemovePasswordConfirming(true);
                    }}
                  >
                    Remove Password
                  </Button>
                </div>
                {removePasswordConfirming && (
                  <div className={styles.field}>
                    <p className={styles.confirmText}>Remove password from &lsquo;{name}&rsquo;?</p>
                    <div className={styles.footer}>
                      <Button
                        variant="secondary"
                        type="button"
                        onClick={() => {
                          setRemovePasswordConfirming(false);
                        }}
                      >
                        Cancel
                      </Button>
                      <Button
                        variant="danger"
                        type="button"
                        onClick={() => {
                          void handleRemovePassword();
                        }}
                      >
                        Remove
                      </Button>
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <>
                <label className={styles.radioOption}>
                  <input
                    type="checkbox"
                    checked={passwordMode !== 'none'}
                    onChange={(event) => {
                      setPasswordMode(event.target.checked ? 'set' : 'none');
                      setPassword('');
                      setConfirmPassword('');
                    }}
                    data-testid="channel-modal-password-enable"
                  />
                  Require a password to join
                </label>
                {passwordMode !== 'none' && (
                  <>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Password</span>
                      <input
                        type="password"
                        className={styles.input}
                        value={password}
                        maxLength={128}
                        onChange={(event) => {
                          setPassword(event.target.value);
                        }}
                        data-testid="channel-modal-password"
                      />
                    </label>
                    <label className={styles.field}>
                      <span className={styles.fieldLabel}>Confirm password</span>
                      <input
                        type="password"
                        className={styles.input}
                        value={confirmPassword}
                        maxLength={128}
                        onChange={(event) => {
                          setConfirmPassword(event.target.value);
                        }}
                        data-testid="channel-modal-password-confirm"
                      />
                    </label>
                    {passwordsMismatched && (
                      <p className={styles.error} role="alert">
                        Passwords must match.
                      </p>
                    )}
                  </>
                )}
              </>
            )}
          </fieldset>

          <ChannelAclEditor
            state={state}
            actions={actions}
            parentId={parentId}
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
              disabled={
                name.trim().length === 0 ||
                submitting ||
                (passwordMode !== 'none' && (password.length === 0 || passwordsMismatched))
              }
              data-testid="channel-modal-submit"
            >
              {mode.type === 'create' ? 'Create' : 'Save'}
            </Button>
          </div>
        </form>
      )}
    </Modal>
  );
}

/** Diffs the live draft against `baseline` (the snapshot loaded from `getEditableChannelNode` at
 * Edit-modal open) — only an axis that actually differs from what the server already has is
 * included in the resulting patch, per this task's "submit only the changed fields" rule.
 * `baseline === undefined` (should not happen for a real Edit-mode submit, since it is always set
 * once loading finishes) falls back to including every axis, matching Create's own
 * diff-against-`DEFAULT_ACL` behavior. */
function aclPatchIfChanged(
  acl: ChannelAclValue,
  baseline: ChannelAclValue | undefined,
): Partial<ChannelUpdatePatch> {
  const base = baseline ?? DEFAULT_ACL;
  return {
    ...(acl.visibilityPolicy !== base.visibilityPolicy ||
    !sameGroupIds(acl.visibilityGroupIds, base.visibilityGroupIds)
      ? { visibilityPolicy: acl.visibilityPolicy, visibilityGroupIds: acl.visibilityGroupIds }
      : {}),
    ...(acl.joinPolicy !== base.joinPolicy || !sameGroupIds(acl.joinGroupIds, base.joinGroupIds)
      ? { joinPolicy: acl.joinPolicy, joinGroupIds: acl.joinGroupIds }
      : {}),
    ...(acl.managePolicy !== base.managePolicy ||
    !sameGroupIds(acl.manageGroupIds, base.manageGroupIds)
      ? { managePolicy: acl.managePolicy, manageGroupIds: acl.manageGroupIds }
      : {}),
  };
}

function channelPatch(options: {
  readonly limited: boolean;
  readonly userLimit: number;
  readonly acl: ChannelAclValue;
  readonly defaults: ChannelAclValue;
}): Partial<ChannelUpdatePatch> {
  return {
    ...(options.limited ? { userLimit: options.userLimit } : {}),
    ...(options.acl.visibilityPolicy !== options.defaults.visibilityPolicy
      ? {
          visibilityPolicy: options.acl.visibilityPolicy,
          visibilityGroupIds: options.acl.visibilityGroupIds,
        }
      : {}),
    ...(options.acl.joinPolicy !== options.defaults.joinPolicy
      ? { joinPolicy: options.acl.joinPolicy, joinGroupIds: options.acl.joinGroupIds }
      : {}),
    ...(options.acl.managePolicy !== options.defaults.managePolicy
      ? { managePolicy: options.acl.managePolicy, manageGroupIds: options.acl.manageGroupIds }
      : {}),
  };
}
