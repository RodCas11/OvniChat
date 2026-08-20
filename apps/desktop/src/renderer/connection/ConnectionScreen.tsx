import { useEffect, useState, type ChangeEvent, type FormEvent, type ReactElement } from 'react';

import type { DesktopServerBookmark } from '../../shared/ipc-contract.js';
import { parseServerAddress } from './parse-server-address.js';

interface ConnectionScreenProps {
  /** Current local nickname (T7) — shown for context only; edited from the settings Identity
   * panel once connected, not duplicated here. */
  readonly nickname: string;
  /** Pre-fills the address field as a development convenience (T8 Section 22-23) — never implies
   * the server always lives here; the field remains fully editable and required. Superseded by the
   * persisted `lastServerAddress` (T11 Section 13) once that loads, if it is set — see the
   * settings-load effect below. */
  readonly defaultAddress: string | undefined;
  /** T9 — `address` and an optional bearer token (privilege key, invite token, or the bootstrap
   * Server Admin token) presented at admission time. Cleared from this component's own state
   * immediately after a connect attempt (T9 Section 72) — never persisted, never logged. */
  readonly onConnect: (address: string, serverToken: string | undefined) => void;
  readonly connecting: boolean;
  readonly connectionError: string | undefined;
}

/**
 * The TeamSpeak-style first screen (T8 Section 15): nickname (read-only context; edit it from
 * settings), a manually-entered server address, and an explicit Connect action. Deliberately no
 * Login/Password/Email fields and no server directory/browser (Section 20) — the operator's
 * address is the only input a self-hosted deployment needs.
 *
 * T11 adds local, client-only server bookmarks (Section 9-11) and an explicit
 * "connect automatically on startup" preference (Section 15) — both loaded/persisted directly
 * through the already-wired `getClientSettings`/`updateClientSettings`/`addBookmark`/
 * `updateBookmark`/`removeBookmark` IPC, entirely independent of `onConnect`'s own connection flow.
 * A bookmark **never** carries a token — see `DesktopServerBookmark`'s own doc comment; this
 * component's `serverToken` field stays exactly as ephemeral as it was before T11 (cleared after
 * one connect attempt, never threaded into the bookmark-add flow at all).
 */
