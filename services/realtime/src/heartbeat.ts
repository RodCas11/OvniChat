export interface HeartbeatCallbacks {
  readonly sendPing: () => void;
  readonly onTimeout: () => void;
}

/**
 * Server-driven liveness detection using WebSocket protocol-level ping/pong frames, independent
 * of the application-level `client:ping`/`server:pong` message pair.
 *
 * Deliberate split: a browser-like `WebSocket` client (the eventual Electron Renderer consumer)
 * cannot itself send a protocol-level ping or observe a pong — that is handled entirely by the
 * network stack, invisible to JS. Only the server can drive protocol-level pings, so this is the
 * server's own mechanism for detecting dead/half-open connections regardless of whether the
 * client ever sends anything. The application-level `client:ping` exists for the opposite
 * direction: it is the only way client-side code can proactively verify liveness/measure
 * round-trip time for itself, since it cannot originate a protocol-level ping.
 *
 * Every `intervalMs` tick sends one ping and arms a `timeoutMs` grace timer; a pong before the
 * timer fires acknowledges it. If the timer fires — meaning that specific ping's pong never
 * arrived — the connection is declared dead.
 */
export class HeartbeatMonitor {
  private intervalTimer: NodeJS.Timeout | undefined;
  private timeoutTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly intervalMs: number,
    private readonly timeoutMs: number,
    private readonly callbacks: HeartbeatCallbacks,
  ) {}

  start(): void {
    this.intervalTimer = setInterval(() => this.beat(), this.intervalMs);
  }

  private beat(): void {
    this.callbacks.sendPing();
    this.timeoutTimer = setTimeout(() => this.callbacks.onTimeout(), this.timeoutMs);
  }

  /** Call when a pong is received: cancels the outstanding grace timer for the ping it answers. */
  acknowledge(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
  }

  stop(): void {
    if (this.intervalTimer) {
      clearInterval(this.intervalTimer);
      this.intervalTimer = undefined;
    }
    this.acknowledge();
  }
}
