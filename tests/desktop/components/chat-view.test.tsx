// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { ChatView } from '../../../apps/desktop/src/renderer/workspace/ChatView.js';
import { chatThreadKey } from '../../../apps/desktop/src/renderer/voice/use-voice-channel.js';
import {
  createChatMessage,
  createChatThread,
  createVoiceActions,
  createVoiceState,
} from '../fixtures/voice-state.js';

afterEach(() => {
  cleanup();
});

describe('ChatView (T13.1)', () => {
  it('the composer is present when the caller has the relevant send permission', () => {
    const state = createVoiceState({ myPermissions: ['chat.server.send'] });
    render(
      <ChatView
        state={state}
        actions={createVoiceActions()}
        scope="server"
        channelId={undefined}
      />,
    );

    expect(screen.getByPlaceholderText('Message…')).toBeInTheDocument();
    expect(
      screen.queryByText('You do not have permission to send messages here.'),
    ).not.toBeInTheDocument();
  });

  it('the composer is absent (not merely disabled) without the relevant send permission', () => {
    const state = createVoiceState({ myPermissions: [] });
    render(
      <ChatView
        state={state}
        actions={createVoiceActions()}
        scope="server"
        channelId={undefined}
      />,
    );

    expect(screen.queryByPlaceholderText('Message…')).not.toBeInTheDocument();
    expect(
      screen.getByText('You do not have permission to send messages here.'),
    ).toBeInTheDocument();
  });

  it('channel-scope send permission is checked independently from server-scope', () => {
    const state = createVoiceState({ myPermissions: ['chat.server.send'] });
    render(
      <ChatView state={state} actions={createVoiceActions()} scope="channel" channelId="general" />,
    );

    expect(screen.queryByPlaceholderText('Message…')).not.toBeInTheDocument();
  });

  it('loads chat history for the selected thread via the real loadChatHistory action', () => {
    const actions = createVoiceActions();
    const state = createVoiceState({ myPermissions: [] });
    render(<ChatView state={state} actions={actions} scope="channel" channelId="general" />);

    expect(actions.loadChatHistory).toHaveBeenCalledWith('channel', 'general');
  });

  it('renders only real, already-loaded messages for the selected thread — never fabricated ones', () => {
    const key = chatThreadKey('server', undefined);
    const thread = createChatThread({
      messages: [createChatMessage({ messageId: 1, senderNickname: 'Alice', body: 'Hi there' })],
    });
    const state = createVoiceState({
      myPermissions: [],
      chatThreads: new Map([[key, thread]]),
    });
    render(
      <ChatView
        state={state}
        actions={createVoiceActions()}
        scope="server"
        channelId={undefined}
      />,
    );

    expect(screen.getByText('Hi there')).toBeInTheDocument();
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByText('No messages yet')).not.toBeInTheDocument();
  });

  it('shows an empty state when the thread has no messages, never a fabricated placeholder message', () => {
    const state = createVoiceState({ myPermissions: [] });
    render(
      <ChatView
        state={state}
        actions={createVoiceActions()}
        scope="server"
        channelId={undefined}
      />,
    );

    expect(screen.getByText('No messages yet')).toBeInTheDocument();
  });
});
