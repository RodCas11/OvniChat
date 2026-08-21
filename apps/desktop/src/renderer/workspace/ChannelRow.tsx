import type { ReactElement } from 'react';
import { LogOut, MessageSquare, Phone, Volume2 } from 'lucide-react';

import type { VoiceChannelSummary } from '@disco-voador/protocol';

import { Button } from '../ui/Button.js';
import { IconButton } from '../ui/IconButton.js';
import type { VoiceParticipantView } from '../voice/use-voice-channel.js';
import { ParticipantRow } from './ParticipantRow.js';
import styles from './ChannelRow.module.css';

interface ChannelRowProps {
  readonly channel: VoiceChannelSummary;
  /** Selected for *viewing its chat* — entirely independent of `isJoined` (T13.1 rule: a single
   * click selects/views a channel's chat and must never join voice by itself). */
  readonly isSelected: boolean;
  /** Actually joined to this channel's voice — the one existing production join concept. Visually
   * distinguished from `isSelected` using more than color alone (a `Volume2` icon plus the accent
   * color, never color alone — T13.1 accessibility rule). */
  readonly isJoined: boolean;
  readonly canJoin: boolean;
  readonly joining: boolean;
  /** Only non-empty when `isJoined` is true — this app has no roster data for a channel nobody is
   * currently joined to (never fabricated). */
  readonly participants: readonly VoiceParticipantView[];
  readonly selfParticipantId: string | undefined;
  readonly remoteCameraParticipantIds: ReadonlySet<string>;
  readonly remoteScreenParticipantIds: ReadonlySet<string>;
  readonly selfCameraEnabled: boolean;
  readonly selfSharingScreen: boolean;
  readonly onSelect: () => void;
  readonly onJoin: () => void;
  readonly onLeave: () => void;
}

/**
 * One row per real server-owned voice channel (T13.1). A click anywhere on the row body selects it
 * for chat viewing only — joining voice is always the separate, explicit `Join`/`Leave` action, per
 * the task's hard "single click never auto-joins voice" rule.
 */
export function ChannelRow({
  channel,
  isSelected,
  isJoined,
  canJoin,
  joining,
  participants,
  selfParticipantId,
  remoteCameraParticipantIds,
  remoteScreenParticipantIds,
  selfCameraEnabled,
  selfSharingScreen,
  onSelect,
  onJoin,
  onLeave,
}: ChannelRowProps): ReactElement {
  return (
    <li className={styles.container} data-testid={`channel-row-${channel.channelId}`}>
      <div className={`${styles.row} ${isSelected ? styles.selected : ''}`}>
        <button
          type="button"
          className={styles.selectButton}
          onClick={onSelect}
          data-testid={`channel-row-select-${channel.channelId}`}
        >
          {isJoined ? (
            <Volume2 size={16} aria-hidden="true" className={styles.joinedIcon} />
          ) : (
            <MessageSquare size={16} aria-hidden="true" className={styles.chatIcon} />
          )}
          <span className={styles.name}>{channel.name}</span>
        </button>

        <div className={styles.actions}>
          <IconButton
            icon={MessageSquare}
            ariaLabel={`Open ${channel.name} chat`}
            size="small"
            onClick={onSelect}
            data-testid={`channel-row-chat-${channel.channelId}`}
          />
          {isJoined ? (
            <IconButton
              icon={LogOut}
              ariaLabel="Leave voice channel"
              size="small"
              onClick={onLeave}
              data-testid={`channel-row-leave-${channel.channelId}`}
            />
          ) : (
            <Button
              variant="ghost"
              onClick={onJoin}
              disabled={!canJoin || joining}
              data-testid={`channel-row-join-${channel.channelId}`}
            >
              <Phone size={14} aria-hidden="true" />
              Join
            </Button>
          )}
        </div>
      </div>

      {isJoined && participants.length > 0 && (
        <ul className={styles.participants}>
          {participants.map((participant) => (
            <ParticipantRow
              key={participant.participantId}
              participant={participant}
              isSelf={participant.participantId === selfParticipantId}
              hasCamera={
                participant.participantId === selfParticipantId
                  ? selfCameraEnabled
                  : remoteCameraParticipantIds.has(participant.participantId)
              }
              hasScreen={
                participant.participantId === selfParticipantId
                  ? selfSharingScreen
                  : remoteScreenParticipantIds.has(participant.participantId)
              }
            />
          ))}
        </ul>
      )}
    </li>
  );
}
