// @vitest-environment jsdom
//
// T13.1 — proves the center content resets when the selected chat target changes, so no
// composer draft (or other per-thread local UI state) leaks from one channel/server-chat thread
// into another. See `ChatView.tsx`'s own local `composerText` state and this task's
// "server switch shouldn't leak previous channel selection" requirement — the same class of
// stale-state risk the `AppShell` remount-key fix (T13.1) targets at the connection level, applied
// here at the thread-selection level within a single connection.
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MainContent } from '../../../apps/desktop/src/renderer/workspace/MainContent.js';
import { createChannel, createVoiceActions, createVoiceState } from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

describe('MainContent (T13.1 — no stale per-thread state on selection change)', () => {
  it('clears an unsent composer draft when switching from one channel to another', () => {
    const state = createVoiceState({
      myPermissions: ['chat.channel.send'],
      channelTree: [
        createChannel({ nodeId: 'general', name: 'General' }),
        createChannel({ nodeId: 'games', name: 'Games' }),
      ],
    });
    const actions = createVoiceActions();

    const { rerender } = render(
      <MainContent
        state={state}
        actions={actions}
        channelTree={state.channelTree}
        selectedChatTarget={{ scope: 'channel', channelId: 'general' }}
        onOpenAuthorization={vi.fn()}
      />,
    );

    const composer = screen.getByPlaceholderText('Message…');
    fireEvent.change(composer, { target: { value: 'a draft nobody sent yet' } });
    expect(screen.getByDisplayValue('a draft nobody sent yet')).toBeInTheDocument();

    rerender(
      <MainContent
        state={state}
        actions={actions}
        channelTree={state.channelTree}
        selectedChatTarget={{ scope: 'channel', channelId: 'games' }}
        onOpenAuthorization={vi.fn()}
      />,
    );

    expect(screen.queryByDisplayValue('a draft nobody sent yet')).not.toBeInTheDocument();
    expect(screen.getByPlaceholderText('Message…')).toHaveValue('');
  });

  it('clears an unsent composer draft when switching from a channel to Server Chat', () => {
    const state = createVoiceState({
      myPermissions: ['chat.channel.send', 'chat.server.send'],
      channelTree: [createChannel({ nodeId: 'general', name: 'General' })],
    });
    const actions = createVoiceActions();

    const { rerender } = render(
      <MainContent
        state={state}
        actions={actions}
        channelTree={state.channelTree}
        selectedChatTarget={{ scope: 'channel', channelId: 'general' }}
        onOpenAuthorization={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByPlaceholderText('Message…'), {
      target: { value: 'draft for general' },
    });

    rerender(
      <MainContent
        state={state}
        actions={actions}
        channelTree={state.channelTree}
        selectedChatTarget={{ scope: 'server' }}
        onOpenAuthorization={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText('Message…')).toHaveValue('');
  });

  it('header always makes clear whether Server Chat or a named channel is showing', () => {
    const state = createVoiceState({
      channelTree: [createChannel({ nodeId: 'general', name: 'General' })],
    });

    const { rerender } = render(
      <MainContent
        state={state}
        actions={createVoiceActions()}
        channelTree={state.channelTree}
        selectedChatTarget={{ scope: 'server' }}
        onOpenAuthorization={vi.fn()}
      />,
    );
    expect(screen.getByText('Server Chat')).toBeInTheDocument();

    rerender(
      <MainContent
        state={state}
        actions={createVoiceActions()}
        channelTree={state.channelTree}
        selectedChatTarget={{ scope: 'channel', channelId: 'general' }}
        onOpenAuthorization={vi.fn()}
      />,
    );
    expect(screen.getByText('General — Chat')).toBeInTheDocument();
  });
});
