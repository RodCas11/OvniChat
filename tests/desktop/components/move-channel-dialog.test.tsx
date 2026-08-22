// @vitest-environment jsdom
//
// T13.2 — the Move dialog excludes the node's own subtree from valid targets (moving a node into
// its own descendant is a cycle the server would also reject via CHANNEL_PARENT_INVALID, but this
// proves the client never even offers the option).
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MoveChannelDialog } from '../../../apps/desktop/src/renderer/workspace/MoveChannelDialog.js';
import { ToastProvider } from '../../../apps/desktop/src/renderer/ui/ToastProvider.js';
import { createChannel, createVoiceActions, createVoiceState } from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

describe('MoveChannelDialog (T13.2)', () => {
  it('excludes the node itself and all of its descendants from the target picker', () => {
    const channelTree = [
      createChannel({ nodeId: 'parent', name: 'Path of Exile', kind: 'voice' }),
      createChannel({ nodeId: 'child', name: 'Bossing', kind: 'voice', parentId: 'parent' }),
      createChannel({
        nodeId: 'grandchild',
        name: 'Uber Bosses',
        kind: 'voice',
        parentId: 'child',
      }),
      createChannel({ nodeId: 'other', name: 'Other Channel', kind: 'voice' }),
    ];
    const state = createVoiceState({ channelTree });

    render(
      <ToastProvider>
        <MoveChannelDialog
          open
          onClose={vi.fn()}
          state={state}
          actions={createVoiceActions()}
          nodeId="parent"
        />
      </ToastProvider>,
    );

    const select = screen.getByTestId('move-channel-target');
    const optionLabels = within(select)
      .getAllByRole('option')
      .map((option) => option.textContent?.trim());

    expect(optionLabels).toContain('Other Channel');
    expect(optionLabels.some((label) => label?.includes('Path of Exile'))).toBe(false);
    expect(optionLabels.some((label) => label?.includes('Bossing'))).toBe(false);
    expect(optionLabels.some((label) => label?.includes('Uber Bosses'))).toBe(false);
  });

  it('Cancel closes the dialog without ever calling moveChannel', () => {
    const channelTree = [
      createChannel({ nodeId: 'games', name: 'GAMES', kind: 'category' }),
      createChannel({ nodeId: 'general', name: 'General', kind: 'voice', parentId: 'games' }),
      createChannel({ nodeId: 'lounge', name: 'Lounge', kind: 'voice' }),
    ];
    const moveChannel = vi.fn();
    const actions = createVoiceActions({ moveChannel });
    const state = createVoiceState({ channelTree });
    const onClose = vi.fn();

    render(
      <ToastProvider>
        <MoveChannelDialog
          open
          onClose={onClose}
          state={state}
          actions={actions}
          nodeId="general"
        />
      </ToastProvider>,
    );

    // Change the selection but never confirm — Cancel must discard it.
    fireEvent.change(screen.getByTestId('move-channel-target'), { target: { value: 'lounge' } });
    fireEvent.click(screen.getByText('Cancel'));

    expect(moveChannel).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('shows the current location breadcrumb and calls moveChannel with the selected target', async () => {
    const channelTree = [
      createChannel({ nodeId: 'games', name: 'GAMES', kind: 'category' }),
      createChannel({ nodeId: 'general', name: 'General', kind: 'voice', parentId: 'games' }),
      createChannel({ nodeId: 'lounge', name: 'Lounge', kind: 'voice' }),
    ];
    const moveChannel = vi.fn().mockResolvedValue(undefined);
    const actions = createVoiceActions({ moveChannel });
    const state = createVoiceState({ channelTree });
    const onClose = vi.fn();

    render(
      <ToastProvider>
        <MoveChannelDialog
          open
          onClose={onClose}
          state={state}
          actions={actions}
          nodeId="general"
        />
      </ToastProvider>,
    );

    expect(screen.getByText('GAMES / General')).toBeInTheDocument();

    fireEvent.change(screen.getByTestId('move-channel-target'), { target: { value: '' } });
    fireEvent.click(screen.getByTestId('move-channel-submit'));

    await waitFor(() => {
      expect(moveChannel).toHaveBeenCalledWith('general', undefined);
    });
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });
});
