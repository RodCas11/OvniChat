import type { MouseEvent, ReactElement } from 'react';
import { Lock, LogOut, MessageSquare, Phone, Timer, Volume2 } from 'lucide-react';

import type { ChannelNodeView } from '@disco-voador/protocol';

import { Button } from '../ui/Button.js';
import { IconButton } from '../ui/IconButton.js';
import type { VoiceParticipantView } from '../voice/use-voice-channel.js';
import { ParticipantRow } from './ParticipantRow.js';
import styles from './ChannelRow.module.css';

interface ChannelRowProps {
  readonly channel: ChannelNodeView;
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
  /** T13.2 — 0 for a top-level channel; a subchannel nested under another voice channel adds one
   * per level (bounded by `MAX_CHANNEL_DEPTH`). Purely a visual indent — the server, not this
   * value, is the actual authority on hierarchy depth limits. */
  readonly depth?: number;
  /** T13.2 — right-click anywhere on the row body opens the shared channel/category admin context
   * menu (see `ChannelContextMenu.tsx`) — optional so every existing caller/test that has no use for
   * it (e.g. a context that never offers admin actions) is unaffected. */
  readonly onContextMenu?: (event: MouseEvent<HTMLLIElement>) => void;
}

/**
 * One row per real server-owned voice channel (T13.1, tree-aware since T13.2 — `ChannelSidebar`
 * flattens the real category/channel/subchannel hierarchy into a depth-annotated list and renders
 * one `ChannelRow` per voice-kind node; categories get their own, simpler header treatment). A click
 * anywhere on the row body selects it for chat viewing only — joining voice is always the separate,
 * explicit `Join`/`Leave` action, per the task's hard "single click never auto-joins voice" rule.
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
  depth = 0,
  onContextMenu,
}: ChannelRowProps): ReactElement {
  // T13.1.1 — secondary actions (the chat-bubble icon, Join/Leave) stay visually quiet until the
  // row is hovered/focused, selected, or already joined; the channel name itself never competes
  // with them. `isJoined`/`isSelected` force the actions fully visible even without hover, since
  // "I am in this channel's voice" (and "this is what I'm currently viewing") are both meaningful
  // ambient state, not merely a hover affordance — CSS (`:hover`/`:focus-within`) handles the
  // hover/focus case; this class handles the other two. Purely a visual (opacity) change: every
  // handler/testid below is completely unchanged, so the existing "click never joins voice"
  // invariant (`tests/desktop/components/channel-row.test.tsx`) is unaffected.
  const actionsClassName = [styles.actions, isJoined || isSelected ? styles.actionsVisible : '']
    .filter(Boolean)
    .join(' ');

  return (
    <li
      className={styles.container}
      style={depth > 0 ? { marginLeft: depth * 16 } : undefined}
      data-testid={`channel-row-${channel.nodeId}`}
      onContextMenu={onContextMenu}
    >
      <div
        className={`${styles.row} ${isSelected ? styles.selected : ''} ${
          isJoined ? styles.joined : ''
        }`}
      >
        <button
          type="button"
          className={styles.selectButton}
          onClick={onSelect}
          data-testid={`channel-row-select-${channel.nodeId}`}
        >
          {isJoined ? (
            <Volume2 size={16} aria-hidden="true" className={styles.joinedIcon} />
          ) : (
            <MessageSquare size={16} aria-hidden="true" className={styles.chatIcon} />
          )}
          <span className={styles.name} title={channel.name}>
            {channel.name}
          </span>
          {channel.hasPassword && (
            <Lock
              size={12}
              aria-hidden="true"
              className={styles.badgeIcon}
              role="img"
              data-testid={`channel-row-password-badge-${channel.nodeId}`}
            >
              <title>Password protected</title>
            </Lock>
          )}
          {channel.temporary && (
            <Timer
              size={12}
              aria-hidden="true"
              className={styles.badgeIcon}
              data-testid={`channel-row-temporary-badge-${channel.nodeId}`}
            >
              <title>Temporary channel</title>
            </Timer>
          )}
        </button>

        <div className={actionsClassName}>
          <IconButton
            icon={MessageSquare}
            ariaLabel={`Open ${channel.name} chat`}
            size="small"
            onClick={onSelect}
            data-testid={`channel-row-chat-${channel.nodeId}`}
          />
          {isJoined ? (
            <IconButton
              icon={LogOut}
              ariaLabel="Leave voice channel"
              size="small"
              onClick={onLeave}
              data-testid={`channel-row-leave-${channel.nodeId}`}
            />
          ) : (
            <Button
              variant="ghost"
              onClick={onJoin}
              disabled={!canJoin || joining}
              data-testid={`channel-row-join-${channel.nodeId}`}
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
