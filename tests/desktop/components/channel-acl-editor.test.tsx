// @vitest-environment jsdom
//
// T13.2 — the ACL editor: no "who can speak" control of any kind, selected-groups checkboxes show
// real group names (never raw ids), and the inheritance note resolves correctly for an inherit-chain
// fixture (including the "identity can't see the ancestor's own group-id list" fallback — never a
// guess).
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ChannelAclEditor,
  type ChannelAclValue,
} from '../../../apps/desktop/src/renderer/workspace/ChannelAclEditor.js';
import { ChannelRequestError } from '../../../apps/desktop/src/renderer/voice/use-voice-channel.js';
import {
  createChannel,
  createChannelAdminView,
  createGroupSummary,
  createVoiceActions,
  createVoiceState,
} from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

const DEFAULT_ACL: ChannelAclValue = {
  visibilityPolicy: 'inherit',
  visibilityGroupIds: [],
  joinPolicy: 'inherit',
  joinGroupIds: [],
  managePolicy: 'inherit',
  manageGroupIds: [],
};

describe('ChannelAclEditor (T13.2)', () => {
  it('never renders any "who can speak" control, in any form', () => {
    const state = createVoiceState({
      groups: [createGroupSummary()],
    });
    render(
      <ChannelAclEditor
        state={state}
        actions={createVoiceActions()}
        parentId={undefined}
        value={DEFAULT_ACL}
        onChange={vi.fn()}
      />,
    );

    expect(screen.queryByText(/who can speak/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/speak/i)).not.toBeInTheDocument();
  });

  it('the Manage axis never offers an "Everyone" option — only "Same as parent"/"Selected groups"', () => {
    const state = createVoiceState();
    render(
      <ChannelAclEditor
        state={state}
        actions={createVoiceActions()}
        parentId={undefined}
        value={DEFAULT_ACL}
        onChange={vi.fn()}
      />,
    );

    const manageLegend = screen.getByText('Who can manage this channel?');
    const manageFieldset = manageLegend.closest('fieldset');
    expect(manageFieldset).not.toBeNull();
    expect(
      manageFieldset && Array.from(manageFieldset.querySelectorAll('input[type="radio"]')),
    ).toHaveLength(2);
  });

  it('shows real group names (never a raw group id) for a selected-groups axis', () => {
    const state = createVoiceState({
      groups: [
        createGroupSummary({ groupId: 'g-member', name: 'Member' }),
        createGroupSummary({ groupId: 'g-mod', name: 'Moderator' }),
      ],
    });
    const value: ChannelAclValue = {
      ...DEFAULT_ACL,
      joinPolicy: 'selected-groups',
      joinGroupIds: ['g-member'],
    };

    render(
      <ChannelAclEditor
        state={state}
        actions={createVoiceActions()}
        parentId={undefined}
        value={value}
        onChange={vi.fn()}
      />,
    );

    expect(screen.getByText('Member')).toBeInTheDocument();
    expect(screen.getByText('Moderator')).toBeInTheDocument();
    expect(screen.queryByText('g-member')).not.toBeInTheDocument();
    expect(screen.queryByText('g-mod')).not.toBeInTheDocument();
  });

  it('resolves an inherit-chain to the nearest explicit ancestor, showing group names once resolved', async () => {
    const channelTree = [
      createChannel({
        nodeId: 'games',
        kind: 'category',
        name: 'GAMES',
        joinPolicy: 'selected-groups',
      }),
    ];
    const state = createVoiceState({
      channelTree,
      groups: [createGroupSummary({ groupId: 'g-member', name: 'Member' })],
    });
    const getEditableChannelNode = vi.fn().mockResolvedValue(
      createChannelAdminView({
        nodeId: 'games',
        kind: 'category',
        joinPolicy: 'selected-groups',
        joinGroupIds: ['g-member'],
      }),
    );
    const actions = createVoiceActions({ getEditableChannelNode });

    render(
      <ChannelAclEditor
        state={state}
        actions={actions}
        parentId="games"
        value={DEFAULT_ACL}
        onChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getByText(/Inherited from .GAMES./)).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText(/Allowed: Member/)).toBeInTheDocument();
    });
  });

  it('renders a full-length (64-char) group name without truncating it, even with no spaces to wrap at', () => {
    const longName = 'X'.repeat(64);
    const state = createVoiceState({
      groups: [createGroupSummary({ groupId: 'g-long', name: longName })],
    });
    const value: ChannelAclValue = {
      ...DEFAULT_ACL,
      joinPolicy: 'selected-groups',
      joinGroupIds: ['g-long'],
    };

    render(
      <ChannelAclEditor
        state={state}
        actions={createVoiceActions()}
        parentId={undefined}
        value={value}
        onChange={vi.fn()}
      />,
    );

    // Full text present, never CSS/JS-truncated — `.checkboxField`'s `overflow-wrap: anywhere`
    // handles the visual wrapping a real browser layout engine would do (not observable in jsdom).
    expect(screen.getByText(longName)).toBeInTheDocument();
  });

  it('never guesses inherited group names when the ancestor is not visible to this identity', async () => {
    const channelTree = [
      createChannel({
        nodeId: 'games',
        kind: 'category',
        name: 'GAMES',
        managePolicy: 'selected-groups',
      }),
    ];
    const state = createVoiceState({ channelTree });
    const getEditableChannelNode = vi
      .fn()
      .mockRejectedValue(new ChannelRequestError('CHANNEL_ACCESS_DENIED', 'denied'));
    const actions = createVoiceActions({ getEditableChannelNode });

    render(
      <ChannelAclEditor
        state={state}
        actions={actions}
        parentId="games"
        value={DEFAULT_ACL}
        onChange={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(getEditableChannelNode).toHaveBeenCalledWith('games');
    });
    expect(screen.getByText(/Inherited from .GAMES./)).toBeInTheDocument();
    expect(screen.queryByText(/Allowed:/)).not.toBeInTheDocument();
  });
});
