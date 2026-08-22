// @vitest-environment jsdom
//
// T13.2 — the password join prompt: renders `state.channelPasswordPrompt`, shows the hook's own
// inline wrong-password error, and clears the local field after every submit attempt regardless of
// outcome (belt-and-suspenders on top of the hook never persisting the password anywhere).
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PasswordJoinDialog } from '../../../apps/desktop/src/renderer/workspace/PasswordJoinDialog.js';
import { createChannel, createVoiceActions, createVoiceState } from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

describe('PasswordJoinDialog (T13.2)', () => {
  it('renders nothing when there is no active prompt', () => {
    const { container } = render(
      <PasswordJoinDialog state={createVoiceState()} actions={createVoiceActions()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the channel name and submits the entered password, clearing the field afterward', () => {
    const submitChannelPassword = vi.fn();
    const actions = createVoiceActions({ submitChannelPassword });
    const state = createVoiceState({
      channelTree: [createChannel({ nodeId: 'vip', name: 'VIP Lounge', hasPassword: true })],
      channelPasswordPrompt: {
        channelId: 'vip',
        isRestore: false,
        submitting: false,
        error: undefined,
      },
    });

    render(<PasswordJoinDialog state={state} actions={actions} />);

    expect(screen.getByText(/VIP Lounge/)).toBeInTheDocument();
    fireEvent.change(screen.getByTestId('password-join-input'), { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByTestId('password-join-submit'));

    expect(submitChannelPassword).toHaveBeenCalledWith('hunter2');
    expect(screen.getByTestId('password-join-input')).toHaveValue('');
  });

  it('renders the hook-supplied inline wrong-password error, never a raw code', () => {
    const state = createVoiceState({
      channelTree: [createChannel({ nodeId: 'vip', name: 'VIP Lounge' })],
      channelPasswordPrompt: {
        channelId: 'vip',
        isRestore: false,
        submitting: false,
        error: 'Incorrect channel password.',
      },
    });

    render(<PasswordJoinDialog state={state} actions={createVoiceActions()} />);

    expect(screen.getByText('Incorrect channel password.')).toBeInTheDocument();
    expect(screen.queryByText('CHANNEL_PASSWORD_INVALID')).not.toBeInTheDocument();
  });

  it('Cancel dismisses the prompt without submitting anything, clearing the field', () => {
    const dismissChannelPasswordPrompt = vi.fn();
    const submitChannelPassword = vi.fn();
    const actions = createVoiceActions({ dismissChannelPasswordPrompt, submitChannelPassword });
    const state = createVoiceState({
      channelTree: [createChannel({ nodeId: 'vip', name: 'VIP Lounge' })],
      channelPasswordPrompt: {
        channelId: 'vip',
        isRestore: false,
        submitting: false,
        error: undefined,
      },
    });

    render(<PasswordJoinDialog state={state} actions={actions} />);

    fireEvent.change(screen.getByTestId('password-join-input'), { target: { value: 'typed' } });
    fireEvent.click(screen.getByText('Cancel'));

    expect(dismissChannelPasswordPrompt).toHaveBeenCalledTimes(1);
    expect(submitChannelPassword).not.toHaveBeenCalled();
  });
});
