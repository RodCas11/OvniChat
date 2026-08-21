// @vitest-environment jsdom
//
// T13.1's single most important behavioral invariant: a click on a channel row selects/views that
// channel's chat and must NEVER join voice by itself — joining is always the separate, explicit
// Join action. See `ChannelRow.tsx`'s own doc comment for the production rule this test proves.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChannelRow } from '../../../apps/desktop/src/renderer/workspace/ChannelRow.js';
import { createChannel, createParticipant } from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

function renderRow(overrides: Partial<Parameters<typeof ChannelRow>[0]> = {}) {
  const onSelect = vi.fn();
  const onJoin = vi.fn();
  const onLeave = vi.fn();
  const props: Parameters<typeof ChannelRow>[0] = {
    channel: createChannel(),
    isSelected: false,
    isJoined: false,
    canJoin: true,
    joining: false,
    participants: [],
    selfParticipantId: undefined,
    remoteCameraParticipantIds: new Set(),
    remoteScreenParticipantIds: new Set(),
    selfCameraEnabled: false,
    selfSharingScreen: false,
    onSelect,
    onJoin,
    onLeave,
    ...overrides,
  };
  const result = render(<ChannelRow {...props} />);
  return { ...result, onSelect, onJoin, onLeave };
}

describe('ChannelRow (T13.1 — click never joins voice)', () => {
  it('clicking the row body calls onSelect only — never onJoin', () => {
    const { onSelect, onJoin } = renderRow();

    fireEvent.click(screen.getByTestId('channel-row-select-general'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onJoin).not.toHaveBeenCalled();
  });

  it('clicking the chat-bubble icon calls onSelect only — never onJoin', () => {
    const { onSelect, onJoin } = renderRow();

    fireEvent.click(screen.getByTestId('channel-row-chat-general'));

    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onJoin).not.toHaveBeenCalled();
  });

  it('the Join control is a distinct element that does call onJoin, and only onJoin', () => {
    const { onSelect, onJoin } = renderRow();

    fireEvent.click(screen.getByTestId('channel-row-join-general'));

    expect(onJoin).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('renders a Leave control instead of Join once actually joined, and it calls onLeave only', () => {
    const { onLeave, onSelect, onJoin } = renderRow({
      isJoined: true,
      participants: [createParticipant()],
    });

    expect(screen.queryByTestId('channel-row-join-general')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId('channel-row-leave-general'));

    expect(onLeave).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
    expect(onJoin).not.toHaveBeenCalled();
  });

  it('visually distinguishes joined from merely-selected using more than color alone', () => {
    renderRow({ isJoined: true, isSelected: false, participants: [createParticipant()] });
    // The joined icon (Volume2) carries `aria-hidden`, but its presence alongside the Leave control
    // (rather than a Join button) is the real, non-color signal — assert both independently.
    expect(screen.getByTestId('channel-row-select-general').querySelector('svg')).toBeTruthy();
    expect(screen.getByTestId('channel-row-leave-general')).toBeInTheDocument();
  });

  it('the Join control is disabled when canJoin is false or a join is already in flight', () => {
    renderRow({ canJoin: false });
    expect(screen.getByTestId('channel-row-join-general')).toBeDisabled();

    cleanup();
    renderRow({ canJoin: true, joining: true });
    expect(screen.getByTestId('channel-row-join-general')).toBeDisabled();
  });

  it('only shows a participant roster while actually joined (never fabricated for a channel nobody is in)', () => {
    renderRow({ isJoined: false, participants: [createParticipant()] });
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });
});
