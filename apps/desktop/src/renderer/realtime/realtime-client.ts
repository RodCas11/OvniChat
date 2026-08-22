import {
  CURRENT_PROTOCOL_VERSION,
  parseServerMessage,
  type AclPolicyKind,
  type ChatScope,
  type ClientMessage,
  type ManagePolicyKind,
  type PermissionKey,
  type ServerAuthorizationAckMessage,
  type ServerAuthorizationBansMessage,
  type ServerAuthorizationGroupsMessage,
  type ServerAuthorizationStateMessage,
  type ServerAuthorizationTokenCreatedMessage,
  type ServerAuthorizationTokenRedeemedMessage,
  type ServerCapability,
  type ServerChannelAckMessage,
  type ServerChannelCreatedMessage,
  type ServerChannelEditableNodeMessage,
  type ServerChatHistoryPageMessage,
  type ServerChatMessageMessage,
  type ServerErrorMessage,
  type ServerIdentityChallengeMessage,
  type ServerMediaTrackSourceMessage,
  type ServerMessage,
  type ServerVoiceCatalogMessage,
  type ServerVoiceJoinedMessage,
  type ServerVoiceLeftMessage,
  type ServerVoiceParticipantJoinedMessage,
  type ServerVoiceParticipantLeftMessage,
  type ServerVoiceRemovedByPolicyMessage,
  type ServerWebrtcAnswerMessage,
  type ServerWebrtcIceCandidateMessage,
  type ServerWebrtcOfferMessage,
  type TokenKind,
  type TrackSource,
} from '@disco-voador/protocol';
import type { ParticipantId, SignalingPort } from '@disco-voador/rtc-core';

import type { IdentitySigner } from './identity-signer.js';

/**
 * `'connecting'`: socket opening, not yet sent `client:hello`. `'authenticating'` (T8): hello
 * sent, waiting on the identity-challenge/proof exchange — distinct from `'connecting'` so the UI
 * can show a real intermediate state (Section 17) instead of one generic spinner covering both a
 * cold TCP/WS handshake and a cryptographic proof exchange. `'open'`: `server:hello` verified,
 * `ready` — never reached before authentication completes, structurally, since nothing before
 * `handleIdentityProof`'s success path can produce it.
 */
export type RealtimeConnectionState = 'connecting' | 'authenticating' | 'open' | 'closed';

export interface ServerInfo {
  readonly serverName: string;
  readonly serverCapabilities: readonly ServerCapability[];
}

/** The raw WebSocket close code/reason for the most recent close — see `reconnect-policy.ts` for
 * how T11's reconnect controller turns `code` into a retry/no-retry decision. `code` is always one
 * of the standard RFC 6455 codes or one of `@disco-voador/protocol`'s `CLOSE_CODES` (the server
 * closes every fatal error with the specific code matching its `ErrorCode`, so the raw numeric code
 * alone is enough to classify the failure — no need to also inspect a preceding `server:error`). */
export interface ClosedInfo {
  readonly code: number;
  readonly reason: string;
}

