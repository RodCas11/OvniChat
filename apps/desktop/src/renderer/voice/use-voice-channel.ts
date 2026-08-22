import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  BanSummary,
  ChannelNodeAdminView,
  ChannelNodeView,
  ChatMessageView,
  ChatScope,
  ErrorCode,
  GroupBadge,
  GroupSummary,
  IceCandidatePayload,
  PermissionKey,
  ServerAuthorizationBansMessage,
  ServerAuthorizationGroupsMessage,
  ServerAuthorizationStateMessage,
  ServerAuthorizationTokenCreatedMessage,
  ServerAuthorizationTokenRedeemedMessage,
  ServerChannelAckMessage,
  ServerChannelCreatedMessage,
  ServerChannelEditableNodeMessage,
  ServerChatHistoryPageMessage,
  ServerChatMessageMessage,
  ServerErrorMessage,
  ServerMediaTrackSourceMessage,
  ServerVoiceCatalogMessage,
  ServerVoiceJoinedMessage,
  ServerVoiceParticipantJoinedMessage,
  ServerVoiceParticipantLeftMessage,
  ServerVoiceRemovedByPolicyMessage,
  ServerWebrtcAnswerMessage,
  ServerWebrtcIceCandidateMessage,
  ServerWebrtcOfferMessage,
  TokenKind,
  TrackSource,
} from '@disco-voador/protocol';
import {
  acquireCamera,
  acquireMicrophone,
  acquireScreen,
  CameraAccessError,
  MicrophoneAccessError,
  ScreenAccessError,
  SCREEN_QUALITY_PRESETS,
  type Camera,
  type Microphone,
  type ProcessAudioTrack,
  type Screen,
  type ScreenQualityPreset,
} from '@disco-voador/media-core';
import {
  P2PMeshTransport,
  type LocalTrackMidEvent,
  type PeerConnectionStateEvent,
  type RemoteTrackEvent,
} from '@disco-voador/rtc-core';

import type {
  DesktopProcessAudioEndedInfo,
  DesktopRealtimeConfig,
} from '../../shared/ipc-contract.js';
import { acquireProcessAudioTrack } from '../media/process-audio-bridge.js';
import { IpcIdentitySigner } from '../realtime/identity-signer.js';
import type {
  ChannelUpdatePatch,
  RealtimeClient,
  ServerInfo,
} from '../realtime/realtime-client.js';
import { channelErrorMessage } from '../workspace/channel-error-copy.js';
import {
  ReconnectController,
  type ConnectionFailedEvent,
  type ReconnectingConnectionState,
  type ReconnectingEvent,
} from '../realtime/reconnect-controller.js';
import { describeNonRetryableClose } from '../realtime/reconnect-policy.js';
import {
  createEmptyRemoteMediaStreamsState,
  RemoteMediaReconciler,
} from './remote-media-reconciliation.js';
import { releasePublishedScreen } from './screen-share-lifecycle.js';
import type { ScreenShareAudioMode } from './ScreenSourcePicker.js';

export interface VoiceParticipantView {
  readonly participantId: string;
  readonly displayName: string;
  readonly connectionState: RTCPeerConnectionState | undefined;
  /** T9 — display-only server-local group badges, snapshotted at join time (see
   * `docs/architecture/SERVER_AUTHORIZATION.md`'s known limitations: not live-updated if the
   * participant's groups change mid-session). Empty for a server with no authorization store
   * (`services/realtime`'s own no-op default). */
  readonly groups: readonly GroupBadge[];
}

/** T11 — `'reconnecting'` is a distinct state from `'disconnected'`: the underlying transport
 * closed unexpectedly and a bounded backoff retry is in progress (see
 * `docs/architecture/CLIENT_SETTINGS_AND_RECONNECT.md`). `'disconnected'` now covers both "never
 * connected yet" and "gave up retrying" (explicit disconnect, or a non-retryable failure — see
 * `state.connectionError` for which). */
export type VoiceConnectionStatus =
  'connecting' | 'authenticating' | 'connected' | 'reconnecting' | 'disconnected';

/**
 * T10 — one persistent chat thread's currently-*loaded* state (never the whole server-side
 * history — see `docs/architecture/PERSISTENT_TEXT_CHAT.md`'s "Client memory" section).
 * `messages` is always deduplicated by `messageId` and kept in ascending (oldest-first) order,
 * whether a message arrived via a history page or a live broadcast — the reconciliation this
 * requires (T10 Section 27/28: no duplicates, no reordering, regardless of arrival order) lives in
 * `mergeChatMessages` below, not scattered across each call site.
 */
export interface ChatThreadState {
  readonly messages: readonly ChatMessageView[];
  /** Whether an older page than what is currently loaded still exists on the server. */
  readonly hasMoreOlder: boolean;
  /** True while a `client:chat-history-request` for this thread is in flight — guards against a
   * second concurrent request for the same thread (e.g. a fast double-scroll). */
  readonly loading: boolean;
}

/** Exported so `tests/desktop/use-voice-channel-chat.test.ts` can unit-test this load-bearing pure
 * function directly, mirroring `RemoteMediaReconciler`'s own precedent (T3-T6) of keeping a
 * dedup/merge-shaped concern independently testable rather than relying solely on the full hook or
 * a live E2E run to exercise it. */
export function chatThreadKey(scope: ChatScope, channelId: string | undefined): string {
  return scope === 'server' ? 'server' : `channel:${channelId ?? ''}`;
}

/** Inverse of {@link chatThreadKey} — T11 uses this to remember, then re-request, whichever threads
 * were open right before an unexpected connection loss (see the main effect's `'reconnecting'`
 * handler). Round-trips correctly because a voice-channel id never contains a `:` (the existing
 * server-owned channel catalog only ever produces simple slug-shaped ids). */
export function decodeChatThreadKey(key: string): {
  scope: ChatScope;
  channelId: string | undefined;
} {
  return key === 'server'
    ? { scope: 'server', channelId: undefined }
    : { scope: 'channel', channelId: key.slice('channel:'.length) };
}

/** Merges a page of messages (older history, or one live broadcast) into an existing thread's
 * already-loaded messages — deduplicated by `messageId`, re-sorted ascending. A full re-sort on
 * every merge is simple and correct; thread sizes stay small (bounded pages, never the whole
 * history), so this is not a real performance concern (T10 Section 27/28/45). Exported for the same
 * direct-unit-test reason as {@link chatThreadKey}. */
export function mergeChatMessages(
  existing: readonly ChatMessageView[],
  incoming: readonly ChatMessageView[],
): readonly ChatMessageView[] {
  const byId = new Map<number, ChatMessageView>();
  for (const message of existing) byId.set(message.messageId, message);
  for (const message of incoming) byId.set(message.messageId, message);
  return [...byId.values()].sort((a, b) => a.messageId - b.messageId);
}

/**
 * Not-sharing/starting/sharing/error — an explicit state, not a boolean, per T5's requirement that
 * screen-share UI state be unambiguous. There is no separate transitional "stopping" state:
 * `disableScreenShare()`'s own work (`unpublishTrack` + `screen.stop()`) is synchronous from this
 * hook's point of view — same as `disableCamera()` — so a "stopping" state would have no observable
 * duration to occupy; the renegotiation that follows unpublish happens the same fire-and-forget way
 * camera's already-proven disable path does.
 */
export type ScreenSharingState = 'idle' | 'starting' | 'sharing' | 'error';

export interface VoiceChannelState {
  readonly connectionStatus: VoiceConnectionStatus;
  /** The Dedicated Server's own display metadata (T8) — `undefined` until `server:hello` arrives
   * for the current connection, and reset back to `undefined` whenever the connection closes or an
   * unexpected loss enters `'reconnecting'` (`onControllerStateChange`/`onReconnecting` in the main
   * effect below), so a leftover value can never be shown for a server the client isn't actually
   * connected to anymore. */
  readonly serverInfo: ServerInfo | undefined;
  /** T13.2 — the flat, already-visibility-filtered channel/category tree the server's `voice:catalog`
   * sends; a hidden node is simply absent, never present-but-marked-hidden (see `ChannelPort`'s own
   * privacy guarantee). Every `voice:catalog` message replaces this wholesale (never merges/patches
   * — see `packages/protocol/src/messages/channels.ts`'s doc comment), so this now updates far more
   * often than the old fixed `channels` list did (every admin mutation, every group-membership/ban
   * change that can alter what this connection may see). Components derive a real nested hierarchy
   * from this flat list via `workspace/channel-tree.ts`'s `buildChannelTree` — never duplicated
   * per-component. */
  readonly channelTree: readonly ChannelNodeView[];
  readonly currentChannelId: string | undefined;
  readonly selfParticipantId: string | undefined;
  readonly participants: readonly VoiceParticipantView[];
  /** Remote microphone audio only — see `TrackSource`. Screen-audio lives in
   * `remoteScreenAudioStreams`, never mixed into this map, even though both are
   * `track.kind === 'audio'` (T6). */
  readonly remoteAudioStreams: ReadonlyMap<string, MediaStream>;
  /** Remote camera video only — see `TrackSource`. Screen-video lives in `remoteScreenStreams`,
   * never mixed into this map, even though both are `track.kind === 'video'`. */
  readonly remoteCameraStreams: ReadonlyMap<string, MediaStream>;
  readonly remoteScreenStreams: ReadonlyMap<string, MediaStream>;
  /** Remote screen/system audio only (T6) — see `TrackSource`. Independent of
   * `remoteAudioStreams` (microphone); a participant sharing screen audio while also talking has
   * both maps populated at once, each with its own playback ownership (see `RemoteAudio.tsx`). */
  readonly remoteScreenAudioStreams: ReadonlyMap<string, MediaStream>;
  readonly muted: boolean;
  readonly deafened: boolean;
  readonly joining: boolean;
  readonly micError: string | undefined;
  /** T11 — the same captured microphone `MediaStream` published to peers, exposed here purely so
   * `SettingsPanel.tsx`'s input-level meter can tap the *live call's* microphone instead of opening
   * a second, concurrent `getUserMedia` capture — mirrors `localCameraStream`'s existing "never a
   * second capture just for local UI" rule. `undefined` whenever no microphone is currently
   * acquired (never joined yet, left, or lost — see `micDisconnected`). */
  readonly localMicrophoneStream: MediaStream | undefined;
  /** T11 Section 20 — `true` when the currently-live microphone track's actual device does not
   * match the caller's preferred `deviceId` (e.g. a previously-selected USB headset was unplugged
   * before this acquisition) — the platform silently substituted a different device (per the Media
   * Capture and Streams specification, a bare `deviceId` constraint is an `ideal`, not `exact`,
   * constraint at the top level, so `getUserMedia`/`getDisplayMedia` never reject for this; see
   * `resolveDeviceFallback`). `false` whenever no preference was set (system default was always the
   * intent) or the preferred device really was used. Never implies an error — the UI is expected to
   * show an explanatory, non-alarming notice, not `micError`. */
  readonly micUsingFallback: boolean;
  /** T11 Section 22-24 — `true` once a *live* microphone track ended unexpectedly (device unplugged
   * or otherwise revoked mid-call), as opposed to an explicit `disableCamera()`-style release. The
   * call itself is never ended by this — see `use-voice-channel.ts`'s microphone `'ended'` handler
   * doc comment for the researched reasoning on why this does not attempt automatic reacquisition.
   * Cleared back to `false` the next time a microphone is successfully (re)acquired. */
  readonly micDisconnected: boolean;
  readonly lastError: string | undefined;
  /** T11 — set only while `connectionStatus === 'reconnecting'`: which attempt (1-based) is
   * currently scheduled/in flight, for a "Reconnecting… Attempt N" style UI. `undefined` otherwise. */
  readonly reconnectAttempt: number | undefined;
  /** T11 — a human-readable reason this connect/reconnect sequence gave up and will not retry
   * further (banned, kicked, incompatible protocol, or a first attempt that never reached "open" at
   * all — see `reconnect-policy.ts`'s `describeNonRetryableClose`). `undefined` while connected,
   * connecting, or actively reconnecting; cleared the moment a new connection reaches `'open'`. */
  readonly connectionError: string | undefined;
  /** Camera is independent of microphone — see `docs/architecture/WEBRTC_CAMERA.md`. */
  readonly cameraEnabled: boolean;
  /** True while `acquireCamera()` is in flight — lets the UI disable the button so a fast
   * double-click can't start a second concurrent capture attempt on the same device. */
  readonly cameraAcquiring: boolean;
  readonly localCameraStream: MediaStream | undefined;
  readonly cameraError: string | undefined;
  /** T11 Section 20 — mirrors `micUsingFallback` exactly, for the camera's preferred `deviceId`. */
  readonly cameraUsingFallback: boolean;
  /** Screen share is a third independent source alongside microphone and camera — see
   * `docs/architecture/WEBRTC_SCREEN_SHARE.md`. */
  readonly screenSharingState: ScreenSharingState;
  readonly localScreenStream: MediaStream | undefined;
  readonly screenShareError: string | undefined;
  /** True only once the current screen share's system-audio track has actually been acquired and
   * published — distinct from "the user checked Share audio", since audio is optional and can be
   * requested but unavailable (see `docs/architecture/WEBRTC_SCREEN_AUDIO.md`). Independent of
   * `screenSharingState`: audio can end on its own (its track's own `'ended'` handler, see
   * `enableScreenShare`) while video keeps sharing. */
  readonly screenShareAudioActive: boolean;
  /** T9 — this connection's own server-local authorization snapshot (see
   * `docs/architecture/SERVER_AUTHORIZATION.md`). Empty groups/permissions until `server:hello`'s
   * companion `server:authorization-state` arrives; updated live if an admin changes them. Drives
   * which admin-panel actions the UI even offers — the server remains the authoritative check
   * regardless of what this hides/shows (T9 Section 35). */
  readonly myGroups: readonly GroupBadge[];
  readonly myPermissions: readonly PermissionKey[];
  /** The result of the most recent `listGroups()` call, or `undefined` if never requested (or the
   * connection changed since). */
  readonly groups: readonly GroupSummary[] | undefined;
  /** The result of the most recent `listBans()` call — `moderation.ban` only; see
   * `docs/architecture/SERVER_AUTHORIZATION.md`. */
  readonly bans: readonly BanSummary[] | undefined;
  /** The raw value of the most recently created token — shown to the operator exactly once, per
   * T9 Section 43-44; the server never re-sends it. Cleared on every new connection. */
  readonly lastCreatedToken:
    | {
        readonly token: string;
        readonly tokenKind: TokenKind;
        readonly groupId: string;
        readonly expiresAt: number | undefined;
      }
    | undefined;
  /** The group most recently granted via `redeemToken()` — transient success feedback for the
   * "Use Privilege Key" action. */
  readonly lastRedeemedGroup: GroupBadge | undefined;
  /** T10 — persistent server-side text chat, keyed by `chatThreadKey(scope, channelId)`. Only ever
   * contains threads the UI has actually requested via `loadChatHistory` — never preloaded for
   * every channel on connection (T10 Section 26/39, mandatory). Cleared on disconnect
   * (`onControllerStateChange`'s `'closed'` branch) *and* on an unexpected loss entering
   * `'reconnecting'` (`onReconnecting`) — the Client is never the authoritative store, so nothing
   * here survives past the connection it was loaded from (T10 Section 9/10/46). T11's
   * `onReconnected` re-requests whichever threads were open before the loss once the connection
   * recovers (see `openChatThreadsBeforeLossRef`). */
  readonly chatThreads: ReadonlyMap<string, ChatThreadState>;
  /** T13.2 — set whenever the most recent `voice:join` attempt (a real user click, or a T11
   * reconnect-restore attempt) failed with `CHANNEL_PASSWORD_REQUIRED`/`CHANNEL_PASSWORD_INVALID`,
   * so the UI can render a focused password dialog for exactly this channel. `undefined` otherwise.
   * The password itself is never stored here or anywhere else in this state — only ever passed
   * through `actions.submitChannelPassword` for one retry attempt, then discarded regardless of
   * outcome (see that action's own doc comment). */
  readonly channelPasswordPrompt: ChannelPasswordPromptState | undefined;
  /** T13.2 — a real, non-punitive notice that this connection was force-removed from a voice
   * channel by a live ACL/group-membership change (`server:voice-removed-by-policy`) — distinct
   * from `lastError` (which also covers moderation kicks/bans and ordinary request failures) so the
   * UI can render clearly different copy ("you can no longer access this channel," never "you were
   * kicked"). Cleared by `actions.dismissChannelAccessRevokedNotice` or the next successful join. */
  readonly channelAccessRevokedNotice: string | undefined;
}

