// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AddServerDialog } from '../../../apps/desktop/src/renderer/shell/AddServerDialog.js';
import type { BookmarksActions } from '../../../apps/desktop/src/renderer/connection/use-bookmarks.js';

afterEach(() => {
  cleanup();
});

function bookmarksActions(overrides: Partial<BookmarksActions> = {}): BookmarksActions {
  return {
    addBookmark: vi.fn(),
    updateBookmark: vi.fn().mockResolvedValue(true),
    removeBookmark: vi.fn(),
    setConnectOnStartup: vi.fn(),
    ...overrides,
  };
}

/**
 * Security review (T13.1, finding F-1): `AddServerDialog` stays mounted across `open` toggles
 * (`Modal` itself returns `null` while closed, but its parent does not unmount), so without an
 * explicit closed→open resync its form state used to leak from one opening into the next — an
 * abandoned "Add Server" draft could reappear when the user later opened "Edit Server" for an
 * unrelated bookmark, and saving would silently repoint that bookmark to the wrong address.
 */
describe('AddServerDialog (T13.1, F-1 regression coverage)', () => {
  it('does not leak an abandoned Add-mode draft into a later Edit-mode opening', () => {
    const actions = bookmarksActions();
    const { rerender } = render(
      <AddServerDialog open={true} onClose={vi.fn()} actions={actions} />,
    );

    fireEvent.change(screen.getByTestId('add-server-name-input'), {
      target: { value: 'Abandoned draft' },
    });
    fireEvent.change(screen.getByTestId('add-server-address-input'), {
      target: { value: '10.0.0.99:9999' },
    });

    // Close (e.g. Cancel) without saving.
    rerender(<AddServerDialog open={false} onClose={vi.fn()} actions={actions} />);

    // Re-open in Edit mode for an unrelated, real bookmark.
    const bookmark = {
      bookmarkId: 'b1',
      displayName: 'Real Server',
      serverAddress: '127.0.0.1:8090',
    };
    rerender(
      <AddServerDialog open={true} onClose={vi.fn()} actions={actions} bookmark={bookmark} />,
    );

    expect(screen.getByTestId('add-server-name-input')).toHaveValue('Real Server');
    expect(screen.getByTestId('add-server-address-input')).toHaveValue('127.0.0.1:8090');
  });

  it("resyncs to the new bookmark when re-opened for a different bookmark, never keeping the previous one's values", () => {
    const actions = bookmarksActions();
    const bookmarkA = { bookmarkId: 'a', displayName: 'Server A', serverAddress: '10.0.0.1:8090' };
    const bookmarkB = { bookmarkId: 'b', displayName: 'Server B', serverAddress: '10.0.0.2:8090' };

    const { rerender } = render(
      <AddServerDialog open={true} onClose={vi.fn()} actions={actions} bookmark={bookmarkA} />,
    );
    expect(screen.getByTestId('add-server-name-input')).toHaveValue('Server A');

    // Edit a field without saving, then close.
    fireEvent.change(screen.getByTestId('add-server-name-input'), {
      target: { value: 'Server A (unsaved edit)' },
    });
    rerender(
      <AddServerDialog open={false} onClose={vi.fn()} actions={actions} bookmark={bookmarkA} />,
    );

    // Re-open for a different bookmark.
    rerender(
      <AddServerDialog open={true} onClose={vi.fn()} actions={actions} bookmark={bookmarkB} />,
    );

    expect(screen.getByTestId('add-server-name-input')).toHaveValue('Server B');
    expect(screen.getByTestId('add-server-address-input')).toHaveValue('10.0.0.2:8090');
  });

  it('does not reset an in-progress edit merely because the bookmark prop is a new object with the same data', () => {
    const actions = bookmarksActions();
    const bookmarkV1 = { bookmarkId: 'a', displayName: 'Server A', serverAddress: '10.0.0.1:8090' };

    const { rerender } = render(
      <AddServerDialog open={true} onClose={vi.fn()} actions={actions} bookmark={bookmarkV1} />,
    );

    fireEvent.change(screen.getByTestId('add-server-name-input'), {
      target: { value: 'Server A (typing…)' },
    });

    // Same bookmark data, new object identity (e.g. from an unrelated parent re-render producing a
    // fresh array via `.map()`) — must not clobber the user's in-progress typing.
    const bookmarkV1Copy = { ...bookmarkV1 };
    rerender(
      <AddServerDialog open={true} onClose={vi.fn()} actions={actions} bookmark={bookmarkV1Copy} />,
    );

    expect(screen.getByTestId('add-server-name-input')).toHaveValue('Server A (typing…)');
  });

  // Regression (T13.4 UX bug): `AddServerDialog` passes `Modal` a locally-defined `resetAndClose`,
  // given a fresh identity on every one of `AddServerDialog`'s own re-renders — including the
  // re-render each keystroke causes via `setDisplayName`. `Modal`'s focus-management effect used to
  // depend on that `onClose` identity, so every keystroke re-ran it and yanked focus to the header
  // Close button. See `Modal.tsx`'s own fix and `tests/desktop/components/modal.test.tsx` for the
  // shared-level coverage; this proves the fix holds through a real consumer end to end.
  it('typing a full server name keeps focus on the field the whole time, never jumping to Close', () => {
    const actions = bookmarksActions();
    render(<AddServerDialog open={true} onClose={vi.fn()} actions={actions} />);

    const input = screen.getByTestId('add-server-name-input') as HTMLInputElement;
    input.focus();
    expect(input).toHaveFocus();

    const name = 'My Gaming Server';
    for (let i = 0; i < name.length; i += 1) {
      const value = name.slice(0, i + 1);
      fireEvent.change(input, { target: { value } });
      expect(input).toHaveFocus();
      expect(screen.getByRole('button', { name: 'Close' })).not.toHaveFocus();
    }

    expect(input).toHaveValue(name);
  });

  it('saves an edit against the currently-open bookmark, never a stale one', async () => {
    const updateBookmark = vi.fn().mockResolvedValue(true);
    const actions = bookmarksActions({ updateBookmark });
    const bookmark = { bookmarkId: 'a', displayName: 'Server A', serverAddress: '10.0.0.1:8090' };

    render(<AddServerDialog open={true} onClose={vi.fn()} actions={actions} bookmark={bookmark} />);

    fireEvent.change(screen.getByTestId('add-server-address-input'), {
      target: { value: '10.0.0.1:9999' },
    });
    fireEvent.click(screen.getByTestId('add-server-submit'));

    await vi.waitFor(() => {
      expect(updateBookmark).toHaveBeenCalledWith({
        bookmarkId: 'a',
        displayName: 'Server A',
        serverAddress: '10.0.0.1:9999',
      });
    });
  });
});
