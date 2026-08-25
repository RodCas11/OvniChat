import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AvatarImageFormat,
  AvatarRef,
  BanSummary,
  ChannelNodeAdminView,
  ChannelNodeView,
  ChatMessageView,
  ChatScope,
  ErrorCode,
  GroupBadge,
  GroupSummary,
  IceCandidatePayload,
  MemberPresence,
  PermissionKey,
  PresenceStatus,
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
  ServerPresenceRemovedMessage,
  ServerPresenceSnapshotMessage,
  ServerPresenceUpdatedMessage,
  ServerProfileAvatarDataMessage,
  ServerProfileSelfUpdatedMessage,
  ServerTurnCredentialsMessage,
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
  TransmitGate,
  type Camera,
  type Microphone,
  type ProcessAudioTrack,
  type Screen,
  type ScreenQualityPreset,
  type VoiceInputMode,
} from '@disco-voador/media-core';
import {
  P2PMeshTransport,
  type LocalTrackMidEvent,
  type PeerConnectionStateEvent,
  type RemoteTrackEvent,
  type RtcIceServerConfig,
} from '@disco-voador/rtc-core';

import type {
  DesktopProcessAudioEndedInfo,
  DesktopRealtimeConfig,
  DesktopSetPttShortcutResult,
  DesktopVoicePreferenceEntry,
  // T13.4 — re-exported by `shared/ipc-contract.ts` specifically so this Renderer file never has a
  // source-text import specifier naming `@disco-voador/windows-media` at all (this repository's
  // `scripts/verify-architecture.mjs` guardrail forbids that categorically, even for a type-only
  // import that is erased at compile time) — see that file's own doc comment on this re-export.
  PttBinding,
} from '../../shared/ipc-contract.js';
import { deriveServerScopeKey } from '../../shared/voice-preference-scope.js';
import { acquireProcessAudioTrack } from '../media/process-audio-bridge.js';
import { IpcIdentitySigner } from '../realtime/identity-signer.js';
import type {
  ChannelUpdatePatch,
  RealtimeClient,
  ServerInfo,
} from '../realtime/realtime-client.js';
import { channelErrorMessage } from '../workspace/channel-error-copy.js';
import { profileErrorMessage } from '../workspace/profile-error-copy.js';
import { diffParticipantsForSound, playJoinLeaveSound } from './join-leave-sounds.js';
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
import { RemoteAudioGraphController } from './remote-audio-graph.js';
import { releasePublishedScreen } from './screen-share-lifecycle.js';
import type { ScreenShareAudioMode } from './ScreenSourcePicker.js';
import { AnalyserActivitySampler } from './voice-activity-detector.js';

export interface VoiceParticipantView {
  readonly participantId: string;
  readonly displayName: string;
  readonly connectionState: RTCPeerConnectionState | undefined;
  /** T9 — display-only server-local group badges, snapshotted at join time (see
   * `docs/architecture/SERVER_AUTHORIZATION.md`'s known limitations: not live-updated if the
   * participant's groups change mid-session). Empty for a server with no authorization store
   * (`services/realtime`'s own no-op default). */
  readonly groups: readonly GroupBadge[];
  /** T13.4 — this participant's stable, per-server `identityRef` (see `@disco-voador/protocol`'s
   * `identityRefSchema`) — never `identityId`, never `memberRef`. Used only to key local voice
   * volume/"Mute for Me" preference persistence; never rendered, never sent anywhere. `undefined`
   * only for the synthesized local-self entry (`VoiceChannelView.tsx`'s `participantsWithSelf`),
   * which never has (or needs) one — "User Volume"/"Mute for Me" are never offered for the local
   * user in the first place (self-mute already exists for that). */
  readonly identityRef?: string;
  /** T13.4 (UI consistency follow-up) — this participant's online-session `memberRef`, the exact
   * same token `state.members` (server-wide T13.3 presence, keyed by `memberRef`) already uses.
   * Used only to resolve the same server-local `avatarRef`/presence entry Member Panel already shows
   * for this person (`VoiceChannelView.tsx`'s `participantsWithSelf`) — never for persistence (that
   * remains `identityRef`'s job specifically because `memberRef` does not survive a reconnect).
   * `undefined` only for the synthesized local-self entry, which resolves its own avatar from
   * `state.selfAvatarRef` directly instead. */
  readonly memberRef?: string;
  /** T13.4 (UI consistency follow-up) — this participant's real server-local avatar reference,
   * already resolved by `VoiceChannelView.tsx`'s `participantsWithSelf` from `state.members`/
   * `state.selfAvatarRef` (the exact same T13.3 `MemberPanelEntry.avatarRef` source Member Panel
   * already uses) — `use-voice-channel.ts` itself never sets this, since correlating a participant to
   * a member is a presentation-layer concern spanning two independently-updating pieces of state
   * (`state.participants`/`state.members`), and must be re-resolved on every render (a profile update
   * arriving after a participant already joined must still update this live), never baked in once at
   * participant-construction time. `undefined` means "no avatar set" — renders the ordinary
   * initials/color fallback, exactly like `MemberPanelEntry.avatarRef`'s own contract. */
  readonly avatarRef?: AvatarRef | undefined;
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

  // --- T13.3 profile/avatar/presence -----------------------------------------------------------
  // Per-Dedicated-Server only — every field below is reset to its default whenever this connection
  // reaches its terminal `'closed'` state (see the main effect's `onControllerStateChange`), and
  // `members` (but not `avatarCache`, which is content-addressed by sha256 hash and safe to reuse
  // across a same-server reconnect) is also cleared on an unexpected `'reconnecting'` loss, exactly
  // mirroring `chatThreads`' own "never carry stale server-scoped state" discipline. A server switch
  // discards this whole hook instance (`VoiceChannelView` remounts with a fresh `key` — see
  // `App.tsx`), so nothing here can ever bleed from one Dedicated Server into a view of another.

  /** This connection's own manual presence preference — defaults to `'online'` (the server's own
   * documented default for a profile with no prior mutation — see
   * `services/dedicated-server/src/profile/store.ts`) until the real value arrives. That happens on
   * *every* connect/reconnect, not only after a mutation from this Client: `handleIdentityProof`
   * proactively pushes a `server:profile-self-updated` carrying this identity's actual persisted
   * presence/status/avatar as part of the same initial burst as `server:hello`/`voice:catalog`/
   * `server:presence-snapshot` (see that handler's own comment), so a returning user's
   * previously-set away/DND preference or custom status is accurate immediately, never a
   * fabricated-then-corrected guess. */
  readonly selfPresence: PresenceStatus;
  readonly selfCustomStatus: string | undefined;
  readonly selfAvatarRef: AvatarRef | undefined;
  /** This connection's own `memberRef`, learned once from `server:presence-snapshot.selfMemberRef`
   * and then held for the life of the connection (a fresh one is reassigned on every reconnect, via
   * the next snapshot). Exists solely so `onPresenceUpdated`/`onPresenceSnapshot` below can recognize
   * and filter out an update that is really about the local user's own identity — e.g. a moderator
   * clearing this identity's own avatar/status broadcasts `server:presence-updated` naming exactly
   * this `memberRef`, to every ready connection *including this one* (correctly — this connection
   * still needs to learn its own status changed). Without this filter that update would land in
   * `members` as if it were "another member," producing a visible duplicate of the local user
   * alongside the separately-synthesized self entry. */
  readonly selfMemberRef: string | undefined;
  /** Every other currently-online member of the connected server, keyed by `memberRef` — sourced
   * from `server:presence-snapshot`/`-updated`/`-removed`, never from voice-channel participation
   * (T13.3 widens "who is shown" from "in this voice channel" to "connected to this server at
   * all" — see `MemberPanel.tsx`). Never includes the local user's own entry — enforced by filtering
   * any incoming member/update whose `memberRef` equals `selfMemberRef` (see `onPresenceSnapshot`/
   * `onPresenceUpdated`), not merely assumed from the server's own snapshot exclusion, since a
   * *later* `server:presence-updated` about this identity (triggered by someone else, e.g. a
   * moderator clear) is not excluded the same way. `VoiceChannelView.tsx` synthesizes a self entry
   * from `selfPresence`/`selfCustomStatus`/`selfAvatarRef`/`myGroups` instead, mirroring
   * `participantsWithSelf`'s existing precedent. */
  readonly members: ReadonlyMap<string, MemberPresence>;
  /** A non-authoritative local cache of already-fetched-and-Main-re-validated avatar bytes, keyed by
   * `AvatarRef.hash` (content-addressed — the same image reused by two different targets shares one
   * cache entry) and resolved to a `data:` URI ready for `Avatar`'s `imageUrl` prop. Only ever
   * populated by `actions.requestAvatar`'s own successful, re-validated reply — never written from
   * anywhere else, and never contains bytes that failed `validateAvatarImageBytes` in Main. */
  readonly avatarCache: ReadonlyMap<string, string>;

  // --- T13.4 gamer voice experience ------------------------------------------------------------
  // Every field below is a *read-only, derived* mirror of `@disco-voador/media-core`'s `TransmitGate`
  // (the single source of truth this hook constructs fresh per microphone acquisition — see
  // `join()`) or of `remote-audio-graph.ts`'s speaking detection — components never reach into the
  // gate or the audio graph directly (per this task's own "narrow, presentation-only state" rule).