export function ConnectionScreen({
  nickname,
  defaultAddress,
  onConnect,
  connecting,
  connectionError,
}: ConnectionScreenProps): ReactElement {
  const [address, setAddress] = useState(defaultAddress ?? '');
  const [serverToken, setServerToken] = useState('');
  const [validationError, setValidationError] = useState<string | undefined>(undefined);
  const [bookmarks, setBookmarks] = useState<readonly DesktopServerBookmark[]>([]);
  const [connectOnStartup, setConnectOnStartup] = useState(false);
  const [newBookmarkName, setNewBookmarkName] = useState('');
  const [bookmarkError, setBookmarkError] = useState<string | undefined>(undefined);
  const [editingBookmarkId, setEditingBookmarkId] = useState<string | undefined>(undefined);
  const [editingName, setEditingName] = useState('');

  useEffect(() => {
    let cancelled = false;
    window.desktopApp
      .getClientSettings()
      .then((settings) => {
        if (cancelled) return;
        setBookmarks(settings.bookmarks);
        setConnectOnStartup(settings.connectOnStartup);
        // T11 Section 13 — the last address actually connected to takes priority over the
        // deployment/development default once it has loaded.
        if (settings.lastServerAddress) setAddress(settings.lastServerAddress);
      })
      .catch((error: unknown) => {
        console.error('connection screen: failed to load persisted settings', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const result = parseServerAddress(address);
    if (!result.ok) {
      setValidationError(result.reason);
      return;
    }
    setValidationError(undefined);
    const trimmedToken = serverToken.trim();
    onConnect(result.address.url, trimmedToken.length > 0 ? trimmedToken : undefined);
    // T9 Section 72: never retained past one connection attempt — not in this component's own
    // state, and never written to bookmarks/settings/logs anywhere downstream.
    setServerToken('');
  };

  function handleConnectOnStartupChange(event: ChangeEvent<HTMLInputElement>): void {
    const checked = event.target.checked;
    setConnectOnStartup(checked);
    window.desktopApp
      .updateClientSettings({ connectOnStartup: checked })
      .catch((error: unknown) => {
        console.error('connection screen: failed to persist connect-on-startup preference', error);
      });
  }

  function handleAddBookmark(event: FormEvent): void {
    event.preventDefault();
    const result = parseServerAddress(address);
    if (!result.ok) {
      setValidationError(result.reason);
      return;
    }
    if (newBookmarkName.trim().length === 0) {
      setBookmarkError('Bookmark name is required.');
      return;
    }
    setValidationError(undefined);
    setBookmarkError(undefined);
    window.desktopApp
      .addBookmark({ displayName: newBookmarkName.trim(), serverAddress: address.trim() })
      .then((bookmark) => {
        setBookmarks((prev) => [...prev, bookmark]);
        setNewBookmarkName('');
      })
      .catch((error: unknown) => {
        console.error('connection screen: failed to add bookmark', error);
        setBookmarkError('Could not save this bookmark.');
      });
  }

  function handleRemoveBookmark(bookmarkId: string): void {
    window.desktopApp
      .removeBookmark(bookmarkId)
      .then((removed) => {
        if (removed) setBookmarks((prev) => prev.filter((b) => b.bookmarkId !== bookmarkId));
      })
      .catch((error: unknown) => {
        console.error('connection screen: failed to remove bookmark', error);
      });
  }

  function handleStartEditBookmark(bookmark: DesktopServerBookmark): void {
    setEditingBookmarkId(bookmark.bookmarkId);
    setEditingName(bookmark.displayName);
  }

  function handleSaveEditBookmark(bookmark: DesktopServerBookmark): void {
    const trimmed = editingName.trim();
    if (trimmed.length === 0) return;
    const updated: DesktopServerBookmark = { ...bookmark, displayName: trimmed };
    window.desktopApp
      .updateBookmark(updated)
      .then((ok) => {
        if (ok) {
          setBookmarks((prev) =>
            prev.map((b) => (b.bookmarkId === bookmark.bookmarkId ? updated : b)),
          );
        }
        setEditingBookmarkId(undefined);
      })
      .catch((error: unknown) => {
        console.error('connection screen: failed to update bookmark', error);
        setEditingBookmarkId(undefined);
      });
  }

  function handleConnectBookmark(bookmark: DesktopServerBookmark): void {
    const result = parseServerAddress(bookmark.serverAddress);
    if (!result.ok) {
      setValidationError(result.reason);
      return;
    }
    setAddress(bookmark.serverAddress);
    setValidationError(undefined);
    // A bookmark never carries a token — see this component's own doc comment.
    onConnect(result.address.url, undefined);
  }

  return (
    <main>
      <h1>OvniChat</h1>
      <p>
        Connecting as <strong>{nickname}</strong>
      </p>
      <form onSubmit={handleSubmit}>
        <label>
          Server Address{' '}
          <input
            value={address}
            onChange={(event) => {
              setAddress(event.target.value);
            }}
            placeholder="127.0.0.1:8090"
            disabled={connecting}
            autoFocus
          />
        </label>{' '}
        <label>
          Server Token (optional){' '}
          <input
            value={serverToken}
            onChange={(event) => {
              setServerToken(event.target.value);
            }}
            placeholder="DV-..."
            disabled={connecting}
            type="password"
          />
        </label>{' '}
        <button type="submit" disabled={connecting || address.trim().length === 0}>
          {connecting ? 'Connecting…' : 'Connect'}
        </button>
      </form>
      {validationError && <p role="alert">{validationError}</p>}
      {connectionError && <p role="alert">{connectionError}</p>}

      <label>
        <input
          type="checkbox"
          checked={connectOnStartup}
          disabled={connecting}
          onChange={handleConnectOnStartupChange}
        />
        Connect automatically on startup
      </label>

      <section data-role="bookmarks">
        <h3>Bookmarks</h3>
        <ul>
          {bookmarks.map((bookmark) => (
            <li key={bookmark.bookmarkId}>
              {editingBookmarkId === bookmark.bookmarkId ? (
                <>
                  <input
                    value={editingName}
                    onChange={(event) => {
                      setEditingName(event.target.value);
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => {
                      handleSaveEditBookmark(bookmark);
                    }}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEditingBookmarkId(undefined);
                    }}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <strong>{bookmark.displayName}</strong> ({bookmark.serverAddress}){' '}
                  <button
                    type="button"
                    disabled={connecting}
                    onClick={() => {
                      handleConnectBookmark(bookmark);
                    }}
                  >
                    Connect
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      handleStartEditBookmark(bookmark);
                    }}
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      handleRemoveBookmark(bookmark.bookmarkId);
                    }}
                  >
                    Remove
                  </button>
                </>
              )}
            </li>
          ))}
          {bookmarks.length === 0 && <li>No saved servers yet.</li>}
        </ul>

        <form onSubmit={handleAddBookmark}>
          <label>
            Bookmark name{' '}
            <input
              value={newBookmarkName}
              onChange={(event) => {
                setNewBookmarkName(event.target.value);
              }}
              maxLength={100}
              placeholder="My server"
            />
          </label>{' '}
          <button type="submit" disabled={address.trim().length === 0}>
            Save current address as bookmark
          </button>
        </form>
        {bookmarkError && <p role="alert">{bookmarkError}</p>}
      </section>
    </main>
  );
}
