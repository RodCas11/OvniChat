import { randomUUID } from 'node:crypto';

import {
  CLOSE_CODES,
  parseClientMessage,
  type ErrorCode,
  type ServerCapability,
  type ServerMessage,
} from '@disco-voador/protocol';
import type { RawData, WebSocket } from 'ws';

import type { AuthorizationPort } from './authorization-port.js';
import type { ChannelPort } from './channel-port.js';
import type { ChatPort } from './chat-port.js';
import type { RealtimeConfig } from './config.js';
import type { ConnectionState } from './connection-state.js';
import type { Logger } from './logging.js';
import { HeartbeatMonitor } from './heartbeat.js';
import type { PresenceRegistry } from './presence/registry.js';
import type { ProfilePort } from './profile-port.js';
import type { TurnCredentialPort } from './turn-credential-port.js';
import {
  buildFilteredVoiceCatalogMessage,
  routeClientMessage,
  type PendingIdentityChallenge,
} from './protocol-handlers.js';
import { RateLimiter } from './rate-limiter.js';
import {
  maybeDestroyEmptyTemporaryChannel,
  type TemporaryChannelRegistry,
} from './voice/temporary-channels.js';
import type { VoiceRegistry } from './voice/registry.js';

/**
 * Which {@link ErrorCode}s close the connection, and with which WebSocket close code. A code's
 * absence here means it is **non-fatal**: `server:error` is sent, but the connection stays open.
 * This single table is the one source of truth for that split (see `errors.ts` in
 * `packages/protocol` for the reasoning) — there is no separately-maintained "is this fatal" flag
 * to drift out of sync with it.
 */
const CLOSE_CODE_BY_ERROR: Partial<Record<ErrorCode, number>> = {
  INVALID_MESSAGE: CLOSE_CODES.INVALID_MESSAGE,
  UNSUPPORTED_PROTOCOL: CLOSE_CODES.UNSUPPORTED_PROTOCOL,
  HANDSHAKE_REQUIRED: CLOSE_CODES.HANDSHAKE_REQUIRED,
  HANDSHAKE_TIMEOUT: CLOSE_CODES.HANDSHAKE_TIMEOUT,
  UNEXPECTED_MESSAGE: CLOSE_CODES.UNEXPECTED_MESSAGE,
  RATE_LIMITED: CLOSE_CODES.RATE_LIMITED,
  MESSAGE_TOO_LARGE: CLOSE_CODES.MESSAGE_TOO_LARGE,
  IDENTITY_INVALID_PUBLIC_KEY: CLOSE_CODES.IDENTITY_INVALID_PUBLIC_KEY,
  IDENTITY_INVALID_SIGNATURE: CLOSE_CODES.IDENTITY_INVALID_SIGNATURE,
  IDENTITY_CHALLENGE_EXPIRED: CLOSE_CODES.IDENTITY_CHALLENGE_EXPIRED,
  IDENTITY_PROTOCOL_ERROR: CLOSE_CODES.IDENTITY_PROTOCOL_ERROR,
  INTERNAL_ERROR: CLOSE_CODES.INTERNAL_ERROR,
  SERVER_AT_CAPACITY: CLOSE_CODES.SERVER_AT_CAPACITY,
  // T9 — BANNED/INVITE_REQUIRED are fatal admission-time rejections; KICKED/BANNED (the same code
  // reused) also close an already-`ready` connection an administrator acted on. AUTHORIZATION_DENIED,
  // GROUP_NOT_FOUND, PROTECTED_GROUP, LAST_ADMIN, TOKEN_INVALID, TOKEN_EXPIRED, TOKEN_ALREADY_USED,
  // and PARTICIPANT_NOT_FOUND are intentionally absent — ordinary, recoverable admin-UI conditions,
  // not protocol violations (see errors.ts).
  BANNED: CLOSE_CODES.BANNED,
  INVITE_REQUIRED: CLOSE_CODES.INVITE_REQUIRED,
  KICKED: CLOSE_CODES.KICKED,
  // CHANNEL_NOT_FOUND, NOT_IN_VOICE_CHANNEL, SIGNALING_TARGET_INVALID, CHANNEL_FULL are
  // intentionally absent: they are ordinary recoverable conditions (see errors.ts), not protocol
  // violations.
  // T10 — CHAT_RATE_LIMITED is also intentionally absent: unlike the generic transport-level
  // RATE_LIMITED above, a chatty-but-legitimate client is throttled, not disconnected (see
  // errors.ts and config.ts's chat-specific rate-limit buckets).
};

