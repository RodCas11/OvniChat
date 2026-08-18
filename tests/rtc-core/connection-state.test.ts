import { describe, expect, it } from 'vitest';

import { isTerminalPeerConnectionState } from '../../packages/rtc-core/src/connection-state.js';

describe('isTerminalPeerConnectionState', () => {
  it('treats "failed" and "closed" as terminal', () => {
    expect(isTerminalPeerConnectionState('failed')).toBe(true);
    expect(isTerminalPeerConnectionState('closed')).toBe(true);
  });

  it('treats "disconnected" as non-terminal because it can be a transient network hiccup', () => {
    expect(isTerminalPeerConnectionState('disconnected')).toBe(false);
  });

  it('treats every other connection state as non-terminal', () => {
    expect(isTerminalPeerConnectionState('new')).toBe(false);
    expect(isTerminalPeerConnectionState('connecting')).toBe(false);
    expect(isTerminalPeerConnectionState('connected')).toBe(false);
  });
});