interface RealtimeClientEvents {
  stateChange: (state: RealtimeConnectionState) => void;
  /** Fires immediately before `stateChange('closed')`, for every close regardless of cause
   * (explicit `disconnect()`, a server-initiated fatal close, or an abnormal network drop) — purely
   * additive, T11: existing listeners that only ever cared about `stateChange` are unaffected. This
   * is the only place the actual close code/reason is observable; `stateChange('closed')` alone
   * cannot distinguish "you disconnected" from "the server banned you" from "the network dropped." */
  closed: (info: ClosedInfo) => void;
  /** Fires once, alongside the `'open'` state change, with the Dedicated Server's own display
   * metadata (T8) — see `docs/architecture/DEDICATED_SERVER.md`. */
  serverInfo: (info: ServerInfo) => void;
  catalog: (message: ServerVoiceCatalogMessage) => void;
  joined: (message: ServerVoiceJoinedMessage) => void;
  left: (message: ServerVoiceLeftMessage) => void;
  participantJoined: (message: ServerVoiceParticipantJoinedMessage) => void;
  participantLeft: (message: ServerVoiceParticipantLeftMessage) => void;
  webrtcOffer: (message: ServerWebrtcOfferMessage) => void;
  webrtcAnswer: (message: ServerWebrtcAnswerMessage) => void;
  webrtcIceCandidate: (message: ServerWebrtcIceCandidateMessage) => void;
  mediaTrackSource: (message: ServerMediaTrackSourceMessage) => void;
  serverError: (message: ServerErrorMessage) => void;
  /** T9 — this connection's own groups/permissions on the connected server; sent once at `ready`
   * and re-sent whenever an admin action changes them live. See
   * `docs/architecture/SERVER_AUTHORIZATION.md`. */
  authorizationState: (message: ServerAuthorizationStateMessage) => void;
  authorizationGroups: (message: ServerAuthorizationGroupsMessage) => void;
  authorizationAck: (message: ServerAuthorizationAckMessage) => void;
  authorizationTokenCreated: (message: ServerAuthorizationTokenCreatedMessage) => void;
  authorizationTokenRedeemed: (message: ServerAuthorizationTokenRedeemedMessage) => void;
  authorizationBans: (message: ServerAuthorizationBansMessage) => void;
  /** T10 — a live, just-persisted chat message (server or channel scope). See
   * `docs/architecture/PERSISTENT_TEXT_CHAT.md`. */
  chatMessage: (message: ServerChatMessageMessage) => void;
  /** T10 — a bounded, paginated history page, in reply to `requestChatHistory`. */
  chatHistoryPage: (message: ServerChatHistoryPageMessage) => void;
  /** T13.2 — reply to `client:channel-create-category`/`client:channel-create-voice`. */
  channelCreated: (message: ServerChannelCreatedMessage) => void;
  /** T13.2 — generic success ack for update/move/reorder/delete/set-password/remove-password. */
  channelAck: (message: ServerChannelAckMessage) => void;
  /** T13.2 — reply to `client:channel-get-editable-node`. */
  channelEditableNode: (message: ServerChannelEditableNodeMessage) => void;
  /** T13.2 — this connection was force-removed from a voice channel by a live ACL/group change,
   * distinct from a self-initiated leave or a moderation kick/ban. */
  voiceRemovedByPolicy: (message: ServerVoiceRemovedByPolicyMessage) => void;
}

/** T13.2 — a leave-unchanged/set/clear-shaped patch for `client:channel-update`, mirroring that
 * message's own field semantics exactly (`undefined` = leave unchanged everywhere, except
 * `userLimit` where `null` also means "clear back to no explicit limit"). */
export interface ChannelUpdatePatch {
  readonly name?: string;
  readonly visibilityPolicy?: AclPolicyKind;
  readonly visibilityGroupIds?: readonly string[];
  readonly joinPolicy?: AclPolicyKind;
  readonly joinGroupIds?: readonly string[];
  readonly managePolicy?: ManagePolicyKind;
  readonly manageGroupIds?: readonly string[];
  readonly userLimit?: number | null;
}

function generateMessageId(): string {
  return crypto.randomUUID();
}

/**
 * Renderer-side realtime WebSocket client. Owns the T2/T7 handshake (`client:hello` ->
 * `server:identity-challenge` -> `client:identity-proof` -> `server:hello`) and the T3 voice/
 * WebRTC signaling wire format, and implements rtc-core's `SignalingPort` directly so a
 * `P2PMeshTransport` can send signaling through it with no adapter layer. This class only ever
 * carries text/signaling — never a media payload, per `docs/SECURITY.md`.
 *
 * The private key itself never passes through this class or the Renderer at all — every identity
 * operation goes through the injected {@link IdentitySigner}, which is IPC-shaped (see
 * `identity-signer.ts`); this class only ever handles public data (`publicKey`, `identityId`,
 * `nickname`) and opaque signature strings.
 *
 * Server-driven WebSocket protocol-level ping/pong (handled transparently by the platform's
 * `WebSocket` implementation) is enough to keep the connection alive; this client does not run its
 * own `client:ping` loop.
 */
