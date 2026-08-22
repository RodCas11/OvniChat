// T13.1 QA fixtures — deterministic, minimal builders for `VoiceChannelState`/`VoiceChannelActions`
// and the handful of real protocol view-model shapes the redesigned components render. Every
// builder starts from the exact same defaults `use-voice-channel.ts`'s own `INITIAL_STATE` uses
// (never fabricated shapes beyond what the real hook contract types allow — see
// `docs/tasks/T13_1_VISUAL_FOUNDATION.md`'s "no fabricated data" rule) and only ever overrides what
// a given test actually needs, via a plain object-spread `overrides` parameter, mirroring this
// repo's existing fixture-builder precedent (`tests/rtc-core/fake-peer-connection.ts`).
import { vi } from 'vitest';

import type {
  BanSummary,
  ChatMessageView,
  ChatScope,
  ChannelNodeAdminView,
  ChannelNodeView,
  GroupBadge,
  GroupSummary,
  PermissionKey,
} from '@disco-voador/protocol';

import type { ServerInfo } from '../../../apps/desktop/src/renderer/realtime/realtime-client.js';
import type {
  ChatThreadState,
  VoiceChannelActions,
  VoiceChannelState,
  VoiceParticipantView,
} from '../../../apps/desktop/src/renderer/voice/use-voice-channel.js';

export function createChannel(overrides: Partial<ChannelNodeView> = {}): ChannelNodeView {
  // `parentId`/`userLimit` are optional keys under `exactOptionalPropertyTypes` — omitted here
  // entirely rather than set to `undefined`, matching `deviceIdConstraint`'s own convention.
  return {
    nodeId: 'general',
    kind: 'voice',
    name: 'General',
    sortOrder: 0,
    visibilityPolicy: 'inherit',
    joinPolicy: 'inherit',
    managePolicy: 'inherit',
    hasPassword: false,
    temporary: false,
    ...overrides,
  };
}

/** T13.2 — the admin/manager detail view a `getEditableChannelNode` resolution carries (adds the
 * three group-id lists the ordinary `ChannelNodeView` deliberately omits). Defaults mirror
 * `createChannel`'s own baseline exactly, so a test only needs to override what it actually cares
 * about. */
export function createChannelAdminView(
  overrides: Partial<ChannelNodeAdminView> = {},
): ChannelNodeAdminView {
  return {
    nodeId: 'general',
    kind: 'voice',
    name: 'General',
    sortOrder: 0,
    visibilityPolicy: 'inherit',
    visibilityGroupIds: [],
    joinPolicy: 'inherit',
    joinGroupIds: [],
    managePolicy: 'inherit',
    manageGroupIds: [],
    hasPassword: false,
    temporary: false,
    ...overrides,
  };
}

export function createParticipant(
  overrides: Partial<VoiceParticipantView> = {},
): VoiceParticipantView {
  return {
    participantId: 'participant-1',
    displayName: 'Alice',
    connectionState: 'connected',
    groups: [],
    ...overrides,
  };
}

export function createGroupBadge(overrides: Partial<GroupBadge> = {}): GroupBadge {
  return { groupId: 'guest', name: 'Guest', ...overrides };
}

export function createGroupSummary(overrides: Partial<GroupSummary> = {}): GroupSummary {
  return {
    groupId: 'guest',
    name: 'Guest',
    permissions: ['voice.channel.join', 'chat.server.send', 'chat.channel.send'],
    protectedGroup: true,
    ...overrides,
  };
}

export function createBan(overrides: Partial<BanSummary> = {}): BanSummary {
  return { identityId: 'dv1_banned', createdAt: Date.UTC(2026, 0, 1), ...overrides };
}

export function createServerInfo(overrides: Partial<ServerInfo> = {}): ServerInfo {
  return { serverName: 'Test Server', serverCapabilities: [], ...overrides };
}

