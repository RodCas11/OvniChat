// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChannelSidebar } from '../../../apps/desktop/src/renderer/workspace/ChannelSidebar.js';
import {
  createChannel,
  createParticipant,
  createVoiceActions,
  createVoiceState,
} from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

function renderSidebar(overrides: Partial<Parameters<typeof ChannelSidebar>[0]> = {}) {
  const onSelectChatTarget = vi.fn();
  const onJoinChannel = vi.fn();
  const onLeaveChannel = vi.fn();
  const onChannelAdminIntent = vi.fn();
  const channelTree = overrides.channelTree ?? [
    createChannel({ nodeId: 'general', name: 'General' }),
  ];
  const props: Parameters<typeof ChannelSidebar>[0] = {
    serverName: 'Test Server',
    channelTree,
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
    state: createVoiceState({ channelTree }),
    actions: createVoiceActions(),
    onChannelAdminIntent,
    ...overrides,
  };
  const result = render(<ChannelSidebar {...props} />);
  return { ...result, onSelectChatTarget, onJoinChannel, onLeaveChannel, onChannelAdminIntent };
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
      channelTree: [
        createChannel({ nodeId: 'general', name: 'General' }),
        createChannel({ nodeId: 'games', name: 'Games' }),
      ],
    });

    expect(screen.getByTestId('channel-row-general')).toBeInTheDocument();
    expect(screen.getByTestId('channel-row-games')).toBeInTheDocument();
    expect(screen.queryAllByRole('listitem')).toHaveLength(2);
  });

  it('derives isJoined per row from currentChannelId, independent of selection', () => {
    renderSidebar({
      channelTree: [
        createChannel({ nodeId: 'general', name: 'General' }),
        createChannel({ nodeId: 'games', name: 'Games' }),
      ],
      currentChannelId: 'games',
      selectedChatTarget: { scope: 'channel', channelId: 'general' },
    });

    // Joined channel shows Leave, not Join; the merely-selected (but not joined) channel still
    // shows Join.
    expect(screen.getByTestId('channel-row-leave-games')).toBeInTheDocument();
    expect(screen.getByTestId('channel-row-join-general')).toBeInTheDocument();
  });

  it('T13.2 — live catalog reconciliation: re-rendering with an updated channelTree prop updates the visible tree without any remount hack', () => {
    const { rerender } = renderSidebar({
      channelTree: [createChannel({ nodeId: 'general', name: 'General' })],
    });
    expect(screen.getByTestId('channel-row-general')).toBeInTheDocument();
    expect(screen.queryByTestId('channel-row-games')).not.toBeInTheDocument();

    const nextChannelTree = [
      createChannel({ nodeId: 'general', name: 'General' }),
      createChannel({ nodeId: 'games', name: 'Games' }),
    ];
    rerender(
      <ChannelSidebar
        serverName="Test Server"
        channelTree={nextChannelTree}
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
        state={createVoiceState({ channelTree: nextChannelTree })}
        actions={createVoiceActions()}
        onChannelAdminIntent={vi.fn()}
      />,
    );

    expect(screen.getByTestId('channel-row-general')).toBeInTheDocument();
    expect(screen.getByTestId('channel-row-games')).toBeInTheDocument();

    // Then removing a channel from the catalog removes its row too — the tree is always derived
    // fresh from the latest `channelTree` prop, never a one-time snapshot.
    rerender(
      <ChannelSidebar
        serverName="Test Server"
        channelTree={[createChannel({ nodeId: 'games', name: 'Games' })]}
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
        state={createVoiceState({
          channelTree: [createChannel({ nodeId: 'games', name: 'Games' })],
        })}
        actions={createVoiceActions()}
        onChannelAdminIntent={vi.fn()}
      />,
    );

    expect(screen.queryByTestId('channel-row-general')).not.toBeInTheDocument();
    expect(screen.getByTestId('channel-row-games')).toBeInTheDocument();
  });

  it('T13.2 — live catalog reconciliation reflects a node acquiring a password/temporary flag live, same nodeId, no remount hack', () => {
    const { rerender } = renderSidebar({
      channelTree: [createChannel({ nodeId: 'vip', name: 'VIP' })],
    });
    expect(screen.queryByTestId('channel-row-password-badge-vip')).not.toBeInTheDocument();
    expect(screen.queryByTestId('channel-row-temporary-badge-vip')).not.toBeInTheDocument();

    const updatedChannelTree = [
      createChannel({ nodeId: 'vip', name: 'VIP', hasPassword: true, temporary: true }),
    ];
    rerender(
      <ChannelSidebar
        serverName="Test Server"
        channelTree={updatedChannelTree}
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
        state={createVoiceState({ channelTree: updatedChannelTree })}
        actions={createVoiceActions()}
        onChannelAdminIntent={vi.fn()}
      />,
    );

    expect(screen.getByTestId('channel-row-password-badge-vip')).toBeInTheDocument();
    expect(screen.getByTestId('channel-row-temporary-badge-vip')).toBeInTheDocument();
  });

  it('T13.2 — password/temporary badges carry real tooltip text via a real <title>, never a raw flag', () => {
    renderSidebar({
      channelTree: [
        createChannel({ nodeId: 'vip', name: 'VIP', hasPassword: true }),
        createChannel({ nodeId: 'raid', name: 'Raid', temporary: true }),
      ],
    });

    const passwordBadge = screen.getByTestId('channel-row-password-badge-vip');
    expect(passwordBadge.querySelector('title')?.textContent).toBe('Password protected');

    const temporaryBadge = screen.getByTestId('channel-row-temporary-badge-raid');
    expect(temporaryBadge.querySelector('title')?.textContent).toBe('Temporary channel');
  });

  it('T13.2 — a Guest with no channel-admin permissions sees zero admin context-menu items, even after the optimistic check settles', async () => {
    const actions = createVoiceActions({
      getEditableChannelNode: vi.fn().mockRejectedValue(new Error('denied')),
    });
    const channelTree = [createChannel({ nodeId: 'general', name: 'General' })];
    renderSidebar({
      channelTree,
      state: createVoiceState({ myPermissions: [], channelTree }),
      actions,
    });

    fireEvent.contextMenu(screen.getByTestId('channel-row-general'));

    expect(await screen.findByText('Open Chat')).toBeInTheDocument();
    await waitFor(() => {
      expect(actions.getEditableChannelNode).toHaveBeenCalled();
    });
    expect(screen.queryByText('Edit Channel')).not.toBeInTheDocument();
    expect(screen.queryByText('Move Channel')).not.toBeInTheDocument();
    expect(screen.queryByText('Create Subchannel')).not.toBeInTheDocument();
    expect(screen.queryByText('Delete Channel')).not.toBeInTheDocument();
  });
});

