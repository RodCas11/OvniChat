import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';

import {
  CHAT_MESSAGE_BODY_MAX_LENGTH,
  type ChatMessageView,
  type ChatScope,
} from '@disco-voador/protocol';

import type { VoiceChannelActions, VoiceChannelState } from './use-voice-channel.js';

interface ChatPanelProps {
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
}

function chatThreadKey(scope: ChatScope, channelId: string | undefined): string {
  return scope === 'server' ? 'server' : `channel:${channelId ?? ''}`;
}

/**
 * T10 minimal, functional (not polished, per Section 83-84) OvniChat persistent text chat panel —
 * mirrors `AuthorizationPanel.tsx`'s own bar: plain forms, no styling. "Server Chat" is always
 * available; a second tab for the currently-joined voice channel's chat appears only while
 * connected to one (T10 Section 5-8: chat scopes are server-wide or attached to an existing voice
 * channel, never an independent text-channel hierarchy yet).
 *
 * Never uses `dangerouslySetInnerHTML` — every message body renders as plain React text content,
 * which is HTML-escaped by construction, so a persisted `<script>...</script>` body (T10 Section
 * 23/73) always renders as literal, inert text, on both a live message and one loaded from history
 * days later. Only `messageId` is ever used as a React list key; nothing derived from body content.
 */
export function ChatPanel({ state, actions }: ChatPanelProps): ReactElement {
  const [activeTab, setActiveTab] = useState<'server' | 'channel'>('server');
  const [composerText, setComposerText] = useState('');

  const channelId = state.currentChannelId;
  const scope: ChatScope = activeTab === 'channel' && channelId ? 'channel' : 'server';
  const effectiveChannelId = scope === 'channel' ? channelId : undefined;
  const key = chatThreadKey(scope, effectiveChannelId);
  const thread = state.chatThreads.get(key);

  // Fall back to Server Chat if the channel tab was active and the user then left the channel —
  // there is nothing to show for a channel-scope tab with no channelId.
  useEffect(() => {
    if (activeTab === 'channel' && !channelId) setActiveTab('server');
  }, [activeTab, channelId]);

  // Load the initial page once a thread becomes visible and has never been requested yet (T10
  // Section 26: "when Server Chat UI becomes active: load recent history" — same for a channel tab).
  const requestedKeysRef = useRef(new Set<string>());
  useEffect(() => {
    if (requestedKeysRef.current.has(key)) return;
    requestedKeysRef.current.add(key);
    actions.loadChatHistory(scope, effectiveChannelId);
  }, [key, scope, effectiveChannelId, actions]);

  function handleLoadOlder(): void {
    actions.loadChatHistory(scope, effectiveChannelId);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const body = composerText.trim();
    if (!body) return;
    actions.sendChatMessage(scope, effectiveChannelId, body);
    setComposerText('');
  }

  const canSend =
    scope === 'server'
      ? state.myPermissions.includes('chat.server.send')
      : state.myPermissions.includes('chat.channel.send');

  return (
    <section aria-label="OvniChat">
      <h3>Chat</h3>
      <nav>
        <button
          type="button"
          disabled={activeTab === 'server'}
          onClick={() => {
            setActiveTab('server');
          }}
        >
          Server Chat
        </button>
        {channelId && (
          <button
            type="button"
            disabled={activeTab === 'channel'}
            onClick={() => {
              setActiveTab('channel');
            }}
          >
            {channelId} Chat
          </button>
        )}
      </nav>

      {thread?.hasMoreOlder && (
        <button type="button" disabled={thread.loading} onClick={handleLoadOlder}>
          {thread.loading ? 'Loading…' : 'Load older messages'}
        </button>
      )}

      <ul>
        {(thread?.messages ?? []).map((message: ChatMessageView) => (
          <li key={message.messageId} style={{ whiteSpace: 'pre-wrap' }}>
            <strong>{message.senderNickname}</strong>: {message.body}
          </li>
        ))}
      </ul>

      {canSend ? (
        <form onSubmit={handleSubmit}>
          <input
            value={composerText}
            onChange={(event) => {
              setComposerText(event.target.value);
            }}
            maxLength={CHAT_MESSAGE_BODY_MAX_LENGTH}
            placeholder="mensagem..."
          />
          <button type="submit" disabled={composerText.trim().length === 0}>
            Send
          </button>
        </form>
      ) : (
        <p>You do not have permission to send messages here.</p>
      )}
    </section>
  );
}
