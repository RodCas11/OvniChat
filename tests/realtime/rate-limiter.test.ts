import { describe, expect, it } from 'vitest';

import { RateLimiter } from '../../services/realtime/src/rate-limiter.js';

describe('RateLimiter', () => {
  it('allows messages up to the configured maximum within a window', () => {
    const now = 0;
    const limiter = new RateLimiter({ maxMessages: 3, windowMs: 1000 }, () => now);

    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
  });

  it('rejects once the limit is exceeded within the same window', () => {
    const now = 0;
    const limiter = new RateLimiter({ maxMessages: 2, windowMs: 1000 }, () => now);

    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);
  });

  it('resets the count once the window elapses', () => {
    let now = 0;
    const limiter = new RateLimiter({ maxMessages: 2, windowMs: 1000 }, () => now);

    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(true);
    expect(limiter.tryConsume()).toBe(false);

    now = 1000;
    expect(limiter.tryConsume()).toBe(true);
  });

  it('keeps rejecting a client that continues sending past the limit within the window', () => {
    const now = 0;
    const limiter = new RateLimiter({ maxMessages: 1, windowMs: 1000 }, () => now);

    expect(limiter.tryConsume()).toBe(true);
    for (let i = 0; i < 5; i += 1) {
      expect(limiter.tryConsume()).toBe(false);
    }
  });
});
