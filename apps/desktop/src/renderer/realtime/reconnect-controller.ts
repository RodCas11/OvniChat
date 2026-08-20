import type { IdentitySigner } from './identity-signer.js';
import { classifyCloseCode } from './reconnect-policy.js';
import {
  RealtimeClient,
  type ClosedInfo,
  type RealtimeConnectionState,
} from './realtime-client.js';

/**
 * T11 automatic reconnect (see `docs/architecture/CLIENT_SETTINGS_AND_RECONNECT.md`). Wraps one
 * `RealtimeClient` instance for its entire lifetime — the underlying client already tolerates being
 * `connect()`-ed again after a close (`connect()`'s own `if (this.socket) return` guard, and the
 * `'close'` listener clearing `this.socket`), so this controller only ever calls `connect()`/
 * `disconnect()` on the *same* instance rather than constructing a new one per attempt. This keeps
 * every domain-event listener (`catalog`, `joined`, `chatMessage`, ...) a caller attaches to
 * `.client` valid across every reconnect — nothing needs to re-subscribe.
 *
 * Deliberately a separate class, not new states/methods inside `RealtimeClient` itself:
 * `RealtimeClient` is used directly by E2E scripts (`e2e-identity-auth.mjs` et al.) that expect
 * today's simple "one connect, one final close" semantics — retry logic living here instead means
 * only a caller that opts into a `ReconnectController` gets it.
 */

export type ReconnectingConnectionState =
  'connecting' | 'authenticating' | 'open' | 'reconnecting' | 'closed';

export interface ReconnectingEvent {
  readonly attempt: number;
  readonly delayMs: number;
}

export interface ConnectionFailedEvent {
  readonly code: number;
  readonly reason: string;
}

interface ReconnectControllerEvents {
  stateChange: (state: ReconnectingConnectionState) => void;
  /** A reconnect attempt has been scheduled (not yet started) — `delayMs` is the actual delay
   * including jitter, useful for a "retrying in Ns" countdown if a future UI wants one. */
  reconnecting: (event: ReconnectingEvent) => void;
  /** Fires once, the moment a reconnect attempt's `RealtimeClient` reaches `'open'` again — the
   * signal `use-voice-channel.ts` uses to trigger channel/mute/deafen restoration and a chat-history
   * reload. Never fires for the *first* successful connect (that's an ordinary `stateChange('open')`
   * with no prior loss to recover from). */
  reconnected: () => void;
  /**
   * This connect/reconnect sequence will not retry further — `stateChange('closed')` fires
   * alongside it. Covers two distinct cases the UI should both surface as a real, human-readable
   * error rather than a silent/generic "disconnected":
   *
   * 1. A close the policy classifies non-retryable (banned, kicked, incompatible protocol, ...),
   *    at any point — including mid-reconnect-loop.
   * 2. **Any** close — even one that would otherwise be retryable, like an abnormal network
   *    drop — that happens before this connect sequence ever reached `'open'` even once. A first
   *    connection attempt failing (wrong address, server not running, refused) must never silently
   *    retry-loop forever with no feedback; the user should see a clear failure and choose to try
   *    again, exactly like every attempt before T11. Automatic backoff-retry is reserved for
   *    recovering an *already-established* session's unexpected loss, never for guessing whether a
   *    first attempt might eventually succeed.
   */
  connectionFailed: (event: ConnectionFailedEvent) => void;
}

const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

/** Equal jitter: half the computed delay is fixed, half is random — spreads out many clients
 * retrying after the same server restart without ever waiting less than half the intended delay. */
function withJitter(delayMs: number): number {
  return delayMs / 2 + Math.random() * (delayMs / 2);
}

export class ReconnectController {
  readonly client: RealtimeClient;

  private state: ReconnectingConnectionState = 'closed';
  /** Bumped on every explicit `connect()`/`disconnect()` — invalidates any in-flight reconnect
   * timer from a *previous* attempt sequence, so a stale timer firing after the user manually
   * disconnected or connected elsewhere can never call `connect()` on a controller nobody wants
   * retried anymore (T11 Section 44/45/82). */
  private generation = 0;
  private explicitDisconnect = true;
  private backoffMs = INITIAL_BACKOFF_MS;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private lastClosed: ClosedInfo | undefined;
  private everReachedOpen = false;

  private readonly listeners: {
    [K in keyof ReconnectControllerEvents]: Set<ReconnectControllerEvents[K]>;
  } = {
    stateChange: new Set(),
    reconnecting: new Set(),
    reconnected: new Set(),
    connectionFailed: new Set(),
  };

