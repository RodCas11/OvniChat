// @vitest-environment jsdom
//
// T14 slice 5 — proves `useVoiceChannel`'s main connection effect merges the STUN servers it was
// configured with (`realtimeConfig.iceServers`) with the Dedicated Server's short-lived
// `server:turn-credentials` TURN payload, and applies the *combined* list to the live
// `P2PMeshTransport` via `setIceServers`. `P2PMeshTransport.setIceServers` is REPLACE, not merge,
// semantics (see `packages/rtc-core/src/p2p-mesh-transport.ts`'s own doc comment) — this hook must
// supply the full merged list itself on every call; nothing in `rtc-core` remembers the STUN
// servers the transport was originally constructed with.
//
// No existing test in this suite exercises `useVoiceChannel`'s real main connection effect (every
// other test either unit-tests a pure helper extracted from this file, or mocks the whole hook away
// — see `use-voice-channel-devices.test.ts`/`voice-channel-view-wiring.test.tsx`), so this file
// builds the minimal harness needed: a fake platform `WebSocket` (mirrors
// `realtime-client.test.ts`'s own `FakeWebSocket`, driving the real hello/challenge/proof handshake
// so `server:turn-credentials` arrives through the exact same wire path production does) and a fake
// `@disco-voador/rtc-core` `P2PMeshTransport` (the real WebRTC/`RTCPeerConnection` stack is out of
// scope for a hook-level test, same as every other heavy-dependency mock elsewhere in this suite).
import '@testing-library/jest-dom/vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installDesktopAppMock } from './fixtures/desktop-app-mock.js';

/** Mirrors `realtime-client.test.ts`'s own `FakeWebSocket` — a minimal stand-in implementing only
 * what `RealtimeClient` actually calls. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(listener);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code: number, reason: string): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatch('close', { code, reason });
  }

  simulateOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.dispatch('open', {});
  }

  simulateMessage(data: unknown): void {
    this.dispatch('message', { data });
  }

  private dispatch(type: string, event: unknown): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }
}

vi.stubGlobal('WebSocket', FakeWebSocket);

/** Minimal stand-in for the real Web Audio `AudioContext` — jsdom implements neither `AudioContext`
 * nor any of its node types (mirrors `settings-panel.test.tsx`'s own `FakeAudioContext` precedent).
 * `useVoiceChannel`'s main connection effect unconditionally constructs one
 * `RemoteAudioGraphController` per connection (T13.4), which otherwise crashes under Vitest/jsdom
 * with no injection point of its own (unlike `remote-audio-graph.test.ts`, which injects
 * `createAudioContext` directly — `use-voice-channel.ts` never exposes that option, so this test
 * stubs the global constructor instead). No `setSinkId` — `RemoteAudioGraphController.setOutputDevice`
 * already feature-detects its absence and no-ops, matching this app's own real-world "not every
 * platform build has it" guard. */
