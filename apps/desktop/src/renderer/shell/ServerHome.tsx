import { useState, type MouseEvent, type ReactElement } from 'react';
import { Plus, Server as ServerIcon, Settings as SettingsIcon } from 'lucide-react';

import type { DesktopIdentity, DesktopServerBookmark } from '../../shared/ipc-contract.js';
import { parseServerAddress } from '../connection/parse-server-address.js';
import { useBookmarks } from '../connection/use-bookmarks.js';
import { IdentityPanel } from '../identity/IdentityPanel.js';
import { Avatar } from '../ui/Avatar.js';
import { ChantivoLogo } from '../ui/brand/ChantivoLogo.js';
import { ContextMenu, type ContextMenuItem } from '../ui/ContextMenu.js';
import { EmptyState } from '../ui/EmptyState.js';
import { Modal } from '../ui/Modal.js';
import { useToast } from '../ui/ToastProvider.js';
import { AddServerDialog } from './AddServerDialog.js';
import styles from './ServerHome.module.css';

interface ServerHomeProps {
  readonly onConnect: (address: string, serverToken: string | undefined) => void;
  readonly connectionError: string | undefined;
  /** T13.1.1 — the local identity/nickname affordance (avatar-fallback + nickname, never the
   * identityId/public key — that stays under Advanced/Identity, unchanged). Optional so this
   * component degrades gracefully (no profile row) if a caller has not threaded identity through
   * yet; `App.tsx` always has real, already-loaded identity data available by the time it renders
   * `ServerHome` (the nickname/identity gate above it already required a ready identity), so this
   * is populated for every real user. */
  readonly identity?: DesktopIdentity | undefined;
  readonly nickname?: string | undefined;
  readonly onNicknameChange?: ((nickname: string) => Promise<boolean>) | undefined;
  readonly onRegenerateIdentity?: (() => Promise<void>) | undefined;
}

/**
 * Shown when disconnected (T13.1) — a minimal grid of local server bookmarks (never a DM/feed/
 * discovery surface: this app has no accounts, no friends, no public directory) plus an explicit
 * "Add Server" tile. Bookmark CRUD is the same real IPC this app has had since T11, now owned by
 * `use-bookmarks.ts` instead of the retired `ConnectionScreen.tsx`.
 */
export function ServerHome({
  onConnect,
  connectionError,
  identity,
  nickname,
  onNicknameChange,
  onRegenerateIdentity,
}: ServerHomeProps): ReactElement {
  const [{ bookmarks }, actions] = useBookmarks();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingBookmark, setEditingBookmark] = useState<DesktopServerBookmark | undefined>(
    undefined,
  );
  const [menu, setMenu] = useState<
    { readonly bookmark: DesktopServerBookmark; readonly x: number; readonly y: number } | undefined
  >(undefined);
  const [connectError, setConnectError] = useState<string | undefined>(undefined);
  const [profileOpen, setProfileOpen] = useState(false);
  const { showToast } = useToast();
  const hasProfile = identity !== undefined && nickname !== undefined;

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
        <div className={styles.brand}>
          <ChantivoLogo size={52} />
          <p className={styles.subheading}>Your self-hosted servers</p>
        </div>

        {nickname !== undefined && (
          <button
            type="button"
            className={styles.profileRow}
            onClick={() => {
              setProfileOpen(true);
            }}
            data-testid="server-home-profile"
          >
            <Avatar name={nickname} />
            <span className={styles.profileName}>{nickname}</span>
            <span className={styles.profileEdit}>
              <SettingsIcon size={16} aria-hidden="true" />
              Profile &amp; Settings
            </span>
          </button>
        )}

        {(connectionError ?? connectError) && (
          <p role="alert" className={styles.error}>
            {connectionError ?? connectError}
          </p>
        )}

        {bookmarks.length === 0 ? (
          <div className={styles.emptyStateWrap}>
            <EmptyState
              icon={ServerIcon}
              title="No servers yet"
              description="Add a self-hosted Chantivo server to get started."
              action={{
                label: 'Add Server',
                onClick: () => {
                  setEditingBookmark(undefined);
                  setDialogOpen(true);
                },
              }}
            />
          </div>
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
                <Avatar name={bookmark.displayName} colorSeed={bookmark.bookmarkId} size="xlarge" />
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

      {/* T13.1.1 — the Home screen's "obvious path to Settings": full device/voice settings only
          make sense once connected to a server (there is no `VoiceChannelState`/`VoiceChannelActions`
          before then), so this reuses the existing `IdentityPanel` (nickname + Identity ID + the
          danger-styled Regenerate action) rather than fabricating a second, disconnected copy of
          `SettingsPanel.tsx`'s device pickers. `identityDetailsCollapsed` (security review): Home has
          no separate "Advanced" tab the way `SettingsPanel.tsx` does, so without this the
          cryptographic Identity ID and the destructive Regenerate action would be one click away
          from Home with no extra step at all — collapses them behind their own closed-by-default
          disclosure instead, consistent with the "identity must not be prominent outside an explicit
          advanced area" rule. */}
      {hasProfile &&
        identity &&
        nickname !== undefined &&
        onNicknameChange &&
        onRegenerateIdentity && (
          <Modal
            open={profileOpen}
            onClose={() => {
              setProfileOpen(false);
            }}
            title="Profile"
            testId="server-home-profile-modal"
          >
            <IdentityPanel
              nickname={nickname}
              identity={identity}
              onNicknameChange={onNicknameChange}
              onRegenerate={onRegenerateIdentity}
              identityDetailsCollapsed
            />
          </Modal>
        )}
    </main>
  );
}