/** How long to wait for a clean WS close handshake before forcing the socket shut. */
const FORCE_CLOSE_GRACE_MS = 2_000;

/**
 * Every *fatal* rejection results in a `server:error` (when the socket can still be written to)
 * followed immediately by connection close — see {@link CLOSE_CODE_BY_ERROR}. A non-fatal
 * rejection (T3's voice/signaling domain errors) sends only the `server:error`; the connection
 * and its voice membership are untouched. The one exception to "error then close" for fatal codes
 * is an oversized frame, which `ws`'s own `maxPayload` enforcement terminates before any
 * application code observes it (see `errors.ts` in `packages/protocol`).
 */
export class Connection {
  readonly id: string = randomUUID();
  readonly connectedAt: number;
  private _state: ConnectionState = 'awaiting_hello';
  private _identityId: string | undefined;
  private _nickname: string | undefined;
  private pendingChallenge: PendingIdentityChallenge | undefined;
  private readonly rateLimiter: RateLimiter;
  /** T10 — separate, smaller buckets than {@link rateLimiter} for chat specifically (see
   * `config.ts`'s doc comment). Checked in `handleRawMessage` after the message is known to be a
   * chat message, before it ever reaches `routeClientMessage` — the same "stateful things live in
   * `Connection`, the handler layer stays pure" split the generic rate limiter already uses. */
  private readonly chatSendRateLimiter: RateLimiter;
  private readonly chatHistoryRateLimiter: RateLimiter;
  /** T13.2 — per-connection rate limiter for `voice:join` attempts against a password-protected
   * channel (see `HandlerContext.channelPasswordRateLimiter`'s own doc comment in
   * `protocol-handlers.ts`). */
  private readonly channelPasswordRateLimiter: RateLimiter;
  /** T13.3 — separate, smaller buckets for profile self-service mutations and on-demand avatar
   * fetches specifically (see `config.ts`'s doc comment), checked the same way
   * `chatSendRateLimiter`/`chatHistoryRateLimiter` are: once the message type is known but before
   * `routeClientMessage` ever runs. */
  private readonly profileMutationRateLimiter: RateLimiter;
  private readonly avatarFetchRateLimiter: RateLimiter;
  private readonly heartbeat: HeartbeatMonitor;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private forceCloseTimer: NodeJS.Timeout | undefined;
  private closeReason: string | undefined;
  private resolveClosed!: () => void;
  private readonly closedPromise: Promise<void>;

