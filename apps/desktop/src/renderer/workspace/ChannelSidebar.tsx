import type { ReactElement } from 'react';
import { MessageSquare } from 'lucide-react';

import type { VoiceChannelSummary } from '@disco-voador/protocol';

import type { VoiceParticipantView } from '../voice/use-voice-channel.js';
import { ChannelRow } from './ChannelRow.js';
import { chatTargetsEqual, type ChatTarget } from './chat-target.js';
import styles from './ChannelSidebar.module.css';

interface ChannelSidebarProps {
  readonly serverName: string | undefined;
  readonly channels: readonly VoiceChannelSummary[];
  readonly participants: readonly VoiceParticipantView[];
  readonly currentChannelId: string | undefined;
  readonly selfParticipantId: string | undefined;
  readonly remoteCameraParticipantIds: ReadonlySet<string>;
  readonly remoteScreenParticipantIds: ReadonlySet<string>;
  readonly selfCameraEnabled: boolean;
  readonly selfSharingScreen: boolean;
  readonly canJoin: boolean;
  readonly joining: boolean;
  readonly selectedChatTarget: ChatTarget;
  readonly onSelectChatTarget: (target: ChatTarget) => void;
  readonly onJoinChannel: (channelId: string) => void;
  readonly onLeaveChannel: () => void;
}

/** Left workspace column (T13.1): server name header, an always-present "Server Chat" entry (T10's
 * existing server-wide chat scope — never a new per-channel-vs-server hierarchy), then the real
 * `VoiceChannelSummary[]` list. */
export function ChannelSidebar({
  serverName,
  channels,
  participants,
  currentChannelId,
  selfParticipantId,
  remoteCameraParticipantIds,
  remoteScreenParticipantIds,
  selfCameraEnabled,
  selfSharingScreen,
  canJoin,
  joining,
  selectedChatTarget,
  onSelectChatTarget,
  onJoinChannel,
  onLeaveChannel,
}: ChannelSidebarProps): ReactElement {
  return (
    <nav className={styles.sidebar} aria-label="Channels">
      <div className={styles.header}>
        <span className={styles.serverName}>{serverName ?? 'OvniChat'}</span>
      </div>

      <div className={styles.scroll}>
        <button
          type="button"
          className={`${styles.serverChat} ${
            selectedChatTarget.scope === 'server' ? styles.serverChatSelected : ''
          }`}
          onClick={() => {
            onSelectChatTarget({ scope: 'server' });
          }}
        >
          <MessageSquare size={16} aria-hidden="true" />
          Server Chat
        </button>

        <div className={styles.sectionLabel}>Voice Channels</div>
        <ul className={styles.channelList}>
          {channels.map((channel) => {
            const isJoined = channel.channelId === currentChannelId;
            return (
              <ChannelRow
                key={channel.channelId}
                channel={channel}
                isSelected={chatTargetsEqual(selectedChatTarget, {
                  scope: 'channel',
                  channelId: channel.channelId,
                })}
                isJoined={isJoined}
                canJoin={canJoin}
                joining={joining}
                participants={isJoined ? participants : []}
                selfParticipantId={selfParticipantId}
                remoteCameraParticipantIds={remoteCameraParticipantIds}
                remoteScreenParticipantIds={remoteScreenParticipantIds}
                selfCameraEnabled={selfCameraEnabled}
                selfSharingScreen={selfSharingScreen}
                onSelect={() => {
                  onSelectChatTarget({ scope: 'channel', channelId: channel.channelId });
                }}
                onJoin={() => {
                  onJoinChannel(channel.channelId);
                }}
                onLeave={onLeaveChannel}
              />
            );
          })}
        </ul>
      </div>
    </nav>
  );
}