// T13.4 (UI consistency follow-up) — a real component-integration proof (Section 49): renders the
// *actual* `ChannelSidebar` → `ChannelRow` → `ParticipantRow` → `UserAvatar` chain with a real,
// non-empty participant/avatarCache/speakingParticipantIds state, rather than only exercising each
// leaf component in isolation (as `participant-row.test.tsx`/`member-presentation.test.ts` already
// do). This is the only place that proves the real prop-threading wiring itself (`state.avatarCache`
// and `handleRequestParticipantAvatar` reaching all the way down to a real rendered `<img>`) actually
// works end-to-end, not just that each component behaves correctly given hand-fed props.
describe('ChannelSidebar — voice participant avatar/speaking wiring (T13.4 UI consistency follow-up, real component integration)', () => {
  const avatarRef = { revision: 1, hash: 'c'.repeat(64) };

  it('a joined channel renders its real participant with the real current avatar, sourced from state.avatarCache via the real UserAvatar component', () => {
    const channelTree = [createChannel({ nodeId: 'general', name: 'General' })];
    const participant = createParticipant({
      participantId: 'participant-1',
      memberRef: 'member-1',
      avatarRef,
    });
    const { container } = renderSidebar({
      channelTree,
      currentChannelId: 'general',
      participants: [participant],
      state: createVoiceState({
        channelTree,
        avatarCache: new Map([[avatarRef.hash, 'data:image/png;base64,real']]),
      }),
    });

    const img = container.querySelector('img');
    expect(img).toHaveAttribute('src', 'data:image/png;base64,real');
  });

  it('a not-yet-cached avatar requests it exactly once via the real actions.requestAvatar("member", memberRef) path', () => {
    const channelTree = [createChannel({ nodeId: 'general', name: 'General' })];
    const participant = createParticipant({
      participantId: 'participant-1',
      memberRef: 'member-1',
      avatarRef,
    });
    const actions = createVoiceActions();
    renderSidebar({
      channelTree,
      currentChannelId: 'general',
      participants: [participant],
      state: createVoiceState({ channelTree }),
      actions,
    });

    expect(actions.requestAvatar).toHaveBeenCalledTimes(1);
    expect(actions.requestAvatar).toHaveBeenCalledWith('member', 'member-1');
  });

  it('a real speaking participantId reaches the real ParticipantRow/UserAvatar speaking ring through the full state.speakingParticipantIds wiring', () => {
    const channelTree = [createChannel({ nodeId: 'general', name: 'General' })];
    const participant = createParticipant({ participantId: 'participant-1' });
    renderSidebar({
      channelTree,
      currentChannelId: 'general',
      participants: [participant],
      state: createVoiceState({
        channelTree,
        speakingParticipantIds: new Set(['participant-1']),
      }),
    });

    expect(screen.getByTestId('participant-row-avatar-wrap-participant-1')).toHaveAttribute(
      'data-speaking',
      'true',
    );
  });

  it('no fabricated avatar or speaking state for a participant absent from members/speakingParticipantIds', () => {
    const channelTree = [createChannel({ nodeId: 'general', name: 'General' })];
    const participant = createParticipant({ participantId: 'participant-1' });
    const { container } = renderSidebar({
      channelTree,
      currentChannelId: 'general',
      participants: [participant],
      state: createVoiceState({ channelTree }),
    });

    expect(container.querySelector('img')).not.toBeInTheDocument();
    expect(screen.getByTestId('participant-row-avatar-wrap-participant-1')).toHaveAttribute(
      'data-speaking',
      'false',
    );
  });
});
