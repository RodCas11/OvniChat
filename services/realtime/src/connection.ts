import { randomUUID } from 'node:crypto';

import {
  CLOSE_CODES,
  parseClientMessage,
  type ErrorCode,
  type ServerMessage,
} from '@disco-voador/protocol';
import type { RawData, WebSocket } from 'ws';

import type { RealtimeConfig } from './config.js';
import type { ConnectionState } from './connection-state.js';
import type { Logger } from './logging.js';
import { HeartbeatMonitor } from './heartbeat.js';
import { routeClientMessage, type PendingIdentityChallenge } from './protocol-handlers.js';
import { RateLimiter } from './rate-limiter.js';
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
  // CHANNEL_NOT_FOUND, NOT_IN_VOICE_CHANNEL, SIGNALING_TARGET_INVALID, CHANNEL_FULL are
  // intentionally absent: they are ordinary recoverable conditions (see errors.ts), not protocol
  // violations.
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
  private pendingChallenge: PendingIdentityChallenge | undefined;
  private readonly rateLimiter: RateLimiter;
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
    /** Sends a message to a *different* connection, looked up by id, if it still exists. */
    private readonly deliverToConnection: (connectionId: string, message: ServerMessage) => void,
    private readonly onClosed: (connection: Connection) => void,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.closedPromise = new Promise((resolve) => {
      this.resolveClosed = resolve;
    });
    this.connectedAt = this.now().getTime();
    this.rateLimiter = new RateLimiter(config.rateLimit);
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

  /** Resolves once the underlying socket has actually finished closing. */
  get closed(): Promise<void> {
    return this.closedPromise;
  }

  /** Pushes a server-originated message to this connection (e.g. forwarded signaling, presence). */
  deliver(message: ServerMessage): void {
    this.send(message);
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
      });

      if (!result.ok) {
        this.rejectOrWarn(result.code, result.message, parsed.message.id);
        return;
      }

      const enteringReady = this._state !== 'ready' && result.nextState === 'ready';
      this._state = result.nextState;
      this.pendingChallenge = result.pendingChallenge;

      if (enteringReady) {
        this.clearHandshakeTimer();
        this.heartbeat.start();
        this.logger.info('handshake_completed', { connectionId: this.id });
      }

      for (const action of result.actions) {
        if (action.kind === 'reply') {
          this.send(action.message);
        } else {
          this.deliverToConnection(action.connectionId, action.message);
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