  constructor(
    private readonly socket: WebSocket,
    private readonly config: RealtimeConfig,
    private readonly logger: Logger,
    private readonly voiceRegistry: VoiceRegistry,
    /** T8 — the Dedicated Server's own display metadata, echoed into every `server:hello` this
     * connection produces. Composition config, immutable for the process lifetime. */
    private readonly serverMetadata: {
      readonly name: string;
      readonly capabilities: readonly ServerCapability[];
    },
    /** T9 — server-local authorization (see `authorization-port.ts`). Composition config, shared
     * across every connection this server accepts. */
    private readonly authorization: AuthorizationPort,
    /** T10 — server-local persistent chat (see `chat-port.ts`). Composition config, shared across
     * every connection this server accepts. */
    private readonly chat: ChatPort,
    /** T13.2 — server-local persistent channel/category tree (see `channel-port.ts`). Composition
     * config, shared across every connection this server accepts. */
    private readonly channels: ChannelPort,
    /** T13.2 — in-memory, non-persistent "quick channel" registry (see
     * `voice/temporary-channels.ts`). Shared across every connection this server accepts (a single
     * process-wide registry, exactly like `voiceRegistry`). */
    private readonly temporaryChannels: TemporaryChannelRegistry,
    /** T13.3 — server-local persistent profile state (see `profile-port.ts`). Composition config,
     * shared across every connection this server accepts. */
    private readonly profile: ProfilePort,
    /** T13.3 — in-memory, non-persistent online-presence registry (see
     * `presence/registry.ts`). Shared across every connection this server accepts (a single
     * process-wide registry, exactly like `voiceRegistry`). */
    private readonly presenceRegistry: PresenceRegistry,
    /** T14 — TURN credential minting (see `turn-credential-port.ts`). Composition config, shared
     * across every connection this server accepts. */
    private readonly turnCredentials: TurnCredentialPort,
    /** Sends a message to a *different* connection, looked up by id, if it still exists. */
    private readonly deliverToConnection: (connectionId: string, message: ServerMessage) => void,
    /** T9 — forcibly closes a *different* connection, looked up by id, with a `server:error` +
     * matching close code (moderation: kick/ban). No-op if that connection no longer exists. */
    private readonly closeOtherConnection: (
      connectionId: string,
      code: ErrorCode,
      message: string,
    ) => void,
    /** T10 — pushes a message to every currently-`ready` connection (server-wide chat broadcast;
     * see `protocol-handlers.ts`'s `'broadcast-ready'` `OutgoingAction`). */
    private readonly broadcastToReadyConnections: (message: ServerMessage) => void,
    /** T13.2 — pushes a *personalized* message (one `buildMessage` call per recipient) to every
     * currently-`ready` connection with a known `identityId` (see `protocol-handlers.ts`'s
     * `'broadcast-ready-personalized'` `OutgoingAction`). Also called directly from
     * `cleanupVoiceMembership` below — an abrupt disconnect that empties a temporary channel
     * triggers the same personalized catalog refresh outside of `routeClientMessage`'s own action
     * pipeline. */
    private readonly broadcastToReadyPersonalized: (
      buildMessage: (identityId: string) => ServerMessage | undefined,
    ) => void,
    /** T13.3 — `broadcastToReadyConnections`'s counterpart that excludes one connection id (the
     * connecting one itself, for a freshly-online identity's `server:presence-updated` — see
     * `protocol-handlers.ts`'s `'broadcast-ready-except-self'` `OutgoingAction`). */
    private readonly broadcastToReadyExceptConnection: (
      excludeConnectionId: string,
      message: ServerMessage,
    ) => void,
    private readonly onClosed: (connection: Connection) => void,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.connectedAt = this.now().getTime();
    this.rateLimiter = new RateLimiter(config.rateLimit);
    this.chatSendRateLimiter = new RateLimiter(config.chatSendRateLimit);
    this.chatHistoryRateLimiter = new RateLimiter(config.chatHistoryRateLimit);
    this.channelPasswordRateLimiter = new RateLimiter(config.channelPasswordRateLimit);
    this.profileMutationRateLimiter = new RateLimiter(config.profileMutationRateLimit);
    this.avatarFetchRateLimiter = new RateLimiter(config.avatarFetchRateLimit);
    this.heartbeat = new HeartbeatMonitor(config.heartbeatIntervalMs, config.heartbeatTimeoutMs, {
      sendPing: () => {
        // Not currently reachable with a throw in `ws@8.21.3` (`ping()` only throws while
        // CONNECTING, which a server-side socket never is, and no-ops after close), but guard
        // consistently with `send()` anyway rather than depend on that library-version detail.
        if (this.socket.readyState === this.socket.OPEN) this.socket.ping();
      },
      onTimeout: () => {
        this.logger.warn('heartbeat_timeout', { connectionId: this.id });
        this.terminate('heartbeat timeout');
      },
    });

    this.handshakeTimer = setTimeout(
      () => this.handleHandshakeTimeout(),
      config.handshakeTimeoutMs,
    );

    socket.on('message', (data, isBinary) => this.handleRawMessage(data, isBinary));
    socket.on('pong', () => this.heartbeat.acknowledge());
    socket.on('close', (code, reason) => this.handleSocketClosed(code, reason.toString()));
    socket.on('error', (error) =>
      this.logger.warn('connection_socket_error', { connectionId: this.id, error: error.message }),
    );
  }

  get state(): ConnectionState {
    return this._state;
  }

  /** T9 — this connection's server-verified identity, once authenticated; `undefined` before
   * (or if) that ever happens. */
  get identityId(): string | undefined {
    return this._identityId;
  }