export function createChatMessage(overrides: Partial<ChatMessageView> = {}): ChatMessageView {
  const base = {
    messageId: 1,
    scope: 'server' as ChatScope,
    senderNickname: 'Alice',
    body: 'Hello',
    createdAt: Date.UTC(2026, 0, 1),
  };
  const merged = { ...base, ...overrides };
  return merged as ChatMessageView;
}

export function createChatThread(overrides: Partial<ChatThreadState> = {}): ChatThreadState {
  return { messages: [], hasMoreOlder: false, loading: false, ...overrides };
}

/** Mirrors `use-voice-channel.ts`'s own `INITIAL_STATE`, then applies `connectionStatus: 'connected'`
 * — every redesigned workspace component (`ChannelSidebar`/`MainContent`/`MemberPanel`/
 * `UserControlBar`) only ever renders once connected, so that is this fixture's own baseline rather
 * than each test having to override it individually. */
export function createVoiceState(overrides: Partial<VoiceChannelState> = {}): VoiceChannelState {
  return {
    connectionStatus: 'connected',
    serverInfo: createServerInfo(),
    channelTree: [createChannel()],
    currentChannelId: undefined,
    selfParticipantId: undefined,
    participants: [],
    remoteAudioStreams: new Map(),
    remoteCameraStreams: new Map(),
    remoteScreenStreams: new Map(),
    remoteScreenAudioStreams: new Map(),
    muted: false,
    deafened: false,
    joining: false,
    micError: undefined,
    localMicrophoneStream: undefined,
    micUsingFallback: false,
    micDisconnected: false,
    lastError: undefined,
    reconnectAttempt: undefined,
    connectionError: undefined,
    cameraEnabled: false,
    cameraAcquiring: false,
    localCameraStream: undefined,
    cameraError: undefined,
    cameraUsingFallback: false,
    screenSharingState: 'idle',
    localScreenStream: undefined,
    screenShareError: undefined,
    screenShareAudioActive: false,
    myGroups: [],
    myPermissions: [],
    groups: undefined,
    bans: undefined,
    lastCreatedToken: undefined,
    lastRedeemedGroup: undefined,
    chatThreads: new Map(),
    channelPasswordPrompt: undefined,
    channelAccessRevokedNotice: undefined,
    ...overrides,
  };
}

/** Every action is a `vi.fn()` — tests assert on call args/counts, never on any real hook/effect
 * behavior (that boundary is `use-voice-channel-*.test.ts`'s job, unchanged by this task). */
export function createVoiceActions(
  overrides: Partial<VoiceChannelActions> = {},
): VoiceChannelActions {
  return {
    join: vi.fn(),
    leave: vi.fn(),
    cancelReconnect: vi.fn(),
    setMuted: vi.fn(),
    setDeafened: vi.fn(),
    enableCamera: vi.fn(),
    disableCamera: vi.fn(),
    switchMicrophone: vi.fn(),
    switchCamera: vi.fn(),
    enableScreenShare: vi.fn(),
    disableScreenShare: vi.fn(),
    redeemToken: vi.fn(),
    createToken: vi.fn(),
    listGroups: vi.fn(),
    createGroup: vi.fn(),
    updateGroup: vi.fn(),
    deleteGroup: vi.fn(),
    grantGroup: vi.fn(),
    revokeGroup: vi.fn(),
    kick: vi.fn(),
    ban: vi.fn(),
    unban: vi.fn(),
    listBans: vi.fn(),
    sendChatMessage: vi.fn(),
    loadChatHistory: vi.fn(),
    createCategory: vi.fn(),
    createVoiceChannel: vi.fn(),
    updateChannel: vi.fn(),
    moveChannel: vi.fn(),
    reorderChannels: vi.fn(),
    deleteChannel: vi.fn(),
    setChannelPassword: vi.fn(),
    removeChannelPassword: vi.fn(),
    getEditableChannelNode: vi.fn(),
    submitChannelPassword: vi.fn(),
    dismissChannelPasswordPrompt: vi.fn(),
    dismissChannelAccessRevokedNotice: vi.fn(),
    ...overrides,
  };
}

export type { PermissionKey };
