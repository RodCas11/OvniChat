import { CURRENT_PROTOCOL_VERSION, type ServerMessage } from '@disco-voador/protocol';
import { describe, expect, it } from 'vitest';

import {
  handleClientHello,
  handleClientPing,
  routeClientMessage,
  type HandlerContext,
  type OutgoingAction,
} from '../../services/realtime/src/protocol-handlers.js';
import { DEFAULT_VOICE_CHANNELS } from '../../services/realtime/src/voice/catalog.js';
import { VoiceRegistry } from '../../services/realtime/src/voice/registry.js';

const FIXED_TIME = new Date('2026-08-18T00:00:00.000Z');

function makeContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    connectionId: 'conn-1',
    now: () => FIXED_TIME,
    heartbeat: { intervalMs: 15000, timeoutMs: 10000 },
    voiceRegistry: new VoiceRegistry(DEFAULT_VOICE_CHANNELS),
    ...overrides,
  };
}

function replies(actions: readonly OutgoingAction[]): ServerMessage[] {
  return actions.filter((a) => a.kind === 'reply').map((a) => a.message);
}

function deliveries(
  actions: readonly OutgoingAction[],
): { connectionId: string; message: ServerMessage }[] {
  return actions
    .filter((a): a is Extract<OutgoingAction, { kind: 'deliver' }> => a.kind === 'deliver')
    .map((a) => ({ connectionId: a.connectionId, message: a.message }));
}

describe('handleClientHello', () => {
  it('builds a server:hello echoing the request id and carrying connection/heartbeat info', () => {
    const response = handleClientHello(
      {
        type: 'client:hello',
        id: 'req-1',
        protocolVersion: 1,
        client: { name: 'test', version: '0.0.0' },
      },
      makeContext(),
    );

    expect(response).toEqual({
      type: 'server:hello',
      id: 'req-1',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      connectionId: 'conn-1',
      serverTime: FIXED_TIME.toISOString(),
      heartbeat: { intervalMs: 15000, timeoutMs: 10000 },
    });
  });
});

describe('handleClientPing', () => {
  it('builds a server:pong echoing the ping id', () => {
    expect(handleClientPing({ type: 'client:ping', id: 'ping-7' })).toEqual({
      type: 'server:pong',
      id: 'ping-7',
    });
  });
});