/** T13.2 — see `VoiceChannelState.channelPasswordPrompt`'s own doc comment. `isRestore` is `true`
 * only when this prompt was raised by a T11 reconnect-restore join attempt (never a direct user
 * click) — `PasswordJoinDialog` renders identical UI either way, but the hook uses this internally to
 * decide whether `CHANNEL_NOT_FOUND`/`CHANNEL_ACCESS_DENIED` should silently give up instead of
 * opening this same prompt (see the main connection effect's join-error handling). */
export interface ChannelPasswordPromptState {
  readonly channelId: string;
  readonly isRestore: boolean;
  readonly submitting: boolean;
  readonly error: string | undefined;
}

/** T13.2 — thrown by every promise-returning channel-administration action
 * (`createCategory`/`updateChannel`/etc.) when the server replies with `server:error` correlated to
 * that specific request (via `replyTo`) — callers (the admin modals) can inspect `.code` to decide
 * between `channelErrorMessage(code)`'s centralized copy and a field-specific inline message (e.g.
 * `CHANNEL_PARENT_INVALID` in a parent picker), never a raw code shown to the user. */
export class ChannelRequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ChannelRequestError';
  }
}

export interface VoiceChannelActions {
  /** `password` is only meaningful against a channel with `hasPassword === true` — never cached
   * anywhere beyond this one call (see `RealtimeClient.joinVoiceChannel`'s own doc comment). */
  join(channelId: string, displayName: string, password?: string): void;
  leave(): void;
  /** T11 — stops a pending automatic-reconnect retry (T11 Section 44). A no-op unless
   * `connectionStatus === 'reconnecting'`. Does not unmount this hook/view — the caller's own
   * top-level "Disconnect" action remains the way back to server selection. */
  cancelReconnect(): void;
  setMuted(muted: boolean): void;
  setDeafened(deafened: boolean): void;
  enableCamera(): void;
  disableCamera(): void;
  /** T11 — selects a microphone device (or `null` for "system default"). If a microphone is
   * currently live (published to the mesh), acquires the new device first and only swaps it in via
   * `transport.replaceTrack` once acquisition succeeds — the old device keeps working untouched if
   * acquisition fails (T11 Section 27, mandatory atomicity). If no microphone is currently live
   * (e.g. changing the preference before ever joining voice), this only updates which device the
   * *next* acquisition (`join()`, or a reconnect's fresh reacquisition) will request — it never
   * starts a capture of its own. Does not itself persist the choice to `settings.json` — the caller
   * (`SettingsPanel.tsx`) is responsible for also calling `updateClientSettings`. */
  switchMicrophone(deviceId: string | null): void;
  /** T11 — mirrors `switchMicrophone` exactly, for the camera. Switching the preferred device while
   * the camera is off never turns it on (T4's "camera off is real off" rule) — it only updates which
   * device the next `enableCamera()` call will use. */
  switchCamera(deviceId: string | null): void;
  /** Call only after a source has already been armed via `desktopApp.selectScreenShareSource`
   * (e.g. by `ScreenSourcePicker`'s `onSourceSelected`) — this does not itself select a source, it
   * only acquires (`getDisplayMedia()`, fulfilled by whatever Main already has pending) and
   * publishes whatever that selection resolves to. `audioMode` must match what was armed via
   * `selectScreenShareSource` for this same share (see `ScreenSourcePicker`'s doc comment) — video
   * is always published; for `{ type: 'system' }` the system-audio track is published too only if
   * the platform actually supplied one (optional, never a failure of the share itself); for
   * `{ type: 'process', pid }` a separate Windows per-process/game audio capture (T12) is started
   * and its resulting track published under the same `screen-audio` semantic source once it becomes
   * available (also optional/best-effort — a failure here degrades to video-only, never fails the
   * whole share). */
  enableScreenShare(quality: ScreenQualityPreset, audioMode: ScreenShareAudioMode): void;
  disableScreenShare(): void;
  /** T9 — redeems a privilege key, invite token, or (on first-ever startup) the Server Admin
   * bootstrap token, granting its configured group to the caller's own identity. */
  redeemToken(token: string): void;
  /** Requires `authorization.tokens.manage`; the server rejects otherwise. */
  createToken(tokenKind: TokenKind, groupId: string, expiresInMs?: number): void;
  listGroups(): void;
  createGroup(name: string, permissions: readonly PermissionKey[]): void;
  updateGroup(groupId: string, name?: string, permissions?: readonly PermissionKey[]): void;
  deleteGroup(groupId: string): void;
  /** `targetParticipantId` — never a client-supplied identityId (T9 Section 37). */
  grantGroup(targetParticipantId: string, groupId: string): void;
  revokeGroup(targetParticipantId: string, groupId: string): void;
  kick(targetParticipantId: string): void;
  ban(targetParticipantId: string, durationMs?: number, reason?: string): void;
  unban(identityId: string): void;
  listBans(): void;
  /** T10 — sends a chat message. `channelId` is required for `scope: 'channel'`, ignored/omitted
   * for `scope: 'server'`. The server derives the sender itself; nothing here can spoof it. */
  sendChatMessage(scope: ChatScope, channelId: string | undefined, body: string): void;
  /** T10 — loads the initial (most recent) page for a thread not yet loaded, or the next older
   * page if it is already partially loaded — one action covers both "open this chat" and "scroll
   * up for more" (T10 Section 25/26/68). A no-op if a request for this exact thread is already in
   * flight, or if the thread is already known to have no older messages left. */
  loadChatHistory(scope: ChatScope, channelId: string | undefined): void;

  // --- T13.2 channel/category tree administration ---------------------------------------------
  // Unlike the T9/T10 fire-and-forget actions above, each of these returns a Promise so an admin
  // modal can `await` it and show a field-specific inline error (e.g. `CHANNEL_PARENT_INVALID` in
  // a parent picker) instead of only a generic global toast — rejects with `ChannelRequestError`
  // when the server replies with `server:error` correlated (via `replyTo`) to this specific
  // request. The server remains the sole authority on whether any of these succeed.

  createCategory(name: string, parentId?: string): Promise<ChannelNodeAdminView>;
  createVoiceChannel(
    name: string,
    parentId?: string,
    temporary?: boolean,
  ): Promise<ChannelNodeAdminView>;
  updateChannel(nodeId: string, patch: ChannelUpdatePatch): Promise<void>;
  moveChannel(nodeId: string, newParentId: string | undefined): Promise<void>;
  reorderChannels(parentId: string | undefined, orderedNodeIds: readonly string[]): Promise<void>;
  deleteChannel(nodeId: string): Promise<void>;
  setChannelPassword(nodeId: string, password: string): Promise<void>;
  removeChannelPassword(nodeId: string): Promise<void>;
  getEditableChannelNode(nodeId: string): Promise<ChannelNodeAdminView>;

  /** Retries the join that raised `state.channelPasswordPrompt`, supplying `password` this time.
   * A wrong password re-opens the same prompt with an inline error (never silently closes); never
   * persists the password anywhere beyond this one call. A no-op if no prompt is currently open. */
  submitChannelPassword(password: string): void;
  /** Closes `state.channelPasswordPrompt` without retrying — for a user-initiated join, this simply
   * abandons the attempt; for a T11 reconnect-restore prompt, the remembered channel is also
   * forgotten (mirrors an explicit `leave()`, since the user chose not to complete the rejoin). */
  dismissChannelPasswordPrompt(): void;
  /** Clears `state.channelAccessRevokedNotice` once the user has seen it. */
  dismissChannelAccessRevokedNotice(): void;
}

/**
 * `IceCandidatePayload` (zod-inferred) types its optional fields as `T | null | undefined`, while
 * the platform's `RTCIceCandidateInit` types them as `T | null` (no explicit `undefined` in the
 * union) — under `exactOptionalPropertyTypes`, only omitting the key entirely (not assigning
 * `undefined` to it) satisfies that. `null` is a distinct, meaningful value (end-of-candidates
 * hint) and is always passed through.
 */
/**
 * T11 Section 20 — determines whether the platform silently substituted a different device than
 * the one preferred, by comparing the preference against the *actually acquired* track's own
 * `MediaStreamTrack.getSettings().deviceId` — read back after the fact, not inferred from whether
 * `getUserMedia`/`getDisplayMedia` threw. This is deliberate: per the Media Capture and Streams
 * specification, a bare (non-`exact`/`ideal`-wrapped) `deviceId` constraint at the top level of a
 * constraints object is an *ideal*, not exact, constraint — `packages/media-core`'s
 * `acquireMicrophone`/`acquireCamera` pass `deviceId` this way (see those modules' own doc
 * comments), so requesting an unplugged/nonexistent device does not throw an `OverconstrainedError`
 * at all; the platform just substitutes a different device and resolves normally. Comparing the
 * resolved track's own `deviceId` after the fact is therefore the only reliable way to detect this,
 * and it uniformly covers every reason a substitution could happen (device removed, device busy,
 * permission narrowed), not just "device id literally absent from the last enumeration."
 *
 * `preferredDeviceId === null` ("no preference, use system default") never counts as a fallback —
 * whatever device the platform picked *is* the intended one in that case.
 */
export function resolveDeviceFallback(
  preferredDeviceId: string | null,
  actualDeviceId: string | undefined,
): boolean {
  if (preferredDeviceId === null) return false;
  return actualDeviceId !== preferredDeviceId;
}

/**
 * Builds a `{ deviceId }`-shaped fragment for `acquireMicrophone`/`acquireCamera` without ever
 * assigning an explicit `undefined` to `deviceId` — required because `MicrophoneConstraints`/
 * `CameraConstraints` type `deviceId` as optional (`deviceId?: string`), and this project's
 * `exactOptionalPropertyTypes: true` distinguishes "the key is absent" from "the key is present
 * with value `undefined`"; only the former is assignable to an optional (`?:`) property. `null`
 * ("use the system default", this app's own device-preference model — see `settings-file.ts`) maps
 * to omitting the key entirely, letting `acquireMicrophone`/`acquireCamera` fall back to their own
 * unconstrained defaults exactly as if no preference had ever been set.
 */
export function deviceIdConstraint(preferredDeviceId: string | null): {
  readonly deviceId?: string;
} {
  return preferredDeviceId === null ? {} : { deviceId: preferredDeviceId };
}

function toRtcIceCandidateInit(payload: IceCandidatePayload | null): RTCIceCandidateInit | null {
  if (payload === null) return null;
  const init: RTCIceCandidateInit = { candidate: payload.candidate };
  if (payload.sdpMid !== undefined) init.sdpMid = payload.sdpMid;
  if (payload.sdpMLineIndex !== undefined) init.sdpMLineIndex = payload.sdpMLineIndex;
  if (payload.usernameFragment !== undefined) init.usernameFragment = payload.usernameFragment;
  return init;
}

