import { useCallback, useEffect, useState } from 'react';

import type { DesktopBookmarkInput, DesktopServerBookmark } from '../../shared/ipc-contract.js';

export interface BookmarksState {
  readonly bookmarks: readonly DesktopServerBookmark[];
  readonly connectOnStartup: boolean;
  readonly lastServerAddress: string | undefined;
  readonly loaded: boolean;
}

export interface BookmarksActions {
  addBookmark: (input: DesktopBookmarkInput) => Promise<DesktopServerBookmark | undefined>;
  updateBookmark: (bookmark: DesktopServerBookmark) => Promise<boolean>;
  removeBookmark: (bookmarkId: string) => Promise<boolean>;
  setConnectOnStartup: (value: boolean) => void;
}

/**
 * T13.1 — extracted from the original `ConnectionScreen.tsx` (T11 Section 9-16) without changing
 * any of its IPC calls or persistence semantics: loads local server bookmarks and the
 * "connect automatically on startup" preference once via `getClientSettings`, and wraps
 * `addBookmark`/`updateBookmark`/`removeBookmark`/`updateClientSettings` exactly as that component
 * did, so `ServerHome`/`ServerRail`/`AddServerDialog` can all share one real implementation instead
 * of re-deriving bookmark CRUD logic. Each caller mounts its own instance (mirrors this codebase's
 * existing pattern of `VoiceChannelView`/`SettingsPanel` each independently loading their own slice
 * of `getClientSettings()`) — bookmarks are local, on-disk, single-profile data with no live-sync
 * concern between two simultaneously-mounted callers.
 */
export function useBookmarks(): readonly [BookmarksState, BookmarksActions] {
  const [bookmarks, setBookmarks] = useState<readonly DesktopServerBookmark[]>([]);
  const [connectOnStartup, setConnectOnStartupState] = useState(false);
  const [lastServerAddress, setLastServerAddress] = useState<string | undefined>(undefined);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    window.desktopApp
      .getClientSettings()
      .then((settings) => {
        if (cancelled) return;
        setBookmarks(settings.bookmarks);
        setConnectOnStartupState(settings.connectOnStartup);
        setLastServerAddress(settings.lastServerAddress ?? undefined);
        setLoaded(true);
      })
      .catch((error: unknown) => {
        console.error('use-bookmarks: failed to load persisted settings', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const addBookmark = useCallback(
    async (input: DesktopBookmarkInput): Promise<DesktopServerBookmark | undefined> => {
      try {
        const bookmark = await window.desktopApp.addBookmark(input);
        setBookmarks((prev) => [...prev, bookmark]);
        return bookmark;
      } catch (error) {
        console.error('use-bookmarks: failed to add bookmark', error);
        return undefined;
      }
    },
    [],
  );

  const updateBookmark = useCallback(async (bookmark: DesktopServerBookmark): Promise<boolean> => {
    try {
      const ok = await window.desktopApp.updateBookmark(bookmark);
      if (ok) {
        setBookmarks((prev) =>
          prev.map((b) => (b.bookmarkId === bookmark.bookmarkId ? bookmark : b)),
        );
      }
      return ok;
    } catch (error) {
      console.error('use-bookmarks: failed to update bookmark', error);
      return false;
    }
  }, []);

  const removeBookmark = useCallback(async (bookmarkId: string): Promise<boolean> => {
    try {
      const removed = await window.desktopApp.removeBookmark(bookmarkId);
      if (removed) setBookmarks((prev) => prev.filter((b) => b.bookmarkId !== bookmarkId));
      return removed;
    } catch (error) {
      console.error('use-bookmarks: failed to remove bookmark', error);
      return false;
    }
  }, []);

  const setConnectOnStartup = useCallback((value: boolean) => {
    setConnectOnStartupState(value);
    window.desktopApp.updateClientSettings({ connectOnStartup: value }).catch((error: unknown) => {
      console.error('use-bookmarks: failed to persist connect-on-startup preference', error);
    });
  }, []);

  return [
    { bookmarks, connectOnStartup, lastServerAddress, loaded },
    { addBookmark, updateBookmark, removeBookmark, setConnectOnStartup },
  ];
}
