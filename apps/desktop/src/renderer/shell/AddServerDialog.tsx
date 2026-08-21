import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';

import type { DesktopServerBookmark } from '../../shared/ipc-contract.js';
import type { BookmarksActions } from '../connection/use-bookmarks.js';
import { parseServerAddress } from '../connection/parse-server-address.js';
import { Button } from '../ui/Button.js';
import { Modal } from '../ui/Modal.js';
import styles from './AddServerDialog.module.css';

interface AddServerDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly actions: BookmarksActions;
  /** Presence switches this dialog into edit mode (name/address only, no immediate connect, no
   * Advanced/token section — an existing bookmark never gains a token retroactively). */
  readonly bookmark?: DesktopServerBookmark | undefined;
  /** Add-mode only: connects immediately after the bookmark is saved, exactly like
   * `ConnectionScreen.tsx`'s original single "type address, optionally add a token, Connect" flow —
   * `serverToken` is passed only to this callback, never to `actions.addBookmark`, preserving T9
   * Section 72's "a bookmark never carries a token" rule byte-for-byte. */
  readonly onConnect?: (address: string, serverToken: string | undefined) => void;
}

/**
 * Built on `Modal` — wraps the bookmark add/update logic lifted into `use-bookmarks.ts` (itself a
 * verbatim extraction of `ConnectionScreen.tsx`'s own IPC calls, T13.1). Reused for both "Add
 * Server" (`bookmark` omitted) and "Edit Server" (`bookmark` provided) per the task's own "and reuse
 * for edit" instruction — only the header/copy and the presence of the Advanced/token section and
 * immediate-connect behavior differ between the two modes.
 */
export function AddServerDialog({
  open,
  onClose,
  actions,
  bookmark,
  onConnect,
}: AddServerDialogProps): ReactElement {
  const isEdit = bookmark !== undefined;
  const [displayName, setDisplayName] = useState(bookmark?.displayName ?? '');
  const [address, setAddress] = useState(bookmark?.serverAddress ?? '');
  const [serverToken, setServerToken] = useState('');
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);

  // Security review (T13.1): `AddServerDialog` itself stays mounted across `open` toggles (only
  // `Modal`'s own render short-circuits to `null` while closed), so without this its form state
  // persists from one opening to the next — e.g. typing into "Add Server" then Cancelling, then
  // opening "Edit Server" for an existing bookmark, previously showed the abandoned Add values
  // instead of that bookmark's own, and saving would silently repoint it to the wrong address.
  // Re-sync only on the closed→open transition (never merely because `bookmark`'s object identity
  // changed while already open, e.g. from an unrelated parent re-render), so an in-progress edit is
  // never wiped out from under the user.
  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (open && !wasOpenRef.current) {
      setDisplayName(bookmark?.displayName ?? '');
      setAddress(bookmark?.serverAddress ?? '');
      setServerToken('');
      setAdvancedOpen(false);
      setError(undefined);
    }
    wasOpenRef.current = open;
  }, [open, bookmark]);

  function resetAndClose(): void {
    setServerToken('');
    setError(undefined);
    onClose();
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmedName = displayName.trim();
    if (trimmedName.length === 0) {
      setError('Server name is required.');
      return;
    }
    const parsed = parseServerAddress(address);
    if (!parsed.ok) {
      setError(parsed.reason);
      return;
    }
    setError(undefined);
    setSaving(true);

    void (async () => {
      if (isEdit && bookmark) {
        const ok = await actions.updateBookmark({
          ...bookmark,
          displayName: trimmedName,
          serverAddress: address.trim(),
        });
        setSaving(false);
        if (!ok) {
          setError('Could not save changes to this server.');
          return;
        }
        resetAndClose();
        return;
      }

      const saved = await actions.addBookmark({
        displayName: trimmedName,
        serverAddress: address.trim(),
      });
      setSaving(false);
      if (!saved) {
        setError('Could not save this server.');
        return;
      }
      const trimmedToken = serverToken.trim();
      onConnect?.(parsed.address.url, trimmedToken.length > 0 ? trimmedToken : undefined);
      resetAndClose();
    })();
  }

  return (
    <Modal
      open={open}
      onClose={resetAndClose}
      title={isEdit ? 'Edit Server' : 'Add Server'}
      testId="add-server-dialog"
    >
      <form onSubmit={handleSubmit} className={styles.form}>
        <label className={styles.field}>
          <span>Server name</span>
          <input
            value={displayName}
            onChange={(event) => {
              setDisplayName(event.target.value);
            }}
            maxLength={100}
            placeholder="My server"
            autoFocus
            disabled={saving}
            data-testid="add-server-name-input"
          />
        </label>
        <label className={styles.field}>
          <span>Server address</span>
          <input
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
            }}
            placeholder="127.0.0.1:8090"
            disabled={saving}
            data-testid="add-server-address-input"
          />
        </label>

        {!isEdit && (
          <div className={styles.advanced}>
            <button
              type="button"
              className={styles.advancedToggle}
              aria-expanded={advancedOpen}
              onClick={() => {
                setAdvancedOpen((prev) => !prev);
              }}
            >
              {advancedOpen ? (
                <ChevronDown size={14} aria-hidden="true" />
              ) : (
                <ChevronRight size={14} aria-hidden="true" />
              )}
              Advanced
            </button>
            {advancedOpen && (
              <label className={styles.field}>
                <span>Server token (optional)</span>
                <input
                  value={serverToken}
                  onChange={(event) => {
                    setServerToken(event.target.value);
                  }}
                  type="password"
                  placeholder="Invite or privilege token"
                  disabled={saving}
                />
                <span className={styles.hint}>
                  Used for connections to this server this session — never saved with this bookmark.
                </span>
              </label>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className={styles.error}>
            {error}
          </p>
        )}

        <div className={styles.actions}>
          <Button variant="ghost" type="button" onClick={resetAndClose} disabled={saving}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={saving} data-testid="add-server-submit">
            {isEdit ? 'Save' : onConnect ? 'Add & Connect' : 'Add Server'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