class FakeAudioContext {
  readonly destination = {};
  createMediaStreamSource(): { connect: () => void; disconnect: () => void } {
    return { connect: vi.fn(), disconnect: vi.fn() };
  }
  createGain(): { gain: { value: number }; connect: () => void; disconnect: () => void } {
    return { gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() };
  }
  createAnalyser(): {
    fftSize: number;
    frequencyBinCount: number;
    getByteTimeDomainData: (buffer: Uint8Array) => void;
    connect: () => void;
    disconnect: () => void;
  } {
    return {
      fftSize: 512,
      frequencyBinCount: 256,
      getByteTimeDomainData: (buffer: Uint8Array) => buffer.fill(128),
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

vi.stubGlobal('AudioContext', FakeAudioContext);

/** A minimal stand-in for `@disco-voador/rtc-core`'s `P2PMeshTransport` — captures the
 * `iceServers` each instance was constructed with, and spies on every later `setIceServers` call,
 * so this test can assert on both without exercising any real `RTCPeerConnection`. Implements every
 * `MediaTransport` method `use-voice-channel.ts` actually calls as an inert `vi.fn()`; the type
 * imports (`LocalTrackMidEvent`/`PeerConnectionStateEvent`/`RemoteTrackEvent`) `use-voice-channel.ts`
 * also pulls from this package are erased at compile time and need no mock counterpart. */
class FakeP2PMeshTransport {
  static instances: FakeP2PMeshTransport[] = [];
  readonly setIceServers = vi.fn();
  readonly addParticipant = vi.fn();
  readonly removeParticipant = vi.fn();
  readonly handleRemoteOffer = vi.fn().mockResolvedValue(undefined);
  readonly handleRemoteAnswer = vi.fn().mockResolvedValue(undefined);
  readonly handleRemoteIceCandidate = vi.fn().mockResolvedValue(undefined);
  readonly publishTrack = vi.fn();
  readonly unpublishTrack = vi.fn();
  readonly replaceTrack = vi.fn();
  readonly getStats = vi.fn().mockResolvedValue(undefined);
  readonly on = vi.fn();
  readonly off = vi.fn();
  readonly closeAll = vi.fn();

  constructor(readonly initialConfig: { readonly iceServers: readonly unknown[] }) {
    FakeP2PMeshTransport.instances.push(this);
  }
}

vi.mock('@disco-voador/rtc-core', () => ({ P2PMeshTransport: FakeP2PMeshTransport }));

const { useVoiceChannel } =
  await import('../../apps/desktop/src/renderer/voice/use-voice-channel.js');

const STUN_ICE_SERVERS = [{ urls: 'stun:stun.example.com:3478' }];

function identityChallengeMessage(): Record<string, unknown> {
  return {
    type: 'server:identity-challenge',
    id: 'c1',
    connectionId: 'conn-1',
    nonce: 'A'.repeat(43),
    expiresAt: Date.now() + 30_000,
  };
}

function helloMessage(): Record<string, unknown> {
  return {
    type: 'server:hello',
    id: 'h1',
    protocolVersion: 1,
    connectionId: 'conn-1',
    identityId: `dv1_${'A'.repeat(43)}`,
    serverName: 'Test Server',
    serverCapabilities: ['voice'],
    serverTime: new Date().toISOString(),
    heartbeat: { intervalMs: 15_000, timeoutMs: 10_000 },
  };
}

function turnCredentialsMessage(
  overrides: Partial<{ iceServers: unknown[]; expiresAt: string }> = {},
): Record<string, unknown> {
  return {
    type: 'server:turn-credentials',
    id: 'turn-1',
    iceServers: [
      { urls: 'turn:turn.example.com:3478', username: 'relay-user', credential: 'relay-secret' },
    ],
    expiresAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('useVoiceChannel — server:turn-credentials -> transport.setIceServers (T14 slice 5)', () => {
  beforeEach(() => {
    installDesktopAppMock();
    FakeWebSocket.instances = [];
    FakeP2PMeshTransport.instances = [];
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  /** Drives the real hello -> challenge -> proof -> server:hello handshake, mirroring
   * `realtime-client.test.ts`'s own `connectAndHandshake`, adapted for a rendered hook (no direct
   * `RealtimeClient` instance to await against — only the socket it creates). */
  async function connectAndHandshake(): Promise<FakeWebSocket> {
    await waitFor(() => {
      if (FakeWebSocket.instances.length === 0) throw new Error('WebSocket not constructed yet');
    });
    const socket = FakeWebSocket.instances[FakeWebSocket.instances.length - 1];
    if (!socket) throw new Error('no socket instance');

    socket.simulateOpen();
    await waitFor(() => {
      if (socket.sent.length === 0) throw new Error('client:hello not sent yet');
    });

    socket.simulateMessage(JSON.stringify(identityChallengeMessage()));
    await waitFor(() => {
      if (socket.sent.length < 2) throw new Error('client:identity-proof not sent yet');
    });

    socket.simulateMessage(JSON.stringify(helloMessage()));
    return socket;
  }

  it('constructs the transport with only the configured STUN servers (no TURN yet)', async () => {
    // `renderHook`'s render callback re-runs on every internal `setState` this hook's own
    // connection sequence triggers (it *is* the mounted component's body) — the connection config
    // must therefore be a single stable object built once outside that callback (mirroring how
    // `App.tsx`/`VoiceChannelView.tsx` only ever hand this hook a config object that itself changes
    // by real identity, e.g. a genuine server switch, never a fresh literal every render). A fresh
    // `{ url, iceServers }` literal captured directly in the callback would make the main connection
    // effect's own `[realtimeConfig]` dependency see a "new" config on every re-render and tear down
    // and rebuild the whole connection in an unbounded loop.
    const config = { url: 'ws://127.0.0.1:8090', iceServers: STUN_ICE_SERVERS };
    renderHook(() => useVoiceChannel(config));

    await waitFor(() => {
      if (FakeP2PMeshTransport.instances.length === 0) throw new Error('transport not constructed');
    });
    expect(FakeP2PMeshTransport.instances[0]?.initialConfig.iceServers).toEqual(STUN_ICE_SERVERS);
  });

  it('merges STUN + TURN and calls transport.setIceServers when turnCredentials arrives after the transport exists', async () => {
    const config = { url: 'ws://127.0.0.1:8090', iceServers: STUN_ICE_SERVERS };
    renderHook(() => useVoiceChannel(config));

    const socket = await connectAndHandshake();
    const transport = FakeP2PMeshTransport.instances[0];
    if (!transport) throw new Error('transport not constructed');
    expect(transport.setIceServers).not.toHaveBeenCalled();

    const turnServers = [
      { urls: 'turn:turn.example.com:3478', username: 'relay-user', credential: 'relay-secret' },
    ];
    socket.simulateMessage(JSON.stringify(turnCredentialsMessage({ iceServers: turnServers })));

    await waitFor(() => {
      if (transport.setIceServers.mock.calls.length === 0) {
        throw new Error('setIceServers not called yet');
      }
    });
    expect(transport.setIceServers).toHaveBeenCalledTimes(1);
    expect(transport.setIceServers).toHaveBeenCalledWith([...STUN_ICE_SERVERS, ...turnServers]);
  });

  it('never calls transport.setIceServers when TURN is not configured (no server:turn-credentials ever arrives)', async () => {
    const config = { url: 'ws://127.0.0.1:8090', iceServers: STUN_ICE_SERVERS };
    renderHook(() => useVoiceChannel(config));

    await connectAndHandshake();
    const transport = FakeP2PMeshTransport.instances[0];
    if (!transport) throw new Error('transport not constructed');

    // The connection is fully open with no TURN message ever having arrived — a fully supported,
    // self-hosted STUN/P2P-only deployment (see `packages/protocol/src/messages/turn.ts`'s own doc
    // comment: this message is never sent at all, never sent empty, when TURN is not configured).
    expect(transport.setIceServers).not.toHaveBeenCalled();
  });
});