export class RealtimeClient implements SignalingPort {
  private socket: WebSocket | undefined;
  /** The nickname actually sent in the most recent `client:hello` — captured once at hello time
   * so a nickname change while a challenge is outstanding can never desync the client's proof
   * from what the server is verifying against (the server always uses the nickname it received
   * at hello, never a later value). */
  private currentNickname = '';
  private readonly listeners: { [K in keyof RealtimeClientEvents]: Set<RealtimeClientEvents[K]> } =
    {
      stateChange: new Set(),
      closed: new Set(),
      serverInfo: new Set(),
      catalog: new Set(),
      joined: new Set(),
      left: new Set(),
      participantJoined: new Set(),
      participantLeft: new Set(),
      webrtcOffer: new Set(),
      webrtcAnswer: new Set(),
      webrtcIceCandidate: new Set(),
      mediaTrackSource: new Set(),
      serverError: new Set(),
      authorizationState: new Set(),
      authorizationGroups: new Set(),
      authorizationAck: new Set(),
      authorizationTokenCreated: new Set(),
      authorizationTokenRedeemed: new Set(),
      authorizationBans: new Set(),
      chatMessage: new Set(),
      chatHistoryPage: new Set(),
      channelCreated: new Set(),
      channelAck: new Set(),
      channelEditableNode: new Set(),
      voiceRemovedByPolicy: new Set(),
    };

  constructor(
    private readonly url: string,
    private readonly signer: IdentitySigner,
    /** T9 — an optional bearer token presented at admission time (invite-only servers only; see
     * `docs/architecture/SERVER_AUTHORIZATION.md`). Read once, at `connect()` time, exactly like
     * `IdentitySigner` — never re-read mid-connection. */
    private readonly serverToken?: string,
  ) {}

  on<K extends keyof RealtimeClientEvents>(event: K, listener: RealtimeClientEvents[K]): void {
    this.listeners[event].add(listener);
  }

  off<K extends keyof RealtimeClientEvents>(event: K, listener: RealtimeClientEvents[K]): void {
    this.listeners[event].delete(listener);
  }

  connect(): void {
    if (this.socket) return;
    this.emit('stateChange', 'connecting');

    const socket = new WebSocket(this.url);
    this.socket = socket;

    socket.addEventListener('open', () => {
      void this.sendHello(socket);
    });

    socket.addEventListener('message', (event: MessageEvent<unknown>) => {
      this.handleRawMessage(event.data);
    });

    socket.addEventListener('close', (event: CloseEvent) => {
      this.socket = undefined;
      this.emit('closed', { code: event.code, reason: event.reason });
      this.emit('stateChange', 'closed');
    });
  }

  /** Loads the local public identity and current nickname, then sends `client:hello`. Async
   * because both come from Main over IPC — `socket` is the exact instance `connect()` just
   * created, checked against `this.socket` after each await so a torn-down/replaced connection
   * (unmount, reconnect) while this was in flight is a silent no-op rather than sending a hello on
   * a dead or unrelated socket, mirroring the same staleness guard `use-voice-channel.ts` already
   * uses for `getUserMedia`/`getDisplayMedia`. */
  private async sendHello(socket: WebSocket): Promise<void> {
    let publicKey: string;
    let nickname: string;
    try {
      const [identity, currentNickname] = await Promise.all([
        this.signer.getPublicIdentity(),
        this.signer.getNickname(),
      ]);
      if (this.socket !== socket) return;
      publicKey = identity.publicKey;
      nickname = currentNickname;
    } catch (error) {
      console.error('realtime-client: failed to load the local identity', error);
      socket.close(1011, 'identity unavailable');
      return;
    }

    this.currentNickname = nickname;
    this.send({
      type: 'client:hello',
      id: generateMessageId(),
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      client: { name: 'disco-voador-desktop', version: '0.0.0' },
      nickname,
      publicKey,
      ...(this.serverToken ? { serverToken: this.serverToken } : {}),
    });
    this.emit('stateChange', 'authenticating');
  }

