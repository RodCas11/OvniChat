import {
  generateIdentityKeyPair,
  signWithIdentityKey,
  type IdentityKeyPair,
} from '@disco-voador/identity';
import {
  buildIdentityAuthPayload,
  CURRENT_PROTOCOL_VERSION,
  type ClientIdentityProofMessage,
  type ServerIdentityChallengeMessage,
  type ServerMessage,
} from '@disco-voador/protocol';
import { describe, expect, it } from 'vitest';

import {
  handleClientPing,
  routeClientMessage,
  type HandlerContext,
  type OutgoingAction,
} from '../../services/realtime/src/protocol-handlers.js';
import { DEFAULT_VOICE_CHANNELS } from '../../services/realtime/src/voice/catalog.js';
import { VoiceRegistry } from '../../services/realtime/src/voice/registry.js';

const FIXED_TIME = new Date('2026-08-18T00:00:00.000Z');
const CHALLENGE_TTL_MS = 10_000;

function makeContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    connectionId: 'conn-1',
    now: () => FIXED_TIME,
    heartbeat: { intervalMs: 15000, timeoutMs: 10000 },
    voiceRegistry: new VoiceRegistry(DEFAULT_VOICE_CHANNELS),
    identityChallengeTtlMs: CHALLENGE_TTL_MS,
    pendingChallenge: undefined,
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

function makeHello(overrides: {
  publicKey: string;
  id?: string;
  protocolVersion?: number;
  nickname?: string;
}) {
  return {
    type: 'client:hello' as const,
    id: overrides.id ?? 'req-1',
    protocolVersion: overrides.protocolVersion ?? CURRENT_PROTOCOL_VERSION,
    client: { name: 'test', version: '0.0.0' },
    nickname: overrides.nickname ?? 'Alice',
    publicKey: overrides.publicKey,
  };
}

/** Signs a valid identity-proof for `challenge`, as issued to `connectionId`, using `keyPair` and
 * the exact hello fields the challenge was bound to. */
function signProof(
  challenge: ServerIdentityChallengeMessage,
  connectionId: string,
  keyPair: IdentityKeyPair,
  fields: { protocolVersion: number; nickname: string; publicKey?: string },
  proofId = 'proof-1',
): ClientIdentityProofMessage {
  const payload = buildIdentityAuthPayload({
    protocolVersion: fields.protocolVersion,
    connectionId,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
    publicKey: fields.publicKey ?? keyPair.publicKey,
    nickname: fields.nickname,
  });
  const signature = signWithIdentityKey(keyPair.privateKey, keyPair.publicKey, payload);
  return { type: 'client:identity-proof', id: proofId, signature };
}

describe('handleClientPing', () => {
  it('builds a server:pong echoing the ping id', () => {
    expect(handleClientPing({ type: 'client:ping', id: 'ping-7' })).toEqual({
      type: 'server:pong',
      id: 'ping-7',
    });
  });
});

describe('routeClientMessage — handshake', () => {
  const keyPair = generateIdentityKeyPair();
  const validHello = makeHello({ publicKey: keyPair.publicKey });
  const ping = { type: 'client:ping' as const, id: 'ping-1' };

  it('accepts a hello while awaiting_hello and issues an identity challenge (does not go ready yet)', () => {
    const ctx = makeContext();
    const result = routeClientMessage(validHello, 'awaiting_hello', ctx);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.nextState).toBe('awaiting_identity_proof');
    const messages = replies(result.actions);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      type: 'server:identity-challenge',
      connectionId: 'conn-1',
    });
    expect(result.pendingChallenge).toMatchObject({
      publicKey: keyPair.publicKey,
      nickname: 'Alice',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
    });
  });

  it('completes the full hello -> challenge -> proof -> ready flow with a matching identityId', () => {
    const ctx = makeContext();
    const helloResult = routeClientMessage(validHello, 'awaiting_hello', ctx);
    expect(helloResult.ok).toBe(true);
    if (!helloResult.ok) return;
    const challenge = replies(helloResult.actions)[0] as ServerIdentityChallengeMessage;

    const proofCtx = makeContext({ pendingChallenge: helloResult.pendingChallenge });
    const proof = signProof(challenge, 'conn-1', keyPair, {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      nickname: 'Alice',
    });
    const proofResult = routeClientMessage(proof, 'awaiting_identity_proof', proofCtx);

    expect(proofResult.ok).toBe(true);
    if (!proofResult.ok) return;
    expect(proofResult.nextState).toBe('ready');
    const messages = replies(proofResult.actions);
    expect(messages[0]).toMatchObject({
      type: 'server:hello',
      id: 'proof-1',
      connectionId: 'conn-1',
    });
    expect((messages[0] as { identityId: string }).identityId).toMatch(/^dv1_[A-Za-z0-9_-]{43}$/u);
    expect(messages[1]).toMatchObject({
      type: 'voice:catalog',
      channels: [...DEFAULT_VOICE_CHANNELS],
    });
  });

  it('rejects a hello with an unsupported protocol version (fatal)', () => {
    const ctx = makeContext();
    const result = routeClientMessage(
      makeHello({ publicKey: keyPair.publicKey, protocolVersion: 999 }),
      'awaiting_hello',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNSUPPORTED_PROTOCOL');
  });

  it('rejects a duplicate hello once already ready (fatal)', () => {
    const result = routeClientMessage(validHello, 'ready', makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('UNEXPECTED_MESSAGE');
  });

  it('rejects a hello sent while closing/closed', () => {
    for (const state of ['closing', 'closed'] as const) {
      const result = routeClientMessage(validHello, state, makeContext());
      expect(result.ok).toBe(false);
    }
  });

  it('rejects a ping sent before the handshake completes (fatal)', () => {
    const result = routeClientMessage(ping, 'awaiting_hello', makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('HANDSHAKE_REQUIRED');
  });

  it('rejects a ping sent while awaiting the identity proof (fatal)', () => {
    const result = routeClientMessage(ping, 'awaiting_identity_proof', makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('HANDSHAKE_REQUIRED');
  });

  it('accepts a ping once ready and keeps the state unchanged', () => {
    const result = routeClientMessage(ping, 'ready', makeContext());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.nextState).toBe('ready');
      expect(replies(result.actions)).toEqual([{ type: 'server:pong', id: 'ping-1' }]);
    }
  });

  it('rejects a ping sent while closing (fatal)', () => {
    const result = routeClientMessage(ping, 'closing', makeContext());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('HANDSHAKE_REQUIRED');
  });
});

