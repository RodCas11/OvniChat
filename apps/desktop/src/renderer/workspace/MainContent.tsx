import type { ReactElement } from 'react';
import { MessageSquare, Settings, Shield, Volume2 } from 'lucide-react';

import type { ChannelNodeView } from '@disco-voador/protocol';

import { IconButton } from '../ui/IconButton.js';
import { LocalCameraPreview } from '../voice/LocalCameraPreview.js';
import { LocalScreenPreview } from '../voice/LocalScreenPreview.js';
import { RemoteCamera } from '../voice/RemoteCamera.js';
import { RemoteScreen } from '../voice/RemoteScreen.js';
import { chatThreadKey } from '../voice/use-voice-channel.js';
import type { VoiceChannelActions, VoiceChannelState } from '../voice/use-voice-channel.js';
import { ChatView } from './ChatView.js';
import type { ChatTarget } from './chat-target.js';
import styles from './MainContent.module.css';

interface MainContentProps {
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
  readonly channelTree: readonly ChannelNodeView[];
  readonly selectedChatTarget: ChatTarget;
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
 * Center workspace column (T13.1): switches between Server Chat and a selected channel's chat based
 * on local selection state (never voice-join status — see `ChatTarget`'s own doc comment), with a
 * header that always makes which one is showing unambiguous (never a bare `#`, which would falsely
 * imply a Discord-style separate text-channel hierarchy this app does not have). Camera/screen
 * tiles (T3-T5) render above the chat, unchanged from before this task's restyle — a full
 * Discord-style "stage" layout for calls is explicitly deferred to T13.5.
 */
export function MainContent({
  state,
  actions,
  channelTree,
  selectedChatTarget,
  onOpenAuthorization,
  onOpenServerSettings,
}: MainContentProps): ReactElement {
  const channelName =
    selectedChatTarget.scope === 'channel'
      ? (channelTree.find((node) => node.nodeId === selectedChatTarget.channelId)?.name ??
        selectedChatTarget.channelId)
      : undefined;
  const isJoinedChannel =
    selectedChatTarget.scope === 'channel' &&
    selectedChatTarget.channelId === state.currentChannelId;

  const hasMedia =
    Boolean(state.localCameraStream) ||
    state.remoteCameraStreams.size > 0 ||
    Boolean(state.localScreenStream) ||
    state.remoteScreenStreams.size > 0;

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

      {hasMedia && (
        <div className={styles.mediaStrip}>
          <div className={styles.mediaRow}>
            {state.localCameraStream && <LocalCameraPreview stream={state.localCameraStream} />}
            {[...state.remoteCameraStreams.entries()].map(([participantId, stream]) => {
              const participant = state.participants.find((p) => p.participantId === participantId);
              return (
                <RemoteCamera
                  key={participantId}
                  participantId={participantId}
                  displayName={participant?.displayName ?? participantId}
                  stream={stream}
                />
              );
            })}
          </div>
          <div className={styles.mediaRow}>
            {state.localScreenStream && <LocalScreenPreview stream={state.localScreenStream} />}
            {[...state.remoteScreenStreams.entries()].map(([participantId, stream]) => {
              const participant = state.participants.find((p) => p.participantId === participantId);
              return (
                <RemoteScreen
                  key={participantId}
                  participantId={participantId}
                  displayName={participant?.displayName ?? participantId}
                  stream={stream}
                />
              );
            })}
          </div>
        </div>
      )}

      <div className={styles.chat}>
        {/* T13.1 fix — keyed by the actual thread identity so switching between Server Chat and a
            channel's chat (or between two channels) always mounts a fresh `ChatView` instance:
            without this, React reconciles the *same* `ChatView` component instance across a
            selection change (same position in the tree, same component type), leaking its local,
            per-thread-unaware `composerText` draft into whichever thread is now showing — the
            exact class of stale-UI-state risk this task's `AppShell` remount-key fix targets at
            the connection level, found here at the thread-selection level while adding this
            task's own test coverage for the requirement. `ChatView`'s own history/pagination state
            is unaffected: it is derived from `state.chatThreads` (owned by `use-voice-channel.ts`),
            never local. */}
        <ChatView
          key={chatThreadKey(
            selectedChatTarget.scope,
            selectedChatTarget.scope === 'channel' ? selectedChatTarget.channelId : undefined,
          )}
          state={state}
          actions={actions}
          scope={selectedChatTarget.scope}
          channelId={
            selectedChatTarget.scope === 'channel' ? selectedChatTarget.channelId : undefined
          }
        />
      </div>
    </div>
  );
}
