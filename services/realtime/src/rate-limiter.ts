export interface RateLimiterOptions {
  readonly maxMessages: number;
  readonly windowMs: number;
}

/**
 * A minimal fixed-window per-connection message counter — deliberately not a distributed/shared
 * limiter. T2's threat model is one connected client flooding the Node event loop, not
 * coordinated abuse across many connections, so a lightweight independent counter per connection
 * is sufficient. `now` is injectable so tests are deterministic without real timers.
 */
export class RateLimiter {
  private windowStart: number;
  private count = 0;

  constructor(
    private readonly options: RateLimiterOptions,
    private readonly now: () => number = Date.now,
  ) {
    this.windowStart = this.now();
  }

  /** Records one message attempt; returns `false` once the limit for the current window is exceeded. */
  tryConsume(): boolean {
    const current = this.now();
    if (current - this.windowStart >= this.options.windowMs) {
      this.windowStart = current;
      this.count = 0;
    }

    this.count += 1;
    return this.count <= this.options.maxMessages;
  }
}
