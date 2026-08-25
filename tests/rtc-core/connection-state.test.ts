import { describe, expect, it } from 'vitest';

import {
  classifyPeerTransportHealth,
  isTerminalPeerConnectionState,
} from '../../packages/rtc-core/src/connection-state.js';

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

describe('classifyPeerTransportHealth (T15.2)', () => {
  it('reports "closed" for a connection that is gone, whichever axis says so', () => {
    expect(classifyPeerTransportHealth('closed', 'new')).toBe('closed');
    expect(classifyPeerTransportHealth('connected', 'closed')).toBe('closed');
  });

  it('reports "failed" for a conclusively failed transport, on either axis', () => {
    expect(classifyPeerTransportHealth('failed', 'failed')).toBe('failed');
    expect(classifyPeerTransportHealth('connecting', 'failed')).toBe('failed');
    expect(classifyPeerTransportHealth('failed', 'checking')).toBe('failed');
  });

  it('lets "failed" win over a stale "connected"/"completed" on the other axis', () => {
    // Practically unreachable on a conforming platform, but treating this as healthy would leave a
    // genuinely broken connection permanently outside every recovery path — the exact dead end
    // T15.1 had to fix once already.
    expect(classifyPeerTransportHealth('connected', 'failed')).toBe('failed');
    expect(classifyPeerTransportHealth('failed', 'completed')).toBe('failed');
  });

  it('reports "established" once either axis proves media can flow', () => {
    expect(classifyPeerTransportHealth('connected', 'checking')).toBe('established');
    expect(classifyPeerTransportHealth('connecting', 'connected')).toBe('established');
    // The documented transient-hiccup shape: ICE still has a selected pair, DTLS momentarily lapsed.
    expect(classifyPeerTransportHealth('disconnected', 'completed')).toBe('established');
  });

  it('reports "pending" for every not-yet-working, not-conclusively-broken state', () => {
    expect(classifyPeerTransportHealth('new', 'new')).toBe('pending');
    expect(classifyPeerTransportHealth('connecting', 'checking')).toBe('pending');
    // `'disconnected'` alone is transient, never a recovery or teardown trigger by itself.
    expect(classifyPeerTransportHealth('disconnected', 'disconnected')).toBe('pending');
  });
});
