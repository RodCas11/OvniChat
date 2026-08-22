// @vitest-environment jsdom
//
// T13.2 — Create Category / Edit Category: confirms the form has no password/user-limit/type
// fields at all (categories are voice-agnostic — those are voice-only concepts, entirely omitted
// rather than merely disabled), and that create/edit both round-trip through the real actions.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CategoryModal,
  type CategoryModalMode,
} from '../../../apps/desktop/src/renderer/workspace/CategoryModal.js';
import { ToastProvider } from '../../../apps/desktop/src/renderer/ui/ToastProvider.js';
import type {
  VoiceChannelActions,
  VoiceChannelState,
} from '../../../apps/desktop/src/renderer/voice/use-voice-channel.js';
import {
  createChannelAdminView,
  createVoiceActions,
  createVoiceState,
} from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

function renderModal(
  mode: CategoryModalMode,
  overrides: {
    readonly state?: VoiceChannelState;
    readonly actions?: VoiceChannelActions;
    readonly onClose?: () => void;
  } = {},
) {
  const onClose = overrides.onClose ?? vi.fn();
  const state = overrides.state ?? createVoiceState();
  const actions = overrides.actions ?? createVoiceActions();
  const result = render(
    <ToastProvider>
      <CategoryModal open onClose={onClose} state={state} actions={actions} mode={mode} />
    </ToastProvider>,
  );
  return { ...result, onClose, state, actions };
}

describe('CategoryModal (T13.2)', () => {
  it('renders no password, user-limit, or type (permanent/temporary) fields at all', () => {
    renderModal({ type: 'create' });

    expect(screen.queryByText(/password/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/user limit/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/temporary/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/permanent/i)).not.toBeInTheDocument();
    // Still has the real fields it does own.
    expect(screen.getByTestId('category-modal-name')).toBeInTheDocument();
    expect(screen.getByText('Who can see this category?')).toBeInTheDocument();
    expect(screen.queryByText('Who can see this channel?')).not.toBeInTheDocument();
    // T13.2.1 — a category is never joinable itself; the Join axis legend must not imply otherwise.
    expect(screen.queryByText('Who can join this channel?')).not.toBeInTheDocument();
  });

  it('never shows a parent picker — categories are always top-level', () => {
    renderModal({ type: 'create' });
    expect(screen.queryByText('Location')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });

  it('creates a category via the real action', async () => {
    const createCategory = vi
      .fn()
      .mockResolvedValue(createChannelAdminView({ nodeId: 'cat-1', kind: 'category' }));
    const actions = createVoiceActions({ createCategory });
    const { onClose } = renderModal({ type: 'create' }, { actions });

    fireEvent.change(screen.getByTestId('category-modal-name'), { target: { value: 'GAMES' } });
    fireEvent.click(screen.getByTestId('category-modal-submit'));

    await waitFor(() => {
      expect(createCategory).toHaveBeenCalledWith('GAMES');
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('prefills Edit mode from getEditableChannelNode', async () => {
    const getEditableChannelNode = vi
      .fn()
      .mockResolvedValue(
        createChannelAdminView({ nodeId: 'cat-1', kind: 'category', name: 'GAMES' }),
      );
    const actions = createVoiceActions({ getEditableChannelNode });
    renderModal({ type: 'edit', nodeId: 'cat-1' }, { actions });

    await waitFor(() => {
      expect(screen.getByTestId('category-modal-name')).toHaveValue('GAMES');
    });
  });

  it('discards a create-mode draft on close/reopen — reopening starts clean', () => {
    const { rerender, onClose } = renderModal({ type: 'create' });

    fireEvent.change(screen.getByTestId('category-modal-name'), {
      target: { value: 'Half-typed draft' },
    });
    expect(screen.getByTestId('category-modal-name')).toHaveValue('Half-typed draft');

    rerender(
      <ToastProvider>
        <CategoryModal
          open={false}
          onClose={onClose}
          state={createVoiceState()}
          actions={createVoiceActions()}
          mode={{ type: 'create' }}
        />
      </ToastProvider>,
    );
    rerender(
      <ToastProvider>
        <CategoryModal
          open
          onClose={onClose}
          state={createVoiceState()}
          actions={createVoiceActions()}
          mode={{ type: 'create' }}
        />
      </ToastProvider>,
    );

    expect(screen.getByTestId('category-modal-name')).toHaveValue('');
  });

  it('closes gracefully if getEditableChannelNode rejects — a race, since the menu item should not have been shown at all', async () => {
    const getEditableChannelNode = vi.fn().mockRejectedValue(new Error('denied'));
    const actions = createVoiceActions({ getEditableChannelNode });
    const { onClose } = renderModal({ type: 'edit', nodeId: 'cat-1' }, { actions });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