  /** T10 — the nickname claimed at `client:hello`, retained the same way `identityId` is (see
   * `RouteResult.nickname`'s doc comment in `protocol-handlers.ts`). */
  get nickname(): string | undefined {
    return this._nickname;
  }

  /** Resolves once the underlying socket has actually finished closing. */
  get closed(): Promise<void> {
    return this.closedPromise;
  }

  /** Pushes a server-originated message to this connection (e.g. forwarded signaling, presence). */
  deliver(message: ServerMessage): void {
    this.send(message);
  }

  /** T9 — forcibly rejects and closes this connection from an *external* trigger (moderation:
   * kick/ban targeting this connection) — the same send-error-then-close policy every internal
   * fatal rejection already uses, just invokable from outside (see `server.ts`'s
   * `closeOtherConnection`). */
  forceReject(code: ErrorCode, message: string): void {
    this.rejectAndClose(code, message);
  }

  private handleHandshakeTimeout(): void {
    if (this._state !== 'awaiting_hello' && this._state !== 'awaiting_identity_proof') return;
    this.logger.warn('handshake_timeout', { connectionId: this.id });
    this.rejectAndClose('HANDSHAKE_TIMEOUT', 'Handshake was not completed in time');
  }

  private handleRawMessage(data: RawData, isBinary: boolean): void {
    if (
      this._state !== 'awaiting_hello' &&
      this._state !== 'awaiting_identity_proof' &&
      this._state !== 'ready'
    ) {
      return;
    }

    if (isBinary) {
      this.rejectAndClose('INVALID_MESSAGE', 'Binary frames are not supported');
      return;
    }

    if (!this.rateLimiter.tryConsume()) {
      this.logger.warn('rate_limited', { connectionId: this.id });
      this.rejectAndClose('RATE_LIMITED', 'Message rate limit exceeded');
      return;
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(data.toString('utf8'));
    } catch {
      this.rejectAndClose('INVALID_MESSAGE', 'Message body is not valid JSON');
      return;
    }

    const parsed = parseClientMessage(parsedJson);
    if (!parsed.ok) {
      this.logger.info('protocol_rejected', { connectionId: this.id, issues: parsed.issues });
      this.rejectAndClose('INVALID_MESSAGE', 'Message does not match the protocol schema');
      return;
    }

    // T10 — a separate, smaller rate-limit bucket for chat specifically, checked once the message
    // type is known but *before* `routeClientMessage` — non-fatal (see `errors.ts`'s
    // `CHAT_RATE_LIMITED`), unlike the generic transport-level check above.
    if (parsed.message.type === 'client:chat-send' && !this.chatSendRateLimiter.tryConsume()) {
      this.rejectOrWarn('CHAT_RATE_LIMITED', 'Chat message rate limit exceeded', parsed.message.id);
      return;
    }
    if (
      parsed.message.type === 'client:chat-history-request' &&
      !this.chatHistoryRateLimiter.tryConsume()
    ) {
      this.rejectOrWarn(
        'CHAT_RATE_LIMITED',
        'Chat history request rate limit exceeded',
        parsed.message.id,
      );
      return;
    }

    // T13.3 — separate, smaller rate-limit buckets for profile mutations and on-demand avatar
    // fetches specifically, checked the same way chat's own buckets are: once the message type is
    // known but before `routeClientMessage` ever runs. Non-fatal (`PROFILE_RATE_LIMITED`).
    const isProfileMutation =
      parsed.message.type === 'client:profile-set-avatar' ||
      parsed.message.type === 'client:profile-clear-avatar' ||
      parsed.message.type === 'client:profile-set-status' ||
      parsed.message.type === 'client:profile-clear-member-status' ||
      parsed.message.type === 'client:profile-set-presence';
    if (isProfileMutation && !this.profileMutationRateLimiter.tryConsume()) {
      this.rejectOrWarn(
        'PROFILE_RATE_LIMITED',
        'Profile mutation rate limit exceeded',
        parsed.message.id,
      );
      return;
    }
    if (
      parsed.message.type === 'client:profile-request-avatar' &&
      !this.avatarFetchRateLimiter.tryConsume()
    ) {
      this.rejectOrWarn(
        'PROFILE_RATE_LIMITED',
        'Avatar fetch rate limit exceeded',
        parsed.message.id,
      );
      return;
    }

    // Everything past this point operates on an already-validated message, but this is a
    // single-process service shared by every connected client: an uncaught exception here would
    // crash the process and drop every connection, not just this one. Contain any unexpected
    // failure to this connection instead, matching the `INTERNAL_ERROR` code's documented
    // contract (see errors.ts) — the client never sees `error.message`/stack, only the generic
    // code; diagnostic detail is server-log-only.
    try {
      const result = routeClientMessage(parsed.message, this._state, {
        connectionId: this.id,
        now: this.now,
        heartbeat: {
          intervalMs: this.config.heartbeatIntervalMs,
          timeoutMs: this.config.heartbeatTimeoutMs,
        },
        voiceRegistry: this.voiceRegistry,
        identityChallengeTtlMs: this.config.identityChallengeTtlMs,
        pendingChallenge: this.pendingChallenge,
        serverMetadata: this.serverMetadata,
        authorization: this.authorization,
        chat: this.chat,
        channels: this.channels,
        temporaryChannels: this.temporaryChannels,
        channelPasswordRateLimiter: this.channelPasswordRateLimiter,
        profile: this.profile,
        presenceRegistry: this.presenceRegistry,
        turnCredentials: this.turnCredentials,
        identityId: this._identityId,
        nickname: this._nickname,
      });

      if (!result.ok) {
        this.rejectOrWarn(result.code, result.message, parsed.message.id);
        return;
      }

      const enteringReady = this._state !== 'ready' && result.nextState === 'ready';
      this._state = result.nextState;
      this.pendingChallenge = result.pendingChallenge;
      if (result.identityId) this._identityId = result.identityId;
      if (result.nickname) this._nickname = result.nickname;

      if (enteringReady) {
        this.clearHandshakeTimer();
        this.heartbeat.start();
        this.logger.info('handshake_completed', { connectionId: this.id });
      }

      for (const action of result.actions) {
        if (action.kind === 'reply') {
          this.send(action.message);
        } else if (action.kind === 'deliver') {
          this.deliverToConnection(action.connectionId, action.message);
        } else if (action.kind === 'broadcast-ready') {
          this.broadcastToReadyConnections(action.message);
        } else if (action.kind === 'broadcast-ready-personalized') {
          this.broadcastToReadyPersonalized(action.buildMessage);
        } else if (action.kind === 'broadcast-ready-except-self') {
          this.broadcastToReadyExceptConnection(this.id, action.message);
        } else {
          this.closeOtherConnection(action.connectionId, action.code, action.message);
        }
      }
    } catch (error) {
      this.logger.error('unexpected_handler_error', {
        connectionId: this.id,
        error: error instanceof Error ? error.message : String(error),
      });
      this.rejectAndClose('INTERNAL_ERROR', 'Unexpected server error', parsed.message.id);
    }
  }