  /** Answers `server:identity-challenge` by asking the signer to sign it, then sends
   * `client:identity-proof` — the only path that can make the connection `ready`
   * (`server:hello`). Never reconstructs the canonical payload itself; that is the signer's (in
   * practice, Main's) job specifically so the Renderer never needs — and never gets — the
   * building blocks to sign anything else. */
  private async handleIdentityChallenge(message: ServerIdentityChallengeMessage): Promise<void> {
    const socket = this.socket;
    if (!socket) return;

    let signature: string;
    try {
      signature = await this.signer.signIdentityChallenge({
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        connectionId: message.connectionId,
        nonce: message.nonce,
        expiresAt: message.expiresAt,
        nickname: this.currentNickname,
      });
    } catch (error) {
      console.error('realtime-client: failed to sign the identity challenge', error);
      socket.close(1011, 'identity signing failed');
      return;
    }
    if (this.socket !== socket) return;

    this.send({ type: 'client:identity-proof', id: generateMessageId(), signature });
  }

  /**
   * Idempotent; safe to call whether or not `connect()` ever succeeded. Deliberately does not
   * clear `this.socket` or emit `'stateChange'` itself — the `'close'` listener registered in
   * `connect()` already does both, and fires for this client-initiated close exactly the same way
   * it fires for a server-initiated one, so there is exactly one code path for "the socket closed."
   */
  disconnect(): void {
    this.socket?.close(1000, 'client disconnect');
  }

  /** T13.2 — `password` is only meaningful against a channel with `hasPassword === true`; never
   * cached/reused by this class — the caller (`use-voice-channel.ts`) is responsible for never
   * persisting it past this one call. Returns the generated request `id` so the caller can
   * correlate the eventual `voice:joined`/`server:error` reply back to this specific attempt (see
   * `use-voice-channel.ts`'s join-error/restore handling). */
  joinVoiceChannel(channelId: string, displayName: string, password?: string): string {
    const id = generateMessageId();
    this.send({
      type: 'voice:join',
      id,
      channelId,
      displayName,
      ...(password !== undefined ? { password } : {}),
    });
    return id;
  }

  leaveVoiceChannel(): void {
    this.send({ type: 'voice:leave', id: generateMessageId() });
  }

  sendOffer(targetParticipantId: ParticipantId, sdp: string): void {
    this.send({ type: 'webrtc:offer', id: generateMessageId(), targetParticipantId, sdp });
  }

  sendAnswer(targetParticipantId: ParticipantId, sdp: string): void {
    this.send({ type: 'webrtc:answer', id: generateMessageId(), targetParticipantId, sdp });
  }

  sendIceCandidate(
    targetParticipantId: ParticipantId,
    candidate: RTCIceCandidateInit | null,
  ): void {
    this.send({
      type: 'webrtc:ice-candidate',
      id: generateMessageId(),
      targetParticipantId,
      candidate:
        candidate === null
          ? null
          : {
              candidate: candidate.candidate ?? '',
              sdpMid: candidate.sdpMid ?? undefined,
              sdpMLineIndex: candidate.sdpMLineIndex ?? undefined,
              usernameFragment: candidate.usernameFragment ?? undefined,
            },
    });
  }

