import { useState, type MouseEvent, type ReactElement } from 'react';
import { Home, Plus } from 'lucide-react';

import type { DesktopServerBookmark } from '../../shared/ipc-contract.js';
import { parseServerAddress } from '../connection/parse-server-address.js';
import { useBookmarks } from '../connection/use-bookmarks.js';
import { Avatar } from '../ui/Avatar.js';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu.js';
import { Tooltip } from '../ui/Tooltip.js';
import { AddServerDialog } from './AddServerDialog.js';
import styles from './ServerRail.module.css';

interface ServerRailProps {
  /** The currently-connected server's plain `host:port` address (matches
   * `DesktopServerBookmark.serverAddress`'s own shape) — used only to highlight which bookmark, if
   * any, corresponds to the live connection. `undefined` if the current connection was reached by a
   * manually-typed address that does not match any saved bookmark. */
  readonly activeServerAddress: string | undefined;
  /** Switches servers via the real disconnect -> connect lifecycle — never a second simultaneous
   * connection (see `AppShell.tsx`'s own remount-key doc comment for the full contract this feeds
   * into). */
  readonly onSwitchServer: (url: string) => void;
  /** Returns to `ServerHome` — an explicit disconnect, not a visual-only state change. */
  readonly onGoHome: () => void;
}

/** Narrow far-left rail (T13.1): a Home button back to `ServerHome`, one circular `Avatar` per
 * local bookmark (tooltip-only name, no permanently-visible label), and a bottom "+" to add
 * another server — purely driven by local bookmarks, exactly like `ServerHome`. */
export function ServerRail({
  activeServerAddress,
  onSwitchServer,
  onGoHome,
}: ServerRailProps): ReactElement {
  const [{ bookmarks }, actions] = useBookmarks();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingBookmark, setEditingBookmark] = useState<DesktopServerBookmark | undefined>(
    undefined,
  );
  const [menu, setMenu] = useState<
    { readonly bookmark: DesktopServerBookmark; readonly x: number; readonly y: number } | undefined
  >(undefined);

  function handleClick(bookmark: DesktopServerBookmark): void {
    if (bookmark.serverAddress === activeServerAddress) return;
    const parsed = parseServerAddress(bookmark.serverAddress);
    if (!parsed.ok) return;
    onSwitchServer(parsed.address.url);
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
            void actions.removeBookmark(menu.bookmark.bookmarkId);
          },
        },
      ]
    : [];

  return (
    <nav className={styles.rail} aria-label="Servers">
      <Tooltip label="Server list">
        <button
          type="button"
          className={styles.homeButton}
          onClick={onGoHome}
          aria-label="Server list"
          data-testid="server-rail-home"
        >
          <Home size={20} aria-hidden="true" />
        </button>
      </Tooltip>

      <div className={styles.divider} />

      <ul className={styles.list}>
        {bookmarks.map((bookmark) => {
          const active = bookmark.serverAddress === activeServerAddress;
          return (
            <li key={bookmark.bookmarkId}>
              <Tooltip label={bookmark.displayName} placement="bottom">
                <button
                  type="button"
                  className={styles.tile}
                  aria-current={active ? 'true' : undefined}
                  onClick={() => {
                    handleClick(bookmark);
                  }}
                  onContextMenu={(event) => {
                    handleContextMenu(event, bookmark);
                  }}
                  data-testid={`server-rail-tile-${bookmark.bookmarkId}`}
                  data-active={active ? 'true' : 'false'}
                >
                  <Avatar
                    name={bookmark.displayName}
                    colorSeed={bookmark.bookmarkId}
                    selected={active}
                  />
                  {active && <span className={styles.activeIndicator} aria-hidden="true" />}
                </button>
              </Tooltip>
            </li>
          );
        })}
      </ul>

      <Tooltip label="Add Server" placement="bottom">
        <button
          type="button"
          className={styles.addButton}
          aria-label="Add Server"
          onClick={() => {
            setEditingBookmark(undefined);
            setDialogOpen(true);
          }}
          data-testid="server-rail-add"
        >
          <Plus size={20} aria-hidden="true" />
        </button>
      </Tooltip>

      <AddServerDialog
        open={dialogOpen}
        onClose={() => {
          setDialogOpen(false);
          setEditingBookmark(undefined);
        }}
        actions={actions}
        bookmark={editingBookmark}
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
    </nav>
  );
}