  /** Fatal codes (present in {@link CLOSE_CODE_BY_ERROR}) close the connection; others do not. */
  private rejectOrWarn(code: ErrorCode, message: string, replyTo?: string): void {
    const closeCode = CLOSE_CODE_BY_ERROR[code];
    if (closeCode === undefined) {
      this.sendError(code, message, replyTo);
      return;
    }
    this.sendError(code, message, replyTo);
    this.close(closeCode, code);
  }

  private rejectAndClose(code: ErrorCode, message: string, replyTo?: string): void {
    this.sendError(code, message, replyTo);
    this.close(CLOSE_CODE_BY_ERROR[code] ?? CLOSE_CODES.INTERNAL_ERROR, code);
  }

  private send(message: ServerMessage): void {
    if (this.socket.readyState !== this.socket.OPEN) return;
    this.socket.send(JSON.stringify(message));
  }

  private sendError(code: ErrorCode, message: string, replyTo?: string): void {
    this.send({
      type: 'server:error',
      id: randomUUID(),
      code,
      message,
      ...(replyTo ? { replyTo } : {}),
    });
  }

  /**
   * Graceful close: attempts a clean WebSocket close handshake. If the remote end never
   * completes it within {@link FORCE_CLOSE_GRACE_MS}, the socket is forcibly terminated so a
   * misbehaving/unresponsive client can never keep a connection (or a server shutdown) hanging.
   */
  close(code: number, reason: string): void {
    if (this._state === 'closing' || this._state === 'closed') return;
    this._state = 'closing';
    this.closeReason = reason;
    this.clearHandshakeTimer();
    this.heartbeat.stop();
    this.socket.close(code, reason);
    this.forceCloseTimer = setTimeout(() => {
      this.logger.warn('close_handshake_timeout', { connectionId: this.id });
      this.socket.terminate();
    }, FORCE_CLOSE_GRACE_MS);
  }