  /**
   * Announces the semantic source (camera vs. screen-video — see `packages/protocol`'s `media.ts`
   * and `docs/architecture/WEBRTC_SCREEN_SHARE.md`) of a local track, by the `mid` that track's
   * transceiver negotiated *for the connection to `targetParticipantId`* — mid is scoped to one
   * peer connection (the same local track can have a different mid on a different peer connection
   * in the mesh), so this is targeted per-peer, not a channel-wide broadcast. Sent directly rather
   * than through `SignalingPort`/`Peer` since `rtc-core` stays protocol-agnostic; `Peer`'s
   * `localTrackMid` event (via `P2PMeshTransport`) is what tells the caller when/what to announce.
   */
  announceTrackSource(targetParticipantId: ParticipantId, mid: string, source: TrackSource): void {
    this.send({
      type: 'media:track-source',
      id: generateMessageId(),
      targetParticipantId,
      mid,
      source,
    });
  }

  // --- T9 server-local authorization ------------------------------------------------------------
  // Every server-authoritative permission check happens on the Dedicated Server, never here — these
  // methods only send the request; the UI reacts to the resulting `server:authorization-*` reply
  // or `server:error` (see `docs/architecture/SERVER_AUTHORIZATION.md` Section 35).

  redeemAuthorizationToken(token: string): void {
    this.send({ type: 'client:authorization-redeem-token', id: generateMessageId(), token });
  }

  createAuthorizationToken(tokenKind: TokenKind, groupId: string, expiresInMs?: number): void {
    this.send({
      type: 'client:authorization-create-token',
      id: generateMessageId(),
      tokenKind,
      groupId,
      ...(expiresInMs !== undefined ? { expiresInMs } : {}),
    });
  }

  listAuthorizationGroups(): void {
    this.send({ type: 'client:authorization-list-groups', id: generateMessageId() });
  }

  createAuthorizationGroup(name: string, permissions: readonly PermissionKey[]): void {
    this.send({
      type: 'client:authorization-create-group',
      id: generateMessageId(),
      name,
      permissions: [...permissions],
    });
  }

  updateAuthorizationGroup(
    groupId: string,
    name: string | undefined,
    permissions: readonly PermissionKey[] | undefined,
  ): void {
    this.send({
      type: 'client:authorization-update-group',
      id: generateMessageId(),
      groupId,
      ...(name !== undefined ? { name } : {}),
      ...(permissions !== undefined ? { permissions: [...permissions] } : {}),
    });
  }

  deleteAuthorizationGroup(groupId: string): void {
    this.send({ type: 'client:authorization-delete-group', id: generateMessageId(), groupId });
  }

  grantAuthorizationGroup(targetParticipantId: ParticipantId, groupId: string): void {
    this.send({
      type: 'client:authorization-grant-group',
      id: generateMessageId(),
      targetParticipantId,
      groupId,
    });
  }

  revokeAuthorizationGroup(targetParticipantId: ParticipantId, groupId: string): void {
    this.send({
      type: 'client:authorization-revoke-group',
      id: generateMessageId(),
      targetParticipantId,
      groupId,
    });
  }

  kickParticipant(targetParticipantId: ParticipantId): void {
    this.send({ type: 'client:authorization-kick', id: generateMessageId(), targetParticipantId });
  }

