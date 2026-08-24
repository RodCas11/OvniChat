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
        participants={[]}
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
        participants={[]}
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
        participants={[]}
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
        participants={[]}
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
        participants={[]}
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
        participants={[]}
        selectedChatTarget={{ scope: 'channel', channelId: 'general' }}
        onOpenAuthorization={vi.fn()}
      />,
    );
    expect(screen.getByText('General — Chat')).toBeInTheDocument();
  });
});

// T13.5 — real component integration through `MainContent` (never `MediaStage` in isolation for
// this part): proves the actual layout decision — chat-primary by default, media stage + toggleable
// side chat once real media is active — happens in the real render tree, not merely that each piece
// works alone.
describe('MainContent (T13.5) — chat-primary default vs. media-active side-chat layout', () => {
  it('no camera/screen stream active: chat renders full-width, with no media stage and no chat-toggle control at all', () => {
    const state = createVoiceState({
      myPermissions: ['chat.channel.send'],
      channelTree: [createChannel({ nodeId: 'general', name: 'General' })],
    });
    render(
      <MainContent
        state={state}
        actions={createVoiceActions()}
        channelTree={state.channelTree}
        participants={[]}
        selectedChatTarget={{ scope: 'channel', channelId: 'general' }}
        onOpenAuthorization={vi.fn()}
      />,
    );

    expect(screen.getByPlaceholderText('Message…')).toBeInTheDocument();
    expect(screen.queryByTestId('main-content-toggle-chat')).not.toBeInTheDocument();
    expect(document.querySelector('[data-role^="media-stage"]')).not.toBeInTheDocument();
  });

  it('a real camera stream active: renders the media stage plus a toggleable side chat panel, never a second chat system', () => {
    const state = createVoiceState({
      myPermissions: ['chat.channel.send'],
      channelTree: [createChannel({ nodeId: 'general', name: 'General' })],
      remoteCameraStreams: new Map([['p1', {} as unknown as MediaStream]]),
    });
    render(
      <MainContent
        state={state}
        actions={createVoiceActions()}
        channelTree={state.channelTree}
        participants={[
          { participantId: 'p1', displayName: 'Alice', connectionState: 'connected', groups: [] },
        ]}
        selectedChatTarget={{ scope: 'channel', channelId: 'general' }}
        onOpenAuthorization={vi.fn()}
      />,
    );

    expect(screen.getByTestId('media-stage-grid')).toBeInTheDocument();
    // Still the one real `ChatView` (same "Message…" composer), now inside the side panel.
    expect(screen.getByPlaceholderText('Message…')).toBeInTheDocument();

    const toggle = screen.getByTestId('main-content-toggle-chat');
    expect(toggle).toBeInTheDocument();
    fireEvent.click(toggle);
    expect(screen.queryByPlaceholderText('Message…')).not.toBeInTheDocument();
    // The media stage itself is unaffected by hiding chat — never removed, never re-negotiated.
    expect(screen.getByTestId('media-stage-grid')).toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByPlaceholderText('Message…')).toBeInTheDocument();
  });
});