  /** Forceful teardown (e.g. a dead connection that never sent a real close frame). */
  private terminate(reason: string): void {
    if (this._state === 'closed') return;
    this._state = 'closing';
    this.closeReason = reason;
    this.clearHandshakeTimer();
    this.heartbeat.stop();
    this.socket.terminate();
  }

  private handleSocketClosed(code: number, reason: string): void {
    this._state = 'closed';
    this.clearHandshakeTimer();
    this.clearForceCloseTimer();
    this.heartbeat.stop();
    this.cleanupVoiceMembership();
    this.cleanupPresence();
    this.logger.info('connection_closed', {
      connectionId: this.id,
      code,
      reason: this.closeReason ?? reason,
    });
    this.onClosed(this);
    this.resolveClosed();
  }

  /**
   * If a WebSocket disappears — however it disappears, explicit `voice:leave` or not — the
   * participant must not linger in server state, and remaining channel members must learn they
   * left. This never waits for an explicit leave message.
   */
  private cleanupVoiceMembership(): void {
    const left = this.voiceRegistry.leave(this.id);
    if (!left) return;

    this.logger.info('voice_left_on_disconnect', {
      connectionId: this.id,
      channelId: left.channelId,
      participantId: left.participantId,
    });

    for (const memberConnectionId of left.remainingMemberConnectionIds) {
      this.deliverToConnection(memberConnectionId, {
        type: 'voice:participant-left',
        id: randomUUID(),
        channelId: left.channelId,
        participantId: left.participantId,
      });
    }

    // T13.2 — an abrupt disconnect is the second of the two call sites that can empty a temporary
    // channel (`handleVoiceLeave` in `protocol-handlers.ts` is the other) — see
    // `voice/temporary-channels.ts`'s `maybeDestroyEmptyTemporaryChannel` doc comment for why this
    // one shared helper must be used at both, never duplicated.
    const destroyed = maybeDestroyEmptyTemporaryChannel(
      left.channelId,
      this.temporaryChannels,
      this.voiceRegistry,
      this.chat,
    );
    if (destroyed.destroyed) {
      this.broadcastToReadyPersonalized((identityId) =>
        buildFilteredVoiceCatalogMessage(
          {
            authorization: this.authorization,
            channels: this.channels,
            temporaryChannels: this.temporaryChannels,
            voiceRegistry: this.voiceRegistry,
            chat: this.chat,
            now: this.now,
          },
          identityId,
        ),
      );
    }
  }

  /**
   * T13.3 — mirrors `cleanupVoiceMembership`'s "never wait for an explicit leave message" guarantee:
   * whenever this connection's socket disappears, this identity's presence must not linger. Only
   * broadcasts `server:presence-removed` on a genuine 1->0 transition (this connection was the
   * identity's *last* live connection) — deregistering one of several simultaneous connections for
   * the same identity is silent, since the identity is still visibly online via the other(s).
   */
  private cleanupPresence(): void {
    const deregistered = this.presenceRegistry.deregisterConnection(this.id);
    if (!deregistered?.becameOffline) return;

    this.logger.info('presence_offline_on_disconnect', {
      connectionId: this.id,
      memberRef: deregistered.memberRef,
    });

    // `broadcastToReadyConnections` already filters to `state === 'ready'`, and this connection's
    // own state was set to `'closed'` above, so it never receives its own removal notice.
    this.broadcastToReadyConnections({
      type: 'server:presence-removed',
      id: randomUUID(),
      memberRef: deregistered.memberRef,
    });
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = undefined;
    }
  }

  private clearForceCloseTimer(): void {
    if (this.forceCloseTimer) {
      clearTimeout(this.forceCloseTimer);
      this.forceCloseTimer = undefined;
    }
  }
}