describe('routeClientMessage — identity proof and replay resistance', () => {
  function issueChallenge(
    connectionId: string,
    keyPair: IdentityKeyPair,
    nickname = 'Alice',
  ): {
    challenge: ServerIdentityChallengeMessage;
    pendingChallenge: HandlerContext['pendingChallenge'];
  } {
    const ctx = makeContext({ connectionId });
    const result = routeClientMessage(
      makeHello({ publicKey: keyPair.publicKey, nickname }),
      'awaiting_hello',
      ctx,
    );
    if (!result.ok) throw new Error('setup failed');
    return {
      challenge: replies(result.actions)[0] as ServerIdentityChallengeMessage,
      pendingChallenge: result.pendingChallenge,
    };
  }

  it('a valid proof on connection A succeeds', () => {
    const keyPair = generateIdentityKeyPair();
    const { challenge, pendingChallenge } = issueChallenge('conn-a', keyPair);
    const proof = signProof(challenge, 'conn-a', keyPair, {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      nickname: 'Alice',
    });

    const result = routeClientMessage(
      proof,
      'awaiting_identity_proof',
      makeContext({ connectionId: 'conn-a', pendingChallenge }),
    );

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.nextState).toBe('ready');
  });

  it('the same proof replayed again on connection A (already ready) is rejected', () => {
    const keyPair = generateIdentityKeyPair();
    const { challenge, pendingChallenge } = issueChallenge('conn-a', keyPair);
    const proof = signProof(challenge, 'conn-a', keyPair, {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      nickname: 'Alice',
    });
    const first = routeClientMessage(
      proof,
      'awaiting_identity_proof',
      makeContext({ connectionId: 'conn-a', pendingChallenge }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;

    // The connection is now 'ready' with no pending challenge — exactly what Connection would
    // carry forward (see connection.ts's `this.pendingChallenge = result.pendingChallenge`).
    const replay = routeClientMessage(
      proof,
      'ready',
      makeContext({ connectionId: 'conn-a', pendingChallenge: first.pendingChallenge }),
    );
    expect(replay.ok).toBe(false);
    if (!replay.ok) expect(replay.code).toBe('IDENTITY_PROTOCOL_ERROR');
  });

  it('a proof copied to a different connection B is rejected (signature is connection-bound)', () => {
    const keyPair = generateIdentityKeyPair();
    const { challenge, pendingChallenge: pendingA } = issueChallenge('conn-a', keyPair);
    const proof = signProof(challenge, 'conn-a', keyPair, {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      nickname: 'Alice',
    });

    // Connection B independently received its own challenge (different nonce/expiresAt), but an
    // attacker forwards A's proof to B anyway.
    const { pendingChallenge: pendingB } = issueChallenge('conn-b', keyPair);

    const result = routeClientMessage(
      proof,
      'awaiting_identity_proof',
      makeContext({ connectionId: 'conn-b', pendingChallenge: pendingB ?? pendingA }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('IDENTITY_INVALID_SIGNATURE');
  });

  it('an expired challenge is rejected', () => {
    const keyPair = generateIdentityKeyPair();
    const { challenge, pendingChallenge } = issueChallenge('conn-a', keyPair);
    const proof = signProof(challenge, 'conn-a', keyPair, {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      nickname: 'Alice',
    });

    const afterExpiry = () => new Date(challenge.expiresAt + 1);
    const result = routeClientMessage(
      proof,
      'awaiting_identity_proof',
      makeContext({ connectionId: 'conn-a', pendingChallenge, now: afterExpiry }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('IDENTITY_CHALLENGE_EXPIRED');
  });

  it('a signature computed over a different nickname than hello claimed is rejected', () => {
    const keyPair = generateIdentityKeyPair();
    const { challenge, pendingChallenge } = issueChallenge('conn-a', keyPair, 'Alice');
    // Signs for "Bob" even though the hello (and thus the server's remembered challenge) claimed
    // "Alice" — the server always rebuilds the payload from ITS OWN remembered nickname, so this
    // mismatches and fails verification.
    const proof = signProof(challenge, 'conn-a', keyPair, {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      nickname: 'Bob',
    });

    const result = routeClientMessage(
      proof,
      'awaiting_identity_proof',
      makeContext({ connectionId: 'conn-a', pendingChallenge }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('IDENTITY_INVALID_SIGNATURE');
  });

  it('a signature from a different private key than the claimed public key is rejected', () => {
    const claimedKeyPair = generateIdentityKeyPair();
    const attackerKeyPair = generateIdentityKeyPair();
    const { challenge, pendingChallenge } = issueChallenge('conn-a', claimedKeyPair);

    const proof = signProof(challenge, 'conn-a', attackerKeyPair, {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      nickname: 'Alice',
      publicKey: claimedKeyPair.publicKey,
    });

    const result = routeClientMessage(
      proof,
      'awaiting_identity_proof',
      makeContext({ connectionId: 'conn-a', pendingChallenge }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('IDENTITY_INVALID_SIGNATURE');
  });

  it('a schema-shaped but degenerate (all-zero) public key is handled safely, never throws', () => {
    const zeroPublicKey = Buffer.alloc(32, 0).toString('base64url');
    const ctx = makeContext();
    const helloResult = routeClientMessage(
      makeHello({ publicKey: zeroPublicKey }),
      'awaiting_hello',
      ctx,
    );
    expect(helloResult.ok).toBe(true);
    if (!helloResult.ok) return;
    const challenge = replies(helloResult.actions)[0] as ServerIdentityChallengeMessage;

    const someKeyPair = generateIdentityKeyPair();
    const proof = signProof(challenge, 'conn-1', someKeyPair, {
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      nickname: 'Alice',
      publicKey: zeroPublicKey,
    });

    expect(() =>
      routeClientMessage(
        proof,
        'awaiting_identity_proof',
        makeContext({ pendingChallenge: helloResult.pendingChallenge }),
      ),
    ).not.toThrow();

    const result = routeClientMessage(
      proof,
      'awaiting_identity_proof',
      makeContext({ pendingChallenge: helloResult.pendingChallenge }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('IDENTITY_INVALID_SIGNATURE');
  });

  it('a proof arriving with no outstanding challenge is rejected', () => {
    const result = routeClientMessage(
      { type: 'client:identity-proof', id: 'p1', signature: 'A'.repeat(86) },
      'awaiting_identity_proof',
      makeContext({ pendingChallenge: undefined }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('IDENTITY_PROTOCOL_ERROR');
  });

  it('a proof arriving while still awaiting_hello (no challenge issued yet) is rejected', () => {
    const result = routeClientMessage(
      { type: 'client:identity-proof', id: 'p1', signature: 'A'.repeat(86) },
      'awaiting_hello',
      makeContext(),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('IDENTITY_PROTOCOL_ERROR');
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

describe('routeClientMessage — media:track-source (T5)', () => {
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

  it('forwards to the target only, attributing the server-verified sender', () => {
    const { registry, participantIdB } = joinedRegistry();
    const ctx = makeContext({ connectionId: 'conn-a', voiceRegistry: registry });

    const result = routeClientMessage(
      {
        type: 'media:track-source',
        id: 'm1',
        targetParticipantId: participantIdB,
        mid: '1',
        source: 'screen-video',
      },
      'ready',
      ctx,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(replies(result.actions)).toEqual([]);

    const notified = deliveries(result.actions);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.connectionId).toBe('conn-b');
    const participantIdA = registry.getParticipant('conn-a')?.participantId;
    expect(notified[0]?.message).toEqual({
      type: 'media:track-source',
      id: expect.any(String) as unknown as string,
      sourceParticipantId: participantIdA,
      mid: '1',
      source: 'screen-video',
    });
  });

  it('rejects an announcement from a sender not currently in a voice channel (non-fatal)', () => {
    const ctx = makeContext();
    const result = routeClientMessage(
      {
        type: 'media:track-source',
        id: 'm1',
        targetParticipantId: 'whoever',
        mid: '1',
        source: 'camera',
      },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_IN_VOICE_CHANNEL');
  });

  it('rejects an announcement toward a participant in a different channel (non-fatal)', () => {
    const registry = new VoiceRegistry(DEFAULT_VOICE_CHANNELS);
    const a = registry.join('conn-a', 'general', 'A');
    const c = registry.join('conn-c', 'games', 'C');
    if (!a.ok || !c.ok) throw new Error('setup failed');

    const ctx = makeContext({ connectionId: 'conn-a', voiceRegistry: registry });
    const result = routeClientMessage(
      {
        type: 'media:track-source',
        id: 'm1',
        targetParticipantId: c.participantId,
        mid: '1',
        source: 'camera',
      },
      'ready',
      ctx,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('SIGNALING_TARGET_INVALID');
  });
});
