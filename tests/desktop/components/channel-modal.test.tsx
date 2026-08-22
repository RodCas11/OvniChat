// @vitest-environment jsdom
//
// T13.2 — Create Channel / Create Subchannel / Edit Channel form behavior: bounds, password-confirm
// mismatch blocking submit, the temporary-channel helper copy, the unlimited/bounded user-limit
// toggle, Edit-mode prefill via `getEditableChannelNode`, and the password enable/change/remove UI
// never rendering or round-tripping an existing password.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChannelModal,
  type ChannelModalMode,
} from '../../../apps/desktop/src/renderer/workspace/ChannelModal.js';
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
  mode: ChannelModalMode,
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
      <ChannelModal open onClose={onClose} state={state} actions={actions} mode={mode} />
    </ToastProvider>,
  );
  return { ...result, onClose, state, actions };
}

describe('ChannelModal — Create (T13.2)', () => {
  it('bounds the name field to MAX_CHANNEL_NAME_LENGTH', () => {
    renderModal({ type: 'create', parentLocked: false });
    expect(screen.getByTestId('channel-modal-name')).toHaveAttribute('maxLength', '64');
  });

  it('bounds the user-limit field to MAX_CHANNEL_PARTICIPANTS', () => {
    renderModal({ type: 'create', parentLocked: false });
    expect(screen.getByTestId('channel-modal-user-limit')).toHaveAttribute('max', '64');
    expect(screen.getByTestId('channel-modal-user-limit')).toHaveAttribute('min', '1');
  });

  it('accepts a name at exactly the MAX_CHANNEL_NAME_LENGTH boundary', async () => {
    const createVoiceChannel = vi
      .fn()
      .mockResolvedValue(createChannelAdminView({ nodeId: 'new-1' }));
    const actions = createVoiceActions({ createVoiceChannel });
    renderModal({ type: 'create', parentLocked: false }, { actions });

    const boundaryName = 'B'.repeat(64);
    fireEvent.change(screen.getByTestId('channel-modal-name'), {
      target: { value: boundaryName },
    });
    fireEvent.click(screen.getByTestId('channel-modal-submit'));

    await waitFor(() => {
      expect(createVoiceChannel).toHaveBeenCalledWith(boundaryName, undefined, false);
    });
  });

  it('blocks submit for a blank (whitespace-only) name', () => {
    renderModal({ type: 'create', parentLocked: false });
    fireEvent.change(screen.getByTestId('channel-modal-name'), { target: { value: '   ' } });
    expect(screen.getByTestId('channel-modal-submit')).toBeDisabled();
  });

  it('"Create Subchannel" (parentLocked) hides the Location picker and pre-sets the parent on submit', async () => {
    const createVoiceChannel = vi
      .fn()
      .mockResolvedValue(createChannelAdminView({ nodeId: 'new-1' }));
    const actions = createVoiceActions({ createVoiceChannel });
    renderModal({ type: 'create', parentId: 'games', parentLocked: true }, { actions });

    expect(screen.queryByTestId('channel-modal-parent')).not.toBeInTheDocument();
    expect(screen.queryByText('Location')).not.toBeInTheDocument();

    fireEvent.change(screen.getByTestId('channel-modal-name'), { target: { value: 'Bossing' } });
    fireEvent.click(screen.getByTestId('channel-modal-submit'));

    await waitFor(() => {
      expect(createVoiceChannel).toHaveBeenCalledWith('Bossing', 'games', false);
    });
  });

  it('shows the Location picker (unlocked) when creating at the top level with no parent lock', () => {
    renderModal({ type: 'create', parentLocked: false });
    expect(screen.getByTestId('channel-modal-parent')).toBeInTheDocument();
  });

  it('discards a create-mode draft on close/reopen — reopening starts clean', () => {
    const { rerender, onClose } = renderModal({ type: 'create', parentLocked: false });

    fireEvent.change(screen.getByTestId('channel-modal-name'), {
      target: { value: 'Half-typed draft' },
    });
    expect(screen.getByTestId('channel-modal-name')).toHaveValue('Half-typed draft');

    // Close (unmount the open form) and reopen a fresh Create instance.
    rerender(
      <ToastProvider>
        <ChannelModal
          open={false}
          onClose={onClose}
          state={createVoiceState()}
          actions={createVoiceActions()}
          mode={{ type: 'create', parentLocked: false }}
        />
      </ToastProvider>,
    );
    rerender(
      <ToastProvider>
        <ChannelModal
          open
          onClose={onClose}
          state={createVoiceState()}
          actions={createVoiceActions()}
          mode={{ type: 'create', parentLocked: false }}
        />
      </ToastProvider>,
    );

    expect(screen.getByTestId('channel-modal-name')).toHaveValue('');
  });

  it('blocks submit when password and confirm-password mismatch, and shows an inline error', () => {
    renderModal({ type: 'create', parentLocked: false });

    fireEvent.change(screen.getByTestId('channel-modal-name'), { target: { value: 'Bossing' } });
    fireEvent.click(screen.getByTestId('channel-modal-password-enable'));
    fireEvent.change(screen.getByTestId('channel-modal-password'), {
      target: { value: 'secret1' },
    });
    fireEvent.change(screen.getByTestId('channel-modal-password-confirm'), {
      target: { value: 'secret2' },
    });

    expect(screen.getByText('Passwords must match.')).toBeInTheDocument();
    expect(screen.getByTestId('channel-modal-submit')).toBeDisabled();
  });

  it('renders temporary helper copy only once Temporary is selected', () => {
    renderModal({ type: 'create', parentLocked: false });

    expect(screen.queryByText(/never survive a server restart/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('channel-modal-temporary-radio'));
    expect(screen.getByText(/never survive a server restart/)).toBeInTheDocument();
  });

  it('toggles the user-limit number input enabled only when "bounded" is selected', () => {
    renderModal({ type: 'create', parentLocked: false });

    const userLimitInput = screen.getByTestId('channel-modal-user-limit');
    expect(userLimitInput).toBeDisabled();

    const boundedRadio = screen
      .getAllByRole('radio')
      .find(
        (radio) => (radio as HTMLInputElement).name === 'user-limit' && !radio.matches(':checked'),
      );
    expect(boundedRadio).toBeDefined();
    if (boundedRadio) fireEvent.click(boundedRadio);

    expect(screen.getByTestId('channel-modal-user-limit')).not.toBeDisabled();
  });

  it('creates a channel, then applies password and settings, calling each action distinctly', async () => {
    const createVoiceChannel = vi
      .fn()
      .mockResolvedValue(createChannelAdminView({ nodeId: 'new-1' }));
    const setChannelPassword = vi.fn().mockResolvedValue(undefined);
    const actions = createVoiceActions({ createVoiceChannel, setChannelPassword });
    const { onClose } = renderModal({ type: 'create', parentLocked: false }, { actions });

    fireEvent.change(screen.getByTestId('channel-modal-name'), { target: { value: 'Bossing' } });
    fireEvent.click(screen.getByTestId('channel-modal-password-enable'));
    fireEvent.change(screen.getByTestId('channel-modal-password'), {
      target: { value: 'secret1' },
    });
    fireEvent.change(screen.getByTestId('channel-modal-password-confirm'), {
      target: { value: 'secret1' },
    });

    fireEvent.click(screen.getByTestId('channel-modal-submit'));

    await waitFor(() => {
      expect(createVoiceChannel).toHaveBeenCalledWith('Bossing', undefined, false);
    });
    await waitFor(() => {
      expect(setChannelPassword).toHaveBeenCalledWith('new-1', 'secret1');
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});

describe('ChannelModal — Edit (T13.2)', () => {
  it('never renders the Permanent/Temporary type toggle — no conversion is implemented server-side', async () => {
    const getEditableChannelNode = vi
      .fn()
      .mockResolvedValue(createChannelAdminView({ nodeId: 'general', name: 'General' }));
    const actions = createVoiceActions({ getEditableChannelNode });
    renderModal({ type: 'edit', nodeId: 'general' }, { actions });

    await waitFor(() => {
      expect(screen.getByTestId('channel-modal-name')).toHaveValue('General');
    });
    expect(screen.queryByText('Permanent')).not.toBeInTheDocument();
    expect(screen.queryByText('Temporary')).not.toBeInTheDocument();
    expect(screen.queryByTestId('channel-modal-temporary-radio')).not.toBeInTheDocument();
  });

  it('never renders a Location/parent picker in Edit mode — moving lives in the separate Move dialog', async () => {
    const getEditableChannelNode = vi
      .fn()
      .mockResolvedValue(createChannelAdminView({ nodeId: 'general', name: 'General' }));
    const actions = createVoiceActions({ getEditableChannelNode });
    renderModal({ type: 'edit', nodeId: 'general' }, { actions });

    await waitFor(() => {
      expect(screen.getByTestId('channel-modal-name')).toHaveValue('General');
    });
    expect(screen.queryByTestId('channel-modal-parent')).not.toBeInTheDocument();
    expect(screen.queryByText('Location')).not.toBeInTheDocument();
  });

  it('prefills from getEditableChannelNode and never renders the existing password', async () => {
    const getEditableChannelNode = vi.fn().mockResolvedValue(
      createChannelAdminView({
        nodeId: 'general',
        name: 'General',
        userLimit: 12,
        hasPassword: true,
      }),
    );
    const actions = createVoiceActions({ getEditableChannelNode });
    renderModal({ type: 'edit', nodeId: 'general' }, { actions });

    await waitFor(() => {
      expect(screen.getByTestId('channel-modal-name')).toHaveValue('General');
    });
    expect(screen.getByTestId('channel-modal-user-limit')).toHaveValue(12);
    expect(screen.getByText('Password protection: Enabled')).toBeInTheDocument();
    // Never a password field with the existing (or any) password value round-tripped in.
    expect(screen.queryByTestId('channel-modal-password')).not.toBeInTheDocument();
  });

  it('closes gracefully (never a permanently-broken form) if getEditableChannelNode rejects — a race, since the menu item should not have been shown at all', async () => {
    const getEditableChannelNode = vi.fn().mockRejectedValue(new Error('denied'));
    const actions = createVoiceActions({ getEditableChannelNode });
    const { onClose } = renderModal({ type: 'edit', nodeId: 'general' }, { actions });

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });

  it('Remove Password requires an explicit confirm step before calling removeChannelPassword', async () => {
    const getEditableChannelNode = vi
      .fn()
      .mockResolvedValue(createChannelAdminView({ nodeId: 'general', hasPassword: true }));
    const removeChannelPassword = vi.fn().mockResolvedValue(undefined);
    const actions = createVoiceActions({ getEditableChannelNode, removeChannelPassword });
    renderModal({ type: 'edit', nodeId: 'general' }, { actions });

    await waitFor(() => {
      expect(screen.getByText('Password protection: Enabled')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByText('Remove Password'));
    expect(removeChannelPassword).not.toHaveBeenCalled();
    expect(screen.getByText(/Remove password from/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Remove'));
    await waitFor(() => {
      expect(removeChannelPassword).toHaveBeenCalledWith('general');
    });
  });

  it('Change Password reveals fresh (empty) password fields, never the existing value', async () => {
    const getEditableChannelNode = vi
      .fn()
      .mockResolvedValue(createChannelAdminView({ nodeId: 'general', hasPassword: true }));
    const actions = createVoiceActions({ getEditableChannelNode });
    renderModal({ type: 'edit', nodeId: 'general' }, { actions });

    await waitFor(() => {
      expect(screen.getByText('Change Password')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText('Change Password'));

    expect(screen.getByTestId('channel-modal-password')).toHaveValue('');
    expect(screen.getByTestId('channel-modal-password-confirm')).toHaveValue('');
  });
});
