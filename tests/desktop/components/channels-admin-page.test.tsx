// @vitest-environment jsdom
//
// T13.2 — the Channels admin page (Server Settings > Channels): root Create Category/Create
// Channel affordances gated on global `channels.create`, per-node affordances gated on the same
// optimistic Manage-rights check the context menu uses, and a Guest sees none of it.
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChannelsAdminPage } from '../../../apps/desktop/src/renderer/workspace/ChannelsAdminPage.js';
import {
  createChannel,
  createChannelAdminView,
  createVoiceActions,
  createVoiceState,
} from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

describe('ChannelsAdminPage (T13.2)', () => {
  it('shows root Create Category/Create Channel only with global channels.create', () => {
    const { rerender } = render(
      <ChannelsAdminPage
        state={createVoiceState({ myPermissions: [] })}
        actions={createVoiceActions({
          getEditableChannelNode: vi.fn().mockRejectedValue(new Error('denied')),
        })}
        onAdminIntent={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('channels-admin-create-category')).not.toBeInTheDocument();
    expect(screen.queryByTestId('channels-admin-create-channel')).not.toBeInTheDocument();

    rerender(
      <ChannelsAdminPage
        state={createVoiceState({ myPermissions: ['channels.create'] })}
        actions={createVoiceActions()}
        onAdminIntent={vi.fn()}
      />,
    );
    expect(screen.getByTestId('channels-admin-create-category')).toBeInTheDocument();
    expect(screen.getByTestId('channels-admin-create-channel')).toBeInTheDocument();
  });

  it('shows an empty state when the tree has no nodes', () => {
    render(
      <ChannelsAdminPage
        state={createVoiceState({ myPermissions: [], channelTree: [] })}
        actions={createVoiceActions()}
        onAdminIntent={vi.fn()}
      />,
    );
    expect(screen.getByText('No channels yet')).toBeInTheDocument();
  });

  it('renders per-node admin actions only once the optimistic Manage check resolves', async () => {
    const getEditableChannelNode = vi.fn().mockResolvedValue({
      nodeId: 'general',
      kind: 'voice',
      name: 'General',
      sortOrder: 0,
      visibilityPolicy: 'inherit',
      visibilityGroupIds: [],
      joinPolicy: 'inherit',
      joinGroupIds: [],
      managePolicy: 'inherit',
      manageGroupIds: [],
      hasPassword: false,
      temporary: false,
    });
    const actions = createVoiceActions({ getEditableChannelNode });
    // `parentId` set: Move's real authorization requires delegated Manage on the node's *parent*,
    // never the node itself (see `ChannelContextMenu.tsx`'s identical fixture doc comment) — a
    // top-level node can only ever be moved via the global `channels.manage` permission.
    const channelTree = [
      createChannel({ nodeId: 'games', name: 'Games', kind: 'category' }),
      createChannel({ nodeId: 'general', name: 'General', parentId: 'games' }),
    ];

    render(
      <ChannelsAdminPage
        state={createVoiceState({ myPermissions: [], channelTree })}
        actions={actions}
        onAdminIntent={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('channels-admin-edit-general')).not.toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByTestId('channels-admin-edit-general')).toBeInTheDocument();
    });
    expect(screen.getByTestId('channels-admin-move-general')).toBeInTheDocument();
  });

  it('per-node action gating distinguishes node-itself Manage from parent Manage (Move/Delete never appear from node-itself delegation alone)', async () => {
    const getEditableChannelNode = vi.fn((nodeId: string) =>
      nodeId === 'general'
        ? Promise.resolve(createChannelAdminView({ nodeId: 'general' }))
        : Promise.reject(new Error('denied')),
    );
    const actions = createVoiceActions({ getEditableChannelNode });
    const channelTree = [
      createChannel({ nodeId: 'games', name: 'Games', kind: 'category' }),
      createChannel({ nodeId: 'general', name: 'General', parentId: 'games' }),
    ];

    render(
      <ChannelsAdminPage
        state={createVoiceState({ myPermissions: [], channelTree })}
        actions={actions}
        onAdminIntent={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId('channels-admin-edit-general')).toBeInTheDocument();
    });
    // Delegated Manage on 'general' itself does not cover its parent ('games') — Move/Delete stay
    // absent, matching `handleChannelMove`/`handleChannelDelete`'s real parent-Manage requirement.
    expect(screen.queryByTestId('channels-admin-move-general')).not.toBeInTheDocument();
    expect(screen.queryByTestId('channels-admin-delete-general')).not.toBeInTheDocument();
  });

  it('clicking a row action invokes onAdminIntent with the right shape', () => {
    const onAdminIntent = vi.fn();
    render(
      <ChannelsAdminPage
        state={createVoiceState({ myPermissions: ['channels.create'] })}
        actions={createVoiceActions({
          getEditableChannelNode: vi.fn().mockRejectedValue(new Error('denied')),
        })}
        onAdminIntent={onAdminIntent}
      />,
    );

    screen.getByTestId('channels-admin-create-category').click();
    expect(onAdminIntent).toHaveBeenCalledWith({ type: 'create-category' });
  });
});
