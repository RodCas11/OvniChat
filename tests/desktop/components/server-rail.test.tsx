// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ServerRail } from '../../../apps/desktop/src/renderer/shell/ServerRail.js';
import { createClientSettings, installDesktopAppMock } from '../fixtures/desktop-app-mock.js';

afterEach(() => {
  cleanup();
});

describe('ServerRail (T13.1)', () => {
  const bookmarks = [
    { bookmarkId: 'a', displayName: 'Server A', serverAddress: '127.0.0.1:8090' },
    { bookmarkId: 'b', displayName: 'Server B', serverAddress: '127.0.0.1:8091' },
  ];

  it('renders exactly one rail tile per bookmark', async () => {
    installDesktopAppMock({
      getClientSettings: vi.fn().mockResolvedValue(createClientSettings({ bookmarks })),
    });

    render(
      <ServerRail activeServerAddress={undefined} onSwitchServer={vi.fn()} onGoHome={vi.fn()} />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('server-rail-tile-a')).toBeInTheDocument();
    });
    expect(screen.getByTestId('server-rail-tile-b')).toBeInTheDocument();
    expect(screen.queryAllByTestId(/^server-rail-tile-/)).toHaveLength(2);
  });

  it('marks only the currently-connected bookmark as active, with more than color alone', async () => {
    installDesktopAppMock({
      getClientSettings: vi.fn().mockResolvedValue(createClientSettings({ bookmarks })),
    });

    render(
      <ServerRail
        activeServerAddress="127.0.0.1:8091"
        onSwitchServer={vi.fn()}
        onGoHome={vi.fn()}
      />,
    );

    const tileA = await screen.findByTestId('server-rail-tile-a');
    const tileB = screen.getByTestId('server-rail-tile-b');
    expect(tileA).toHaveAttribute('data-active', 'false');
    expect(tileB).toHaveAttribute('data-active', 'true');
    expect(tileB).toHaveAttribute('aria-current', 'true');
    expect(tileA).not.toHaveAttribute('aria-current');
  });

  it('switches server via the real onSwitchServer callback (disconnect -> connect lifecycle owned by the caller)', async () => {
    installDesktopAppMock({
      getClientSettings: vi.fn().mockResolvedValue(createClientSettings({ bookmarks })),
    });
    const onSwitchServer = vi.fn();

    render(
      <ServerRail
        activeServerAddress="127.0.0.1:8090"
        onSwitchServer={onSwitchServer}
        onGoHome={vi.fn()}
      />,
    );

    const tileB = await screen.findByTestId('server-rail-tile-b');
    fireEvent.click(tileB);

    expect(onSwitchServer).toHaveBeenCalledWith('ws://127.0.0.1:8091');
  });

  it('never re-triggers a switch when clicking the already-active server', async () => {
    installDesktopAppMock({
      getClientSettings: vi.fn().mockResolvedValue(createClientSettings({ bookmarks })),
    });
    const onSwitchServer = vi.fn();

    render(
      <ServerRail
        activeServerAddress="127.0.0.1:8090"
        onSwitchServer={onSwitchServer}
        onGoHome={vi.fn()}
      />,
    );

    const tileA = await screen.findByTestId('server-rail-tile-a');
    fireEvent.click(tileA);

    expect(onSwitchServer).not.toHaveBeenCalled();
  });

  it('calls the real onGoHome callback (an explicit disconnect, not a visual-only change) from the Home button', async () => {
    installDesktopAppMock({
      getClientSettings: vi.fn().mockResolvedValue(createClientSettings({ bookmarks: [] })),
    });
    const onGoHome = vi.fn();

    render(
      <ServerRail activeServerAddress={undefined} onSwitchServer={vi.fn()} onGoHome={onGoHome} />,
    );

    fireEvent.click(screen.getByTestId('server-rail-home'));

    expect(onGoHome).toHaveBeenCalledTimes(1);
  });

  it('every icon-only rail button has a real accessible name', async () => {
    installDesktopAppMock({
      getClientSettings: vi.fn().mockResolvedValue(createClientSettings({ bookmarks })),
    });

    render(
      <ServerRail activeServerAddress={undefined} onSwitchServer={vi.fn()} onGoHome={vi.fn()} />,
    );

    expect(screen.getByTestId('server-rail-home')).toHaveAccessibleName();
    expect(screen.getByTestId('server-rail-add')).toHaveAccessibleName();
  });
});