  banParticipant(targetParticipantId: ParticipantId, durationMs?: number, reason?: string): void {
    this.send({
      type: 'client:authorization-ban',
      id: generateMessageId(),
      targetParticipantId,
      ...(durationMs !== undefined ? { durationMs } : {}),
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  unbanIdentity(identityId: string): void {
    this.send({ type: 'client:authorization-unban', id: generateMessageId(), identityId });
  }

  listAuthorizationBans(): void {
    this.send({ type: 'client:authorization-list-bans', id: generateMessageId() });
  }

  // --- T10 persistent server-side text chat -------------------------------------------------
  // Server derives the sender itself (identity + current nickname) — there is no sender field to
  // set here at all (see `docs/architecture/PERSISTENT_TEXT_CHAT.md` Section 29/30/74).

  sendChatMessage(scope: ChatScope, channelId: string | undefined, body: string): void {
    this.send({
      type: 'client:chat-send',
      id: generateMessageId(),
      scope,
      ...(channelId !== undefined ? { channelId } : {}),
      body,
    });
  }

  /** Returns the generated request `id` — `server:chat-history-page` carries no scope/channelId of
   * its own (see `packages/protocol/src/messages/chat.ts`), so a caller tracking more than one
   * thread must correlate the eventual reply back to this exact id itself (see
   * `use-voice-channel.ts`'s `pendingChatHistoryRequestsRef`). */
  requestChatHistory(
    scope: ChatScope,
    channelId: string | undefined,
    beforeMessageId?: number,
    limit?: number,
  ): string {
    const id = generateMessageId();
    this.send({
      type: 'client:chat-history-request',
      id,
      scope,
      ...(channelId !== undefined ? { channelId } : {}),
      ...(beforeMessageId !== undefined ? { beforeMessageId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    return id;
  }

  // --- T13.2 channel/category tree administration --------------------------------------------
  // Every method returns the generated request `id` so the caller can correlate the eventual
  // `server:channel-created`/`server:channel-ack`/`server:channel-editable-node`/`server:error`
  // reply back to this specific request (mirroring `requestChatHistory`'s own id-return
  // convention) — the server is the sole authority on whether the request succeeds; a denial
  // arrives as an ordinary `server:error` with `replyTo` set to this id.

  createChannelCategory(name: string, parentId?: string): string {
    const id = generateMessageId();
    this.send({
      type: 'client:channel-create-category',
      id,
      name,
      ...(parentId !== undefined ? { parentId } : {}),
    });
    return id;
  }

  createVoiceChannelNode(name: string, parentId?: string, temporary?: boolean): string {
    const id = generateMessageId();
    this.send({
      type: 'client:channel-create-voice',
      id,
      name,
      ...(parentId !== undefined ? { parentId } : {}),
      ...(temporary !== undefined ? { temporary } : {}),
    });
    return id;
  }

  updateChannelNode(nodeId: string, patch: ChannelUpdatePatch): string {
    const id = generateMessageId();
    this.send({
      type: 'client:channel-update',
      id,
      nodeId,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.visibilityPolicy !== undefined ? { visibilityPolicy: patch.visibilityPolicy } : {}),
      ...(patch.visibilityGroupIds !== undefined
        ? { visibilityGroupIds: [...patch.visibilityGroupIds] }
        : {}),
      ...(patch.joinPolicy !== undefined ? { joinPolicy: patch.joinPolicy } : {}),
      ...(patch.joinGroupIds !== undefined ? { joinGroupIds: [...patch.joinGroupIds] } : {}),
      ...(patch.managePolicy !== undefined ? { managePolicy: patch.managePolicy } : {}),
      ...(patch.manageGroupIds !== undefined ? { manageGroupIds: [...patch.manageGroupIds] } : {}),
      ...(patch.userLimit !== undefined ? { userLimit: patch.userLimit } : {}),
    });
    return id;
  }

  moveChannelNode(nodeId: string, newParentId: string | undefined): string {
    const id = generateMessageId();
    this.send({
      type: 'client:channel-move',
      id,
      nodeId,
      ...(newParentId !== undefined ? { newParentId } : {}),
    });
    return id;
  }

  reorderChannelNodes(parentId: string | undefined, orderedNodeIds: readonly string[]): string {
    const id = generateMessageId();
    this.send({
      type: 'client:channel-reorder',
      id,
      ...(parentId !== undefined ? { parentId } : {}),
      orderedNodeIds: [...orderedNodeIds],
    });
    return id;
  }

  deleteChannelNode(nodeId: string): string {
    const id = generateMessageId();
    this.send({ type: 'client:channel-delete', id, nodeId });
    return id;
  }

  setChannelPassword(nodeId: string, password: string): string {
    const id = generateMessageId();
    this.send({ type: 'client:channel-set-password', id, nodeId, password });
    return id;
  }

  removeChannelPassword(nodeId: string): string {
    const id = generateMessageId();
    this.send({ type: 'client:channel-remove-password', id, nodeId });
    return id;
  }

  getEditableChannelNode(nodeId: string): string {
    const id = generateMessageId();
    this.send({ type: 'client:channel-get-editable-node', id, nodeId });
    return id;
  }

  private send(message: ClientMessage): void {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) {
      console.error('realtime-client: dropped a message because the socket is not open', {
        type: message.type,
      });
      return;
    }
    this.socket.send(JSON.stringify(message));
  }

  private handleRawMessage(data: unknown): void {
    if (typeof data !== 'string') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      console.error('realtime-client: received malformed JSON from the server');
      return;
    }

    const result = parseServerMessage(parsed);
    if (!result.ok) {
      console.error(
        'realtime-client: received a message that failed protocol validation',
        result.issues,
      );
      return;
    }

    this.dispatch(result.message);
  }

  private dispatch(message: ServerMessage): void {
    switch (message.type) {
      case 'server:hello':
        // Public data only — used by the T7 identity-authentication E2E script to confirm this
        // connection's server-verified identityId matches the local one logged by
        // `use-identity.ts`. See `apps/desktop/scripts/e2e-identity-auth.mjs`.
        console.info(`disco-voador:server-authenticated-identity:${message.identityId}`);
        this.emit('serverInfo', {
          serverName: message.serverName,
          serverCapabilities: message.serverCapabilities,
        });
        this.emit('stateChange', 'open');
        return;
      case 'server:identity-challenge':
        void this.handleIdentityChallenge(message);
        return;
      case 'server:pong':
        return;
      case 'server:error':
        this.emit('serverError', message);
        return;
      case 'voice:catalog':
        this.emit('catalog', message);
        return;
      case 'voice:joined':
        this.emit('joined', message);
        return;
      case 'voice:left':
        this.emit('left', message);
        return;
      case 'voice:participant-joined':
        this.emit('participantJoined', message);
        return;
      case 'voice:participant-left':
        this.emit('participantLeft', message);
        return;
      case 'webrtc:offer':
        this.emit('webrtcOffer', message);
        return;
      case 'webrtc:answer':
        this.emit('webrtcAnswer', message);
        return;
      case 'webrtc:ice-candidate':
        this.emit('webrtcIceCandidate', message);
        return;
      case 'media:track-source':
        this.emit('mediaTrackSource', message);
        return;
      case 'server:authorization-state':
        this.emit('authorizationState', message);
        return;
      case 'server:authorization-groups':
        this.emit('authorizationGroups', message);
        return;
      case 'server:authorization-ack':
        this.emit('authorizationAck', message);
        return;
      case 'server:authorization-token-created':
        this.emit('authorizationTokenCreated', message);
        return;
      case 'server:authorization-token-redeemed':
        this.emit('authorizationTokenRedeemed', message);
        return;
      case 'server:authorization-bans':
        this.emit('authorizationBans', message);
        return;
      case 'server:chat-message':
        this.emit('chatMessage', message);
        return;
      case 'server:chat-history-page':
        this.emit('chatHistoryPage', message);
        return;
      case 'server:channel-created':
        this.emit('channelCreated', message);
        return;
      case 'server:channel-ack':
        this.emit('channelAck', message);
        return;
      case 'server:channel-editable-node':
        this.emit('channelEditableNode', message);
        return;
      case 'server:voice-removed-by-policy':
        this.emit('voiceRemovedByPolicy', message);
        return;
    }
  }

  private emit<K extends keyof RealtimeClientEvents>(
    event: K,
    ...args: Parameters<RealtimeClientEvents[K]>
  ): void {
    for (const listener of [...this.listeners[event]]) {
      (listener as (...eventArgs: Parameters<RealtimeClientEvents[K]>) => void)(...args);
    }
  }
}