  constructor(url: string, signer: IdentitySigner, serverToken?: string) {
    this.client = new RealtimeClient(url, signer, serverToken);
    this.client.on('closed', this.handleClientClosed);
    this.client.on('stateChange', this.handleClientStateChange);
  }

  on<K extends keyof ReconnectControllerEvents>(
    event: K,
    listener: ReconnectControllerEvents[K],
  ): void {
    this.listeners[event].add(listener);
  }

  off<K extends keyof ReconnectControllerEvents>(
    event: K,
    listener: ReconnectControllerEvents[K],
  ): void {
    this.listeners[event].delete(listener);
  }

  /** Starts (or restarts) the connection with a clean retry budget — the first attempt of a new,
   * deliberate connection sequence, never itself a retry. */
  connect(): void {
    this.explicitDisconnect = false;
    this.generation += 1;
    this.backoffMs = INITIAL_BACKOFF_MS;
    this.attempt = 0;
    this.everReachedOpen = false;
    this.clearReconnectTimer();
    this.client.connect();
  }

  /** Explicit user disconnect (T11 Section 39/57, mandatory): marks this sequence as deliberately
   * ended, cancels any pending reconnect timer, and closes the live socket if there is one. No
   * further reconnect attempt can happen for this controller until `connect()` is called again. */
  disconnect(): void {
    this.explicitDisconnect = true;
    this.generation += 1;
    this.clearReconnectTimer();
    this.client.disconnect();
    this.setState('closed');
  }

  /** Same effect as `disconnect()` — named separately for the "Cancel" button on the reconnecting
   * UI (T11 Section 44), which is conceptually canceling a pending retry, not disconnecting an
   * already-open session (there usually isn't one to disconnect while reconnecting). */
  cancelReconnect(): void {
    this.disconnect();
  }

  private handleClientClosed = (info: ClosedInfo): void => {
    this.lastClosed = info;
  };

  private handleClientStateChange = (clientState: RealtimeConnectionState): void => {
    if (clientState !== 'closed') {
      this.setState(clientState);
      return;
    }
    this.handleUnderlyingClose();
  };

  private handleUnderlyingClose(): void {
    // Always surface the momentary 'closed' transition first — even when a retry follows
    // immediately after — so the UI genuinely observes "connection lost" before "reconnecting"
    // (T11 Section 43), rather than the state machine silently skipping over it.
    this.setState('closed');
    if (this.explicitDisconnect) return;

    const code = this.lastClosed?.code ?? -1;
    // Only an already-established session (reached 'open' at least once) gets the automatic
    // backoff-retry treatment — see `connectionFailed`'s doc comment for why a first connection
    // attempt never silently retry-loops, regardless of whether its close code would otherwise be
    // retryable.
    if (classifyCloseCode(code) === 'no-retry' || !this.everReachedOpen) {
      this.emit('connectionFailed', { code, reason: this.lastClosed?.reason ?? '' });
      return;
    }

    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.attempt += 1;
    const delayMs = withJitter(this.backoffMs);
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);

    this.setState('reconnecting');
    this.emit('reconnecting', { attempt: this.attempt, delayMs });

    const generation = this.generation;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      // Superseded by a manual connect()/disconnect() that happened while this timer was pending
      // (T11 Section 45/82's race requirement) — do nothing, this attempt sequence is dead.
      if (generation !== this.generation) return;
      this.client.connect();
    }, delayMs);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  private setState(state: ReconnectingConnectionState): void {
    // Deduplicates a redundant re-entry into the same non-'open' state — e.g. `disconnect()` sets
    // 'closed' immediately for instant UI feedback, and the underlying socket's own (possibly
    // asynchronous, per the real WebSocket spec) 'close' event later drives the exact same
    // transition again through `handleUnderlyingClose()`. 'open' is excluded: it is not
    // realistically re-entered without an intervening state change, and the recovery bookkeeping
    // below already has its own dedicated guard (`everReachedOpen`).
    if (state === this.state && state !== 'open') return;

    this.state = state;
    if (state === 'open') {
      const isRecovery = this.everReachedOpen;
      this.everReachedOpen = true;
      this.backoffMs = INITIAL_BACKOFF_MS;
      this.attempt = 0;
      this.emit('stateChange', state);
      if (isRecovery) this.emit('reconnected');
      return;
    }
    this.emit('stateChange', state);
  }

  getState(): ReconnectingConnectionState {
    return this.state;
  }

  private emit<K extends keyof ReconnectControllerEvents>(
    event: K,
    ...args: Parameters<ReconnectControllerEvents[K]>
  ): void {
    for (const listener of [...this.listeners[event]]) {
      (listener as (...eventArgs: Parameters<ReconnectControllerEvents[K]>) => void)(...args);
    }
  }
}
