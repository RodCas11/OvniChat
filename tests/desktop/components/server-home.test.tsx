// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServerHome } from '../../../apps/desktop/src/renderer/shell/ServerHome.js';
import { ToastProvider } from '../../../apps/desktop/src/renderer/ui/ToastProvider.js';
import {
  createClientSettings,
  createIdentity,
  installDesktopAppMock,
} from '../fixtures/desktop-app-mock.js';

// RTL's automatic post-test cleanup only self-registers when it detects a *global* `afterEach`
// (i.e. `test.globals: true` in `vitest.config.ts`, deliberately left `false` for this repo's
// existing Main-process tests) — explicit here instead, so a previous test's rendered tree never
// leaks into the next one's `screen` queries.
afterEach(() => {
  cleanup();
});

/** `ServerHome` calls the real `useToast()` unconditionally (its bookmark-removal success toast) —
 * every render needs a real `<ToastProvider>` ancestor, exactly like `index.tsx` provides one in
 * production. */
function renderServerHome(props: Parameters<typeof ServerHome>[0]): ReturnType<typeof render> {
  return render(
    <ToastProvider>
      <ServerHome {...props} />
    </ToastProvider>,
  );
}

describe('ServerHome (T13.1)', () => {
  it('shows the empty state (no fake/hardcoded servers) when there are no bookmarks', async () => {
    installDesktopAppMock({
      getClientSettings: vi.fn().mockResolvedValue(createClientSettings({ bookmarks: [] })),
    });
    const onConnect = vi.fn();

    renderServerHome({ onConnect, connectionError: undefined });

    expect(await screen.findByText('No servers yet')).toBeInTheDocument();
    expect(screen.queryByTestId(/^server-home-tile-/)).not.toBeInTheDocument();
  });

  it('renders exactly one tile per real bookmark returned by getClientSettings, plus an add tile', async () => {
    const bookmarks = [
      { bookmarkId: 'a', displayName: 'Server A', serverAddress: '127.0.0.1:8090' },
      { bookmarkId: 'b', displayName: 'Server B', serverAddress: '127.0.0.1:8091' },
    ];
    installDesktopAppMock({
      getClientSettings: vi.fn().mockResolvedValue(createClientSettings({ bookmarks })),
    });

    renderServerHome({ onConnect: vi.fn(), connectionError: undefined });

    await waitFor(() => {
      expect(screen.getByTestId('server-home-tile-a')).toBeInTheDocument();
    });
    expect(screen.getByTestId('server-home-tile-b')).toBeInTheDocument();
    expect(screen.getByText('Server A')).toBeInTheDocument();
    expect(screen.getByText('Server B')).toBeInTheDocument();
    expect(screen.getByTestId('server-home-add-tile')).toBeInTheDocument();
    // Never a fake/hardcoded server beyond what getClientSettings actually returned.
    expect(screen.queryAllByTestId(/^server-home-tile-/)).toHaveLength(2);
  });

  it('connects using the real onConnect callback when a bookmark tile is clicked', async () => {
    const bookmarks = [
      { bookmarkId: 'a', displayName: 'Server A', serverAddress: '127.0.0.1:8090' },
    ];
    installDesktopAppMock({
      getClientSettings: vi.fn().mockResolvedValue(createClientSettings({ bookmarks })),
    });
    const onConnect = vi.fn();

    renderServerHome({ onConnect, connectionError: undefined });

    const tile = await screen.findByTestId('server-home-tile-a');
    fireEvent.click(tile);

    expect(onConnect).toHaveBeenCalledWith('ws://127.0.0.1:8090', undefined);
  });

  it('opens the Add Server dialog from the add-server action, wired to the real bookmark IPC', async () => {
    const addBookmark = vi.fn().mockResolvedValue({
      bookmarkId: 'new-1',
      displayName: 'New Server',
      serverAddress: '10.0.0.5:8090',
    });
    installDesktopAppMock({
      getClientSettings: vi.fn().mockResolvedValue(createClientSettings({ bookmarks: [] })),
      addBookmark,
    });

    renderServerHome({ onConnect: vi.fn(), connectionError: undefined });

    const addAction = await screen.findByRole('button', { name: 'Add Server' });
    fireEvent.click(addAction);

    expect(screen.getByTestId('add-server-dialog')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('add-server-name-input'), {
      target: { value: 'New Server' },
    });
    fireEvent.change(screen.getByTestId('add-server-address-input'), {
      target: { value: '10.0.0.5:8090' },
    });
    fireEvent.click(screen.getByTestId('add-server-submit'));

    await waitFor(() => {
      expect(addBookmark).toHaveBeenCalledWith({
        displayName: 'New Server',
        serverAddress: '10.0.0.5:8090',
      });
    });
  });

  it('renders a connection error passed in via props, never fabricating one', async () => {
    installDesktopAppMock({
      getClientSettings: vi.fn().mockResolvedValue(createClientSettings({ bookmarks: [] })),
    });

    renderServerHome({ onConnect: vi.fn(), connectionError: 'Could not reach that server' });

    expect(await screen.findByRole('alert')).toHaveTextContent('Could not reach that server');
  });

  describe('T13.1.1 — nickname/profile row (optional identity props)', () => {
    it('omits the nickname/profile row entirely when identity props are not supplied (the existing tests above, which never pass them, keep working)', async () => {
      installDesktopAppMock({
        getClientSettings: vi.fn().mockResolvedValue(createClientSettings({ bookmarks: [] })),
      });

      renderServerHome({ onConnect: vi.fn(), connectionError: undefined });

      await screen.findByText('No servers yet');
      expect(screen.queryByTestId('server-home-profile')).not.toBeInTheDocument();
    });

    it('renders the nickname/profile row and opens the real IdentityPanel modal when identity props ARE supplied (the realistic connected-app case)', async () => {
      installDesktopAppMock({
        getClientSettings: vi.fn().mockResolvedValue(createClientSettings({ bookmarks: [] })),
      });
      const identity = createIdentity();
      const onNicknameChange = vi.fn().mockResolvedValue(true);
      const onRegenerateIdentity = vi.fn().mockResolvedValue(undefined);

      renderServerHome({
        onConnect: vi.fn(),
        connectionError: undefined,
        identity,
        nickname: 'Nova',
        onNicknameChange,
        onRegenerateIdentity,
      });

      const profileRow = await screen.findByTestId('server-home-profile');
      expect(profileRow).toHaveTextContent('Nova');
      expect(screen.queryByTestId('server-home-profile-modal')).not.toBeInTheDocument();

      fireEvent.click(profileRow);

      const modal = screen.getByTestId('server-home-profile-modal');
      expect(modal).toBeInTheDocument();
      // Security-review fix (concurrent with this task): Home has no separate "Advanced" tab the
      // way Settings does, so the cryptographic Identity ID / Regenerate action stay behind their
      // own closed-by-default disclosure here (`IdentityPanel`'s `identityDetailsCollapsed` prop) —
      // not visible until that disclosure is explicitly opened.
      expect(modal).not.toHaveTextContent(identity.identityId);

      fireEvent.click(screen.getByRole('button', { name: 'Advanced (cryptographic identity)' }));

      expect(modal).toHaveTextContent(identity.identityId);
    });
  });
});
