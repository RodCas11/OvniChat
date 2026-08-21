import { useState, type MouseEvent, type ReactElement } from 'react';
import { Plus, Server as ServerIcon } from 'lucide-react';

import type { DesktopServerBookmark } from '../../shared/ipc-contract.js';
import { parseServerAddress } from '../connection/parse-server-address.js';
import { useBookmarks } from '../connection/use-bookmarks.js';
import { Avatar } from '../ui/Avatar.js';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu.js';
import { EmptyState } from '../ui/EmptyState.js';
import { useToast } from '../ui/ToastProvider.js';
import { AddServerDialog } from './AddServerDialog.js';
import styles from './ServerHome.module.css';

interface ServerHomeProps {
  readonly onConnect: (address: string, serverToken: string | undefined) => void;
  readonly connectionError: string | undefined;
}

/**
 * Shown when disconnected (T13.1) — a minimal grid of local server bookmarks (never a DM/feed/
 * discovery surface: this app has no accounts, no friends, no public directory) plus an explicit
 * "Add Server" tile. Bookmark CRUD is the same real IPC this app has had since T11, now owned by
 * `use-bookmarks.ts` instead of the retired `ConnectionScreen.tsx`.
 */
export function ServerHome({ onConnect, connectionError }: ServerHomeProps): ReactElement {
  const [{ bookmarks }, actions] = useBookmarks();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingBookmark, setEditingBookmark] = useState<DesktopServerBookmark | undefined>(
    undefined,
  );
  const [menu, setMenu] = useState<
    { readonly bookmark: DesktopServerBookmark; readonly x: number; readonly y: number } | undefined
  >(undefined);
  const [connectError, setConnectError] = useState<string | undefined>(undefined);
  const { showToast } = useToast();

  function handleTileClick(bookmark: DesktopServerBookmark): void {
    const parsed = parseServerAddress(bookmark.serverAddress);
    if (!parsed.ok) {
      setConnectError(parsed.reason);
      return;
    }
    setConnectError(undefined);
    // A bookmark never carries a token (see `DesktopServerBookmark`'s own doc comment) — connecting
    // from a saved tile is always token-free, exactly like `ConnectionScreen.tsx`'s original
    // `handleConnectBookmark`.
    onConnect(parsed.address.url, undefined);
  }

  function handleContextMenu(
    event: MouseEvent<HTMLButtonElement>,
    bookmark: DesktopServerBookmark,
  ): void {
    event.preventDefault();
    setMenu({ bookmark, x: event.clientX, y: event.clientY });
  }

  const menuItems: readonly ContextMenuItem[] = menu
    ? [
        {
          label: 'Edit',
          onSelect: () => {
            setEditingBookmark(menu.bookmark);
            setDialogOpen(true);
          },
        },
        {
          label: 'Remove',
          danger: true,
          onSelect: () => {
            const { displayName, bookmarkId } = menu.bookmark;
            void actions.removeBookmark(bookmarkId).then((removed) => {
              if (removed) showToast(`Removed "${displayName}"`, 'success');
            });
          },
        },
      ]
    : [];

  return (
    <main className={styles.container}>
      <div className={styles.content}>
        <h1 className={styles.heading}>OvniChat</h1>
        <p className={styles.subheading}>Your self-hosted servers</p>

        {(connectionError ?? connectError) && (
          <p role="alert" className={styles.error}>
            {connectionError ?? connectError}
          </p>
        )}

        {bookmarks.length === 0 ? (
          <EmptyState
            icon={ServerIcon}
            title="No servers yet"
            description="Add a self-hosted OvniChat server to get started."
            action={{
              label: 'Add Server',
              onClick: () => {
                setEditingBookmark(undefined);
                setDialogOpen(true);
              },
            }}
          />
        ) : (
          <div className={styles.grid}>
            {bookmarks.map((bookmark) => (
              <button
                key={bookmark.bookmarkId}
                type="button"
                className={styles.tile}
                onClick={() => {
                  handleTileClick(bookmark);
                }}
                onContextMenu={(event) => {
                  handleContextMenu(event, bookmark);
                }}
                data-testid={`server-home-tile-${bookmark.bookmarkId}`}
              >
                <Avatar name={bookmark.displayName} colorSeed={bookmark.bookmarkId} size="large" />
                <span className={styles.tileName}>{bookmark.displayName}</span>
              </button>
            ))}

            <button
              type="button"
              className={`${styles.tile} ${styles.addTile}`}
              onClick={() => {
                setEditingBookmark(undefined);
                setDialogOpen(true);
              }}
              data-testid="server-home-add-tile"
            >
              <span className={styles.addIcon}>
                <Plus size={28} aria-hidden="true" />
              </span>
              <span className={styles.tileName}>Add Server</span>
            </button>
          </div>
        )}
      </div>

      <AddServerDialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setEditingBookmark(undefined);
        }}
        actions={actions}
        bookmark={editingBookmark}
        onConnect={onConnect}
      />

      {menu && (
        <ContextMenu
          open
          position={{ x: menu.x, y: menu.y }}
          items={menuItems}
          onClose={() => {
            setMenu(undefined);
          }}
        />
      )}
    </main>
  );
}
