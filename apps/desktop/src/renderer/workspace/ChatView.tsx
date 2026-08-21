import { useEffect, useMemo, useState, type FormEvent, type ReactElement } from 'react';
import { Send } from 'lucide-react';

import {
  CHAT_MESSAGE_BODY_MAX_LENGTH,
  type ChatMessageView,
  type ChatScope,
} from '@disco-voador/protocol';

import { Avatar } from '../ui/Avatar.js';
import { Button } from '../ui/Button.js';
import { EmptyState } from '../ui/EmptyState.js';
import {
  chatThreadKey,
  type VoiceChannelActions,
  type VoiceChannelState,
} from '../voice/use-voice-channel.js';
import styles from './ChatView.module.css';

interface ChatViewProps {
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
  /** Which thread to show — driven entirely by the caller's own selection state (see
   * `VoiceChannelView.tsx`'s `selectedChatTarget`), never derived from voice-join status: viewing a
   * channel's chat and being joined to its voice are two independent things (T13.1 rule: a single
   * click on a channel shows its chat and must never join voice). */
  readonly scope: ChatScope;
  readonly channelId: string | undefined;
}

interface MessageGroup {
  readonly senderNickname: string;
  readonly messages: readonly ChatMessageView[];
}

/** Presentation-only grouping of consecutive same-sender messages (Discord-style) — never changes
 * fetch/pagination/persistence semantics, only how an already-loaded, already-ordered message list
 * is chunked for rendering. Builds each group's message list by mutating a local mutable array
 * (not by re-spreading the group on every message, which was O(n²) on a long same-sender run) —
 * security review (T13.1) flagged the original as a Renderer-side DoS risk against an unbounded,
 * server-controlled thread. */
function groupMessages(messages: readonly ChatMessageView[]): readonly MessageGroup[] {
  const groups: { senderNickname: string; messages: ChatMessageView[] }[] = [];
  for (const message of messages) {
    const last = groups[groups.length - 1];
    if (last && last.senderNickname === message.senderNickname) {
      last.messages.push(message);
    } else {
      groups.push({ senderNickname: message.senderNickname, messages: [message] });
    }
  }
  return groups;
}

function formatTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

/**
 * T13.1 restyle of the original `voice/ChatPanel.tsx` (T10) — every hook/effect/handler this
 * component drives (`loadChatHistory` on first view, `sendChatMessage` on submit, the
 * dedup/merge/pagination semantics themselves) is unchanged; only the markup/styling and the
 * scope/channelId selection mechanism differ (see this file's own `scope`/`channelId` prop doc
 * comment — the original derived a channel tab from `state.currentChannelId` alone, which cannot
 * express "viewing a channel's chat without having joined its voice").
 */
export function ChatView({ state, actions, scope, channelId }: ChatViewProps): ReactElement {
  const [composerText, setComposerText] = useState('');
  const key = chatThreadKey(scope, channelId);
  const thread = state.chatThreads.get(key);

  // Security review (T13.1): dedup against `state.chatThreads` (owned by `use-voice-channel.ts`,
  // outliving this component's own remounts — `MainContent.tsx` keys `ChatView` per thread so
  // switching threads always mounts a fresh instance) rather than a component-local ref, which
  // would re-request a page of already-loaded history every time a thread with `hasMoreOlder: true`
  // was revisited — a self-inflicted amplifier against the server's chat-history rate limit. A
  // thread that does not exist yet in `chatThreads` has genuinely never been requested.
  useEffect(() => {
    if (state.chatThreads.has(key)) return;
    actions.loadChatHistory(scope, channelId);
  }, [key, scope, channelId, actions, state.chatThreads]);

  function handleLoadOlder(): void {
    actions.loadChatHistory(scope, channelId);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const body = composerText.trim();
    if (!body) return;
    actions.sendChatMessage(scope, channelId, body);
    setComposerText('');
  }

  const canSend =
    scope === 'server'
      ? state.myPermissions.includes('chat.server.send')
      : state.myPermissions.includes('chat.channel.send');

  const messages = thread?.messages ?? [];
  const groups = useMemo(() => groupMessages(messages), [messages]);

  return (
    <div className={styles.container}>
      <div className={styles.history}>
        {thread?.hasMoreOlder && (
          <div className={styles.loadOlder}>
            <Button variant="ghost" disabled={thread.loading} onClick={handleLoadOlder}>
              {thread.loading ? 'Loading…' : 'Load older messages'}
            </Button>
          </div>
        )}

        {messages.length === 0 ? (
          <EmptyState icon={Send} title="No messages yet" description="Say hello." />
        ) : (
          groups.map((group) => (
            <div key={group.messages[0]?.messageId} className={styles.group}>
              <Avatar name={group.senderNickname} size="small" />
              <div className={styles.groupBody}>
                <div className={styles.groupHeader}>
                  <span className={styles.sender}>{group.senderNickname}</span>
                  <span className={styles.time}>
                    {formatTime(group.messages[0]?.createdAt ?? 0)}
                  </span>
                </div>
                {group.messages.map((message) => (
                  <p key={message.messageId} className={styles.messageBody}>
                    {message.body}
                  </p>
                ))}
              </div>
            </div>
          ))
        )}
      </div>

      {canSend ? (
        <form onSubmit={handleSubmit} className={styles.composer}>
          <input
            value={composerText}
            onChange={(event) => {
              setComposerText(event.target.value);
            }}
            maxLength={CHAT_MESSAGE_BODY_MAX_LENGTH}
            placeholder="Message…"
            className={styles.composerInput}
          />
          <Button variant="primary" type="submit" disabled={composerText.trim().length === 0}>
            <Send size={16} aria-hidden="true" />
          </Button>
        </form>
      ) : (
        <p className={styles.noPermission}>You do not have permission to send messages here.</p>
      )}
    </div>
  );
}