describe('routeClientMessage — handshake', () => {
  const ctx = makeContext();
  const validHello = {
    type: 'client:hello' as const,
    id: 'req-1',
    protocolVersion: 1,
    client: { name: 'test', version: '0.0.0' },
  };
  const ping = { type: 'client:ping' as const, id: 'ping-1' };

  it('accepts a hello while awaiting_hello, transitions to ready, and also sends the voice catalog', () => {
    const result = routeClientMessage(validHello, 'awaiting_hello', ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextState).toBe('ready');
      const messages = replies(result.actions);
      expect(messages[0]?.type).toBe('server:hello');
      expect(messages[1]).toMatchObject({
        type: 'voice:catalog',
        channels: [...DEFAULT_VOICE_CHANNELS],
      });
    }
  });

  it('rejects a hello with an unsupported protocol version (fatal)', () => {
    const result = routeClientMessage(
      { ...validHello, protocolVersion: 999 },
      'awaiting_hello',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_PROTOCOL');
  });

  it('rejects a duplicate hello once already ready (fatal)', () => {
    const result = routeClientMessage(validHello, 'ready', ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNEXPECTED_MESSAGE');
  });

  it('rejects a hello sent while closing/closed', () => {
    for (const state of ['closing', 'closed'] as const) {
      const result = routeClientMessage(validHello, state, ctx);
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a ping sent before the handshake completes (fatal)', () => {
    const result = routeClientMessage(ping, 'awaiting_hello', ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('HANDSHAKE_REQUIRED');
  });

  it('accepts a ping once ready and keeps the state unchanged', () => {
    const result = routeClientMessage(ping, 'ready', ctx);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextState).toBe('ready');
      expect(replies(result.actions)).toEqual([{ type: 'server:pong', id: 'ping-1' }]);
    }
  });

  it('rejects a ping sent while closing (fatal)', () => {
    const result = routeClientMessage(ping, 'closing', ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('HANDSHAKE_REQUIRED');
  });
});

describe('routeClientMessage — voice:join / voice:leave', () => {
  it('joining an empty channel replies voice:joined with an empty participants list', () => {
    const registry = new VoiceRegistry(DEFAULT_VOICE_CHANNELS);
    const ctx = makeContext({ connectionId: 'conn-a', voiceRegistry: registry });

    const result = routeClientMessage(
      { type: 'voice:join', id: 'j1', channelId: 'general', displayName: 'Rodrigo' },
      'ready',
      ctx,
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      const [joined] = replies(result.actions);
      expect(joined).toMatchObject({
        type: 'voice:joined',
        id: 'j1',
        channelId: 'general',
        participants: [],
      });
      expect(deliveries(result.actions)).toEqual([]);
    }
  });

  it('joining a populated channel returns existing participants and notifies them of the newcomer', () => {
    const registry = new VoiceRegistry(DEFAULT_VOICE_CHANNELS);
    registry.join('conn-a', 'general', 'Rodrigo');

    const ctx = makeContext({ connectionId: 'conn-b', voiceRegistry: registry });
    const result = routeClientMessage(
      { type: 'voice:join', id: 'j2', channelId: 'general', displayName: 'Arthur' },
      'ready',
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [joined] = replies(result.actions);
    expect(joined).toMatchObject({
      type: 'voice:joined',
      participants: [{ displayName: 'Rodrigo' }],
    });

    const notified = deliveries(result.actions);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.connectionId).toBe('conn-a');
    expect(notified[0]?.message).toMatchObject({
      type: 'voice:participant-joined',
      channelId: 'general',
      participant: { displayName: 'Arthur' },
    });
  });

  it('assigns unique participant ids across joins', () => {
    const registry = new VoiceRegistry(DEFAULT_VOICE_CHANNELS);
    const ctxA = makeContext({ connectionId: 'conn-a', voiceRegistry: registry });
    const ctxB = makeContext({ connectionId: 'conn-b', voiceRegistry: registry });

    const a = routeClientMessage(
      { type: 'voice:join', id: 'j1', channelId: 'general', displayName: 'A' },
      'ready',
      ctxA,
    );
    const b = routeClientMessage(
      { type: 'voice:join', id: 'j2', channelId: 'general', displayName: 'B' },
      'ready',
      ctxB,
    );

    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    const idA = (replies(a.actions)[0] as { participantId: string }).participantId;
    const idB = (replies(b.actions)[0] as { participantId: string }).participantId;
    expect(idA).not.toBe(idB);
  });

  it('rejects joining an unknown channel (non-fatal)', () => {
    const ctx = makeContext();
    const result = routeClientMessage(
      { type: 'voice:join', id: 'j1', channelId: 'unknown-channel', displayName: 'Rodrigo' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CHANNEL_NOT_FOUND');
  });

  it('switching channels notifies the old channel and the new one, with no duplicate membership', () => {
    const registry = new VoiceRegistry(DEFAULT_VOICE_CHANNELS);
    registry.join('conn-a', 'general', 'Rodrigo');
    registry.join('conn-b', 'general', 'Arthur');

    const ctx = makeContext({ connectionId: 'conn-a', voiceRegistry: registry });
    const result = routeClientMessage(
      { type: 'voice:join', id: 'switch-1', channelId: 'games', displayName: 'Rodrigo' },
      'ready',
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const notified = deliveries(result.actions);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.connectionId).toBe('conn-b');
    expect(notified[0]?.message).toMatchObject({
      type: 'voice:participant-left',
      channelId: 'general',
    });

    // The switcher gets exactly one reply — a fresh `voice:joined` — and never a `voice:left` for
    // the channel it switched out of. Renderer code (`use-voice-channel.ts`'s `onJoined` handler)
    // relies on this exact contract to reset its own local participant/transport state itself,
    // since it cannot expect a `voice:left` to do that for it on a mid-session channel switch.
    const repliesToSwitcher = replies(result.actions);
    expect(repliesToSwitcher).toHaveLength(1);
    expect(repliesToSwitcher[0]).toMatchObject({ type: 'voice:joined', channelId: 'games' });
    expect(repliesToSwitcher.some((message) => message.type === 'voice:left')).toBe(false);

    // No longer a member of general.
    expect(registry.resolveSignalingTarget('conn-b', 'anything').ok).toBe(false);
  });

  it('leave notifies remaining channel members and confirms to the leaver', () => {
    const registry = new VoiceRegistry(DEFAULT_VOICE_CHANNELS);
    const a = registry.join('conn-a', 'general', 'Rodrigo');
    registry.join('conn-b', 'general', 'Arthur');
    if (!a.ok) throw new Error('setup failed');

    const ctx = makeContext({ connectionId: 'conn-b', voiceRegistry: registry });
    const result = routeClientMessage({ type: 'voice:leave', id: 'l1' }, 'ready', ctx);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(replies(result.actions)).toEqual([
      { type: 'voice:left', id: 'l1', channelId: 'general' },
    ]);
    const notified = deliveries(result.actions);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.connectionId).toBe('conn-a');
    expect(notified[0]?.message).toMatchObject({ type: 'voice:participant-left' });
  });

  it('rejects leave when not currently in a voice channel (non-fatal)', () => {
    const ctx = makeContext();
    const result = routeClientMessage({ type: 'voice:leave', id: 'l1' }, 'ready', ctx);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_IN_VOICE_CHANNEL');
  });
});

describe('routeClientMessage — webrtc signaling', () => {
  function joinedRegistry(): {
    registry: VoiceRegistry;
    participantIdA: string;
    participantIdB: string;
  } {
    const registry = new VoiceRegistry(DEFAULT_VOICE_CHANNELS);
    const a = registry.join('conn-a', 'general', 'A');
    const b = registry.join('conn-b', 'general', 'B');
    if (!a.ok || !b.ok) throw new Error('setup failed');
    return { registry, participantIdA: a.participantId, participantIdB: b.participantId };
  }

  it('forwards an offer to the target, attributing the server-verified sender', () => {
    const { registry, participantIdB } = joinedRegistry();
    const ctx = makeContext({ connectionId: 'conn-a', voiceRegistry: registry });

    const result = routeClientMessage(
      { type: 'webrtc:offer', id: 'o1', targetParticipantId: participantIdB, sdp: 'v=0' },
      'ready',
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(replies(result.actions)).toEqual([]);
    const notified = deliveries(result.actions);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.connectionId).toBe('conn-b');
    const [participantAId] = [registry.getParticipant('conn-a')?.participantId];
    expect(notified[0]?.message).toEqual({
      type: 'webrtc:offer',
      id: expect.any(String) as unknown as string,
      sourceParticipantId: participantAId,
      sdp: 'v=0',
    });
  });

  it('forwards an answer and an ICE candidate the same way', () => {
    const { registry, participantIdA } = joinedRegistry();
    const ctx = makeContext({ connectionId: 'conn-b', voiceRegistry: registry });

    const answer = routeClientMessage(
      { type: 'webrtc:answer', id: 'a1', targetParticipantId: participantIdA, sdp: 'v=0-answer' },
      'ready',
      ctx,
    );
    expect(answer.ok).toBe(true);
    if (answer.ok) {
      expect(deliveries(answer.actions)[0]?.message).toMatchObject({
        type: 'webrtc:answer',
        sdp: 'v=0-answer',
      });
    }

    const ice = routeClientMessage(
      {
        type: 'webrtc:ice-candidate',
        id: 'i1',
        targetParticipantId: participantIdA,
        candidate: { candidate: 'candidate:1 1 UDP 1 1.2.3.4 5 typ host' },
      },
      'ready',
      ctx,
    );
    expect(ice.ok).toBe(true);
    if (ice.ok) {
      expect(deliveries(ice.actions)[0]?.message).toMatchObject({ type: 'webrtc:ice-candidate' });
    }
  });

  it('rejects signaling from a sender not currently in a voice channel (non-fatal)', () => {
    const ctx = makeContext();
    const result = routeClientMessage(
      { type: 'webrtc:offer', id: 'o1', targetParticipantId: 'whoever', sdp: 'v=0' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_IN_VOICE_CHANNEL');
  });

  it('rejects signaling toward a participant in a different channel (non-fatal)', () => {
    const registry = new VoiceRegistry(DEFAULT_VOICE_CHANNELS);
    const a = registry.join('conn-a', 'general', 'A');
    const c = registry.join('conn-c', 'games', 'C');
    if (!a.ok || !c.ok) throw new Error('setup failed');

    const ctx = makeContext({ connectionId: 'conn-a', voiceRegistry: registry });
    const result = routeClientMessage(
      { type: 'webrtc:offer', id: 'o1', targetParticipantId: c.participantId, sdp: 'v=0' },
      'ready',
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SIGNALING_TARGET_INVALID');
  });

  it('rejects signaling toward an unknown participant id (non-fatal)', () => {
    const { registry } = joinedRegistry();
    const ctx = makeContext({ connectionId: 'conn-a', voiceRegistry: registry });
    const result = routeClientMessage(
      { type: 'webrtc:offer', id: 'o1', targetParticipantId: 'does-not-exist', sdp: 'v=0' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SIGNALING_TARGET_INVALID');
  });
});
