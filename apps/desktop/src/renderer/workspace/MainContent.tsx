import { useState, type ReactElement } from 'react';
import { MessageSquare, MessageSquareOff, Settings, Shield, Volume2 } from 'lucide-react';

import type { ChannelNodeView } from '@disco-voador/protocol';

import { IconButton } from '../ui/IconButton.js';
import { chatThreadKey } from '../voice/use-voice-channel.js';
import type {
  VoiceChannelActions,
  VoiceChannelState,
  VoiceParticipantView,
} from '../voice/use-voice-channel.js';
import { ChatView } from './ChatView.js';
import type { ChatTarget } from './chat-target.js';
import { MediaStage } from './MediaStage.js';
import styles from './MainContent.module.css';

interface MainContentProps {
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
  readonly channelTree: readonly ChannelNodeView[];
  readonly selectedChatTarget: ChatTarget;
  /** T13.5 — already avatar-resolved participants (`VoiceChannelView.tsx`'s `participantsWithSelf`,
   * the same list `ChannelSidebar` already receives) — threaded through so the media stage's tiles
   * show the exact same avatar/nickname Member Panel and the voice-channel roster already show,
   * never a second avatar-resolution path (Section 23). */
  readonly participants: readonly VoiceParticipantView[];
  /** Opens the Authorization modal (token redemption +, when permitted, admin sections) — a plain
   * entry point available to every connected user, not an admin-only control itself (the admin
   * sub-sections inside stay gated by `AuthorizationPanel.tsx`'s own real `can()` checks). */
  readonly onOpenAuthorization: () => void;
  /** T13.2 — opens the new Server Settings shell (Channels/Groups & Permissions/Invites/Bans).
   * `undefined` (never merely a disabled button) when the caller has determined this identity holds
   * no relevant capability at all — see `VoiceChannelView.tsx`'s `canOpenServerSettings` — so a Guest
   * sees zero trace of this icon in the DOM, not a greyed-out one. */
  readonly onOpenServerSettings?: (() => void) | undefined;
}

/**
 * Center workspace column (T13.1, media stage since T13.5): switches between Server Chat and a
 * selected channel's chat based on local selection state (never voice-join status — see
 * `ChatTarget`'s own doc comment), with a header that always makes which one is showing unambiguous
 * (never a bare `#`, which would falsely imply a Discord-style separate text-channel hierarchy this
 * app does not have).
 *
 * Chat stays the sole, full-width primary content whenever no camera/screen stream is actually
 * active (Section 18/80, `MediaStage`'s own `hasMedia` check) — this is the deliberate default, not
 * a fallback. Once real media is active, `MediaStage` takes the primary content area and chat
 * becomes a narrower, user-toggleable side panel (never removed entirely — Section 44) rather than
 * disappearing or being replaced by a second, parallel chat system.
 */
export function MainContent({
  state,
  actions,
  channelTree,
  selectedChatTarget,
  participants,
  onOpenAuthorization,
  onOpenServerSettings,
}: MainContentProps): ReactElement {
  const [chatVisible, setChatVisible] = useState(true);

  const channelName =
    selectedChatTarget.scope === 'channel'
      ? (channelTree.find((node) => node.nodeId === selectedChatTarget.channelId)?.name ??
        selectedChatTarget.channelId)
      : undefined;
  const isJoinedChannel =
    selectedChatTarget.scope === 'channel' &&
    selectedChatTarget.channelId === state.currentChannelId;

  // Mirrors `MediaStage.tsx`'s own `hasMedia` check exactly (never diverges from it — this is only
  // used to decide the layout shape, `MediaStage` itself is still the single source of truth for
  // whether it actually renders anything).
  const hasMedia =
    Boolean(state.cameraEnabled && state.localCameraStream) ||
    state.remoteCameraStreams.size > 0 ||
    Boolean(state.screenSharingState === 'sharing' && state.localScreenStream) ||
    state.remoteScreenStreams.size > 0;

  const chatThread = (
    <ChatView
      key={chatThreadKey(
        selectedChatTarget.scope,
        selectedChatTarget.scope === 'channel' ? selectedChatTarget.channelId : undefined,
      )}
      state={state}
      actions={actions}
      scope={selectedChatTarget.scope}
      channelId={selectedChatTarget.scope === 'channel' ? selectedChatTarget.channelId : undefined}
      channelName={selectedChatTarget.scope === 'channel' ? channelName : undefined}
    />
  );

  return (
    <div className={styles.container}>
      <header className={styles.header}>
        {selectedChatTarget.scope === 'server' ? (
          <MessageSquare size={18} aria-hidden="true" className={styles.headerIcon} />
        ) : isJoinedChannel ? (
          <Volume2 size={18} aria-hidden="true" className={styles.headerIconJoined} />
        ) : (
          <MessageSquare size={18} aria-hidden="true" className={styles.headerIcon} />
        )}
        <span className={styles.headerTitle}>
          {selectedChatTarget.scope === 'server' ? 'Server Chat' : `${channelName} — Chat`}
        </span>
        <div className={styles.headerActions}>
          {hasMedia && (
            <IconButton
              icon={chatVisible ? MessageSquareOff : MessageSquare}
              ariaLabel={chatVisible ? 'Hide chat' : 'Show chat'}
              tooltip={chatVisible ? 'Hide chat' : 'Show chat'}
              size="small"
              active={chatVisible}
              onClick={() => {
                setChatVisible((visible) => !visible);
              }}
              data-testid="main-content-toggle-chat"
            />
          )}
          {onOpenServerSettings && (
            <IconButton
              icon={Settings}
              ariaLabel="Open Server Settings"
              tooltip="Server Settings"
              size="small"
              onClick={onOpenServerSettings}
              data-testid="open-server-settings"
            />
          )}
          <IconButton
            icon={Shield}
            ariaLabel="Open authorization"
            tooltip="Authorization"
            size="small"
            onClick={onOpenAuthorization}
          />
        </div>
      </header>

      {hasMedia ? (
        <div className={styles.mediaLayout}>
          <div className={styles.mediaArea}>
            <MediaStage state={state} actions={actions} participants={participants} />
          </div>
          {chatVisible && <div className={styles.sideChat}>{chatThread}</div>}
        </div>
      ) : (
        <div className={styles.chat}>{chatThread}</div>
      )}
    </div>
  );
}
