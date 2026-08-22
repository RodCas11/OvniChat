// @vitest-environment jsdom
//
// T13.2 — the delete confirmation's cascade-count copy is truthfully derived client-side (deletion
// always cascades the whole subtree server-side — there is no separate "still has children"
// rejection code), and the occupied-channel copy is accurate for what this connection can actually
// know (exact count only for the channel it is itself joined to; a general, still-truthful note
// otherwise) — never a fabricated blocking error.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { DeleteChannelConfirmDialog } from '../../../apps/desktop/src/renderer/workspace/DeleteChannelConfirmDialog.js';
import { ToastProvider } from '../../../apps/desktop/src/renderer/ui/ToastProvider.js';
import {
  createChannel,
  createParticipant,
  createVoiceActions,
  createVoiceState,
} from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

describe('DeleteChannelConfirmDialog (T13.2)', () => {
  it('shows a truthful cascade-count for a category with descendants', () => {
    const channelTree = [
      createChannel({ nodeId: 'games', name: 'GAMES', kind: 'category' }),
      createChannel({ nodeId: 'a', name: 'A', kind: 'voice', parentId: 'games' }),
      createChannel({ nodeId: 'b', name: 'B', kind: 'voice', parentId: 'games' }),
    ];
    const state = createVoiceState({ channelTree });

    render(
      <ToastProvider>
        <DeleteChannelConfirmDialog
          open
          onClose={vi.fn()}
          state={state}
          actions={createVoiceActions()}
          nodeId="games"
        />
      </ToastProvider>,
    );

    expect(screen.getByText(/This will also delete 2 channels inside it\./)).toBeInTheDocument();
  });

  it('shows an exact participant count when deleting the channel this connection is currently joined to', () => {
    const state = createVoiceState({
      channelTree: [createChannel({ nodeId: 'general' })],
      currentChannelId: 'general',
      participants: [
        createParticipant({ participantId: 'p1' }),
        createParticipant({ participantId: 'p2' }),
      ],
    });

    render(
      <ToastProvider>
        <DeleteChannelConfirmDialog
          open
          onClose={vi.fn()}
          state={state}
          actions={createVoiceActions()}
          nodeId="general"
        />
      </ToastProvider>,
    );

    expect(screen.getByText(/currently has 2 participants connected/)).toBeInTheDocument();
    expect(screen.getByText(/nobody will be disconnected from the server/)).toBeInTheDocument();
  });

  it('shows a general (non-fabricated) occupancy note for a voice channel this connection is not in', () => {
    const state = createVoiceState({ channelTree: [createChannel({ nodeId: 'general' })] });

    render(
      <ToastProvider>
        <DeleteChannelConfirmDialog
          open
          onClose={vi.fn()}
          state={state}
          actions={createVoiceActions()}
          nodeId="general"
        />
      </ToastProvider>,
    );

    expect(
      screen.getByText(
        /If anyone is currently in this channel, deleting it will remove their voice membership only/,
      ),
    ).toBeInTheDocument();
  });

  it('calls deleteChannel and closes on confirm', async () => {
    const deleteChannel = vi.fn().mockResolvedValue(undefined);
    const actions = createVoiceActions({ deleteChannel });
    const state = createVoiceState({ channelTree: [createChannel({ nodeId: 'general' })] });
    const onClose = vi.fn();

    render(
      <ToastProvider>
        <DeleteChannelConfirmDialog
          open
          onClose={onClose}
          state={state}
          actions={actions}
          nodeId="general"
        />
      </ToastProvider>,
    );

    fireEvent.click(screen.getByTestId('delete-channel-confirm'));

    await waitFor(() => {
      expect(deleteChannel).toHaveBeenCalledWith('general');
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});
