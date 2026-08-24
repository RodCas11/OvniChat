// @vitest-environment jsdom
//
// T13.2 item K — a fixture identity with *no* channel-admin (or any other elevated) permission,
// rendered through the same real components a connected client actually composes
// (`ChannelSidebar` + `MainContent`, both driven by the same `state`/`actions`), must show zero
// admin DOM anywhere — not disabled, not aria-hidden, genuinely absent. Covers both the always-
// visible chrome (no Server Settings icon) and the context-menu admin items (checked after the
// optimistic per-node check has had a chance to settle).
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChannelSidebar } from '../../../apps/desktop/src/renderer/workspace/ChannelSidebar.js';
import { MainContent } from '../../../apps/desktop/src/renderer/workspace/MainContent.js';
import { createChannel, createVoiceActions, createVoiceState } from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

describe('Normal-user (Guest) render shows no admin DOM at all (T13.2 item K)', () => {
  it('ChannelSidebar + MainContent together render zero admin affordances for a no-permissions identity', async () => {
    const actions = createVoiceActions({
      getEditableChannelNode: vi.fn().mockRejectedValue(new Error('denied')),
    });
    const channelTree = [
      createChannel({ nodeId: 'games', kind: 'category', name: 'GAMES' }),
      createChannel({ nodeId: 'general', name: 'General', parentId: 'games' }),
    ];
    const state = createVoiceState({ myPermissions: [], channelTree });

    render(
      <>
        <ChannelSidebar
          serverName="Test Server"
          channelTree={channelTree}
          participants={[]}
          currentChannelId={undefined}
          selfParticipantId={undefined}
          remoteCameraParticipantIds={new Set()}
          remoteScreenParticipantIds={new Set()}
          selfCameraEnabled={false}
          selfSharingScreen={false}
          canJoin
          joining={false}
          selectedChatTarget={{ scope: 'server' }}
          onSelectChatTarget={vi.fn()}
          onJoinChannel={vi.fn()}
          onLeaveChannel={vi.fn()}
          state={state}
          actions={actions}
          onChannelAdminIntent={vi.fn()}
        />
        <MainContent
          state={state}
          actions={actions}
          channelTree={channelTree}
          selectedChatTarget={{ scope: 'server' }}
          participants={[]}
          onOpenAuthorization={vi.fn()}
          onOpenServerSettings={undefined}
        />
      </>,
    );

    // No Server Settings entry point at all — never merely hidden-but-present.
    expect(screen.queryByTestId('open-server-settings')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Open Server Settings')).not.toBeInTheDocument();

    // Right-clicking both a category and a voice channel never surfaces an admin item, even once
    // the optimistic per-node check has settled.
    fireEvent.contextMenu(screen.getByTestId('channel-category-games'));
    await waitFor(() => {
      expect(actions.getEditableChannelNode).toHaveBeenCalled();
    });
    expect(screen.queryByText('Create Channel')).not.toBeInTheDocument();
    expect(screen.queryByText('Edit Category')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete Category')).not.toBeInTheDocument();

    fireEvent.contextMenu(screen.getByTestId('channel-row-general'));
    await waitFor(() => {
      expect(screen.getByText('Open Chat')).toBeInTheDocument();
    });
    expect(screen.queryByText('Edit Channel')).not.toBeInTheDocument();
    expect(screen.queryByText('Move Channel')).not.toBeInTheDocument();
    expect(screen.queryByText('Create Subchannel')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete Channel')).not.toBeInTheDocument();

    // No disabled admin control anywhere either — genuinely absent, not greyed out.
    expect(document.querySelector('[disabled][data-admin]')).toBeNull();
  });
});
