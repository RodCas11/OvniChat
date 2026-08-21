// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChannelSidebar } from '../../../apps/desktop/src/renderer/workspace/ChannelSidebar.js';
import { createChannel } from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

function renderSidebar(overrides: Partial<Parameters<typeof ChannelSidebar>[0]> = {}) {
  const onSelectChatTarget = vi.fn();
  const onJoinChannel = vi.fn();
  const onLeaveChannel = vi.fn();
  const props: Parameters<typeof ChannelSidebar>[0] = {
    serverName: 'Test Server',
    channels: [createChannel({ channelId: 'general', name: 'General' })],
    participants: [],
    currentChannelId: undefined,
    selfParticipantId: undefined,
    remoteCameraParticipantIds: new Set(),
    remoteScreenParticipantIds: new Set(),
    selfCameraEnabled: false,
    selfSharingScreen: false,
    canJoin: true,
    joining: false,
    selectedChatTarget: { scope: 'server' },
    onSelectChatTarget,
    onJoinChannel,
    onLeaveChannel,
    ...overrides,
  };
  const result = render(<ChannelSidebar {...props} />);
  return { ...result, onSelectChatTarget, onJoinChannel, onLeaveChannel };
}

describe('ChannelSidebar (T13.1)', () => {
  it('clicking a channel row selects its chat without ever joining voice', () => {
    const { onSelectChatTarget, onJoinChannel } = renderSidebar();

    fireEvent.click(screen.getByTestId('channel-row-select-general'));

    expect(onSelectChatTarget).toHaveBeenCalledWith({ scope: 'channel', channelId: 'general' });
    expect(onJoinChannel).not.toHaveBeenCalled();
  });

  it('clicking Join calls onJoinChannel with the real channelId, and never touches selection', () => {
    const { onSelectChatTarget, onJoinChannel } = renderSidebar();

    fireEvent.click(screen.getByTestId('channel-row-join-general'));

    expect(onJoinChannel).toHaveBeenCalledWith('general');
    expect(onSelectChatTarget).not.toHaveBeenCalled();
  });

  it('always renders a Server Chat entry, selectable independently of any channel', () => {
    const { onSelectChatTarget } = renderSidebar({
      selectedChatTarget: { scope: 'channel', channelId: 'general' },
    });

    fireEvent.click(screen.getByText('Server Chat'));

    expect(onSelectChatTarget).toHaveBeenCalledWith({ scope: 'server' });
  });

  it('renders exactly one row per real server-owned channel — never fabricated channels', () => {
    renderSidebar({
      channels: [
        createChannel({ channelId: 'general', name: 'General' }),
        createChannel({ channelId: 'games', name: 'Games' }),
      ],
    });

    expect(screen.getByTestId('channel-row-general')).toBeInTheDocument();
    expect(screen.getByTestId('channel-row-games')).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(2);
  });

  it('derives isJoined per row from currentChannelId, independent of selection', () => {
    renderSidebar({
      channels: [
        createChannel({ channelId: 'general', name: 'General' }),
        createChannel({ channelId: 'games', name: 'Games' }),
      ],
      currentChannelId: 'games',
      selectedChatTarget: { scope: 'channel', channelId: 'general' },
    });

    // Joined channel shows Leave, not Join; the merely-selected (but not joined) channel still
    // shows Join.
    expect(screen.getByTestId('channel-row-leave-games')).toBeInTheDocument();
    expect(screen.getByTestId('channel-row-join-general')).toBeInTheDocument();
  });
});