  /** Mirrors `TransmitGate.inputMode` — which input control scheme is currently active. */
  readonly voiceInputMode: VoiceInputMode;
  /** The currently-configured global Push-to-Talk binding, or `null` if none has ever been set —
   * mirrors `settings.json`'s own persisted value (loaded once at mount, updated by
   * `actions.setPttShortcut`/`clearPttShortcut`). */
  readonly pttBinding: PttBinding | null;
  /** `true` for as long as the configured PTT key/button is physically held — a *raw* mirror of
   * `TransmitGate.pttHeld`, always updated regardless of `voiceInputMode` (see `TransmitGate`'s own
   * derivation: this alone never implies transmission unless `voiceInputMode === 'push-to-talk'`).
   * Drives the "PTT held" mic-turns-green feedback, which must be visually distinct from actually
   * speaking. */
  readonly pttHeld: boolean;
  /** 0 (least sensitive) - 1 (most sensitive) — mirrors `settings.json`'s persisted value. */
  readonly voiceActivitySensitivity: number;
  /** Raw local mic-energy detection output (a real, currently-measured signal) — independent of
   * `voiceInputMode`: this is the local voice-activity-detector's own output, always running,
   * whether or not the gate is currently using it to decide transmission. */
  readonly selfVoiceActivityDetected: boolean;
  /** `TransmitGate.shouldTransmit` — whether the local microphone is *actually* transmitting right
   * now (explicit mute always wins; then either PTT-held or voice-activity-detected, depending on
   * `voiceInputMode`). `false` whenever no microphone is currently live (never joined voice yet). */
  readonly effectiveTransmitting: boolean;
  /** The local user's own speaking indicator — reflects genuinely *transmitted* speech
   * (`effectiveTransmitting && selfVoiceActivityDetected`), never merely "PTT is held" or merely
   * "mic energy present while muted" (product spec: holding PTT while silent must not show
   * "speaking"). */
  readonly selfSpeaking: boolean;
  /** Every remote participant currently judged to be speaking, via `remote-audio-graph.ts`'s own
   * per-participant `AnalyserNode`-based detection — updated only on a real transition (never a
   * flood of per-sample renders). */
  readonly speakingParticipantIds: ReadonlySet<string>;
  /** Whether join/leave sounds are currently enabled — mirrors `settings.json`'s persisted value;
   * playback itself is driven by `join-leave-sounds.ts`, not this hook directly. */
  readonly joinLeaveSoundsEnabled: boolean;
  /** T13.4 — mirrors `remote-audio-graph.ts`'s own per-participant volume, purely so the "User
   * Volume" UI can read back the current value without reaching into the graph directly. A
   * participant absent from this map is at the default 100% (never persisted merely to be read
   * back — see `setParticipantVolume`'s own doc comment). Purely session-local for now (see that
   * same doc comment for the not-yet-persisted-by-identityId caveat). */
  readonly participantVolumes: ReadonlyMap<string, number>;
  /** T13.4 — mirrors `remote-audio-graph.ts`'s own per-participant "Mute for Me" state, for the same
   * UI-read-back reason as `participantVolumes`. Purely local: never sent to any Dedicated Server,
   * never visible to the muted person or anyone else. */
  readonly participantLocalMutes: ReadonlySet<string>;
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

/** T13.3 — mirrors `ChannelRequestError` exactly, for the Promise-returning `client:profile-*`
 * mutation actions below (`setSelfAvatar`/`clearSelfAvatar`/etc.) — thrown when the server replies
 * with `server:error` correlated (via `replyTo`) to that specific request. See
 * `workspace/profile-error-copy.ts`'s `describeProfileError` for the matching catch-block funnel. */
export class ProfileRequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProfileRequestError';
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
  /** T13.4 — switches between Voice Activity and Push to Talk. Routed into the live
   * `TransmitGate` immediately (no renegotiation) and persisted to `settings.json`. */
  setVoiceInputMode(mode: VoiceInputMode): void;
  /** T13.4 — 0 (least sensitive) to 1 (most sensitive); re-derives the local voice-activity
   * detector's thresholds immediately if a microphone is currently live, and persisted. */
  setVoiceActivitySensitivity(sensitivity: number): void;
  /** T13.4 — validates/probes/starts the global PTT hotkey via Main (see `docs/adr/
   * 0021-global-ptt-in-process-keyboard-hook.md`); updates `state.pttBinding` only on success. */
  setPttShortcut(binding: PttBinding): Promise<DesktopSetPttShortcutResult>;
  /** T13.4 — stops the current global PTT hotkey listener and clears the persisted binding. */
  clearPttShortcut(): Promise<void>;
  /** T13.4 — toggles join/leave sound notifications for the currently-joined voice channel. */
  setJoinLeaveSoundsEnabled(enabled: boolean): void;
  /** T13.4 — per-participant local playback volume (0-200%), purely client-local (never sent to any
   * Dedicated Server, never visible to the target). A no-op if `participantId` has no remote audio
   * currently attached. */
  setParticipantVolume(participantId: string, percent: number): void;
  /** T13.4 — "Mute for Me" / "Unmute for Me": purely local playback gating, independent of the
   * participant's own self-mute and of any server-side moderation concept. Un-muting restores the
   * previously-configured volume, never resets to 100%. */
  setParticipantLocalMute(participantId: string, muted: boolean): void;
  /** T13.4 — tells the shared remote-audio graph and join/leave-sound playback which output device
   * to route to; does not itself enumerate devices or persist the preference (the caller does both,
   * exactly as it already did before T13.4 for `<RemoteAudio>`'s own `setSinkId`). */
  setOutputDevice(deviceId: string | null): void;
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

  // --- T13.3 profile/avatar/presence ------------------------------------------------------------
  // Every mutation below returns a Promise (mirroring the T13.2 channel-administration actions
  // above) so the Profile Editor / member popover can `await` it and show real, honest,
  // error-code-mapped inline copy — rejects with `ProfileRequestError` when the server replies with
  // a correlated `server:error`. The server remains the sole authority on whether any of these
  // succeed (byte/dimension/format bounds are only ever pre-checked client-side for fast feedback,
  // never trusted as the real enforcement).

