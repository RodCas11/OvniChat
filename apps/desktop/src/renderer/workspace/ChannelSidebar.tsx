import { useCallback, useState, type MouseEvent, type ReactElement } from 'react';
import { MessageSquare } from 'lucide-react';

import type { ChannelNodeView } from '@disco-voador/protocol';

import type {
  VoiceChannelActions,
  VoiceChannelState,
  VoiceParticipantView,
} from '../voice/use-voice-channel.js';
import type { ChannelAdminIntent } from './channel-admin-intent.js';
import { buildChannelTree, type ChannelTreeNode } from './channel-tree.js';
import { ChannelContextMenu, type ChannelContextMenuTarget } from './ChannelContextMenu.js';
import { ChannelRow } from './ChannelRow.js';
import { chatTargetsEqual, type ChatTarget } from './chat-target.js';
import styles from './ChannelSidebar.module.css';

interface ChannelSidebarProps {
  readonly serverName: string | undefined;
  readonly channelTree: readonly ChannelNodeView[];
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
  /** T13.2 — the full hook state/actions, needed only for the right-click admin context menu (real
   * permission checks, the optimistic per-node Manage-rights probe) — every other prop above stays
   * the same narrow, pre-derived shape it always has, so this is purely additive. */
  readonly state: VoiceChannelState;
  readonly actions: VoiceChannelActions;
  readonly onChannelAdminIntent: (intent: ChannelAdminIntent) => void;
  /** T13.4 — opens the local per-participant "User Volume"/"Mute for Me" controls. */
  readonly onOpenVoiceControls?: ((participantId: string) => void) | undefined;
}

interface FlatEntry {
  readonly node: ChannelTreeNode;
  readonly depth: number;
}

/** Pre-order flatten of the real category/channel/subchannel tree into a single depth-annotated
 * list. Chosen over `ChannelRow` rendering its own children recursively so that every existing
 * `onSelect`/`onJoin`/`onLeave` callback on `ChannelRow` can stay a plain, pre-bound, no-argument
 * closure exactly as before T13.2 — `tests/desktop/components/channel-row.test.tsx` asserts
 * `toHaveBeenCalledTimes()` with no argument matching, and changing that contract would be a
 * needless breaking ripple through every existing call site for a purely cosmetic hierarchy
 * change. */
function flatten(nodes: readonly ChannelTreeNode[], depth = 0): readonly FlatEntry[] {
  const result: FlatEntry[] = [];
  for (const node of nodes) {
    result.push({ node, depth });
    result.push(...flatten(node.children, depth + 1));
  }
  return result;
}

/** Left workspace column (T13.1, tree-aware since T13.2): server name header, an always-present
 * "Server Chat" entry (T10's existing server-wide chat scope — never a new per-channel-vs-server
 * hierarchy), then the real, server-owned category/channel hierarchy — already visibility-filtered
 * by the server (see `ChannelNodeView`'s own doc comment: a hidden node is simply absent from
 * `channelTree`, never present-but-marked-hidden). */
export function ChannelSidebar({
  serverName,
  channelTree,
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
  state,
  actions,
  onChannelAdminIntent,
  onOpenVoiceControls,
}: ChannelSidebarProps): ReactElement {
  const entries = flatten(buildChannelTree(channelTree));
  const [menuTarget, setMenuTarget] = useState<ChannelContextMenuTarget | undefined>(undefined);

  function openMenu(event: MouseEvent<HTMLLIElement>, node: ChannelNodeView): void {
    event.preventDefault();
    setMenuTarget({ node, x: event.clientX, y: event.clientY });
  }

  // T13.4 (UI consistency follow-up) — reuses the exact same T13.3 `actions.requestAvatar` this
  // component already has via its own `actions` prop (the same one `MemberPanel`'s
  // `handleRequestMemberAvatar` in `VoiceChannelView.tsx` calls) — never a second, voice-specific
  // avatar-fetch mechanism. Fires at most once per distinct, not-yet-cached hash regardless of how
  // many `ParticipantRow`s call it (`useAvatarUrl`'s own per-hash dedup).
  const handleRequestParticipantAvatar = useCallback(
    (participant: VoiceParticipantView) => {
      if (participant.participantId === selfParticipantId) {
        actions.requestAvatar('self');
      } else if (participant.memberRef) {
        actions.requestAvatar('member', participant.memberRef);
      }
    },
    [actions, selfParticipantId],
  );

  return (
    <nav className={styles.sidebar} aria-label="Channels">
      <div className={styles.header}>
        <span className={styles.serverName}>{serverName ?? 'Chantivo'}</span>
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
          {entries.map(({ node, depth }) => {
            if (node.kind === 'category') {
              return (
                <li
                  key={node.nodeId}
                  className={styles.categoryHeader}
                  style={depth > 0 ? { marginLeft: depth * 16 } : undefined}
                  data-testid={`channel-category-${node.nodeId}`}
                  title={node.name}
                  onContextMenu={(event) => {
                    openMenu(event, node);
                  }}
                >
                  {node.name}
                </li>
              );
            }

            const isJoined = node.nodeId === currentChannelId;
            return (
              <ChannelRow
                key={node.nodeId}
                channel={node}
                depth={depth}
                isSelected={chatTargetsEqual(selectedChatTarget, {
                  scope: 'channel',
                  channelId: node.nodeId,
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
                speakingParticipantIds={state.speakingParticipantIds}
                selfSpeaking={state.selfSpeaking}
                avatarCache={state.avatarCache}
                onRequestAvatar={handleRequestParticipantAvatar}
                onOpenVoiceControls={onOpenVoiceControls}
                onSelect={() => {
                  onSelectChatTarget({ scope: 'channel', channelId: node.nodeId });
                }}
                onJoin={() => {
                  onJoinChannel(node.nodeId);
                }}
                onLeave={onLeaveChannel}
                onContextMenu={(event) => {
                  openMenu(event, node);
                }}
              />
            );
          })}
        </ul>
      </div>

      {menuTarget && (
        <ChannelContextMenu
          state={state}
          actions={actions}
          target={menuTarget}
          canJoin={canJoin}
          onClose={() => {
            setMenuTarget(undefined);
          }}
          onOpenChat={(nodeId) => {
            onSelectChatTarget({ scope: 'channel', channelId: nodeId });
          }}
          onJoin={onJoinChannel}
          onLeave={onLeaveChannel}
          onAdminIntent={onChannelAdminIntent}
        />
      )}
    </nav>
  );
}