const INITIAL_STATE: VoiceChannelState = {
  connectionStatus: 'connecting',
  serverInfo: undefined,
  channelTree: [],
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
};

/**
 * Owns one realtime connection plus one P2P mesh transport for the lifetime this hook is mounted,
 * and translates T3's voice/signaling wire events into semantic participants and remote media
 * streams for the UI — per ADR 0006, the UI never sees peer connections directly. Offer/answer
 * ownership follows T3's deterministic rule: participants present when *we* join are added as
 * `'responder'` (they own the offer toward us); a participant who joins *our* already-open channel
 * is added as `'initiator'` (we own the offer toward them).
 */
/** T9 — `serverToken` is optional connect-time-only state (an invite-only server's admission
 * credential, or the bootstrap token) — never part of `DesktopRealtimeConfig` itself, since that
 * type is also the IPC-shared deployment default and this value must never be persisted/reused
 * across a later reconnect (T9 Section 72: cleared after one connection attempt). */
export interface VoiceChannelConnectionConfig extends DesktopRealtimeConfig {
  readonly serverToken?: string;
}

export function useVoiceChannel(
  realtimeConfig: VoiceChannelConnectionConfig | undefined,
): readonly [VoiceChannelState, VoiceChannelActions] {
  const [state, setState] = useState<VoiceChannelState>(INITIAL_STATE);

  const clientRef = useRef<RealtimeClient | undefined>(undefined);
  const controllerRef = useRef<ReconnectController | undefined>(undefined);
  const transportRef = useRef<P2PMeshTransport | undefined>(undefined);
  /** T11 — the channel/displayName the user most recently asked to join, set at the top of `join()`
   * (not only on confirmed success — a join that was in-flight when the connection dropped is still
   * worth restoring after reconnect) and cleared only by an explicit `leave()` (T11 Section 49: a
   * deliberate leave must never be "restored" later). Survives an unexpected connection loss/retry
   * cycle untouched — that is the whole point, see the main effect's `'reconnecting'`/`'reconnected'`
   * handlers below. Reset alongside every other per-connection ref at the top of the main effect. */
  const currentChannelRef = useRef<{ channelId: string; displayName: string } | undefined>(
    undefined,
  );
  /** T11 — a stable ref to the latest `join` action, so the main effect's `'reconnected'` handler
   * can call it without needing `join` (declared later in this function, via `useCallback`) in its
   * own dependency/closure chain. */
  const joinRef = useRef<
    | ((channelId: string, displayName: string, password?: string, isRestore?: boolean) => void)
    | undefined
  >(undefined);
  /** T11 — which chat threads were loaded right before the most recent unexpected connection loss,
   * so `'reconnected'` can re-request exactly those from the server (never trusting anything left in
   * memory — T10's own "never the authoritative store" rule applies here too). Populated by the
   * `'reconnecting'` handler, drained by `'reconnected'`. */
  const openChatThreadsBeforeLossRef = useRef<
    readonly { readonly scope: ChatScope; readonly channelId: string | undefined }[]
  >([]);
  const microphoneRef = useRef<Microphone | undefined>(undefined);
  const mutedRef = useRef(false);
  // T11 — mirrors `cameraGenerationRef`/`cameraAcquiringRef` exactly, shared by `join()`'s initial
  // microphone acquisition and `switchMicrophone`'s live-replace acquisition, so the two can never
  // race each other (a `switchMicrophone` call landing while `join()`'s own acquisition is still in
  // flight, or a fast double-click on the device dropdown, is detected as stale the same way a
  // stale `enableCamera()` resolution already is).
  const microphoneGenerationRef = useRef(0);
  const microphoneAcquiringRef = useRef(false);
  /** T11 — the currently-preferred microphone/camera `deviceId` (`null` = system default),
   * mirroring `settings.json`'s `audio.inputDeviceId`/`video.cameraDeviceId`. Seeded once from
   * `getClientSettings()` at hook mount (see the settings-load effect below) and updated
   * immediately by `switchMicrophone`/`switchCamera` — read by every acquisition site (`join()`,
   * `enableCamera()`, a reconnect's fresh reacquisition) so a later acquisition always requests
   * whatever the user most recently chose, without needing to re-read settings from disk each time. */
  const preferredMicDeviceIdRef = useRef<string | null>(null);
  const preferredCameraDeviceIdRef = useRef<string | null>(null);
  const cameraRef = useRef<Camera | undefined>(undefined);
  // Bumped on every enable/disable so a `getUserMedia` call that resolves after the user (or a
  // channel leave/unmount) has already moved on can detect it is stale — see the T3 microphone
  // late-acquisition race this mirrors, in `join()` below.
  const cameraGenerationRef = useRef(0);
  // True for the duration of one `acquireCamera()` call — blocks a second concurrent call (see
  // `enableCamera` for the double-click race this closes).
  const cameraAcquiringRef = useRef(false);
  const screenRef = useRef<Screen | undefined>(undefined);
  // Same late-acquisition-race and double-click protections as camera's, mirrored exactly for
  // `getDisplayMedia()` — see `enableScreenShare`.
  const screenGenerationRef = useRef(0);
  const screenAcquiringRef = useRef(false);
  /**
   * T12 — the currently-live Windows per-process/game audio track (via `packages/windows-media`'s
   * native process-loopback capture, bridged through `MessageChannelMain` — see
   * `apps/desktop/src/renderer/media/process-audio-bridge.ts`), present only when the active screen
   * share's audio mode is `{ type: 'process' }`. Entirely independent of `screenRef.current?.audioTrack`
   * (T6 system audio) — the two are mutually exclusive per share (`ScreenSourcePicker`'s radio
   * choice), but kept as a separate ref/publish call rather than unified onto `Screen`, since
   * process-audio capture is this app's own Electron-specific session (Main's own
   * `ProcessLoopbackSupervisor` instance), not part of `@disco-voador/media-core`'s platform-
   * `getDisplayMedia`-based `Screen` abstraction.
   */
  const processAudioTrackRef = useRef<ProcessAudioTrack | undefined>(undefined);
  /** T12 — the Main-process session id from the most recent successful `startProcessAudioCapture`;
   * used only to ignore a stale `onProcessAudioEnded` push notification for a session this hook has
   * already released or superseded (see the notification listener registered in the main connection
   * effect below). */
  const processAudioSessionIdRef = useRef<number | undefined>(undefined);

  /**
   * T12 — releases the currently-live process-audio track (if any): unpublishes it, stops the
   * synthesized `MediaStreamTrack`, and tells Main to stop the underlying native capture. Hoisted to
   * hook level (like `disableScreenShare` itself) rather than declared inside the main connection
   * effect (unlike `releaseMicrophone`/`releaseCamera`/`releaseScreen`), because both the effect's
   * own handlers (`onReconnecting`/`onLeft`/`releaseScreen`) and the standalone `enableScreenShare`/
   * `disableScreenShare` callbacks need to call it, and only refs (stable across renders) are
   * involved, so a single stable `useCallback` safely serves every call site.
   */
  const releaseProcessAudioTrack = useCallback((): void => {
    const processAudioTrack = processAudioTrackRef.current;
    if (!processAudioTrack) return;
    processAudioTrackRef.current = undefined;
    processAudioSessionIdRef.current = undefined;
    transportRef.current?.unpublishTrack(processAudioTrack.track);
    processAudioTrack.stop();
    window.desktopApp.stopProcessAudioCapture().catch((error: unknown) => {
      console.error('voice: failed to stop process-audio capture', error);
    });
  }, []);
  /** T10 — correlates an in-flight `client:chat-history-request` back to which thread it was for,
   * since `server:chat-history-page` itself carries no scope/channelId (correlation is via `id`
   * alone — see `packages/protocol/src/messages/chat.ts`). Reset (implicitly abandoned) on every
   * reconnect, matching every other per-connection ref in this hook. */
  const pendingChatHistoryRequestsRef = useRef(
    new Map<string, { readonly scope: ChatScope; readonly channelId: string | undefined }>(),
  );
  /** T10 — mirrors `state.chatThreads`, kept in sync everywhere `chatThreads` is set. `loadChatHistory`
   * (a stable `useCallback`) needs to read the *current* thread synchronously to decide the request
   * cursor and guard against a duplicate in-flight request — the same "ref is the source of truth
   * for imperative decisions, state mirrors it for render" split `cameraRef`/`screenRef` already use
   * elsewhere in this hook, applied here because `chatThreads` otherwise has no dedicated ref. */
  const chatThreadsRef = useRef<ReadonlyMap<string, ChatThreadState>>(new Map());

  /** T13.2 — correlates a `client:channel-*` administration request's generated id back to the
   * Promise an admin modal is awaiting (see `VoiceChannelActions`'s own doc comment on why these
   * are Promise-returning, unlike the T9/T10 fire-and-forget actions above). Resolved by
   * `onChannelCreated`/`onChannelAck`/`onChannelEditableNode`; rejected (with a `ChannelRequestError`)
   * by `onServerError` when a `server:error`'s `replyTo` matches a still-pending entry. */
  const pendingChannelRequestsRef = useRef(
    new Map<
      string,
      {
        readonly resolve: (node?: ChannelNodeAdminView) => void;
        readonly reject: (error: Error) => void;
      }
    >(),
  );
  /** T13.2 — the most recent in-flight `voice:join` request this hook itself issued (a real user
   * click, or a T11 reconnect-restore attempt) — `onServerError` reads this to decide whether a
   * `CHANNEL_*` rejection should open `channelPasswordPrompt`, silently abandon a background
   * restore, or surface an ordinary `lastError` toast. Cleared once that specific request's
   * success/failure has been observed (`onJoined`/`onServerError`), never left stale across a
   * later, unrelated join. */
  const lastJoinRequestRef = useRef<
    { readonly id: string; readonly channelId: string; readonly isRestore: boolean } | undefined
  >(undefined);

  /**
   * T11 — loads persisted device/mute-on-launch preferences exactly once, at hook mount, per the
   * task's own "read settings once at hook-mount time for this — don't overengineer a live-sync
   * mechanism" guidance. Deliberately independent of the `realtimeConfig` effect below (empty
   * dependency array): device/mute preferences are meaningful even before a server address is known
   * and must not reload on every reconnect (a reconnect never remounts this hook — `realtimeConfig`
   * does not change during one — so this could not clobber a mid-session mute toggle even if it
   * somehow re-ran, but keeping it strictly mount-only is simpler to reason about regardless).
   * `mutedRef.current` is set synchronously alongside `setState` so a `join()` call that races this
   * load (a very fast user) still applies whatever preference wins the race consistently between the
   * ref (used to mute a freshly-acquired microphone) and the rendered `state.muted`.
   */
  useEffect(() => {
    let cancelled = false;
    window.desktopApp
      .getClientSettings()
      .then((settings) => {
        if (cancelled) return;
        preferredMicDeviceIdRef.current = settings.audio.inputDeviceId;
        preferredCameraDeviceIdRef.current = settings.video.cameraDeviceId;
        mutedRef.current = settings.voice.startMuted;
        setState((prev) => ({
          ...prev,
          muted: settings.voice.startMuted,
          deafened: settings.voice.startDeafened,
        }));
      })
      .catch((error: unknown) => {
        console.error('voice: failed to load persisted client settings', error);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!realtimeConfig) return undefined;
    // Captured as local consts, not read via `realtimeConfig.xxx` inline, so TypeScript's
    // undefined-narrowing from the guard above still holds inside nested function *declarations*
    // further down this effect (e.g. `recreateTransport`) — narrowing a closed-over parameter does
    // not otherwise propagate into a separately-declared nested function.
    const { url, iceServers, serverToken } = realtimeConfig;

    // T10 — a fresh connection starts with no outstanding chat-history requests; any left over
    // from a previous connection are meaningless (their responses, if they ever arrived, would be
    // ignored anyway since this hook only listens on the *current* client instance).
    pendingChatHistoryRequestsRef.current = new Map();
    chatThreadsRef.current = new Map();
    openChatThreadsBeforeLossRef.current = [];
    currentChannelRef.current = undefined;
    // T13.2 — mirrors the chat-history reset immediately above: a fresh connection starts with no
    // outstanding channel-admin requests or in-flight join to correlate against.
    pendingChannelRequestsRef.current = new Map();
    lastJoinRequestRef.current = undefined;

    // T11 — the controller owns exactly one `RealtimeClient` for this whole connection sequence,
    // including every automatic reconnect attempt (see `reconnect-controller.ts`'s doc comment for
    // why it is a wrapper, not new `RealtimeClient` states) — `client` itself never changes across a
    // reconnect, so every listener registered on it below stays valid without re-subscribing.
    const controller = new ReconnectController(url, new IpcIdentitySigner(), serverToken);
    const client = controller.client;
    controllerRef.current = controller;
    clientRef.current = client;

    // `transport`, unlike `client`, genuinely cannot survive a reconnect: `P2PMeshTransport.closeAll()`
    // permanently disables an instance (see the effect cleanup's own comment below), and every P2P
    // peer connection is unrecoverable once its signaling channel (this WebSocket) is gone anyway —
    // a fresh session needs a fresh mesh. `let`, not `const`, specifically so `recreateTransport()`
    // (used by the `'reconnecting'` handler further down) can reassign it in place; every closure
    // below that references `transport` automatically observes the new instance on its next call,
    // since a closure captures the *binding*, not a value snapshot — no other changes are needed for
    // `onJoined`/`onLeft`/`onParticipantJoined`/`onParticipantLeft`/`onWebrtcOffer`/`onWebrtcAnswer`/
    // `onWebrtcIceCandidate`/`releaseMicrophone`/`releaseCamera`/`releaseScreen` to keep working
    // correctly across a transport recreation.
    let transport = new P2PMeshTransport({ iceServers }, client);
    transportRef.current = transport;

    // Tracked outside React state: drives transport add/remove calls, which must never happen
    // twice for the same participant id and must not depend on React's render/commit timing.
    let currentParticipantIds = new Set<string>();

    // T5 introduced this reconciliation for video (camera vs. screen-video); T6 extends it to
    // audio (microphone vs. screen-audio) for the identical reason. `media:track-source` (announced
    // by `onLocalTrackMid` below, once `rtc-core` reports a local track's negotiated `mid` for a
    // specific peer) and `ontrack` (the transport's `remoteTrack` event, itself carrying the
    // *remote* side's view of that same mid) arrive independently and in no guaranteed order
    // relative to each other, for every source kind. Neither side is ever inferred (e.g. "no
    // announcement yet, so assume camera/microphone") — see
    // `docs/architecture/WEBRTC_SCREEN_SHARE.md`'s "Media source identity" and
    // `docs/architecture/WEBRTC_SCREEN_AUDIO.md`'s "Media identity" sections. The full reconciler
    // (pending/wired/source-by-key bookkeeping, mid-reuse handling, the two real bugs this exact
    // logic has already produced and their fixes) lives in `remote-media-reconciliation.ts` — kept
    // as a plain, React-free class specifically so it has direct unit test coverage instead of
    // relying solely on a live two-instance E2E run. Reset on every reconnect/rejoin (`onJoined`/
    // `onLeft` below), matching `currentParticipantIds`.
    const reconciler = new RemoteMediaReconciler({
      updateStreams: (updater) => {
        setState((prev) => ({ ...prev, ...updater(prev) }));
      },
      onMissingAnnouncement: (participantId, mid, kind) => {
        console.error(
          `voice: no media:track-source announcement arrived for a remote ${kind} track`,
          {
            participantId,
            mid,
          },
        );
      },
    });

    function releaseMicrophone(): void {
      const microphone = microphoneRef.current;
      if (!microphone) return;
      transport.unpublishTrack(microphone.track);
      // `MediaStreamTrack.stop()` never fires `'ended'` per spec (only an unexpected platform-side
      // stop does — see the `'ended'` listener attached at each acquisition site below), so this
      // ordering can never be mistaken for an unexpected loss regardless of the ref-clear position.
      microphone.stop();
      microphoneRef.current = undefined;
      setState((prev) => ({
        ...prev,
        localMicrophoneStream: undefined,
        micUsingFallback: false,
        micDisconnected: false,
      }));
    }

    /** Unlike microphone mute, camera OFF always fully stops the device (see task section on
     * camera-mute-vs-stop) — this is the single place that happens, called from `disableCamera()`
     * (user-driven), `onLeft` (voice left), and this effect's own cleanup (unmount/reconnect). */
    function releaseCamera(): void {
      cameraGenerationRef.current += 1;
      const camera = cameraRef.current;
      if (!camera) return;
      transport.unpublishTrack(camera.track);
      camera.stop();
      cameraRef.current = undefined;
      setState((prev) => ({ ...prev, cameraUsingFallback: false }));
    }

    /** Mirrors `releaseCamera()` exactly — screen share off always fully releases capture too.
     * T12: also releases a live process-audio track (see `releaseProcessAudioTrack`'s own doc
     * comment) — every caller of `releaseScreen()` (`onReconnecting`, `onLeft`) must release
     * process-audio the same way it releases system audio, since the two are mutually exclusive
     * per share but otherwise follow the identical lifecycle. */
    function releaseScreen(): void {
      screenGenerationRef.current += 1;
      const screen = screenRef.current;
      screenRef.current = undefined;
      if (screen) releasePublishedScreen(transport, screen);
      releaseProcessAudioTrack();
    }

    /** T11 — replaces the (now-dead) transport with a fresh one, for an automatic-reconnect cycle.
     * See the `let transport` declaration's own comment above for why every other closure in this
     * effect keeps working unchanged after this reassignment. */
    function recreateTransport(): void {
      transport.off('remoteTrack', onRemoteTrack);
      transport.off('localTrackMid', onLocalTrackMid);
      transport.off('peerStateChanged', onPeerStateChanged);
      transport.closeAll();

      transport = new P2PMeshTransport({ iceServers }, client);
      transportRef.current = transport;

      transport.on('remoteTrack', onRemoteTrack);
      transport.on('localTrackMid', onLocalTrackMid);
      transport.on('peerStateChanged', onPeerStateChanged);
    }

    /** T11 — issues a fresh (first-page) history request for one thread, used both by
     * `loadChatHistory` semantics on a normal open and by the `'reconnected'` handler restoring
     * whichever threads were loaded before the loss. Kept local to this effect (rather than reusing
     * the `loadChatHistory` action defined later in this hook) so it never depends on declaration
     * order across the two — this closure only ever runs asynchronously, after the whole hook body
     * has finished its current render pass, but keeping it self-contained here is simpler to reason
     * about than relying on that. */
    function requestInitialChatHistory(scope: ChatScope, channelId: string | undefined): void {
      const key = chatThreadKey(scope, channelId);
      const requestId = client.requestChatHistory(scope, channelId);
      pendingChatHistoryRequestsRef.current.set(requestId, { scope, channelId });
      const next = new Map(chatThreadsRef.current);
      next.set(key, { messages: [], hasMoreOlder: false, loading: true });
      chatThreadsRef.current = next;
      setState((prev) => ({ ...prev, chatThreads: next }));
    }

    /** Ordinary `'connecting'`/`'authenticating'`/`'open'`/`'closed'` transitions — `'reconnecting'`
     * is deliberately handled by its own dedicated listener below (registered via
     * `controller.on('reconnecting', ...)`), which needs to do real cleanup work, not just update
     * `connectionStatus`; this handler explicitly no-ops for it rather than racing that one. */
    const onControllerStateChange = (connectionState: ReconnectingConnectionState) => {
      if (connectionState === 'reconnecting') return;

      if (connectionState === 'closed') {
        // Final for this sequence — either an explicit disconnect, or `connectionFailed` already
        // decided not to retry further. T10 — the Client is never the authoritative chat store
        // (Section 9/10); nothing loaded from this connection carries into whatever connects next.
        chatThreadsRef.current = new Map();
        pendingChatHistoryRequestsRef.current = new Map();
        openChatThreadsBeforeLossRef.current = [];
        // T13.2 — an admin modal awaiting one of these would otherwise hang forever once the
        // connection it was sent on is gone for good; reject cleanly instead of leaving it pending.
        for (const pending of pendingChannelRequestsRef.current.values()) {
          pending.reject(new Error('Disconnected before the server replied.'));
        }
        pendingChannelRequestsRef.current = new Map();
        lastJoinRequestRef.current = undefined;
      }

      const connectionStatus: VoiceConnectionStatus =
        connectionState === 'open'
          ? 'connected'
          : connectionState === 'connecting' || connectionState === 'authenticating'
            ? connectionState
            : 'disconnected';
      // Public data only (an application-level status word, never message/identity content) — used
      // by `apps/desktop/scripts/e2e-reconnect-smoke.mjs` to observe the connect -> (unexpected
      // loss) -> reconnecting -> connected-again sequence without depending on UI rendering, the
      // same convention every other `disco-voador:*` diagnostic marker in this file already uses.
      console.info(`disco-voador:connection-status:${connectionStatus}`);

      setState((prev) => ({
        ...prev,
        connectionStatus,
        reconnectAttempt: undefined,
        ...(connectionState === 'open' ? { connectionError: undefined } : {}),
        ...(connectionState === 'closed'
          ? {
              serverInfo: undefined,
              myGroups: [],
              myPermissions: [],
              groups: undefined,
              bans: undefined,
              lastCreatedToken: undefined,
              lastRedeemedGroup: undefined,
              chatThreads: chatThreadsRef.current,
            }
          : {}),
      }));
    };

    /**
     * An unexpected loss of an already-established session — the underlying transport just closed
     * and a bounded backoff retry has just been scheduled (T11 Section 39-42). Everything from the
     * dead session is torn down or released *now*, not lazily: old P2P peer connections can never
     * recover across a new WebSocket, and privacy-sensitive sources (camera, screen) must never
     * silently keep running (let alone auto-restart later) once the session they were published to
     * is gone (T11 Section 51-53, mandatory).
     */
    const onReconnecting = (event: ReconnectingEvent) => {
      for (const id of currentParticipantIds) transport.removeParticipant(id);
      currentParticipantIds = new Set();
      reconciler.reset();

      // Privacy-sensitive, mandatory: camera and screen video/audio must never auto-restart after a
      // reconnect (T11 Section 51/52) — released here, alongside the dead mesh, never lazily
      // restored by `'reconnected'` below. Microphone is released too; `join()`'s own restoration
      // path (below) reacquires it fresh, the same "acquire on demand" model every other source in
      // this hook already uses, rather than holding a live capture with nothing to publish it to in
      // the meantime.
      releaseCamera();
      releaseScreen();
      releaseMicrophone();

      recreateTransport();

      // T10 — remember which chat threads were loaded so `'reconnected'` can re-request exactly
      // those from the server; nothing here is trusted, only the *list of what to ask for again*.
      openChatThreadsBeforeLossRef.current = [...chatThreadsRef.current.keys()].map(
        decodeChatThreadKey,
      );
      chatThreadsRef.current = new Map();
      pendingChatHistoryRequestsRef.current = new Map();
      // T13.2 — a request sent on the now-dead socket will never get a reply; reject rather than
      // leave an admin modal awaiting it hanging until some unrelated later request happens to
      // reuse the same id space. `currentChannelRef` (the restore target) is deliberately left
      // untouched — only the dead request bookkeeping is cleared here.
      for (const pending of pendingChannelRequestsRef.current.values()) {
        pending.reject(new Error('Connection lost before the server replied.'));
      }
      pendingChannelRequestsRef.current = new Map();
      lastJoinRequestRef.current = undefined;

      // Public data only — see `onControllerStateChange`'s identical marker for the full
      // conventions this follows.
      console.info(`disco-voador:connection-status:reconnecting`);

      setState((prev) => ({
        ...prev,
        connectionStatus: 'reconnecting',
        reconnectAttempt: event.attempt,
        connectionError: undefined,
        // A password prompt tied to the now-dead connection is stale — if the restore attempt
        // below hits `CHANNEL_PASSWORD_REQUIRED` again once reconnected, it reopens fresh.
        channelPasswordPrompt: undefined,
        currentChannelId: undefined,
        selfParticipantId: undefined,
        participants: [],
        ...createEmptyRemoteMediaStreamsState(),
        joining: false,
        cameraEnabled: false,
        localCameraStream: undefined,
        screenSharingState: 'idle',
        localScreenStream: undefined,
        screenShareAudioActive: false,
        serverInfo: undefined,
        myGroups: [],
        myPermissions: [],
        groups: undefined,
        bans: undefined,
        lastCreatedToken: undefined,
        lastRedeemedGroup: undefined,
        chatThreads: chatThreadsRef.current,
      }));
    };

    /**
     * A reconnect attempt just reached `'open'` again — fresh T7 identity authentication already
     * happened (the same handshake every connection goes through; see `RealtimeClient.connect()`),
     * and `onControllerStateChange` above already flipped `connectionStatus` to `'connected'`. This
     * handler restores what T11 says *should* survive an unexpected loss: the previously-joined
     * voice channel (which itself re-applies the current mute state — see `join()`) and whichever
     * chat threads were open. Camera and screen are deliberately *not* restored here (see
     * `onReconnecting` above).
     */
    const onReconnected = () => {
      const restore = currentChannelRef.current;
      // T13.2 — `isRestore: true` so `onServerError` can tell a background reconciliation attempt
      // apart from a real user click when this specific request fails (see that handler's own doc
      // comment for the three-way CHANNEL_NOT_FOUND/CHANNEL_ACCESS_DENIED/CHANNEL_PASSWORD_REQUIRED
      // handling this enables).
      if (restore) joinRef.current?.(restore.channelId, restore.displayName, undefined, true);

      for (const { scope, channelId } of openChatThreadsBeforeLossRef.current) {
        requestInitialChatHistory(scope, channelId);
      }
      openChatThreadsBeforeLossRef.current = [];
    };

    const onConnectionFailed = (event: ConnectionFailedEvent) => {
      setState((prev) => ({
        ...prev,
        connectionError:
          describeNonRetryableClose(event.code) ?? 'Could not connect to the server.',
      }));
    };

    const onServerInfo = (info: ServerInfo) => {
      setState((prev) => ({ ...prev, serverInfo: info }));
      // Public data only — used by the T8 connection-smoke E2E script to confirm the client
      // actually rendered the Dedicated Server's own name, not a stale/default value. See
      // `apps/desktop/scripts/e2e-connection-smoke.mjs`.
      console.info(`disco-voador:server-name:${info.serverName}`);
    };

    // T13.2 — every `voice:catalog` replaces the tree wholesale (never merges/patches — see
    // `ServerVoiceCatalogMessage`'s own doc comment), and now arrives far more often than the old
    // fixed catalog did (every admin mutation, every group-membership/ban change that can alter
    // what this connection may see or join), not only once at connect.
    const onCatalog = (message: ServerVoiceCatalogMessage) => {
      setState((prev) => ({ ...prev, channelTree: message.nodes }));
      // T13.2 E2E hook only — public data already sent to this connection over the wire (never a
      // secret; `channelNodeSchema` itself already omits `visibilityGroupIds`/`joinGroupIds`/
      // `manageGroupIds`/the password verifier). Added specifically for
      // `apps/desktop/scripts/e2e-channel-admin-smoke.mjs`, which otherwise has no way to observe
      // this connection's *actual received* channel tree (id/name/parentId) without scraping the
      // DOM — mirrors `disco-voador:my-groups:...`'s existing "log the small, already-public,
      // already-received wire payload as a diagnostic marker" convention exactly. Emits the whole
      // tree (not just ids) because this script also needs to observe a live rename/reparent of an
      // already-visible node, which a bare id list could never reveal.
      console.info(
        `disco-voador:voice-catalog-nodes:${JSON.stringify(
          message.nodes.map((node) => ({
            nodeId: node.nodeId,
            name: node.name,
            parentId: node.parentId,
          })),
        )}`,
      );
    };

    const onJoined = (message: ServerVoiceJoinedMessage) => {
      for (const id of currentParticipantIds) transport.removeParticipant(id);
      currentParticipantIds = new Set(message.participants.map((p) => p.participantId));
      reconciler.reset();
      for (const participant of message.participants) {
        transport.addParticipant(participant.participantId, 'responder');
      }

      // Public data only (a channel id, never participant/identity content) — fires for both an
      // ordinary join and a post-reconnect restoration join (T11 Section 48), so
      // `e2e-reconnect-smoke.mjs` can observe the same channel being (re)joined a second time after
      // a `disco-voador:connection-status:reconnecting` marker, without depending on UI rendering.
      console.info(`disco-voador:voice-joined:${message.channelId}`);

      setState((prev) => ({
        ...prev,
        currentChannelId: message.channelId,
        selfParticipantId: message.participantId,
        participants: message.participants.map((p) => ({
          participantId: p.participantId,
          displayName: p.displayName,
          connectionState: undefined,
          groups: p.groups ?? [],
        })),
        ...createEmptyRemoteMediaStreamsState(),
        joining: false,
        lastError: undefined,
      }));
    };

    const onLeft = () => {
      for (const id of currentParticipantIds) transport.removeParticipant(id);
      currentParticipantIds = new Set();
      reconciler.reset();
      releaseMicrophone();
      releaseCamera();
      releaseScreen();

      setState((prev) => ({
        ...prev,
        currentChannelId: undefined,
        selfParticipantId: undefined,
        participants: [],
        ...createEmptyRemoteMediaStreamsState(),
        cameraEnabled: false,
        localCameraStream: undefined,
        screenSharingState: 'idle',
        localScreenStream: undefined,
        screenShareAudioActive: false,
      }));
    };

    // T13.2 — mirrors `onLeft`'s cleanup exactly (this connection's voice membership just ended,
    // server-side, same as any ordinary leave). The one difference: this was never initiated by
    // the client's own `leave()` action, so the T11 reconnect-restore target must be forgotten here
    // too (never silently restored into a channel whose access was just revoked), and the reason is
    // surfaced via `channelAccessRevokedNotice` — distinct from `lastError` (which also covers
    // moderation kicks/bans and ordinary request failures) — so the UI can show accurate,
    // non-punitive copy ("you can no longer access this channel," never "you were kicked").
    const onVoiceRemovedByPolicy = (message: ServerVoiceRemovedByPolicyMessage) => {
      currentChannelRef.current = undefined;
      for (const id of currentParticipantIds) transport.removeParticipant(id);
      currentParticipantIds = new Set();
      reconciler.reset();
      releaseMicrophone();
      releaseCamera();
      releaseScreen();

      setState((prev) => ({
        ...prev,
        currentChannelId: undefined,
        selfParticipantId: undefined,
        participants: [],
        ...createEmptyRemoteMediaStreamsState(),
        cameraEnabled: false,
        localCameraStream: undefined,
        screenSharingState: 'idle',
        localScreenStream: undefined,
        screenShareAudioActive: false,
        channelAccessRevokedNotice: 'You can no longer access this channel.',
      }));
      // Public data only (a channel id, never identity/membership content) — lets a future E2E
      // observe this specific, non-punitive removal path without depending on UI text rendering,
      // matching `onJoined`'s own `disco-voador:voice-joined:...` marker convention.
      console.info(`disco-voador:voice-removed-by-policy:${message.channelId}`);
    };

    // --- T13.2 channel/category tree administration replies ----------------------------------
    // Each resolves the Promise `pendingChannelRequestsRef` is holding for this request's `id` —
    // `onServerError` above handles the rejection side via the same map. A reply with no matching
    // pending entry (already resolved, or from a request this specific hook instance never sent)
    // is silently ignored, not an error — mirrors `onChatHistoryPage`'s identical "no pending
    // entry, drop it" discipline.

    const onChannelCreated = (message: ServerChannelCreatedMessage) => {
      const pending = pendingChannelRequestsRef.current.get(message.id);
      if (!pending) return;
      pendingChannelRequestsRef.current.delete(message.id);
      pending.resolve(message.node);
    };

    const onChannelAck = (message: ServerChannelAckMessage) => {
      const pending = pendingChannelRequestsRef.current.get(message.id);
      if (!pending) return;
      pendingChannelRequestsRef.current.delete(message.id);
      pending.resolve(undefined);
    };

    const onChannelEditableNode = (message: ServerChannelEditableNodeMessage) => {
      const pending = pendingChannelRequestsRef.current.get(message.id);
      if (!pending) return;
      pendingChannelRequestsRef.current.delete(message.id);
      pending.resolve(message.node);
    };

    const onParticipantJoined = (message: ServerVoiceParticipantJoinedMessage) => {
      currentParticipantIds.add(message.participant.participantId);
      transport.addParticipant(message.participant.participantId, 'initiator');
      // No explicit re-announce needed for this new peer's view of any already-active camera/screen
      // track: `addParticipant` seeds it into this new peer connection and sends that connection's
      // own initial offer (see `P2PMeshTransport.addParticipant`), which makes `Peer` report this
      // connection's `localTrackMid` for it just like any other peer — `onLocalTrackMid` below
      // announces to *that* new participant then, with *that* connection's own negotiated mid.

      setState((prev) => ({
        ...prev,
        participants: [
          ...prev.participants,
          {
            participantId: message.participant.participantId,
            displayName: message.participant.displayName,
            connectionState: undefined,
            groups: message.participant.groups ?? [],
          },
        ],
      }));
    };

    const onParticipantLeft = (message: ServerVoiceParticipantLeftMessage) => {
      currentParticipantIds.delete(message.participantId);
      transport.removeParticipant(message.participantId);
      reconciler.removeParticipant(message.participantId);

      setState((prev) => {
        return {
          ...prev,
          participants: prev.participants.filter((p) => p.participantId !== message.participantId),
        };
      });
    };

    const onWebrtcOffer = (message: ServerWebrtcOfferMessage) => {
      void transport.handleRemoteOffer(message.sourceParticipantId, message.sdp);
    };
    const onWebrtcAnswer = (message: ServerWebrtcAnswerMessage) => {
      void transport.handleRemoteAnswer(message.sourceParticipantId, message.sdp);
    };
    const onWebrtcIceCandidate = (message: ServerWebrtcIceCandidateMessage) => {
      void transport.handleRemoteIceCandidate(
        message.sourceParticipantId,
        toRtcIceCandidateInit(message.candidate),
      );
    };

    const onServerError = (message: ServerErrorMessage) => {
      console.error('voice: server rejected a request', message.code, message.message);
      // Public data only (an error code, never message content that could echo untrusted input) —
      // used by `apps/desktop/scripts/e2e-authorization.mjs` to observe admission-time rejections
      // (BANNED, INVITE_REQUIRED) that close the connection before any other T9 state exists yet.
      console.info(`disco-voador:server-error:${message.code}`);

      // T13.2 — a channel-administration request awaiting its own Promise settlement.
      const pendingChannelRequest = message.replyTo
        ? pendingChannelRequestsRef.current.get(message.replyTo)
        : undefined;
      if (pendingChannelRequest) {
        pendingChannelRequestsRef.current.delete(message.replyTo as string);
        pendingChannelRequest.reject(
          new ChannelRequestError(
            message.code,
            channelErrorMessage(message.code) ?? message.message,
          ),
        );
        return;
      }

      // T13.2 — a `voice:join` this hook itself issued (a real user click, or a T11
      // reconnect-restore attempt) failing with a channel-domain code needs differentiated
      // handling; every other rejection (groups/tokens/chat/anything else) falls through to the
      // ordinary generic-toast path below, unchanged from before T13.2.
      const joinRequest =
        message.replyTo && lastJoinRequestRef.current?.id === message.replyTo
          ? lastJoinRequestRef.current
          : undefined;
      if (joinRequest) {
        lastJoinRequestRef.current = undefined;

        if (
          message.code === 'CHANNEL_PASSWORD_REQUIRED' ||
          message.code === 'CHANNEL_PASSWORD_INVALID'
        ) {
          setState((prev) => ({
            ...prev,
            joining: false,
            channelPasswordPrompt: {
              channelId: joinRequest.channelId,
              isRestore: joinRequest.isRestore,
              submitting: false,
              error:
                message.code === 'CHANNEL_PASSWORD_INVALID'
                  ? (channelErrorMessage(message.code) ?? message.message)
                  : undefined,
            },
          }));
          return;
        }

        if (
          joinRequest.isRestore &&
          (message.code === 'CHANNEL_NOT_FOUND' || message.code === 'CHANNEL_ACCESS_DENIED')
        ) {
          // A background reconnect-restore attempt found its remembered channel deleted, hidden,
          // or no longer joinable — silently give up (no error toast for something the user never
          // directly asked for just now). `join()` unconditionally set `currentChannelRef` to this
          // now-known-invalid target before sending the request; forget it here so a *later*
          // reconnect never retries the same doomed restore again.
          currentChannelRef.current = undefined;
          setState((prev) => ({ ...prev, joining: false }));
          return;
        }

        // Every other channel-domain code (CHANNEL_FULL, CHANNEL_ACCESS_DENIED/CHANNEL_NOT_FOUND
        // on a *user-initiated* join, CHANNEL_PASSWORD_RATE_LIMITED) — an ordinary, visible toast.
        setState((prev) => ({
          ...prev,
          joining: false,
          lastError: channelErrorMessage(message.code) ?? message.message,
        }));
        return;
      }

      setState((prev) => ({ ...prev, lastError: message.message, joining: false }));
    };

    // --- T9 server-local authorization -------------------------------------------------------

    const onAuthorizationState = (message: ServerAuthorizationStateMessage) => {
      setState((prev) => ({
        ...prev,
        myGroups: message.groups,
        myPermissions: message.permissions,
      }));
      // Public data only (group ids this identity holds *on this server*, never a raw identityId)
      // — used by `apps/desktop/scripts/e2e-authorization.mjs` to observe group membership changes
      // (initial Guest baseline, post-redemption group) without relying on UI text rendering.
      console.info(
        `disco-voador:my-groups:${message.groups.map((group) => group.groupId).join(',')}`,
      );
    };
    const onAuthorizationGroups = (message: ServerAuthorizationGroupsMessage) => {
      setState((prev) => ({ ...prev, groups: message.groups }));
    };
    const onAuthorizationTokenCreated = (message: ServerAuthorizationTokenCreatedMessage) => {
      setState((prev) => ({
        ...prev,
        lastCreatedToken: {
          token: message.token,
          tokenKind: message.tokenKind,
          groupId: message.groupId,
          expiresAt: message.expiresAt,
        },
      }));
    };
    const onAuthorizationTokenRedeemed = (message: ServerAuthorizationTokenRedeemedMessage) => {
      setState((prev) => ({ ...prev, lastRedeemedGroup: message.group }));
    };
    const onAuthorizationBans = (message: ServerAuthorizationBansMessage) => {
      setState((prev) => ({ ...prev, bans: message.bans }));
    };

    // --- T10 persistent server-side text chat -------------------------------------------------

    const onChatMessage = (message: ServerChatMessageMessage) => {
      const key = chatThreadKey(message.message.scope, message.message.channelId);
      // A live message for a thread the UI has never opened is dropped, not used to lazily create
      // one — this hook never preloads/accumulates chat for a channel nobody asked to see (T10
      // Section 26/39/45); the message is not lost, since it is already persisted server-side and
      // will arrive via `loadChatHistory` whenever the thread is actually opened.
      const thread = chatThreadsRef.current.get(key);
      if (thread) {
        const next = new Map(chatThreadsRef.current);
        next.set(key, {
          ...thread,
          messages: mergeChatMessages(thread.messages, [message.message]),
        });
        chatThreadsRef.current = next;
        setState((prev) => ({ ...prev, chatThreads: next }));
      }
      // Public data only (chat is meant to be visible; nothing here is a secret the way T9's
      // tokens are) — used by `apps/desktop/scripts/e2e-text-chat-persistence.mjs` /
      // `e2e-text-chat-channel-persistence.mjs` to confirm a specific message body actually
      // arrived live, without depending on UI rendering.
      console.info(`disco-voador:chat-message:${JSON.stringify(message.message)}`);
    };

    const onChatHistoryPage = (message: ServerChatHistoryPageMessage) => {
      const pending = pendingChatHistoryRequestsRef.current.get(message.id);
      if (!pending) return;
      pendingChatHistoryRequestsRef.current.delete(message.id);
      const key = chatThreadKey(pending.scope, pending.channelId);

      const thread = chatThreadsRef.current.get(key) ?? {
        messages: [],
        hasMoreOlder: false,
        loading: false,
      };
      const next = new Map(chatThreadsRef.current);
      next.set(key, {
        messages: mergeChatMessages(thread.messages, message.messages),
        hasMoreOlder: message.hasMore,
        loading: false,
      });
      chatThreadsRef.current = next;
      setState((prev) => ({ ...prev, chatThreads: next }));
      // Public data only (see `onChatMessage`'s identical reasoning above) — bodies are included,
      // not just a count, so `e2e-text-chat-persistence.mjs` can confirm a *specific* persisted
      // string actually reappeared through the history API after a restart, not merely that some
      // page arrived.
      console.info(
        `disco-voador:chat-history:${JSON.stringify({
          scope: pending.scope,
          channelId: pending.channelId,
          hasMore: message.hasMore,
          messages: message.messages,
        })}`,
      );
    };

    const onRemoteTrack = (event: RemoteTrackEvent) => {
      reconciler.handleRemoteTrack(event);
    };

    const onMediaTrackSource = (message: ServerMediaTrackSourceMessage) => {
      reconciler.handleMediaTrackSource(message.sourceParticipantId, message.mid, message.source);
    };

    /**
     * Announces a local track's semantic source to exactly the one peer this `mid` was just
     * negotiated with (see `RealtimeClient.announceTrackSource`'s doc comment for why this is
     * targeted, not a broadcast). Fired by `rtc-core` once per successful offer for every currently
     * local-tracked sender. T6: microphone is now announced too, symmetrically with every other
     * source (see `TrackSource`'s doc comment in `packages/protocol` for why leaving it as an
     * unannounced default would itself be the absence-based inference this design forbids) —
     * `source` is `undefined` only for a track this hook genuinely does not recognize at all
     * (should not happen for any currently-published track).
     */
    const onLocalTrackMid = (event: LocalTrackMidEvent) => {
      const source: TrackSource | undefined =
        event.track === microphoneRef.current?.track
          ? 'microphone'
          : event.track === cameraRef.current?.track
            ? 'camera'
            : event.track === screenRef.current?.track
              ? 'screen-video'
              : event.track === screenRef.current?.audioTrack ||
                  event.track === processAudioTrackRef.current?.track
                ? 'screen-audio'
                : undefined;
      if (!source) return;
      client.announceTrackSource(event.participantId, event.mid, source);
    };

    /**
     * T12 — Main pushes this only when a process-audio session ends on its own (the captured
     * process exited, the native helper crashed, or a capture error) — never for a caller-initiated
     * `stopProcessAudioCapture()` (`releaseProcessAudioTrack` already knows about that one, since it
     * asked for it). `sessionId` guards against a stale notification for a session this hook has
     * already released or superseded (e.g. the user stopped sharing and started a new process-audio
     * share in the same tick this notification was already in flight for the old one).
     */
    const onProcessAudioEnded = (info: DesktopProcessAudioEndedInfo) => {
      if (processAudioSessionIdRef.current !== info.sessionId) return;
      console.error(`voice: process-audio capture ended unexpectedly (${info.reason})`);
      const processAudioTrack = processAudioTrackRef.current;
      processAudioTrackRef.current = undefined;
      processAudioSessionIdRef.current = undefined;
      if (processAudioTrack) transport.unpublishTrack(processAudioTrack.track);
      // Main's own session already tore itself down — no matching `stopProcessAudioCapture()` call
      // is needed here, unlike `releaseProcessAudioTrack`'s caller-initiated path.
      setState((prev) => ({ ...prev, screenShareAudioActive: false }));
    };

    const onPeerStateChanged = (event: PeerConnectionStateEvent) => {
      setState((prev) => ({
        ...prev,
        participants: prev.participants.map((p) =>
          p.participantId === event.participantId
            ? { ...p, connectionState: event.connectionState }
            : p,
        ),
      }));
    };

    controller.on('stateChange', onControllerStateChange);
    controller.on('reconnecting', onReconnecting);
    controller.on('reconnected', onReconnected);
    controller.on('connectionFailed', onConnectionFailed);
    client.on('serverInfo', onServerInfo);
    client.on('catalog', onCatalog);
    client.on('joined', onJoined);
    client.on('left', onLeft);
    client.on('participantJoined', onParticipantJoined);
    client.on('participantLeft', onParticipantLeft);
    client.on('webrtcOffer', onWebrtcOffer);
    client.on('webrtcAnswer', onWebrtcAnswer);
    client.on('webrtcIceCandidate', onWebrtcIceCandidate);
    client.on('mediaTrackSource', onMediaTrackSource);
    client.on('serverError', onServerError);
    client.on('authorizationState', onAuthorizationState);
    client.on('authorizationGroups', onAuthorizationGroups);
    client.on('authorizationTokenCreated', onAuthorizationTokenCreated);
    client.on('authorizationTokenRedeemed', onAuthorizationTokenRedeemed);
    client.on('authorizationBans', onAuthorizationBans);
    client.on('chatMessage', onChatMessage);
    client.on('chatHistoryPage', onChatHistoryPage);
    client.on('voiceRemovedByPolicy', onVoiceRemovedByPolicy);
    client.on('channelCreated', onChannelCreated);
    client.on('channelAck', onChannelAck);
    client.on('channelEditableNode', onChannelEditableNode);
    transport.on('remoteTrack', onRemoteTrack);
    transport.on('localTrackMid', onLocalTrackMid);
    transport.on('peerStateChanged', onPeerStateChanged);
    const unsubscribeProcessAudioEnded = window.desktopApp.onProcessAudioEnded(onProcessAudioEnded);

    controller.connect();

    return () => {
      controller.off('stateChange', onControllerStateChange);
      controller.off('reconnecting', onReconnecting);
      controller.off('reconnected', onReconnected);
      controller.off('connectionFailed', onConnectionFailed);
      client.off('serverInfo', onServerInfo);
      client.off('catalog', onCatalog);
      client.off('joined', onJoined);
      client.off('left', onLeft);
      client.off('participantJoined', onParticipantJoined);
      client.off('participantLeft', onParticipantLeft);
      client.off('webrtcOffer', onWebrtcOffer);
      client.off('webrtcAnswer', onWebrtcAnswer);
      client.off('webrtcIceCandidate', onWebrtcIceCandidate);
      client.off('mediaTrackSource', onMediaTrackSource);
      client.off('serverError', onServerError);
      client.off('authorizationState', onAuthorizationState);
      client.off('authorizationGroups', onAuthorizationGroups);
      client.off('authorizationTokenCreated', onAuthorizationTokenCreated);
      client.off('authorizationTokenRedeemed', onAuthorizationTokenRedeemed);
      client.off('authorizationBans', onAuthorizationBans);
      client.off('chatMessage', onChatMessage);
      client.off('chatHistoryPage', onChatHistoryPage);
      client.off('voiceRemovedByPolicy', onVoiceRemovedByPolicy);
      client.off('channelCreated', onChannelCreated);
      client.off('channelAck', onChannelAck);
      client.off('channelEditableNode', onChannelEditableNode);
      transport.off('remoteTrack', onRemoteTrack);
      transport.off('localTrackMid', onLocalTrackMid);
      transport.off('peerStateChanged', onPeerStateChanged);
      unsubscribeProcessAudioEnded();

      // This is a genuinely final teardown (unmount, or the user connected to a different
      // server/address) — `controller.disconnect()` marks the sequence as deliberately ended, so no
      // reconnect timer can fire after this point (T11 Section 39/57/82). An automatic reconnect
      // cycle, by contrast, never reaches this cleanup at all: `realtimeConfig` does not change
      // during one, so this effect simply keeps running, exactly as designed.
      controller.disconnect();
      // The transport is discarded along with this effect run — permanent teardown is correct
      // here, unlike a mid-session channel switch (`onJoined`/`onLeft` above use
      // `removeParticipant`, never `closeAll`, since `closeAll` permanently disables the
      // transport).
      transport.closeAll();
      microphoneRef.current?.stop();
      microphoneRef.current = undefined;
      cameraGenerationRef.current += 1;
      cameraRef.current?.stop();
      cameraRef.current = undefined;
      screenGenerationRef.current += 1;
      screenRef.current?.stop();
      screenRef.current = undefined;
      // T12 — mirrors screen's own final-teardown shape: stop the local synthesized track directly
      // (the transport itself is already being fully closed above, so an explicit unpublish is not
      // needed here, same as microphone/camera/screen), and tell Main to release the native helper.
      processAudioTrackRef.current?.stop();
      processAudioTrackRef.current = undefined;
      processAudioSessionIdRef.current = undefined;
      window.desktopApp.stopProcessAudioCapture().catch((error: unknown) => {
        console.error('voice: failed to stop process-audio capture on teardown', error);
      });
      clientRef.current = undefined;
      controllerRef.current = undefined;
      transportRef.current = undefined;
      currentChannelRef.current = undefined;
    };
  }, [realtimeConfig]);

  /**
   * T11 Sections 22-24 — detects a microphone track ending *unexpectedly* (device unplugged,
   * revoked, or otherwise lost mid-call) and surfaces it in state without ending the voice session,
   * mirroring `enableCamera`'s own already-proven `'ended'` handling for camera exactly (same
   * `ref-still-points-at-this-instance` staleness guard). Attached once per acquired `Microphone`
   * instance, at every acquisition site (`join()`'s initial acquisition, `switchMicrophone`'s
   * replacement acquisition, and therefore a reconnect's fresh reacquisition via `join()`'s own
   * restore path).
   *
   * **Deliberately does not attempt automatic reacquisition.** Per the W3C Media Capture and
   * Streams specification and MDN's documented `MediaStreamTrack` behavior, a track's `readyState`
   * becomes `'ended'` and the `ended` event fires when the underlying source stops supplying data
   * for a reason outside the application's control (e.g. the hardware device was disconnected) —
   * this is standard, specified behavior, not a special "recovery" mode; the specification defines
   * no automatic re-acquisition or fallback-device substitution once a track has ended, and once
   * `ended`, a `MediaStreamTrack` cannot be revived — only a fresh `getUserMedia()` call can start
   * capturing again. This matches `Camera`'s own documented model (`packages/media-core/src/camera.ts`:
   * "After this, the ... instance is dead — acquire a new one to resume") and this codebase's
   * existing, already-shipped camera `'ended'` handling, which likewise never auto-restarts.
   * Silently guessing a replacement device (e.g. falling back to system default) risks routing the
   * user's voice through a device they did not choose, with no confirmation — surfacing
   * `micDisconnected` and letting the user explicitly pick a device from Settings (or plug the same
   * one back in and try again) is the safer, more honest default, consistent with T11 Section 20's
   * own "explain, do not silently substitute without saying so" principle for the *initial*
   * acquisition case. This reasoning is based on the specification and MDN's documented platform
   * behavior, not an independent live-hardware-unplug test on this machine (no removable microphone
   * hardware was available to physically test during this task — see the final report).
   */
  function attachMicrophoneUnexpectedEndedHandler(microphone: Microphone): void {
    microphone.track.addEventListener('ended', () => {
      // `microphoneRef.current !== microphone` means an explicit release (`releaseMicrophone()`,
      // called from `leave()`/`onLeft`/`onReconnecting`/unmount) or a newer acquisition
      // (`switchMicrophone`) already handled cleanup for this instance — a no-op here.
      if (microphoneRef.current !== microphone) return;
      microphoneRef.current = undefined;
      const transport = transportRef.current;
      if (transport) transport.unpublishTrack(microphone.track);
      setState((prev) => ({ ...prev, localMicrophoneStream: undefined, micDisconnected: true }));
    });
  }

  const join = useCallback(
    (channelId: string, displayName: string, password?: string, isRestore = false) => {
      const client = clientRef.current;
      const transport = transportRef.current;
      if (!client || !transport) return;

      // T11 — remembered so an unexpected connection loss can restore this same channel/name once
      // reconnected (T11 Section 48/50). Set here, not only on confirmed `onJoined` success, since a
      // join that was still in flight when the connection dropped is still worth restoring. Cleared
      // only by an explicit `leave()`, never by the reconnect cycle itself (T13.2: also cleared by
      // `onServerError` specifically when a *restore* attempt finds its target deleted/hidden — see
      // that handler's own doc comment).
      currentChannelRef.current = { channelId, displayName };

      setState((prev) => ({
        ...prev,
        joining: true,
        lastError: undefined,
        micError: undefined,
        channelPasswordPrompt: undefined,
      }));

      void (async () => {
        if (!microphoneRef.current) {
          const generation = ++microphoneGenerationRef.current;
          const preferredDeviceId = preferredMicDeviceIdRef.current;
          try {
            const microphone = await acquireMicrophone(deviceIdConstraint(preferredDeviceId));
            if (
              transportRef.current !== transport ||
              microphoneGenerationRef.current !== generation
            ) {
              // This effect's connection/transport was torn down (unmount, or `realtimeConfig`
              // changed), or a newer acquisition (a `switchMicrophone` call) superseded this one,
              // while `getUserMedia` was pending. Stop the device immediately instead of leaking the
              // hardware microphone or publishing a track nobody asked for anymore.
              microphone.stop();
              return;
            }
            microphone.setMuted(mutedRef.current);
            microphoneRef.current = microphone;
            attachMicrophoneUnexpectedEndedHandler(microphone);
            transport.publishTrack(microphone.track);
            const usingFallback = resolveDeviceFallback(
              preferredDeviceId,
              microphone.track.getSettings().deviceId,
            );
            setState((prev) => ({
              ...prev,
              localMicrophoneStream: microphone.stream,
              micUsingFallback: usingFallback,
              micDisconnected: false,
            }));
          } catch (error) {
            const message =
              error instanceof MicrophoneAccessError ? error.message : 'Microphone access failed';
            console.error('voice: microphone acquisition failed', message, error);
            setState((prev) => ({ ...prev, micError: message, joining: false }));
            return;
          }
        }

        const requestId = client.joinVoiceChannel(channelId, displayName, password);
        lastJoinRequestRef.current = { id: requestId, channelId, isRestore };
      })();
    },
    [],
  );

  const leave = useCallback(() => {
    // T11 — an explicit leave must never be "restored" after a later reconnect (Section 49).
    currentChannelRef.current = undefined;
    clientRef.current?.leaveVoiceChannel();
  }, []);

  // T11 — keeps `joinRef` pointing at the latest stable `join` callback so the main connection
  // effect's `'reconnected'` handler (defined once per effect run, unaware of `join`'s own
  // declaration) can always call the current one.
  useEffect(() => {
    joinRef.current = join;
  }, [join]);

  const cancelReconnect = useCallback(() => {
    controllerRef.current?.cancelReconnect();
  }, []);

  const setMuted = useCallback((muted: boolean) => {
    mutedRef.current = muted;
    microphoneRef.current?.setMuted(muted);
    setState((prev) => ({ ...prev, muted }));
    // T11 — persists the mute-on-launch preference. Fire-and-forget: a failed write here is not
    // worth surfacing as a call-affecting error (mirrors this file's other IPC-write call sites),
    // and it never blocks the actual mute, which already took effect above via `microphone.setMuted`.
    // Only ever invoked from an explicit user toggle (this `useCallback` is `VoiceChannelActions`'
    // `setMuted`, the sole caller of `microphone.setMuted` for a deliberate mute/unmute) — a
    // reconnect never calls this (mute state survives a reconnect untouched via `mutedRef`/
    // `state.muted`, see the main effect's `onReconnecting`/`onReconnected` handlers), so this can
    // never fire from anything other than a genuine user choice.
    window.desktopApp
      .updateClientSettings({ voice: { startMuted: muted } })
      .catch((error: unknown) => {
        console.error('voice: failed to persist mute preference', error);
      });
  }, []);

  const setDeafened = useCallback((deafened: boolean) => {
    setState((prev) => ({ ...prev, deafened }));
    // T11 — mirrors `setMuted`'s persistence exactly.
    window.desktopApp
      .updateClientSettings({ voice: { startDeafened: deafened } })
      .catch((error: unknown) => {
        console.error('voice: failed to persist deafen preference', error);
      });
  }, []);

  const enableCamera = useCallback(() => {
    const transport = transportRef.current;
    // `cameraAcquiringRef` blocks a *second* concurrent `acquireCamera()` call for as long as one
    // is already in flight — even across an intervening `disableCamera()` — because many real
    // webcams only support one open capture handle at a time; without this, a fast double-click
    // (the button has no `disabled`-during-acquisition state to rely on instead) could start two
    // concurrent `getUserMedia` calls, and if the *stale* one happens to be the one that succeeds,
    // the user sees a spurious camera error after a single intended click. Found by QA review, not
    // by the live E2E (which never exercises rapid double-invocation).
    if (!transport || cameraRef.current || cameraAcquiringRef.current) return;

    cameraAcquiringRef.current = true;
    const generation = ++cameraGenerationRef.current;
    const preferredDeviceId = preferredCameraDeviceIdRef.current;
    setState((prev) => ({ ...prev, cameraError: undefined, cameraAcquiring: true }));

    void (async () => {
      try {
        const camera = await acquireCamera(deviceIdConstraint(preferredDeviceId));
        if (transportRef.current !== transport || cameraGenerationRef.current !== generation) {
          // The transport was torn down, or the user disabled the camera again (or enabled it a
          // second time — the generation counter only ever matches the most recent call) while
          // `getUserMedia` was pending. Stop the device immediately instead of leaking the
          // hardware camera or publishing a track nobody asked for anymore — the same class of
          // race T3 fixed for the microphone.
          camera.stop();
          return;
        }

        cameraRef.current = camera;
        camera.track.addEventListener('ended', () => {
          // The physical device stopped unexpectedly (unplugged, revoked, etc.) rather than via
          // `disableCamera()` — `cameraRef.current !== camera` means `disableCamera()` (or a
          // newer `enableCamera()`) already handled cleanup for this instance, so this is a no-op.
          if (cameraRef.current !== camera) return;
          cameraRef.current = undefined;
          transport.unpublishTrack(camera.track);
          setState((prev) => ({
            ...prev,
            cameraEnabled: false,
            localCameraStream: undefined,
            cameraUsingFallback: false,
          }));
        });

        transport.publishTrack(camera.track);
        // T5: camera's video source must be identified explicitly too, symmetrically with screen —
        // once both exist, leaving camera unannounced and treating "no announcement" as an implicit
        // default would itself be a form of order/absence-based inference, exactly what T5's
        // protocol design set out to avoid. The actual announcement is driven by `onLocalTrackMid`
        // above, once `rtc-core` reports this track's negotiated mid for each peer — not here,
        // since the mid isn't known yet at publish time. See
        // `docs/architecture/WEBRTC_SCREEN_SHARE.md`.
        const usingFallback = resolveDeviceFallback(
          preferredDeviceId,
          camera.track.getSettings().deviceId,
        );
        setState((prev) => ({
          ...prev,
          cameraEnabled: true,
          localCameraStream: camera.stream,
          cameraUsingFallback: usingFallback,
        }));
      } catch (error) {
        const message = error instanceof CameraAccessError ? error.message : 'Camera access failed';
        console.error('voice: camera acquisition failed', message, error);
        setState((prev) => ({ ...prev, cameraError: message }));
      } finally {
        cameraAcquiringRef.current = false;
        setState((prev) => ({ ...prev, cameraAcquiring: false }));
      }
    })();
  }, []);

  const disableCamera = useCallback(() => {
    cameraGenerationRef.current += 1;
    const transport = transportRef.current;
    const camera = cameraRef.current;
    cameraRef.current = undefined;
    if (transport && camera) transport.unpublishTrack(camera.track);
    camera?.stop();
    setState((prev) => ({
      ...prev,
      cameraEnabled: false,
      localCameraStream: undefined,
      cameraUsingFallback: false,
    }));
  }, []);

  /**
   * T11 — live microphone device switching. See `VoiceChannelActions.switchMicrophone`'s doc
   * comment for the full contract (atomicity, no-op-if-nothing-live). Shares
   * `microphoneGenerationRef`/`microphoneAcquiringRef` with `join()`'s own initial acquisition —
   * see those refs' declaration comment for why.
   */
  const switchMicrophone = useCallback((deviceId: string | null) => {
    preferredMicDeviceIdRef.current = deviceId;

    const transport = transportRef.current;
    const currentMicrophone = microphoneRef.current;
    // No live microphone to replace (never joined yet, or currently between join attempts) — the
    // preference above is all that needs to happen; the next acquisition will pick it up.
    if (!transport || !currentMicrophone) return;
    // Mirrors `enableCamera`'s exact double-invocation guard — blocks a second concurrent
    // `acquireMicrophone()` call while one is already in flight (another `switchMicrophone` call,
    // or `join()`'s own initial acquisition, sharing the same ref).
    if (microphoneAcquiringRef.current) return;

    microphoneAcquiringRef.current = true;
    const generation = ++microphoneGenerationRef.current;
    setState((prev) => ({ ...prev, micError: undefined }));

    void (async () => {
      try {
        const newMicrophone = await acquireMicrophone(deviceIdConstraint(deviceId));
        if (transportRef.current !== transport || microphoneGenerationRef.current !== generation) {
          // Stale: the transport was torn down, or a newer switch/join superseded this one, while
          // `getUserMedia` was pending — the old device (if it is even still the current one) was
          // never touched, so nothing needs to be undone; just release the now-unwanted new device.
          newMicrophone.stop();
          return;
        }

        newMicrophone.setMuted(mutedRef.current);
        // Atomicity (T11 Section 27, mandatory): the new device is confirmed live and swapped in
        // via `replaceTrack` *before* the old device is stopped — if acquisition above had failed
        // instead, `currentMicrophone` would still be untouched and still working, handled by the
        // `catch` block below doing nothing to it.
        transport.replaceTrack(currentMicrophone.track, newMicrophone.track);
        microphoneRef.current = newMicrophone;
        attachMicrophoneUnexpectedEndedHandler(newMicrophone);
        currentMicrophone.stop();

        const usingFallback = resolveDeviceFallback(
          deviceId,
          newMicrophone.track.getSettings().deviceId,
        );
        setState((prev) => ({
          ...prev,
          localMicrophoneStream: newMicrophone.stream,
          micUsingFallback: usingFallback,
          micDisconnected: false,
        }));
      } catch (error) {
        // The old device (`currentMicrophone`) is left completely untouched — still acquired, still
        // published, still working, per the atomicity requirement above.
        const message =
          error instanceof MicrophoneAccessError ? error.message : 'Microphone switch failed';
        console.error('voice: microphone switch failed', message, error);
        setState((prev) => ({ ...prev, micError: message }));
      } finally {
        microphoneAcquiringRef.current = false;
      }
    })();
  }, []);

  /** T11 — live camera device switching. Mirrors `switchMicrophone` exactly, reusing camera's own
   * existing `cameraGenerationRef`/`cameraAcquiringRef` (shared with `enableCamera`/`disableCamera`,
   * exactly like microphone's refs are shared with `join()`). */
  const switchCamera = useCallback((deviceId: string | null) => {
    preferredCameraDeviceIdRef.current = deviceId;

    const transport = transportRef.current;
    const currentCamera = cameraRef.current;
    // Camera is off, or no transport — T4's "camera off is real off" rule: this must never turn the
    // camera on. Only the preference above is updated; `enableCamera()` will pick it up next time.
    if (!transport || !currentCamera) return;
    if (cameraAcquiringRef.current) return;

    cameraAcquiringRef.current = true;
    const generation = ++cameraGenerationRef.current;
    setState((prev) => ({ ...prev, cameraError: undefined, cameraAcquiring: true }));

    void (async () => {
      try {
        const newCamera = await acquireCamera(deviceIdConstraint(deviceId));
        if (transportRef.current !== transport || cameraGenerationRef.current !== generation) {
          newCamera.stop();
          return;
        }

        // Atomicity (T11 Section 27, mandatory) — same ordering as `switchMicrophone`.
        transport.replaceTrack(currentCamera.track, newCamera.track);
        cameraRef.current = newCamera;
        newCamera.track.addEventListener('ended', () => {
          // Mirrors `enableCamera`'s own `'ended'` handler exactly — see that one's comment.
          if (cameraRef.current !== newCamera) return;
          cameraRef.current = undefined;
          transport.unpublishTrack(newCamera.track);
          setState((prev) => ({
            ...prev,
            cameraEnabled: false,
            localCameraStream: undefined,
            cameraUsingFallback: false,
          }));
        });
        currentCamera.stop();

        const usingFallback = resolveDeviceFallback(
          deviceId,
          newCamera.track.getSettings().deviceId,
        );
        setState((prev) => ({
          ...prev,
          localCameraStream: newCamera.stream,
          cameraUsingFallback: usingFallback,
        }));
      } catch (error) {
        // `currentCamera` is left completely untouched, per the atomicity requirement.
        const message = error instanceof CameraAccessError ? error.message : 'Camera switch failed';
        console.error('voice: camera switch failed', message, error);
        setState((prev) => ({ ...prev, cameraError: message }));
      } finally {
        cameraAcquiringRef.current = false;
        setState((prev) => ({ ...prev, cameraAcquiring: false }));
      }
    })();
  }, []);

  const enableScreenShare = useCallback(
    (quality: ScreenQualityPreset, audioMode: ScreenShareAudioMode) => {
      const transport = transportRef.current;
      // Mirrors `enableCamera`'s double-click/concurrent-acquisition guard exactly — the same class
      // of real bug T4 found for camera (a fast double-invocation starting two concurrent capture
      // attempts) applies identically here.
      if (!transport || screenRef.current || screenAcquiringRef.current) return;

      screenAcquiringRef.current = true;
      const generation = ++screenGenerationRef.current;
      setState((prev) => ({
        ...prev,
        screenShareError: undefined,
        screenSharingState: 'starting',
      }));

      void (async () => {
        try {
          // T12: process-audio never rides Windows system-loopback — only `{ type: 'system' }` ever
          // requests it from `acquireScreen` (matches what `ScreenSourcePicker` armed via
          // `selectScreenShareSource`).
          const screen = await acquireScreen(
            SCREEN_QUALITY_PRESETS[quality],
            audioMode.type === 'system',
          );
          if (transportRef.current !== transport || screenGenerationRef.current !== generation) {
            // The transport was torn down, or the user stopped sharing again (or started a second
            // share — the generation counter only ever matches the most recent call) while
            // `getDisplayMedia()` was pending. Stop the device immediately instead of leaking the
            // capture or publishing a track nobody asked for anymore — the same race class T3 fixed
            // for the microphone and T4 fixed for the camera. `screen.stop()` releases both video
            // and (if present) audio.
            screen.stop();
            return;
          }

          screenRef.current = screen;
          screen.track.addEventListener('ended', () => {
            // Native capture ended externally — the OS/browser-style "Stop sharing" control, or the
            // captured window was closed — rather than via `disableScreenShare()`.
            // `screenRef.current !== screen` means `disableScreenShare()` (or a newer
            // `enableScreenShare()`) already handled cleanup for this instance, so this is a no-op.
            // T6/T12: video ending externally always tears down audio too (system *or* process) —
            // audio must never keep broadcasting after the visual share ended.
            if (screenRef.current !== screen) return;
            screenRef.current = undefined;
            releasePublishedScreen(transport, screen);
            releaseProcessAudioTrack();
            setState((prev) => ({
              ...prev,
              screenSharingState: 'idle',
              localScreenStream: undefined,
              screenShareAudioActive: false,
            }));
          });

          transport.publishTrack(screen.track);
          // Announced by `onLocalTrackMid` once each peer's negotiated mid for this track is known —
          // see the identical comment in `enableCamera`.
          let audioActive = false;
          const audioTrack = screen.audioTrack;
          if (audioTrack) {
            audioActive = true;
            // Both `publishTrack` calls happen synchronously in this same task — the platform's own
            // `negotiationneeded` batching (see `packages/rtc-core/src/peer.ts`) coalesces them into
            // one renegotiation cycle for this share-start, not two.
            transport.publishTrack(audioTrack);
            // T6: system audio can independently stop supplying data (source app closed, platform
            // revoked it) while video keeps sharing — must not end the whole share, only mark audio
            // unavailable. `screenRef.current !== screen` means the video 'ended' handler above (or
            // `disableScreenShare()`) already handled full cleanup for this instance.
            audioTrack.addEventListener('ended', () => {
              if (screenRef.current !== screen) return;
              transport.unpublishTrack(audioTrack);
              setState((prev) => ({ ...prev, screenShareAudioActive: false }));
            });
          }

          setState((prev) => ({
            ...prev,
            screenSharingState: 'sharing',
            localScreenStream: screen.stream,
            screenShareAudioActive: audioActive,
          }));

          // T12 — application audio is acquired *after* video is already publishing, mirroring system
          // audio's own "video always publishes; audio is optional/best-effort" contract exactly:
          // acquisition/publication failure here degrades to video-only (surfaced via
          // `screenShareError`), never fails the whole share.
          if (audioMode.type === 'process') {
            const pid = audioMode.pid;
            void (async () => {
              try {
                const { processAudioTrack, sessionId } = await acquireProcessAudioTrack(pid);
                if (
                  screenRef.current !== screen ||
                  transportRef.current !== transport ||
                  screenGenerationRef.current !== generation
                ) {
                  // Stale by the time the capture actually started (the share was stopped, or a newer
                  // share superseded this one, while the port/format round-trip was pending) — release
                  // immediately instead of leaking the native capture or publishing an orphaned track.
                  processAudioTrack.stop();
                  window.desktopApp.stopProcessAudioCapture().catch(() => {
                    // Best-effort — Main's own session bookkeeping is idempotent either way.
                  });
                  return;
                }

                processAudioTrackRef.current = processAudioTrack;
                processAudioSessionIdRef.current = sessionId;
                transport.publishTrack(processAudioTrack.track);
                setState((prev) => ({ ...prev, screenShareAudioActive: true }));
              } catch (error) {
                console.error('voice: process-audio capture failed', error);
                setState((prev) => ({
                  ...prev,
                  screenShareError: 'Could not capture application audio; sharing video only.',
                }));
              }
            })();
          }
        } catch (error) {
          const message =
            error instanceof ScreenAccessError ? error.message : 'Screen share failed';
          console.error('voice: screen share acquisition failed', message, error);
          setState((prev) => ({ ...prev, screenShareError: message, screenSharingState: 'error' }));
        } finally {
          screenAcquiringRef.current = false;
        }
      })();
    },
    [releaseProcessAudioTrack],
  );

  const disableScreenShare = useCallback(() => {
    screenGenerationRef.current += 1;
    const transport = transportRef.current;
    const screen = screenRef.current;
    screenRef.current = undefined;
    if (transport && screen) releasePublishedScreen(transport, screen);
    else screen?.stop();
    releaseProcessAudioTrack();
    setState((prev) => ({
      ...prev,
      screenSharingState: 'idle',
      localScreenStream: undefined,
      screenShareAudioActive: false,
    }));
  }, [releaseProcessAudioTrack]);

  // --- T9 server-local authorization actions --------------------------------------------------
  // Each is a thin pass-through to the current client — the server is the sole authority on
  // whether the request succeeds (T9 Section 35); a denial arrives as an ordinary `server:error`
  // via the existing `onServerError` handler above, same as any other non-fatal rejection.

  const redeemToken = useCallback((token: string) => {
    clientRef.current?.redeemAuthorizationToken(token);
  }, []);
  const createToken = useCallback((tokenKind: TokenKind, groupId: string, expiresInMs?: number) => {
    clientRef.current?.createAuthorizationToken(tokenKind, groupId, expiresInMs);
  }, []);
  const listGroups = useCallback(() => {
    clientRef.current?.listAuthorizationGroups();
  }, []);
  const createGroup = useCallback((name: string, permissions: readonly PermissionKey[]) => {
    clientRef.current?.createAuthorizationGroup(name, permissions);
  }, []);
  const updateGroup = useCallback(
    (groupId: string, name?: string, permissions?: readonly PermissionKey[]) => {
      clientRef.current?.updateAuthorizationGroup(groupId, name, permissions);
    },
    [],
  );
  const deleteGroup = useCallback((groupId: string) => {
    clientRef.current?.deleteAuthorizationGroup(groupId);
  }, []);
  const grantGroup = useCallback((targetParticipantId: string, groupId: string) => {
    clientRef.current?.grantAuthorizationGroup(targetParticipantId, groupId);
  }, []);
  const revokeGroup = useCallback((targetParticipantId: string, groupId: string) => {
    clientRef.current?.revokeAuthorizationGroup(targetParticipantId, groupId);
  }, []);
  const kick = useCallback((targetParticipantId: string) => {
    clientRef.current?.kickParticipant(targetParticipantId);
  }, []);
  const ban = useCallback((targetParticipantId: string, durationMs?: number, reason?: string) => {
    clientRef.current?.banParticipant(targetParticipantId, durationMs, reason);
  }, []);
  const unban = useCallback((identityId: string) => {
    clientRef.current?.unbanIdentity(identityId);
  }, []);
  const listBans = useCallback(() => {
    clientRef.current?.listAuthorizationBans();
  }, []);

  // --- T10 persistent server-side text chat actions -------------------------------------------

  const sendChatMessage = useCallback(
    (scope: ChatScope, channelId: string | undefined, body: string) => {
      clientRef.current?.sendChatMessage(scope, channelId, body);
    },
    [],
  );

  const loadChatHistory = useCallback((scope: ChatScope, channelId: string | undefined) => {
    const client = clientRef.current;
    if (!client) return;

    const key = chatThreadKey(scope, channelId);
    const thread = chatThreadsRef.current.get(key);
    // Guard against a duplicate concurrent request for the same thread (a fast double-scroll), and
    // against re-requesting once the server has already said there is nothing older left.
    if (thread?.loading) return;
    if (thread && !thread.hasMoreOlder) return;

    const beforeMessageId = thread?.messages[0]?.messageId;
    const requestId = client.requestChatHistory(scope, channelId, beforeMessageId);
    pendingChatHistoryRequestsRef.current.set(requestId, { scope, channelId });

    const nextThread: ChatThreadState = thread
      ? { ...thread, loading: true }
      : { messages: [], hasMoreOlder: false, loading: true };
    const next = new Map(chatThreadsRef.current);
    next.set(key, nextThread);
    chatThreadsRef.current = next;
    setState((prev) => ({ ...prev, chatThreads: next }));
  }, []);

  // --- T13.2 channel/category tree administration ---------------------------------------------
  // Each pairs a `RealtimeClient` call (which returns the generated request id) with a Promise
  // registered in `pendingChannelRequestsRef` under that same id — `onChannelCreated`/
  // `onChannelAck`/`onChannelEditableNode` resolve it, `onServerError` rejects it with a
  // `ChannelRequestError`. The server is the sole authority on whether any of these succeed; this
  // is purely request/response plumbing, never a client-side decision.

  function registerPendingChannelRequest(
    requestId: string,
  ): Promise<ChannelNodeAdminView | undefined> {
    return new Promise((resolve, reject) => {
      pendingChannelRequestsRef.current.set(requestId, { resolve, reject });
    });
  }

  const createCategory = useCallback((name: string, parentId?: string) => {
    const client = clientRef.current;
    if (!client) return Promise.reject(new Error('Not connected.'));
    const requestId = client.createChannelCategory(name, parentId);
    return registerPendingChannelRequest(requestId) as Promise<ChannelNodeAdminView>;
  }, []);

  const createVoiceChannel = useCallback((name: string, parentId?: string, temporary?: boolean) => {
    const client = clientRef.current;
    if (!client) return Promise.reject(new Error('Not connected.'));
    const requestId = client.createVoiceChannelNode(name, parentId, temporary);
    return registerPendingChannelRequest(requestId) as Promise<ChannelNodeAdminView>;
  }, []);

  const updateChannel = useCallback((nodeId: string, patch: ChannelUpdatePatch) => {
    const client = clientRef.current;
    if (!client) return Promise.reject(new Error('Not connected.'));
    const requestId = client.updateChannelNode(nodeId, patch);
    return registerPendingChannelRequest(requestId).then(() => undefined);
  }, []);

  const moveChannel = useCallback((nodeId: string, newParentId: string | undefined) => {
    const client = clientRef.current;
    if (!client) return Promise.reject(new Error('Not connected.'));
    const requestId = client.moveChannelNode(nodeId, newParentId);
    return registerPendingChannelRequest(requestId).then(() => undefined);
  }, []);

  const reorderChannels = useCallback(
    (parentId: string | undefined, orderedNodeIds: readonly string[]) => {
      const client = clientRef.current;
      if (!client) return Promise.reject(new Error('Not connected.'));
      const requestId = client.reorderChannelNodes(parentId, orderedNodeIds);
      return registerPendingChannelRequest(requestId).then(() => undefined);
    },
    [],
  );

  const deleteChannel = useCallback((nodeId: string) => {
    const client = clientRef.current;
    if (!client) return Promise.reject(new Error('Not connected.'));
    const requestId = client.deleteChannelNode(nodeId);
    return registerPendingChannelRequest(requestId).then(() => undefined);
  }, []);

  const setChannelPassword = useCallback((nodeId: string, password: string) => {
    const client = clientRef.current;
    if (!client) return Promise.reject(new Error('Not connected.'));
    const requestId = client.setChannelPassword(nodeId, password);
    return registerPendingChannelRequest(requestId).then(() => undefined);
  }, []);

  const removeChannelPassword = useCallback((nodeId: string) => {
    const client = clientRef.current;
    if (!client) return Promise.reject(new Error('Not connected.'));
    const requestId = client.removeChannelPassword(nodeId);
    return registerPendingChannelRequest(requestId).then(() => undefined);
  }, []);

  const getEditableChannelNode = useCallback((nodeId: string) => {
    const client = clientRef.current;
    if (!client) return Promise.reject(new Error('Not connected.'));
    const requestId = client.getEditableChannelNode(nodeId);
    return registerPendingChannelRequest(requestId) as Promise<ChannelNodeAdminView>;
  }, []);

  /** Retries the join that raised `state.channelPasswordPrompt`. Reuses `currentChannelRef`'s
   * remembered `displayName` — the same one the original attempt used, whether that attempt was a
   * user click or a T11 restore — so this never has to ask the caller to re-supply it. The password
   * itself flows straight into `join()` and is never stored in this hook's own state at any point. */
  const submitChannelPassword = useCallback(
    (password: string) => {
      setState((prev) => {
        const prompt = prev.channelPasswordPrompt;
        if (!prompt) return prev;
        const displayName = currentChannelRef.current?.displayName ?? '';
        join(prompt.channelId, displayName, password, prompt.isRestore);
        return {
          ...prev,
          channelPasswordPrompt: { ...prompt, submitting: true, error: undefined },
        };
      });
    },
    [join],
  );

  const dismissChannelPasswordPrompt = useCallback(() => {
    setState((prev) => {
      if (!prev.channelPasswordPrompt) return prev;
      // Mirrors `leave()`'s own "an explicit dismissal must never be silently restored later" rule
      // — abandoning either a user-initiated or a restore-triggered password prompt means the user
      // does not want to be in this channel right now.
      currentChannelRef.current = undefined;
      return { ...prev, channelPasswordPrompt: undefined };
    });
  }, []);

  const dismissChannelAccessRevokedNotice = useCallback(() => {
    setState((prev) => ({ ...prev, channelAccessRevokedNotice: undefined }));
  }, []);

  // Memoized so callers holding `actions` in a `useEffect` dependency array (e.g. the E2E
  // auto-camera-off timer in `VoiceChannelView.tsx`) get a stable reference instead of one that
  // changes on every render — each individual action is already a `useCallback` with empty deps,
  // so this object's own identity is stable for the component's whole lifetime.
  const actions = useMemo<VoiceChannelActions>(
    () => ({
      join,
      leave,
      cancelReconnect,
      setMuted,
      setDeafened,
      enableCamera,
      disableCamera,
      switchMicrophone,
      switchCamera,
      enableScreenShare,
      disableScreenShare,
      redeemToken,
      createToken,
      listGroups,
      createGroup,
      updateGroup,
      deleteGroup,
      grantGroup,
      revokeGroup,
      kick,
      ban,
      unban,
      listBans,
      sendChatMessage,
      loadChatHistory,
      createCategory,
      createVoiceChannel,
      updateChannel,
      moveChannel,
      reorderChannels,
      deleteChannel,
      setChannelPassword,
      removeChannelPassword,
      getEditableChannelNode,
      submitChannelPassword,
      dismissChannelPasswordPrompt,
      dismissChannelAccessRevokedNotice,
    }),
    [
      join,
      leave,
      cancelReconnect,
      setMuted,
      setDeafened,
      enableCamera,
      disableCamera,
      switchMicrophone,
      switchCamera,
      enableScreenShare,
      disableScreenShare,
      redeemToken,
      createToken,
      listGroups,
      createGroup,
      updateGroup,
      deleteGroup,
      grantGroup,
      revokeGroup,
      kick,
      ban,
      unban,
      listBans,
      sendChatMessage,
      loadChatHistory,
      createCategory,
      createVoiceChannel,
      updateChannel,
      moveChannel,
      reorderChannels,
      deleteChannel,
      setChannelPassword,
      removeChannelPassword,
      getEditableChannelNode,
      submitChannelPassword,
      dismissChannelPasswordPrompt,
      dismissChannelAccessRevokedNotice,
    ],
  );

  return [state, actions] as const;
}
