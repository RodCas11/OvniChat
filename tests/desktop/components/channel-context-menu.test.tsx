// @vitest-environment jsdom
//
// T13.2 — proves the channel/category admin context menu (a) shows admin items immediately for a
// caller holding the relevant *global* permission, (b) merges admin items in once an optimistic
// `getEditableChannelNode` check resolves for a caller with only *delegated* Manage rights, (c)
// never shows them at all when that check rejects or the caller holds neither, and (d) a Guest with
// no channel-admin permissions at all sees zero admin DOM — never a disabled control.
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChannelContextMenu } from '../../../apps/desktop/src/renderer/workspace/ChannelContextMenu.js';
import { ChannelRequestError } from '../../../apps/desktop/src/renderer/voice/use-voice-channel.js';
import {
  createChannel,
  createChannelAdminView,
  createVoiceActions,
  createVoiceState,
} from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

describe('ChannelContextMenu (T13.2)', () => {
  it('a Guest with no permissions sees only base items, never any admin item — even after the optimistic check settles', async () => {
    const actions = createVoiceActions({
      getEditableChannelNode: vi
        .fn()
        .mockRejectedValue(new ChannelRequestError('CHANNEL_ACCESS_DENIED', 'denied')),
    });
    const state = createVoiceState({ myPermissions: [], channelTree: [createChannel()] });

    render(
      <ChannelContextMenu
        state={state}
        actions={actions}
        target={{ node: createChannel(), x: 10, y: 10 }}
        canJoin
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onJoin={vi.fn()}
        onLeave={vi.fn()}
        onAdminIntent={vi.fn()}
      />,
    );

    expect(screen.getByText('Open Chat')).toBeInTheDocument();
    expect(screen.getByText('Join Voice')).toBeInTheDocument();

    await waitFor(() => {
      expect(actions.getEditableChannelNode).toHaveBeenCalled();
    });

    expect(screen.queryByText('Edit Channel')).not.toBeInTheDocument();
    expect(screen.queryByText('Move Channel')).not.toBeInTheDocument();
    expect(screen.queryByText('Create Subchannel')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete Channel')).not.toBeInTheDocument();
  });

  it('shows Edit/Move/Create Subchannel immediately for global channels.manage — no network call needed', () => {
    const actions = createVoiceActions();
    const state = createVoiceState({ myPermissions: ['channels.manage'] });

    render(
      <ChannelContextMenu
        state={state}
        actions={actions}
        target={{ node: createChannel(), x: 0, y: 0 }}
        canJoin
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onJoin={vi.fn()}
        onLeave={vi.fn()}
        onAdminIntent={vi.fn()}
      />,
    );

    expect(screen.getByText('Edit Channel')).toBeInTheDocument();
    expect(screen.getByText('Move Channel')).toBeInTheDocument();
    expect(screen.getByText('Create Subchannel')).toBeInTheDocument();
    // Delete is gated on the *parent*, never covered by `channels.manage` alone.
    expect(screen.queryByText('Delete Channel')).not.toBeInTheDocument();
  });

  it('shows Delete immediately for global channels.delete', () => {
    const actions = createVoiceActions({
      // `channels.manage` is not held, so the (irrelevant to this test) manage-here check still
      // fires a real network call — mocked here just so it resolves instead of crashing.
      getEditableChannelNode: vi
        .fn()
        .mockRejectedValue(new ChannelRequestError('CHANNEL_ACCESS_DENIED', 'denied')),
    });
    const state = createVoiceState({ myPermissions: ['channels.delete'] });

    render(
      <ChannelContextMenu
        state={state}
        actions={actions}
        target={{ node: createChannel({ parentId: 'games' }), x: 0, y: 0 }}
        canJoin
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onJoin={vi.fn()}
        onLeave={vi.fn()}
        onAdminIntent={vi.fn()}
      />,
    );

    expect(screen.getByText('Delete Channel')).toBeInTheDocument();
  });

  it('merges in admin items once a delegated-Manage optimistic check resolves, without any global permission', async () => {
    const actions = createVoiceActions({
      getEditableChannelNode: vi.fn().mockResolvedValue(createChannelAdminView()),
    });
    const state = createVoiceState({ myPermissions: [] });

    render(
      <ChannelContextMenu
        state={state}
        actions={actions}
        // `parentId` set: Move's real authorization (`handleChannelMove`) requires delegated Manage
        // on the node's *parent*, never on the node itself — a top-level node (no parent) can only
        // ever be moved via the *global* `channels.manage` permission, since there is no parent to
        // hold delegated rights on. This fixture channel needs a parent for the delegated-Manage
        // "Move Channel" case under test to be a real, reachable scenario.
        target={{ node: createChannel({ parentId: 'games' }), x: 0, y: 0 }}
        canJoin
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onJoin={vi.fn()}
        onLeave={vi.fn()}
        onAdminIntent={vi.fn()}
      />,
    );

    // Base items render immediately, before the async check settles.
    expect(screen.getByText('Open Chat')).toBeInTheDocument();
    expect(screen.queryByText('Edit Channel')).not.toBeInTheDocument();

    await waitFor(() => {
      expect(screen.getByText('Edit Channel')).toBeInTheDocument();
    });
    expect(screen.getByText('Move Channel')).toBeInTheDocument();
    expect(screen.getByText('Create Subchannel')).toBeInTheDocument();
  });

  it('delegated Manage on the node itself (but NOT its parent) grants Edit/Create Subchannel but never Move/Delete', async () => {
    const getEditableChannelNode = vi.fn((nodeId: string) =>
      nodeId === 'general'
        ? Promise.resolve(createChannelAdminView({ nodeId: 'general' }))
        : Promise.reject(new ChannelRequestError('CHANNEL_ACCESS_DENIED', 'denied')),
    );
    const actions = createVoiceActions({ getEditableChannelNode });
    const state = createVoiceState({ myPermissions: [] });

    render(
      <ChannelContextMenu
        state={state}
        actions={actions}
        target={{ node: createChannel({ nodeId: 'general', parentId: 'games' }), x: 0, y: 0 }}
        canJoin
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onJoin={vi.fn()}
        onLeave={vi.fn()}
        onAdminIntent={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Edit Channel')).toBeInTheDocument();
    });
    expect(screen.getByText('Create Subchannel')).toBeInTheDocument();
    // Node-itself Manage is not enough — `handleChannelMove`/`handleChannelDelete` require Manage
    // on the *parent* ('games'), which this identity does not hold.
    expect(screen.queryByText('Move Channel')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete Channel')).not.toBeInTheDocument();
  });

  it('delegated Manage on the parent only (NOT the node itself) grants Move/Delete but never Edit/Create Subchannel', async () => {
    const getEditableChannelNode = vi.fn((nodeId: string) =>
      nodeId === 'games'
        ? Promise.resolve(createChannelAdminView({ nodeId: 'games', kind: 'category' }))
        : Promise.reject(new ChannelRequestError('CHANNEL_ACCESS_DENIED', 'denied')),
    );
    const actions = createVoiceActions({ getEditableChannelNode });
    const state = createVoiceState({ myPermissions: [] });

    render(
      <ChannelContextMenu
        state={state}
        actions={actions}
        target={{ node: createChannel({ nodeId: 'general', parentId: 'games' }), x: 0, y: 0 }}
        canJoin
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onJoin={vi.fn()}
        onLeave={vi.fn()}
        onAdminIntent={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText('Move Channel')).toBeInTheDocument();
    });
    expect(screen.getByText('Delete Channel')).toBeInTheDocument();
    // Parent Manage does not, by itself, authorize editing the node — only its own delegated
    // Manage (or the global permission) does.
    expect(screen.queryByText('Edit Channel')).not.toBeInTheDocument();
    expect(screen.queryByText('Create Subchannel')).not.toBeInTheDocument();
  });

  it('shows Leave Voice (not Join Voice) once already joined to the target channel', () => {
    const actions = createVoiceActions({
      getEditableChannelNode: vi
        .fn()
        .mockRejectedValue(new ChannelRequestError('CHANNEL_ACCESS_DENIED', 'denied')),
    });
    const state = createVoiceState({ myPermissions: [], currentChannelId: 'general' });

    render(
      <ChannelContextMenu
        state={state}
        actions={actions}
        target={{ node: createChannel({ nodeId: 'general' }), x: 0, y: 0 }}
        canJoin
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onJoin={vi.fn()}
        onLeave={vi.fn()}
        onAdminIntent={vi.fn()}
      />,
    );

    expect(screen.getByText('Leave Voice')).toBeInTheDocument();
    expect(screen.queryByText('Join Voice')).not.toBeInTheDocument();
  });

  it('a category node offers Create Channel/Edit Category (manage-here) and Delete Category (manage-parent), never Move', async () => {
    const actions = createVoiceActions();
    const state = createVoiceState({ myPermissions: ['channels.manage', 'channels.delete'] });
    const category = createChannel({ nodeId: 'games', kind: 'category', name: 'Games' });

    render(
      <ChannelContextMenu
        state={state}
        actions={actions}
        target={{ node: category, x: 0, y: 0 }}
        canJoin
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onJoin={vi.fn()}
        onLeave={vi.fn()}
        onAdminIntent={vi.fn()}
      />,
    );

    expect(screen.getByText('Create Channel')).toBeInTheDocument();
    expect(screen.getByText('Edit Category')).toBeInTheDocument();
    expect(screen.getByText('Delete Category')).toBeInTheDocument();
    expect(screen.queryByText('Move Channel')).not.toBeInTheDocument();
    expect(screen.queryByText('Open Chat')).not.toBeInTheDocument();
  });

  it('selecting Create Subchannel invokes onAdminIntent with the right-clicked node pre-seeded as parent', async () => {
    const onAdminIntent = vi.fn();
    const actions = createVoiceActions();
    const state = createVoiceState({ myPermissions: ['channels.manage'] });

    render(
      <ChannelContextMenu
        state={state}
        actions={actions}
        target={{ node: createChannel({ nodeId: 'general' }), x: 0, y: 0 }}
        canJoin
        onClose={vi.fn()}
        onOpenChat={vi.fn()}
        onJoin={vi.fn()}
        onLeave={vi.fn()}
        onAdminIntent={onAdminIntent}
      />,
    );

    await act(async () => {
      screen.getByText('Create Subchannel').click();
    });

    expect(onAdminIntent).toHaveBeenCalledWith({
      type: 'create-channel',
      parentId: 'general',
      parentLocked: true,
    });
  });
});