  /** `target: 'self'` needs no special permission; `target: 'server'` requires `server.manage` —
   * `ServerSettingsModal` must hide (not merely disable) its own "Server Profile" section for a
   * caller without it, matching this app's established honest-limits convention. */
  setAvatar(
    target: 'self' | 'server',
    format: AvatarImageFormat,
    imageBase64: string,
  ): Promise<void>;
  clearSelfAvatar(): Promise<void>;
  /** Requires `server.manage`. */
  clearServerAvatar(): Promise<void>;
  /** Requires `moderation.profile.clear`; clears only — never sets another member's avatar. */
  clearMemberAvatar(memberRef: string): Promise<void>;
  /** Self-service only — omitting/passing `undefined` clears the current status. */
  setCustomStatus(customStatus: string | undefined): Promise<void>;
  /** Requires `moderation.profile.clear`; clears only — never sets another member's status. */
  clearMemberStatus(memberRef: string): Promise<void>;
  /** Self-service only. No `'invisible'` option exists on this wire protocol or in this UI — see
   * `PresenceStatus`. */
  setPresence(presence: PresenceStatus): Promise<void>;
  /**
   * Fire-and-forget: requests `target`'s current avatar bytes (a no-op if a request for the same
   * target is already in flight, or if this exact content is already in `state.avatarCache`), and,
   * once Main has re-validated the reply, populates `state.avatarCache` keyed by the resulting
   * `AvatarRef.hash`. A `MEMBER_NOT_FOUND`/"no avatar set" reply is a normal, silent no-op — never
   * surfaced as an error (the caller simply keeps seeing the initials fallback).
   */
  requestAvatar(target: 'self' | 'server' | 'member', memberRef?: string): void;
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

/**
 * T13.4 — every current `participantId` mapped to `identityRef` in `participantIdsByIdentity` (a
 * plain `participantId -> identityRef` map, exactly `identityRefByParticipantIdRef`'s own shape) —
 * normally exactly one, but T13.3 explicitly supports multiple simultaneous connections for the same
 * identity, and a local volume/mute adjustment must apply to *every* one of that identity's active
 * voice sessions at once, never just the row the user happened to click (this task's own brief,
 * Sections 8/28: "do not create separate persisted values for each session participantId"). Order is
 * whatever `Map` iteration order produces (insertion order) — callers must not depend on which
 * `participantId` comes first.
 */
export function participantIdsForIdentityRef(
  participantIdsByIdentity: ReadonlyMap<string, string>,
  identityRef: string,
): string[] {
  const result: string[] = [];
  for (const [participantId, ref] of participantIdsByIdentity) {
    if (ref === identityRef) result.push(participantId);
  }
  return result;
}

function toRtcIceCandidateInit(payload: IceCandidatePayload | null): RTCIceCandidateInit | null {
  if (payload === null) return null;
  const init: RTCIceCandidateInit = { candidate: payload.candidate };
  if (payload.sdpMid !== undefined) init.sdpMid = payload.sdpMid;
  if (payload.sdpMLineIndex !== undefined) init.sdpMLineIndex = payload.sdpMLineIndex;
  if (payload.usernameFragment !== undefined) init.usernameFragment = payload.usernameFragment;
  return init;
}

/**
 * T14 — translates one `ServerTurnCredentialsMessage.iceServers` element (the wire shape) into
 * `packages/rtc-core`'s own `RtcIceServerConfig` — the two are structurally near-identical
 * (`urls`/`username`/`credential`, per that message's own doc comment: "mirrors the shape
 * `RTCPeerConnection`'s own `iceServers` constructor option expects"), but a plain cast/spread does
 * not compile under this project's `exactOptionalPropertyTypes: true`: the zod-inferred wire type's
 * optional fields are `string | undefined`, while `RtcIceServerConfig`'s are bare `string` (only
 * omittable, never assignable `undefined`) — mirrors `toRtcIceCandidateInit`'s own "only set the key
 * when the source value is not `undefined`" pattern immediately above for the identical reason.
 */
function toRtcIceServerConfig(
  server: ServerTurnCredentialsMessage['iceServers'][number],
): RtcIceServerConfig {
  return {
    urls: server.urls,
    ...(server.username !== undefined ? { username: server.username } : {}),
    ...(server.credential !== undefined ? { credential: server.credential } : {}),
  };
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
  selfPresence: 'online',
  selfCustomStatus: undefined,
  selfAvatarRef: undefined,
  selfMemberRef: undefined,
  members: new Map(),
  avatarCache: new Map(),
  voiceInputMode: 'voice-activity',
  pttBinding: null,
  pttHeld: false,
  voiceActivitySensitivity: 0.5,
  selfVoiceActivityDetected: false,
  effectiveTransmitting: false,
  selfSpeaking: false,
  speakingParticipantIds: new Set(),
  participantVolumes: new Map(),
  participantLocalMutes: new Set(),
  joinLeaveSoundsEnabled: true,
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
  /** T13.4 — mirrors `mutedRef`'s own "ref alongside `state.deafened` so an imperative call site
   * (graph construction, `setDeafened`) always has a synchronous current value" pattern — read once
   * at graph-construction time in the main connection effect, and kept current by the `setDeafened`
   * action and the mount-time settings-load effect below. */
  const deafenedRef = useRef(false);
  // T13.4 — the single source of truth for "should the mic actually transmit right now" (see
  // `@disco-voador/media-core`'s `TransmitGate`). Constructed fresh on every microphone acquisition
  // (`join()`'s initial acquire, a reconnect's fresh reacquire via the same `join()` restore path) —
  // never reused across those — and discarded (`undefined`) whenever the microphone itself is
  // released (`releaseMicrophone()`, the effect's own final cleanup). `rebind()`-ed, not
  // reconstructed, for a live T11 device switch (see `switchMicrophone`).
  const transmitGateRef = useRef<TransmitGate | undefined>(undefined);
  /** T13.4 — the local voice-activity detector's own live audio-graph handle (a small,
   * analysis-only `AudioContext`/`AnalyserNode` pair tapped off a *cloned* copy of the current
   * microphone's track, feeding `transmitGateRef.current?.setVoiceActivityDetected`) — always
   * running once a microphone is live, regardless of `voiceInputMode` (the gate itself only *uses*
   * this signal in `'voice-activity'` mode; this ref's own lifecycle mirrors `microphoneRef`'s
   * exactly). **Real bug found and fixed via `e2e:voice-smoke`**: this must analyze a *cloned*
   * `MediaStreamTrack` (`analysisTrack` below), never `microphone.track` itself — per the Media
   * Capture and Streams specification, a disabled (`track.enabled = false`) track emits *silence* to
   * every consumer, including a local `MediaStreamAudioSourceNode`, not merely to the
   * `RTCPeerConnection` sender. `TransmitGate` is exactly what disables `microphone.track` while not
   * transmitting — analyzing that same track directly created a permanent deadlock in Voice Activity
   * mode (muted-for-not-speaking -> the very energy analysis meant to un-mute it reads silence
   * forever -> never un-mutes). `MediaStreamTrack.clone()` shares the same underlying hardware
   * source but has its own, independently-controlled `enabled` flag, so it keeps reading the real
   * microphone signal regardless of what the gate does to the original. The clone needs its own
   * explicit `.stop()` (a clone's lifecycle is independent of the original's — stopping one never
   * stops the other), done in `stopLocalVoiceActivityDetection`. */
  const localVoiceActivityRef = useRef<
    | {
        readonly audioContext: AudioContext;
        readonly analysisTrack: MediaStreamTrack;
        readonly source: MediaStreamAudioSourceNode;
        readonly analyser: AnalyserNode;
        readonly sampler: AnalyserActivitySampler;
      }
    | undefined
  >(undefined);
  /** T13.4 — mirrors `preferredMicDeviceIdRef`'s own "loaded once at mount, read by every later
   * acquisition/mutation site" pattern, for the input-mode/sensitivity preferences a fresh
   * `TransmitGate`/voice-activity detector needs at construction time. */
  const inputModeRef = useRef<VoiceInputMode>('voice-activity');
  const voiceActivitySensitivityRef = useRef(0.5);
  const joinLeaveSoundsEnabledRef = useRef(true);
  /** T13.4 — one `RemoteAudioGraphController` per connection session (constructed once per main
   * connection effect run — see that effect — never per participant churn), owning every remote
   * microphone stream's Web Audio playback/volume/speaking-detection graph. `undefined` only before
   * the first connection effect run has completed its setup (never observably so from outside this
   * hook). */
  const remoteAudioGraphRef = useRef<RemoteAudioGraphController | undefined>(undefined);
  /** T13.4 — join/leave sound dedup baseline (see `join-leave-sounds.ts`'s own doc comment for the
   * exact semantics `undefined` vs. a real `Set` encodes). Reset to `undefined` at every point a
   * fresh "first snapshot" genuinely begins: explicit `leave()`, `onLeft`, `onReconnecting`, and a
   * policy-forced channel removal. */
  const knownParticipantIdsForSoundRef = useRef<ReadonlySet<string> | undefined>(undefined);
  /** T13.4 — the currently-selected output device, mirrored here (kept in sync by
   * `VoiceChannelView.tsx`'s own settings-load effect is out of this hook's reach) so
   * `remoteAudioGraphRef`/join-leave-sound playback can route to it without a second IPC round trip.
   * Loaded once at mount alongside every other T13.4 preference below. */
  const outputDeviceIdRef = useRef<string | null>(null);
  /** T13.4 — the current connection's local voice-preference server scope key (see
   * `shared/voice-preference-scope.ts`'s `deriveServerScopeKey`), derived once per real connection
   * (main connection effect, from `realtimeConfig.url`'s own resolved host:port — the same value on
   * every T11 reconnect attempt for this session, since the url does not change; a genuinely
   * different value only on an actual server switch, which remounts this whole effect). `undefined`
   * only before the first connection effect run completes its setup. */
  const serverScopeKeyRef = useRef<string | undefined>(undefined);
  /** T13.4 — every currently-relevant participant's stable, per-server `identityRef` (see
   * `@disco-voador/protocol`'s `identityRefSchema`), keyed by their current, session-scoped
   * `participantId` — populated from `ServerVoiceJoinedMessage`/`ServerVoiceParticipantJoinedMessage`
   * exactly where `state.participants` itself is populated, and cleared at the same points. This is
   * what lets `attachParticipant`/`setParticipantVolume`/`setParticipantLocalMute` key local
   * preference persistence by the *stable* identity rather than the *session-scoped* participant
   * slot — see the attach-with-preference effect and `setParticipantVolume`'s own doc comment below. */
  const identityRefByParticipantIdRef = useRef<Map<string, string>>(new Map());
  /** T13.4 — mirrors `state.participantVolumes`/`state.participantLocalMutes` every render (assigned
   * directly in the render body, not inside an effect — a standard, React-sanctioned "always read the
   * latest value from inside a `useCallback` with an empty dependency array" pattern) purely so
   * `setParticipantVolume`/`setParticipantLocalMute` can read each other's *current* value (needed to
   * persist a single combined `{volumePercent, locallyMuted}` entry) without stale closures or
   * needing either state field in their own dependency array. */
  const participantVolumesRef = useRef(state.participantVolumes);
  participantVolumesRef.current = state.participantVolumes;
  const participantLocalMutesRef = useRef(state.participantLocalMutes);
  participantLocalMutesRef.current = state.participantLocalMutes;
  /** T13.4 — mirrors `state.remoteAudioStreams` every render, for the same reason as the two refs
   * immediately above: the attach-with-preference effect below awaits an IPC round trip before
   * calling `attachParticipant`, and must re-check *after* that await whether the participant it was
   * about to attach is still actually current (they may have left, or gotten a newer stream, while
   * the lookup was in flight) — a plain closure over `state.remoteAudioStreams` captured at effect-run
   * time would go stale the instant a *later* effect run replaces it. */
  const latestRemoteAudioStreamsRef = useRef(state.remoteAudioStreams);
  latestRemoteAudioStreamsRef.current = state.remoteAudioStreams;
  /** T13.4 — one pending debounced/immediate local voice-preference write per `identityRef`, keyed so
   * a later change (of either kind) for the same identity always supersedes an earlier still-pending
   * one rather than racing it. See `schedulePersistVolume`/`persistVoicePreferenceNow`/
   * `flushPendingVoicePreferences` below. */
  const pendingVoicePreferenceWritesRef = useRef<
    Map<
      string,
      { readonly timer: ReturnType<typeof setTimeout>; readonly entry: DesktopVoicePreferenceEntry }
    >
  >(new Map());
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

  /** T13.3 — correlates a `client:profile-*` mutation request's generated id back to the Promise a
   * caller (Profile Editor, member popover) is awaiting — mirrors `pendingChannelRequestsRef`
   * exactly. Resolved by `onProfileSelfUpdated`; rejected (with a `ProfileRequestError`) by
   * `onServerError` when a `server:error`'s `replyTo` matches a still-pending entry. */
  const pendingProfileRequestsRef = useRef(
    new Map<string, { readonly resolve: () => void; readonly reject: (error: Error) => void }>(),
  );
  /** T13.3 — correlates a `client:profile-request-avatar` request's generated id back to which
   * *target key* (`'self'`, `'server'`, or `'member:<memberRef>'`) it was for — `onProfileAvatarData`
   * needs this to know which dimension ceiling (512 vs. 1024) to re-validate against; `onServerError`
   * needs it to recognize a `MEMBER_NOT_FOUND`/"no avatar" reply as this silent, non-fatal case
   * rather than falling through to the generic error toast. */
  const pendingAvatarRequestIdsRef = useRef(new Map<string, string>());
  /** T13.3 — the set of target keys with an avatar request currently in flight, so
   * `actions.requestAvatar` never sends a second concurrent request for the same target (e.g. a
   * fast-scrolling member list re-rendering the same row). Cleared alongside the corresponding
   * entry in `pendingAvatarRequestIdsRef`. */
  const inFlightAvatarTargetKeysRef = useRef(new Set<string>());

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
        deafenedRef.current = settings.voice.startDeafened;
        // T13.4 — mirrors every preference-ref above: loaded once at mount, read by every later
        // gate-construction/detection-tap/sound-playback site via the ref, not re-read from disk.
        inputModeRef.current = settings.voice.inputMode;
        voiceActivitySensitivityRef.current = settings.voice.voiceActivitySensitivity;
        joinLeaveSoundsEnabledRef.current = settings.voice.joinLeaveSoundsEnabled;
        outputDeviceIdRef.current = settings.audio.outputDeviceId;
        // T13.4 — this settings load is asynchronous and can resolve *after* the main connection
        // effect has already constructed `remoteAudioGraphRef.current` (which reads these same refs
        // synchronously, at their initial default values, to seed the graph — see that effect). If
        // that race happened, push the real persisted values into the already-built graph now rather
        // than leaving it silently stuck on system-default output/never-deafened until the next
        // explicit `setOutputDevice`/`setDeafened` call.
        if (remoteAudioGraphRef.current) {
          void remoteAudioGraphRef.current.setOutputDevice(settings.audio.outputDeviceId);
          remoteAudioGraphRef.current.setDeafened(settings.voice.startDeafened);
        }
        setState((prev) => ({
          ...prev,
          muted: settings.voice.startMuted,
          deafened: settings.voice.startDeafened,
          voiceInputMode: settings.voice.inputMode,
          pttBinding: settings.voice.pttBinding,
          voiceActivitySensitivity: settings.voice.voiceActivitySensitivity,
          joinLeaveSoundsEnabled: settings.voice.joinLeaveSoundsEnabled,
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

    // T13.4 — derived once per real connection (stable across every T11 reconnect attempt for this
    // session, since `url` does not change; only a genuine server switch, which remounts this whole
    // effect, produces a different value) — see `serverScopeKeyRef`'s own doc comment. `url` is
    // always a `ws://host:port` or `wss://host:port` string (see `parse-server-address.ts`), and
    // `URL.host` yields the same `host[:port]` shape regardless of which of those two schemes is
    // present, so `new URL(url).host` is exactly the shape `deriveServerScopeKey` expects — never
    // re-derived independently from `main/settings/settings-file.ts`'s own copy, which would risk
    // the two drifting apart.
    serverScopeKeyRef.current = deriveServerScopeKey(new URL(url).host);

    // T10 — a fresh connection starts with no outstanding chat-history requests; any left over
    // from a previous connection are meaningless (their responses, if they ever arrived, would be
    // ignored anyway since this hook only listens on the *current* client instance).
    pendingChatHistoryRequestsRef.current = new Map();
    chatThreadsRef.current = new Map();
    openChatThreadsBeforeLossRef.current = [];
    currentChannelRef.current = undefined;
    // T13.4 — a fresh connection has no known participant roster to diff join/leave sounds against.
    knownParticipantIdsForSoundRef.current = undefined;
    // T13.2 — mirrors the chat-history reset immediately above: a fresh connection starts with no
    // outstanding channel-admin requests or in-flight join to correlate against.
    pendingChannelRequestsRef.current = new Map();
    lastJoinRequestRef.current = undefined;
    // T13.3 — mirrors the same reset for profile mutations/avatar-fetch bookkeeping.
    pendingProfileRequestsRef.current = new Map();
    pendingAvatarRequestIdsRef.current = new Map();
    inFlightAvatarTargetKeysRef.current = new Set();

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
    /**
     * T15.1 — the ICE server list a `P2PMeshTransport` is *constructed* with, kept as a mutable
     * binding so it survives `recreateTransport()`.
     *
     * Previously both the initial construction and every reconnect's `recreateTransport()` passed
     * the bare `iceServers` const (the operator's configured STUN list, which is legitimately empty
     * in a default deployment), and the merged STUN+TURN list existed only inside the already-
     * constructed transport. A reconnect therefore threw away every TURN server this session had
     * already learned about and started again from nothing, re-opening the same "peer connections
     * created before TURN is known" window on every single reconnect — worst for exactly the
     * restrictive-NAT clients that need TURN in the first place and reconnect most often.
     *
     * A retained credential can be near or past its own `expiresAt` by the time a reconnect reuses
     * it, which is fine and deliberate: the reconnect's own identity handshake always mints a fresh
     * set moments later, and `P2PMeshTransport.setIceServers` now pushes that fresh set into any
     * peer that has not connected yet (see that method's T15.1 doc comment). Starting a reconnect
     * from the last-known list is therefore never worse than starting from an empty one.
     */
    let currentIceServers: readonly RtcIceServerConfig[] = iceServers;

    let transport = new P2PMeshTransport({ iceServers: currentIceServers }, client);
    transportRef.current = transport;

    // T13.4 Decision 3 — one `RemoteAudioGraphController` per connection session, matching this
    // effect's own per-`realtimeConfig` lifetime exactly (constructed once per effect run here,
    // disposed once in this effect's own cleanup below — never per participant churn, never
    // recreated by an internal `recreateTransport()` reconnect cycle, mirroring `reconciler`'s own
    // "one instance per connection lifetime, `reset()` on reconnect" precedent for its own
    // per-participant bookkeeping instead). Attach/detach for individual participants is driven by a
    // separate hook-level effect watching `state.remoteAudioStreams` (see below this main effect).
    remoteAudioGraphRef.current = new RemoteAudioGraphController({
      sensitivity: voiceActivitySensitivityRef.current,
      initialDeafened: deafenedRef.current,
      onSpeakingChange: (participantId, speaking) => {
        setState((prev) => {
          const next = new Set(prev.speakingParticipantIds);
          if (speaking) next.add(participantId);
          else next.delete(participantId);
          return { ...prev, speakingParticipantIds: next };
        });
      },
    });
    void remoteAudioGraphRef.current.setOutputDevice(outputDeviceIdRef.current);

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
      // T13.4 — the gate and its local voice-activity detector are scoped to exactly one microphone
      // acquisition (see `transmitGateRef`'s own doc comment: a reconnect's fresh reacquire via
      // `join()` constructs a brand-new gate, never resurrects this one) — discarded here alongside
      // the microphone itself, never left dangling with a `MutableMicrophone` reference to a track
      // that no longer exists.
      stopLocalVoiceActivityDetection();
      transmitGateRef.current = undefined;
      setState((prev) => ({
        ...prev,
        localMicrophoneStream: undefined,
        micUsingFallback: false,
        micDisconnected: false,
        pttHeld: false,
        selfVoiceActivityDetected: false,
        effectiveTransmitting: false,
        selfSpeaking: false,
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

      // T15.1 — the last-known combined STUN+TURN list, never the bare configured STUN list; see
      // `currentIceServers`' own doc comment above for why a reconnect must not reset it.
      transport = new P2PMeshTransport({ iceServers: currentIceServers }, client);
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
        // T13.3 — mirrors the channel-admin-request cleanup immediately above, for profile
        // mutations; avatar-fetch bookkeeping has no Promise to reject (it is fire-and-forget) so it
        // is simply cleared.
        for (const pending of pendingProfileRequestsRef.current.values()) {
          pending.reject(new Error('Disconnected before the server replied.'));
        }
        pendingProfileRequestsRef.current = new Map();
        pendingAvatarRequestIdsRef.current = new Map();
        inFlightAvatarTargetKeysRef.current = new Set();
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
              // T13.3 — per-Dedicated-Server profile/presence state must never survive past this
              // connection's own terminal close (see `VoiceChannelState`'s own doc comment on this).
              selfPresence: 'online' as const,
              selfCustomStatus: undefined,
              selfAvatarRef: undefined,
              selfMemberRef: undefined,
              members: new Map<string, MemberPresence>(),
              avatarCache: new Map<string, string>(),
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
      // T13.4 — the connection just died; the restore `join()` inside `onReconnected` will fire a
      // fresh `voice:joined` (which resets this itself too — see `onJoined`), but resetting here as
      // well means the transient empty-participants state this handler's own `setState` below
      // produces can never itself be misread as everyone having "left".
      knownParticipantIdsForSoundRef.current = undefined;

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
      // T13.3 — mirrors the channel-admin cleanup immediately above. `members` is cleared too (a
      // fresh `server:presence-snapshot` always arrives once reconnected — see `onPresenceSnapshot`
      // — so a stale membership list is never worth keeping across the gap); `avatarCache` is
      // deliberately left untouched, since it is content-addressed by hash and still valid for the
      // same server once reconnected.
      for (const pending of pendingProfileRequestsRef.current.values()) {
        pending.reject(new Error('Connection lost before the server replied.'));
      }
      pendingProfileRequestsRef.current = new Map();
      pendingAvatarRequestIdsRef.current = new Map();
      inFlightAvatarTargetKeysRef.current = new Set();

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
        // T13.3 — a fresh `server:presence-snapshot` always arrives once reconnected (see
        // `onPresenceSnapshot`); `avatarCache` is deliberately preserved (see the comment on
        // `inFlightAvatarTargetKeysRef`'s reset immediately above).
        members: new Map<string, MemberPresence>(),
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

    /** T14 — merges the STUN servers this connection was configured with (the `iceServers` const
     * captured once above, from `realtimeConfig`) with the Dedicated Server's just-issued
     * short-lived TURN credentials, then applies the combined list to whichever `P2PMeshTransport`
     * is *currently* live. Reads the mutable `transport` binding (not a snapshot) specifically so
     * this keeps working correctly regardless of whether `turnCredentials` arrives before or after
     * a given `recreateTransport()` call — a closure over a `let` binding always observes its
     * latest value, exactly like every other closure in this effect that references `transport`
     * (see `recreateTransport`'s own doc comment). `P2PMeshTransport.setIceServers` is REPLACE, not
     * merge, semantics (see that method's own doc comment in `packages/rtc-core`) — STUN must be
     * re-supplied here every time rather than relying on the transport to remember its own
     * constructor value. Only ever fires when the Dedicated Server actually has TURN configured
     * (`server:turn-credentials` is never sent otherwise); if it never arrives, this handler simply
     * never runs and every peer connection keeps using `iceServers` (STUN only) exactly as before
     * this feature existed — a fully supported, no-op-safe degradation. */
    const onTurnCredentials = (message: ServerTurnCredentialsMessage) => {
      currentIceServers = [...iceServers, ...message.iceServers.map(toRtcIceServerConfig)];
      transport.setIceServers(currentIceServers);
      // Public metadata only — counts and a boolean, never a URL, username, or credential value.
      // Exists so a real client's TURN availability can be confirmed from its own logs without
      // anyone ever having to inspect (or accidentally paste) a live credential.
      console.info(
        `disco-voador:turn-credentials:servers=${message.iceServers.length}` +
          `:credentialed=${message.iceServers.every((server) => typeof server.credential === 'string')}` +
          `:expiresInSeconds=${Math.max(0, Math.round((Date.parse(message.expiresAt) - Date.now()) / 1000))}`,
      );
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
      // T13.4 — every `voice:joined` (a genuine first join, a channel switch, or a T11
      // reconnect-restore) is a fresh "first snapshot" for join/leave-sound purposes — the roster
      // this event carries must never be diffed against whatever channel's roster was known before
      // (see `join-leave-sounds.ts`'s own dedup-semantics doc comment).
      knownParticipantIdsForSoundRef.current = undefined;
      // T13.4 — a fresh `identityRef` roster to match the fresh participant roster above; this event
      // is always a genuine "here is who is here now" snapshot (initial join, channel switch, or a
      // T11 reconnect-restore), never a delta.
      identityRefByParticipantIdRef.current = new Map(
        message.participants.map((p) => [p.participantId, p.identityRef]),
      );
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
          identityRef: p.identityRef,
          memberRef: p.memberRef,
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
      // T13.4 — no longer in any channel; the next `voice:joined` establishes a fresh baseline.
      knownParticipantIdsForSoundRef.current = undefined;
      identityRefByParticipantIdRef.current = new Map();
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
      // T13.4 — mirrors `onLeft`'s own reset exactly (this connection is no longer in any channel).
      knownParticipantIdsForSoundRef.current = undefined;
      identityRefByParticipantIdRef.current = new Map();
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
      identityRefByParticipantIdRef.current.set(
        message.participant.participantId,
        message.participant.identityRef,
      );
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
            identityRef: message.participant.identityRef,
            memberRef: message.participant.memberRef,
          },
        ],
      }));
    };

    const onParticipantLeft = (message: ServerVoiceParticipantLeftMessage) => {
      currentParticipantIds.delete(message.participantId);
      identityRefByParticipantIdRef.current.delete(message.participantId);
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

      // T13.3 — a `client:profile-*` mutation awaiting its own Promise settlement.
      const pendingProfileRequest = message.replyTo
        ? pendingProfileRequestsRef.current.get(message.replyTo)
        : undefined;
      if (pendingProfileRequest) {
        pendingProfileRequestsRef.current.delete(message.replyTo as string);
        pendingProfileRequest.reject(
          new ProfileRequestError(
            message.code,
            profileErrorMessage(message.code) ?? message.message,
          ),
        );
        return;
      }

      // T13.3 — a `client:profile-request-avatar` this hook itself issued. `MEMBER_NOT_FOUND` (also
      // used, by extension, for "no avatar currently set" on a self/server request — see
      // `handleProfileRequestAvatar`'s own doc comment server-side) is a normal, silent no-op here:
      // the caller simply keeps seeing the initials fallback, never a visible error toast.
      const avatarRequestTargetKey = message.replyTo
        ? pendingAvatarRequestIdsRef.current.get(message.replyTo)
        : undefined;
      if (avatarRequestTargetKey !== undefined) {
        pendingAvatarRequestIdsRef.current.delete(message.replyTo as string);
        inFlightAvatarTargetKeysRef.current.delete(avatarRequestTargetKey);
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

    // --- T13.3 profile/avatar/presence --------------------------------------------------------

    const onProfileSelfUpdated = (message: ServerProfileSelfUpdatedMessage) => {
      const pending = pendingProfileRequestsRef.current.get(message.id);
      if (pending) {
        pendingProfileRequestsRef.current.delete(message.id);
        pending.resolve();
      }
      setState((prev) => ({
        ...prev,
        // `message.presence` is `EffectivePresence` (includes `'offline'`); this reply is always the
        // actor's own state while this very connection is live, so `'offline'` should never actually
        // occur here — the fallback to the previous value is a defensive, never-fabricating guard,
        // not a real expected path.
        selfPresence: message.presence === 'offline' ? prev.selfPresence : message.presence,
        selfCustomStatus: message.customStatus,
        selfAvatarRef: message.avatarRef,
      }));
    };

    /** Re-validates the received bytes in Main (`validateAvatarImageBytes`) before ever caching or
     * rendering them — a hostile/compromised server operator is an untrusted input source into the
     * local filesystem/renderer (see `main/avatar-images.ts`'s own doc comment). A failed
     * (re-)validation is logged and silently dropped — never cached, never displayed — rather than
     * surfaced as a user-visible error, mirroring `MEMBER_NOT_FOUND`'s own "just show initials"
     * treatment for every other avatar-fetch failure mode. */
    const onProfileAvatarData = (message: ServerProfileAvatarDataMessage) => {
      const targetKey = pendingAvatarRequestIdsRef.current.get(message.id);
      pendingAvatarRequestIdsRef.current.delete(message.id);
      if (targetKey !== undefined) inFlightAvatarTargetKeysRef.current.delete(targetKey);

      const maxDimension: 512 | 1024 = targetKey === 'server' ? 1024 : 512;
      void (async () => {
        let validation;
        try {
          validation = await window.desktopApp.validateAvatarImageBytes(
            message.imageBase64,
            message.format,
            maxDimension,
          );
        } catch (error) {
          console.error('voice: failed to validate avatar bytes received from the server', error);
          return;
        }
        if (!validation.ok) {
          console.error(
            'voice: rejected avatar bytes received from the server',
            validation.code,
            validation.message,
          );
          return;
        }
        const dataUrl = `data:image/${message.format};base64,${message.imageBase64}`;
        setState((prev) => {
          const next = new Map(prev.avatarCache);
          next.set(message.avatarRef.hash, dataUrl);
          return { ...prev, avatarCache: next };
        });
      })();
    };

    /** The full online-member snapshot, sent once when this connection becomes `ready` — replaces
     * `state.members` wholesale (never merges), matching `onCatalog`'s own "resend the whole small
     * bounded thing" convention exactly. */
    const onPresenceSnapshot = (message: ServerPresenceSnapshotMessage) => {
      const next = new Map<string, MemberPresence>();
      // Defensive, not load-bearing: the server already omits `selfMemberRef` from `message.members`
      // (see `serverPresenceSnapshotMessageSchema`'s own doc comment) — this filter exists so the
      // invariant holds structurally here too, matching `onPresenceUpdated` below, where it *is*
      // load-bearing.
      for (const member of message.members) {
        if (member.memberRef !== message.selfMemberRef) next.set(member.memberRef, member);
      }
      setState((prev) => ({ ...prev, members: next, selfMemberRef: message.selfMemberRef }));
    };

    const onPresenceUpdated = (message: ServerPresenceUpdatedMessage) => {
      setState((prev) => {
        // A moderator clearing this identity's own avatar/status broadcasts this update to every
        // ready connection including this one (correctly — see `selfMemberRef`'s own doc comment on
        // `VoiceChannelState`). Route it into the self-* fields instead of `members` — the local user
        // just learned their own avatar/status was cleared and should see that reflected immediately,
        // and adding it to `members` too would render a duplicate of themselves. `message.member`'s
        // `presence` is never actually `'offline'` here (it is always an online member's own
        // preference — see `buildMemberPresenceView`), but the same defensive guard
        // `onProfileSelfUpdated` already uses is mirrored for consistency rather than assumed.
        if (message.member.memberRef === prev.selfMemberRef) {
          return {
            ...prev,
            selfPresence:
              message.member.presence === 'offline' ? prev.selfPresence : message.member.presence,
            selfCustomStatus: message.member.customStatus,
            selfAvatarRef: message.member.avatarRef,
          };
        }
        const next = new Map(prev.members);
        next.set(message.member.memberRef, message.member);
        return { ...prev, members: next };
      });
    };

    const onPresenceRemoved = (message: ServerPresenceRemovedMessage) => {
      setState((prev) => {
        if (!prev.members.has(message.memberRef)) return prev;
        const next = new Map(prev.members);
        next.delete(message.memberRef);
        return { ...prev, members: next };
      });
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
    client.on('profileSelfUpdated', onProfileSelfUpdated);
    client.on('profileAvatarData', onProfileAvatarData);
    client.on('presenceSnapshot', onPresenceSnapshot);
    client.on('presenceUpdated', onPresenceUpdated);
    client.on('presenceRemoved', onPresenceRemoved);
    client.on('turnCredentials', onTurnCredentials);
    transport.on('remoteTrack', onRemoteTrack);
    transport.on('localTrackMid', onLocalTrackMid);
    transport.on('peerStateChanged', onPeerStateChanged);
    const unsubscribeProcessAudioEnded = window.desktopApp.onProcessAudioEnded(onProcessAudioEnded);

    controller.connect();

    return () => {
      // This is a genuinely final teardown (unmount, or the user connected to a different
      // server/address) — `controller.disconnect()` marks the sequence as deliberately ended, so no
      // reconnect timer can fire after this point (T11 Section 39/57/82). It is called *before*
      // detaching `'stateChange'` (unlike every other listener below) specifically so its
      // synchronous `'closed'` emission still reaches `onControllerStateChange` — that handler's own
      // `'closed'` branch is what actually clears per-Dedicated-Server profile/presence state
      // (`members`/`avatarCache`/`selfPresence`/etc., T13.3) and rejects pending channel/profile
      // requests. Detaching first would silently skip that reset on every real teardown path
      // (this repo's own `AppShell` remount-by-connection-key currently masks the gap with a fresh
      // `useState` anyway, but this handler should not rely on that to keep its own documented
      // guarantee true).
      controller.disconnect();
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
      client.off('profileSelfUpdated', onProfileSelfUpdated);
      client.off('profileAvatarData', onProfileAvatarData);
      client.off('presenceSnapshot', onPresenceSnapshot);
      client.off('presenceUpdated', onPresenceUpdated);
      client.off('presenceRemoved', onPresenceRemoved);
      client.off('turnCredentials', onTurnCredentials);
      transport.off('remoteTrack', onRemoteTrack);
      transport.off('localTrackMid', onLocalTrackMid);
      transport.off('peerStateChanged', onPeerStateChanged);
      unsubscribeProcessAudioEnded();

      // The transport is discarded along with this effect run — permanent teardown is correct
      // here, unlike a mid-session channel switch (`onJoined`/`onLeft` above use
      // `removeParticipant`, never `closeAll`, since `closeAll` permanently disables the
      // transport).
      transport.closeAll();
      microphoneRef.current?.stop();
      microphoneRef.current = undefined;
      // T13.4 — full session teardown: the gate/local voice-activity tap and the shared remote-audio
      // graph are both scoped to this connection's lifetime (see `transmitGateRef`/
      // `remoteAudioGraphRef`'s own doc comments) — never left running past it.
      stopLocalVoiceActivityDetection();
      transmitGateRef.current = undefined;
      remoteAudioGraphRef.current?.disposeAll();
      remoteAudioGraphRef.current = undefined;
      // T13.4 — a genuinely final teardown (unmount, or a real server switch) must never silently
      // drop a still-debounced local volume-slider write (Section 13's "do not silently lose the
      // latest change on shutdown/finalization") — flush every pending write immediately rather than
      // let its timer simply never fire once this session's refs are cleared below.
      flushPendingVoicePreferences();
      identityRefByParticipantIdRef.current = new Map();
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
   * T13.4 Decision 1/2 — subscribes once, for the life of this hook, to Main's global PTT `'down'`/
   * `'up'` push (see `docs/adr/0021-global-ptt-in-process-keyboard-hook.md`) — deliberately
   * independent of `realtimeConfig`/connection lifecycle (the whole point of a *global* hotkey is
   * that it keeps working while unfocused/disconnected/mid-reconnect; Main's own listener lifecycle
   * is equally independent — see `main/ptt-hotkey.ts`). Every edge is forwarded to the current
   * `TransmitGate` unconditionally, regardless of `voiceInputMode` — the gate's own derivation
   * formula only *uses* `pttHeld` in `'push-to-talk'` mode, so forwarding it in `'voice-activity'`
   * mode is harmless and keeps this one subscription simple rather than resubscribing on every mode
   * change. A no-op when no microphone is currently live (`transmitGateRef.current` is `undefined`
   * until `join()`'s first successful acquisition) — nothing to gate yet.
   */
  useEffect(() => {
    const unsubscribe = window.desktopApp.onPttState((event) => {
      transmitGateRef.current?.setPttHeld(event.type === 'down');
      pushGateDerivedState();
    });
    return unsubscribe;
  }, []);

  /**
   * T13.4 Decision 3 — attaches/detaches each remote participant's Web Audio playback/analysis graph
   * as `state.remoteAudioStreams` changes (new participant, participant left, or a full reset on
   * reconnect via `createEmptyRemoteMediaStreamsState()` — see the main connection effect's
   * `onReconnecting`), diffed against the previous render's own attached set. Deliberately *not*
   * inside the main connection effect itself: `remoteAudioGraphRef.current` is constructed once per
   * connection session by that effect (see its own doc comment), and this effect's job is only ever
   * to keep individual participant attachment in sync with already-derived React state — the same
   * "state-driven diff, not imperative event-driven" shape `remoteCameraParticipantIds`/
   * `remoteScreenParticipantIds` already use one layer up in `VoiceChannelView.tsx`, applied here
   * for the audio graph's own attach/detach calls instead.
   */
  const attachedRemoteAudioParticipantIdsRef = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const graph = remoteAudioGraphRef.current;
    if (!graph) return;
    const previouslyAttached = attachedRemoteAudioParticipantIdsRef.current;
    const currentIds = new Set(state.remoteAudioStreams.keys());

    for (const participantId of previouslyAttached) {
      if (!currentIds.has(participantId)) graph.detachParticipant(participantId);
    }
    for (const [participantId, stream] of state.remoteAudioStreams) {
      if (!previouslyAttached.has(participantId)) {
        void attachWithStoredPreference(graph, participantId, stream);
      }
    }
    // Marked attached here, synchronously, even though the real `graph.attachParticipant` call for a
    // brand-new participant is deferred behind `attachWithStoredPreference`'s own IPC round trip —
    // this bookkeeping ref only ever drives *this same effect's* own diffing, so a participant who
    // leaves again before that round trip resolves is still correctly handed to `detachParticipant`
    // above on the very next run (itself a safe no-op if the real attach never actually happened yet
    // — see `RemoteAudioGraphController.detachParticipant`'s own doc comment), and
    // `attachWithStoredPreference`'s own post-await freshness check independently skips attaching a
    // stream that is no longer current either way. Belt and suspenders, no leak either path.
    attachedRemoteAudioParticipantIdsRef.current = currentIds;
  }, [state.remoteAudioStreams]);

  /**
   * T13.4 — resolves this participant's stable `identityRef` and any persisted local volume/"Mute for
   * Me" preference for the current server scope *before* ever calling `graph.attachParticipant`, so
   * playback starts at the remembered value instead of the 100%/unmuted default followed a moment
   * later by a correction (Section 14 of this task's own brief: avoid "briefly blasting the user at
   * 100% for several seconds before 60% restores" — a short silence during this local IPC round trip
   * is preferable and is all this ever costs, not a network call). Falls back to the product default
   * if this participant has no known `identityRef` yet (should not happen in practice — see
   * `identityRefByParticipantIdRef`'s own doc comment on when it is populated relative to when a
   * remote stream can first appear) or no preference has ever been saved for them.
   *
   * Re-checks `latestRemoteAudioStreamsRef` immediately after the await, before ever touching the
   * graph: the participant may have left, or already gotten a *newer* stream (a fresh negotiation for
   * the same slot), while this lookup was in flight — in either case this stale call must do nothing,
   * since a leave is handled by the effect's own detach branch and a newer stream gets its own,
   * independent `attachWithStoredPreference` call from a later effect run.
   */
  async function attachWithStoredPreference(
    graph: RemoteAudioGraphController,
    participantId: string,
    stream: MediaStream,
  ): Promise<void> {
    const identityRef = identityRefByParticipantIdRef.current.get(participantId);
    let volumePercent = 100;
    let locallyMuted = false;
    const serverScopeKey = serverScopeKeyRef.current;
    if (identityRef && serverScopeKey) {
      try {
        const stored = await window.desktopApp.getVoicePreference(serverScopeKey, identityRef);
        if (stored) {
          volumePercent = stored.volumePercent;
          locallyMuted = stored.locallyMuted;
        }
      } catch (error) {
        console.error('voice: failed to load local voice preference', error);
      }
    }

    if (remoteAudioGraphRef.current !== graph) return; // this whole session was torn down/replaced.
    if (latestRemoteAudioStreamsRef.current.get(participantId) !== stream) return; // stale.

    graph.attachParticipant(participantId, stream, volumePercent, locallyMuted);
    setState((prev) => {
      const nextVolumes = new Map(prev.participantVolumes);
      nextVolumes.set(participantId, volumePercent);
      const nextMutes = new Set(prev.participantLocalMutes);
      if (locallyMuted) nextMutes.add(participantId);
      else nextMutes.delete(participantId);
      return { ...prev, participantVolumes: nextVolumes, participantLocalMutes: nextMutes };
    });
    // Public data only (a participant id and the two local-preference values already visible in this
    // app's own Settings UI to the user who set them — never identityRef/identityId, never sent
    // anywhere) — lets `e2e-voice-preference-smoke.mjs` observe that a persisted preference actually
    // reached the live audio graph, without depending on UI rendering, matching every other
    // `disco-voador:*` diagnostic marker in this file.
    console.info(
      `disco-voador:voice-preference-applied:${participantId}:${String(volumePercent)}:${String(locallyMuted)}`,
    );
  }

  /**
   * T13.4 — join/leave sound notifications for the currently-joined voice channel's own membership
   * transitions (see `join-leave-sounds.ts`'s own doc comment for the exact dedup semantics this
   * relies on `knownParticipantIdsForSoundRef` — reset at every genuine "fresh roster" point inside
   * the main connection effect — to provide). Self is structurally excluded (`state.participants`
   * never contains the local user — see that field's own doc comment), so no separate check is
   * needed here.
   */
  useEffect(() => {
    const currentIds = new Set(state.participants.map((p) => p.participantId));
    const { joined, left } = diffParticipantsForSound(
      knownParticipantIdsForSoundRef.current,
      currentIds,
    );
    knownParticipantIdsForSoundRef.current = currentIds;
    if (!joinLeaveSoundsEnabledRef.current) return;
    if (joined.length > 0) playJoinLeaveSound('join', outputDeviceIdRef.current);
    if (left.length > 0) playJoinLeaveSound('leave', outputDeviceIdRef.current);
  }, [state.participants]);

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
      // T13.4 — the device that died is exactly the one the current gate/local voice-activity
      // detector were built against; both are discarded alongside it (mirrors `releaseMicrophone`'s
      // own teardown exactly — see `transmitGateRef`'s doc comment).
      stopLocalVoiceActivityDetection();
      transmitGateRef.current = undefined;
      setState((prev) => ({
        ...prev,
        localMicrophoneStream: undefined,
        micDisconnected: true,
        pttHeld: false,
        selfVoiceActivityDetected: false,
        effectiveTransmitting: false,
        selfSpeaking: false,
      }));
    });
  }

  /**
   * T13.4 — pushes the current `TransmitGate`'s derived fields into `VoiceChannelState`, so
   * `UserControlBar`/settings UI can render PTT-held/effective-transmitting/voice-activity-detected
   * state without ever reaching into the gate directly (components only ever see this hook's plain
   * state — the gate itself is never returned from this hook). Call after *every* gate mutation
   * (`setUserMuted`, `setPttHeld`, `setInputMode`, construction, `rebind`) — the gate has no
   * change-notification mechanism of its own, so this hook is responsible for re-reading it.
   * `selfSpeaking` additionally requires *real* mic energy (`selfVoiceActivityDetected`), not merely
   * `effectiveTransmitting` — holding PTT while silent must never show "speaking" (product spec).
   */
  function pushGateDerivedState(): void {
    const gate = transmitGateRef.current;
    const pttHeld = gate?.pttHeld ?? false;
    const effectiveTransmitting = gate?.shouldTransmit ?? false;
    const selfVoiceActivityDetected = gate?.voiceActivityDetected ?? false;
    setState((prev) => ({
      ...prev,
      pttHeld,
      effectiveTransmitting,
      selfVoiceActivityDetected,
      selfSpeaking: effectiveTransmitting && selfVoiceActivityDetected,
    }));
  }

  /**
   * T13.4 — starts (replacing any previous instance first — see `stopLocalVoiceActivityDetection`)
   * a small, analysis-only Web Audio tap on a *cloned* copy of `microphone`'s track, feeding every
   * real speaking-state *transition* into `gate.setVoiceActivityDetected` — the same
   * `AnalyserActivitySampler`/Schmitt-hangover technique `remote-audio-graph.ts` uses for every
   * remote participant (see `voice-activity-detector.ts`'s own "don't invent two different
   * detection algorithms" doc comment). Always runs once a microphone is live, regardless of
   * `voiceInputMode` — the gate itself only *uses* this signal in `'voice-activity'` mode; this
   * function does not know or care which mode is active.
   *
   * **Analyzes a clone, never `microphone.track` itself — a real deadlock found and fixed via
   * `e2e:voice-smoke`.** `TransmitGate` disables (`track.enabled = false`) `microphone.track` while
   * not transmitting; per the Media Capture and Streams specification, a disabled track emits
   * *silence* to every consumer, including a local `MediaStreamAudioSourceNode`, not merely to the
   * `RTCPeerConnection` sender. Tapping the original track directly meant Voice Activity mode could
   * never recover from its own initial muted state: no real energy would ever reach the analyser to
   * trigger an un-mute. `MediaStreamTrack.clone()` shares the same underlying hardware source but
   * carries its own, independently-controlled `enabled` flag, so this tap keeps reading the real
   * microphone signal no matter what the gate does to the original (published) track. Failures (e.g.
   * `AudioContext` construction throwing in an unusual environment) are logged, never thrown — a
   * missing voice-activity signal degrades to "never auto-transmits in Voice Activity mode until the
   * user switches devices/modes," not a crash.
   */
  function startLocalVoiceActivityDetection(microphone: Microphone, gate: TransmitGate): void {
    stopLocalVoiceActivityDetection();
    let analysisTrack: MediaStreamTrack | undefined;
    try {
      const AudioContextCtor =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      const audioContext = new AudioContextCtor();
      analysisTrack = microphone.track.clone();
      // `MediaStreamTrack.clone()` copies the *current* `enabled` value from the source track at
      // clone time — it does not always start `true` — so cloning while the gate has already
      // disabled the original (the common case: a fresh gate starts not-transmitting) produces a
      // clone that is itself disabled, and per spec a disabled track still emits silence to its own
      // consumers even though it is now an independent object from the original. Force it enabled
      // unconditionally, once, right after cloning — this clone is analysis-only and must always
      // read the real signal regardless of whatever the gate does to the original going forward
      // (the two `enabled` flags are independent from this point on).
      analysisTrack.enabled = true;
      const analysisStream = new MediaStream([analysisTrack]);
      const source = audioContext.createMediaStreamSource(analysisStream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      // Analysis-only — deliberately never connected onward to `destination` or anything else (this
      // must never be an audible path; the microphone's own publish to peers is unaffected by, and
      // entirely independent of, this local analysis tap).
      source.connect(analyser);

      const sampler = new AnalyserActivitySampler(
        analyser,
        voiceActivitySensitivityRef.current,
        (speaking) => {
          gate.setVoiceActivityDetected(speaking);
          pushGateDerivedState();
        },
      );
      sampler.start();
      localVoiceActivityRef.current = { audioContext, analysisTrack, source, analyser, sampler };
    } catch (error) {
      console.error('voice: failed to start local voice-activity detection', error);
      analysisTrack?.stop();
    }
  }

  /** Full node cleanup (disconnect, stop the sampler's timer, stop the cloned analysis track, close
   * the dedicated `AudioContext`) — safe to call when nothing is active. */
  function stopLocalVoiceActivityDetection(): void {
    const current = localVoiceActivityRef.current;
    if (!current) return;
    localVoiceActivityRef.current = undefined;
    current.sampler.stop();
    current.source.disconnect();
    current.analyser.disconnect();
    // The clone's lifecycle is independent of `microphone.track`'s own — stopping one never stops
    // the other, so this must be released explicitly here (never relies on `releaseMicrophone()`'s
    // own `microphone.stop()` to clean it up).
    current.analysisTrack.stop();
    void current.audioContext.close();
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
            microphoneRef.current = microphone;
            attachMicrophoneUnexpectedEndedHandler(microphone);
            // T13.4 Decision 2 — a brand-new `TransmitGate` per fresh acquisition (this is the
            // *only* thing that makes "PTT can never resume transmission after a reconnect" true —
            // see `TransmitGate`'s own doc comment): `pttHeld` unconditionally starts `false`
            // regardless of whether a key is still physically held. The gate's own constructor
            // immediately applies the correct initial `setMuted` call, replacing the old direct
            // `microphone.setMuted(mutedRef.current)` call this line used to make.
            const gate = new TransmitGate(microphone, {
              userMuted: mutedRef.current,
              inputMode: inputModeRef.current,
            });
            transmitGateRef.current = gate;
            startLocalVoiceActivityDetection(microphone, gate);
            pushGateDerivedState();
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
    // T13.4 — `TransmitGate` is now the sole caller of `Microphone.setMuted` (see
    // `transmitGateRef`'s own doc comment); this action only ever feeds the gate's `userMuted`
    // input, never the microphone directly.
    transmitGateRef.current?.setUserMuted(muted);
    pushGateDerivedState();
    setState((prev) => ({ ...prev, muted }));
    // T11 — persists the mute-on-launch preference. Fire-and-forget: a failed write here is not
    // worth surfacing as a call-affecting error (mirrors this file's other IPC-write call sites),
    // and it never blocks the actual mute, which already took effect above via the gate. Only ever
    // invoked from an explicit user toggle — a reconnect never calls this (mute state survives a
    // reconnect untouched via `mutedRef`/`state.muted`, applied to the *new* gate at construction
    // time — see the main effect's `onReconnecting`/`onReconnected` handlers and `join()`), so this
    // can never fire from anything other than a genuine user choice.
    window.desktopApp
      .updateClientSettings({ voice: { startMuted: muted } })
      .catch((error: unknown) => {
        console.error('voice: failed to persist mute preference', error);
      });
  }, []);

  const setDeafened = useCallback((deafened: boolean) => {
    deafenedRef.current = deafened;
    // T13.4 — deafening every remote participant's playback is now this graph's own responsibility
    // (never a per-`<audio>`-element `.muted` toggle — see `RemoteAudioGraphController.setDeafened`'s
    // own doc comment for why a single override flag, not a per-participant mutation, is what makes
    // un-deafening restore each participant's own volume/local-mute exactly).
    remoteAudioGraphRef.current?.setDeafened(deafened);
    setState((prev) => ({ ...prev, deafened }));
    // T11 — mirrors `setMuted`'s persistence exactly.
    window.desktopApp
      .updateClientSettings({ voice: { startDeafened: deafened } })
      .catch((error: unknown) => {
        console.error('voice: failed to persist deafen preference', error);
      });
  }, []);

  /** T13.4 — switches Voice Activity <-> Push to Talk on the live gate immediately (no
   * renegotiation — see `TransmitGate.setInputMode`), then persists the choice. */
  const setVoiceInputMode = useCallback((mode: VoiceInputMode) => {
    inputModeRef.current = mode;
    transmitGateRef.current?.setInputMode(mode);
    pushGateDerivedState();
    setState((prev) => ({ ...prev, voiceInputMode: mode }));
    window.desktopApp
      .updateClientSettings({ voice: { inputMode: mode } })
      .catch((error: unknown) => {
        console.error('voice: failed to persist input-mode preference', error);
      });
  }, []);

  /** T13.4 — re-derives the local voice-activity detector's on/off thresholds immediately (by
   * re-tapping a fresh `AnalyserActivitySampler` against the same live microphone stream, if one is
   * currently acquired) and persists the new sensitivity. A no-op re-tap (only the ref updates) when
   * no microphone is currently live — the next acquisition reads the ref fresh anyway. */
  const setVoiceActivitySensitivity = useCallback((sensitivity: number) => {
    voiceActivitySensitivityRef.current = sensitivity;
    setState((prev) => ({ ...prev, voiceActivitySensitivity: sensitivity }));
    if (microphoneRef.current && transmitGateRef.current) {
      startLocalVoiceActivityDetection(microphoneRef.current, transmitGateRef.current);
    }
    window.desktopApp
      .updateClientSettings({ voice: { voiceActivitySensitivity: sensitivity } })
      .catch((error: unknown) => {
        console.error('voice: failed to persist voice-activity sensitivity', error);
      });
  }, []);

  /** T13.4 — see `VoiceChannelActions.setPttShortcut`'s own doc comment. Only updates
   * `state.pttBinding` on a genuine `{ ok: true }` result — a rejected (conflict/native-failure)
   * attempt must never make the UI believe a new shortcut took effect. */
  const setPttShortcutAction = useCallback(async (binding: PttBinding) => {
    const result = await window.desktopApp.setPttShortcut(binding);
    if (result.ok) setState((prev) => ({ ...prev, pttBinding: binding }));
    return result;
  }, []);

  const clearPttShortcutAction = useCallback(async () => {
    await window.desktopApp.clearPttShortcut();
    setState((prev) => ({ ...prev, pttBinding: null }));
  }, []);

  const setJoinLeaveSoundsEnabled = useCallback((enabled: boolean) => {
    joinLeaveSoundsEnabledRef.current = enabled;
    setState((prev) => ({ ...prev, joinLeaveSoundsEnabled: enabled }));
    window.desktopApp
      .updateClientSettings({ voice: { joinLeaveSoundsEnabled: enabled } })
      .catch((error: unknown) => {
        console.error('voice: failed to persist join/leave-sounds preference', error);
      });
  }, []);

  /** T13.4 — the one place that actually calls `window.desktopApp.setVoicePreference`. A no-op
   * (logged, never thrown) if `serverScopeKeyRef.current` is not yet set — should not happen for any
   * real caller (both call sites below only ever fire once a participant has already been observed,
   * which requires an already-established connection), but this is local-UI-preference persistence,
   * not a correctness-critical path, so it degrades silently rather than risking an uncaught
   * rejection taking down anything else. */
  function persistVoicePreferenceNow(
    identityRef: string,
    entry: DesktopVoicePreferenceEntry,
  ): void {
    const serverScopeKey = serverScopeKeyRef.current;
    if (!serverScopeKey) return;
    window.desktopApp
      .setVoicePreference(serverScopeKey, identityRef, entry)
      .catch((error: unknown) => {
        console.error('voice: failed to persist local voice preference', error);
      });
  }

  /** Cancels any still-pending write for `identityRef` (debounced or not yet fired), if any — every
   * write path below calls this first, so a later change always supersedes an earlier still-pending
   * one for the same identity rather than racing it. */
  function cancelPendingVoicePreference(identityRef: string): void {
    const pending = pendingVoicePreferenceWritesRef.current.get(identityRef);
    if (!pending) return;
    clearTimeout(pending.timer);
    pendingVoicePreferenceWritesRef.current.delete(identityRef);
  }

  const VOICE_PREFERENCE_PERSIST_DEBOUNCE_MS = 400;

  /** A live-dragged volume slider can fire many updates a second (Section 13 of this task's own
   * brief: "do not rewrite the settings file on every mouse pixel movement") — debounces the actual
   * IPC write, coalescing rapid updates into one, while `remoteAudioGraphRef`'s own gain change (see
   * the call sites below) always applies instantly regardless. */
  function schedulePersistVolume(identityRef: string, entry: DesktopVoicePreferenceEntry): void {
    cancelPendingVoicePreference(identityRef);
    const timer = setTimeout(() => {
      pendingVoicePreferenceWritesRef.current.delete(identityRef);
      persistVoicePreferenceNow(identityRef, entry);
    }, VOICE_PREFERENCE_PERSIST_DEBOUNCE_MS);
    pendingVoicePreferenceWritesRef.current.set(identityRef, { timer, entry });
  }

  /** "Mute for Me" is a single discrete click, not a continuous drag — persisted immediately, no
   * debounce — and supersedes (never races) any volume write still pending for the same identity. */
  function persistVoicePreferenceImmediately(
    identityRef: string,
    entry: DesktopVoicePreferenceEntry,
  ): void {
    cancelPendingVoicePreference(identityRef);
    persistVoicePreferenceNow(identityRef, entry);
  }

  /** Flushes every still-pending debounced write immediately — called on genuine session teardown
   * (see the main connection effect's own cleanup) so a shutdown/server-switch/unmount landing inside
   * the debounce window never silently drops the last value the user actually set. */
  function flushPendingVoicePreferences(): void {
    for (const [identityRef, pending] of pendingVoicePreferenceWritesRef.current) {
      clearTimeout(pending.timer);
      persistVoicePreferenceNow(identityRef, pending.entry);
    }
    pendingVoicePreferenceWritesRef.current.clear();
  }

  /** T13.4 — live-adjusts one remote participant's local playback volume via the shared
   * `RemoteAudioGraphController` (applied to every session of the same identity — see
   * `participantIdsForIdentityRef`), mirrors the result into `state.participantVolumes` so the
   * "User Volume" UI can read back the current value without reaching into the graph directly, and
   * persists it — debounced — keyed by the participant's stable `identityRef` within the current
   * server scope, never by `participantId`/`memberRef` (both session-scoped, which would silently
   * orphan the saved preference on the very next reconnect/rejoin — see
   * `docs/architecture/GAMER_VOICE_EXPERIENCE.md`). A no-op persistence-wise (still applies to the
   * live graph/UI) for a `participantId` this hook has no known `identityRef` for — should not happen
   * for any currently-attached participant, but never throws either way. */
  const setParticipantVolume = useCallback((participantId: string, percent: number) => {
    const clamped = Math.max(0, Math.min(200, percent));
    const identityRef = identityRefByParticipantIdRef.current.get(participantId);
    const targetIds = identityRef
      ? participantIdsForIdentityRef(identityRefByParticipantIdRef.current, identityRef)
      : [participantId];

    for (const id of targetIds) remoteAudioGraphRef.current?.setParticipantVolume(id, clamped);
    setState((prev) => {
      const next = new Map(prev.participantVolumes);
      for (const id of targetIds) next.set(id, clamped);
      return { ...prev, participantVolumes: next };
    });

    if (!identityRef) return;
    const locallyMuted = participantLocalMutesRef.current.has(participantId);
    schedulePersistVolume(identityRef, { volumePercent: clamped, locallyMuted });
  }, []);

  /** T13.4 — "Mute for Me"/"Unmute for Me". See `setParticipantVolume`'s own doc comment for the
   * same identity-keyed, multi-session-aware persistence — the only difference is this persists
   * immediately (a discrete click, not a continuous drag) and never resets the stored volume: the
   * currently-known `volumePercent` is always re-sent unchanged alongside the new `locallyMuted`
   * flag, so unmuting later restores exactly what was configured before, never a reset to 100%. */
  const setParticipantLocalMute = useCallback((participantId: string, muted: boolean) => {
    const identityRef = identityRefByParticipantIdRef.current.get(participantId);
    const targetIds = identityRef
      ? participantIdsForIdentityRef(identityRefByParticipantIdRef.current, identityRef)
      : [participantId];

    for (const id of targetIds) remoteAudioGraphRef.current?.setParticipantMuted(id, muted);
    setState((prev) => {
      const next = new Set(prev.participantLocalMutes);
      for (const id of targetIds) {
        if (muted) next.add(id);
        else next.delete(id);
      }
      return { ...prev, participantLocalMutes: next };
    });

    if (!identityRef) return;
    const volumePercent = participantVolumesRef.current.get(participantId) ?? 100;
    persistVoicePreferenceImmediately(identityRef, { volumePercent, locallyMuted: muted });
  }, []);

  /** T13.4 — output-device *selection* stays owned by `VoiceChannelView.tsx`/`SettingsPanel.tsx`
   * exactly as it was before T13.4 (this action does not itself enumerate/persist anything); this is
   * only the seam that tells the shared remote-audio graph and join/leave-sound playback which
   * device the rest of the UI already selected — `SettingsPanel.tsx`'s existing `handleOutputChange`
   * calls this in addition to updating its own local `outputDeviceId` state and persisting via
   * `updateClientSettings`, mirroring `switchMicrophone`'s own "live behavior here, persistence
   * stays with the caller" split. */
  const setOutputDevice = useCallback((deviceId: string | null) => {
    outputDeviceIdRef.current = deviceId;
    void remoteAudioGraphRef.current?.setOutputDevice(deviceId);
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

        // T13.4 Decision 2 — a live device switch `rebind()`s the existing gate rather than
        // constructing a new one: this is the same logical voice session, so `pttHeld`/
        // `voiceActivityDetected` must survive untouched (see `TransmitGate.rebind`'s own doc
        // comment for why this differs from a reconnect's fresh construction). `rebind` itself
        // re-applies `setMuted` unconditionally, replacing the old direct
        // `newMicrophone.setMuted(mutedRef.current)` call this line used to make.
        transmitGateRef.current?.rebind(newMicrophone);
        // Atomicity (T11 Section 27, mandatory): the new device is confirmed live and swapped in
        // via `replaceTrack` *before* the old device is stopped — if acquisition above had failed
        // instead, `currentMicrophone` would still be untouched and still working, handled by the
        // `catch` block below doing nothing to it.
        transport.replaceTrack(currentMicrophone.track, newMicrophone.track);
        microphoneRef.current = newMicrophone;
        attachMicrophoneUnexpectedEndedHandler(newMicrophone);
        // Re-taps local voice-activity detection onto the new device's stream — the previous
        // `AnalyserNode` was wired to the now-stopped device's own `MediaStream` and would otherwise
        // silently keep analyzing a dead track.
        if (transmitGateRef.current) {
          startLocalVoiceActivityDetection(newMicrophone, transmitGateRef.current);
        }
        pushGateDerivedState();
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

  // --- T13.3 profile/avatar/presence ------------------------------------------------------------
  // Mirrors `registerPendingChannelRequest`'s exact shape: pairs a `RealtimeClient` call (which
  // returns the generated request id) with a Promise registered in `pendingProfileRequestsRef`
  // under that same id — `onProfileSelfUpdated` resolves it, `onServerError` rejects it with a
  // `ProfileRequestError`.

  function registerPendingProfileRequest(requestId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      pendingProfileRequestsRef.current.set(requestId, { resolve, reject });
    });
  }

  const setAvatar = useCallback(
    (target: 'self' | 'server', format: AvatarImageFormat, imageBase64: string) => {
      const client = clientRef.current;
      if (!client) return Promise.reject(new Error('Not connected.'));
      const requestId = client.setAvatar(target, format, imageBase64);
      return registerPendingProfileRequest(requestId);
    },
    [],
  );

  const clearSelfAvatar = useCallback(() => {
    const client = clientRef.current;
    if (!client) return Promise.reject(new Error('Not connected.'));
    const requestId = client.clearSelfAvatar();
    return registerPendingProfileRequest(requestId);
  }, []);

  const clearServerAvatar = useCallback(() => {
    const client = clientRef.current;
    if (!client) return Promise.reject(new Error('Not connected.'));
    const requestId = client.clearServerAvatar();
    return registerPendingProfileRequest(requestId);
  }, []);

  const clearMemberAvatar = useCallback((memberRef: string) => {
    const client = clientRef.current;
    if (!client) return Promise.reject(new Error('Not connected.'));
    const requestId = client.clearMemberAvatar(memberRef);
    return registerPendingProfileRequest(requestId);
  }, []);

  const setCustomStatus = useCallback((customStatus: string | undefined) => {
    const client = clientRef.current;
    if (!client) return Promise.reject(new Error('Not connected.'));
    const requestId = client.setCustomStatus(customStatus);
    return registerPendingProfileRequest(requestId);
  }, []);

  const clearMemberStatus = useCallback((memberRef: string) => {
    const client = clientRef.current;
    if (!client) return Promise.reject(new Error('Not connected.'));
    const requestId = client.clearMemberStatus(memberRef);
    return registerPendingProfileRequest(requestId);
  }, []);

  const setPresence = useCallback((presence: PresenceStatus) => {
    const client = clientRef.current;
    if (!client) return Promise.reject(new Error('Not connected.'));
    const requestId = client.setPresence(presence);
    return registerPendingProfileRequest(requestId);
  }, []);

  const requestAvatar = useCallback((target: 'self' | 'server' | 'member', memberRef?: string) => {
    const client = clientRef.current;
    if (!client) return;
    if (target === 'member' && !memberRef) return;
    const targetKey = target === 'member' ? `member:${memberRef}` : target;
    if (inFlightAvatarTargetKeysRef.current.has(targetKey)) return;
    inFlightAvatarTargetKeysRef.current.add(targetKey);
    const requestId =
      target === 'member'
        ? client.requestAvatar('member', memberRef)
        : client.requestAvatar(target);
    pendingAvatarRequestIdsRef.current.set(requestId, targetKey);
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
      setVoiceInputMode,
      setVoiceActivitySensitivity,
      setPttShortcut: setPttShortcutAction,
      clearPttShortcut: clearPttShortcutAction,
      setJoinLeaveSoundsEnabled,
      setParticipantVolume,
      setParticipantLocalMute,
      setOutputDevice,
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
      setAvatar,
      clearSelfAvatar,
      clearServerAvatar,
      clearMemberAvatar,
      setCustomStatus,
      clearMemberStatus,
      setPresence,
      requestAvatar,
    }),
    [
      join,
      leave,
      cancelReconnect,
      setMuted,
      setDeafened,
      setVoiceInputMode,
      setVoiceActivitySensitivity,
      setPttShortcutAction,
      clearPttShortcutAction,
      setJoinLeaveSoundsEnabled,
      setParticipantVolume,
      setParticipantLocalMute,
      setOutputDevice,
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
      setAvatar,
      clearSelfAvatar,
      clearServerAvatar,
      clearMemberAvatar,
      setCustomStatus,
      clearMemberStatus,
      setPresence,
      requestAvatar,
    ],
  );

  return [state, actions] as const;
}
