// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

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
  vi.unstubAllEnvs();
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

  // T13.5.1 — the channel-chat empty state uses the real channel name when given one, never a
  // generic placeholder or a Discord-style "#" prefix (T13.1's own established rule against implying
  // a channel-hash hierarchy this app does not have — see MainContent.tsx's own header treatment).
  it('uses the real channel name in the empty state for a channel thread, distinct copy from Server Chat', () => {
    const state = createVoiceState({ myPermissions: [] });
    render(
      <ChatView
        state={state}
        actions={createVoiceActions()}
        scope="channel"
        channelId="general"
        channelName="General"
      />,
    );

    expect(screen.getByText('This channel is quiet')).toBeInTheDocument();
    expect(screen.getByText('Send the first message in General.')).toBeInTheDocument();
    expect(screen.queryByText('No messages yet')).not.toBeInTheDocument();
    expect(screen.queryByText('#General')).not.toBeInTheDocument();
  });

  it('falls back to generic channel copy when no channel name was resolved (never blocking render)', () => {
    const state = createVoiceState({ myPermissions: [] });
    render(
      <ChatView state={state} actions={createVoiceActions()} scope="channel" channelId="general" />,
    );

    expect(screen.getByText('This channel is quiet')).toBeInTheDocument();
    expect(screen.getByText('Send the first message.')).toBeInTheDocument();
  });
});

// T13.1.1 — `CHAT_FIXTURE_COMMAND` ('/fixture') is gated on `import.meta.env.DEV` alone (a
// Vite/Vitest runtime-mutable property, not statically inlined outside a real `vite build` — see
// `chat-dev-fixture.ts`'s own doc comment). `vi.stubEnv('DEV', ...)` is Vitest's own sanctioned
// mechanism for flipping this exact flag at runtime (its type signature special-cases
// 'DEV'/'PROD'/'SSR' to booleans), so this genuinely exercises both branches of the real gate rather
// than just asserting today's default test-runner mode.
describe('ChatView — /fixture is dev/test-only-gated, never silently dropped in production (T13.1.1)', () => {
  it('with import.meta.env.DEV=true, "/fixture" toggles the local preview only and is never sent as a real chat message', () => {
    vi.stubEnv('DEV', true);
    const actions = createVoiceActions();
    const state = createVoiceState({ myPermissions: ['chat.server.send'] });
    render(<ChatView state={state} actions={actions} scope="server" channelId={undefined} />);

    const input = screen.getByPlaceholderText('Message…');
    fireEvent.change(input, { target: { value: '/fixture' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(actions.sendChatMessage).not.toHaveBeenCalled();
    expect(input).toHaveValue('');
  });

  it('with import.meta.env.DEV=false (the packaged/production path), "/fixture" is treated like any other message and genuinely sent via the real sendChatMessage action — never silently dropped, never fabricating data with no trace', () => {
    vi.stubEnv('DEV', false);
    const actions = createVoiceActions();
    const state = createVoiceState({ myPermissions: ['chat.server.send'] });
    render(<ChatView state={state} actions={actions} scope="server" channelId={undefined} />);

    const input = screen.getByPlaceholderText('Message…');
    fireEvent.change(input, { target: { value: '/fixture' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send message' }));

    expect(actions.sendChatMessage).toHaveBeenCalledTimes(1);
    expect(actions.sendChatMessage).toHaveBeenCalledWith('server', undefined, '/fixture');
  });

  it('with import.meta.env.DEV=false, the dev-only hint text is never rendered', () => {
    vi.stubEnv('DEV', false);
    const state = createVoiceState({ myPermissions: ['chat.server.send'] });
    render(
      <ChatView
        state={state}
        actions={createVoiceActions()}
        scope="server"
        channelId={undefined}
      />,
    );

    expect(screen.queryByText(/Dev only: type/)).not.toBeInTheDocument();
  });
});
