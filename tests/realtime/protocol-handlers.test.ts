import {
  generateIdentityKeyPair,
  signWithIdentityKey,
  type IdentityKeyPair,
} from '@disco-voador/identity';
import {
  buildIdentityAuthPayload,
  CURRENT_PROTOCOL_VERSION,
  MAX_CHANNEL_PARTICIPANTS,
  type ClientIdentityProofMessage,
  type ServerIdentityChallengeMessage,
  type ServerMessage,
} from '@disco-voador/protocol';
import { describe, expect, it } from 'vitest';

import {
  createNoopAuthorizationPort,
  type AuthorizationPort,
} from '../../services/realtime/src/authorization-port.js';
import { createNoopChannelPort } from '../../services/realtime/src/channel-port.js';
import { createNoopChatPort, type ChatPort } from '../../services/realtime/src/chat-port.js';
import { PresenceRegistry } from '../../services/realtime/src/presence/registry.js';
import { createNoopProfilePort } from '../../services/realtime/src/profile-port.js';
import {
  handleClientPing,
  routeClientMessage,
  type HandlerContext,
  type OutgoingAction,
} from '../../services/realtime/src/protocol-handlers.js';
import { RateLimiter } from '../../services/realtime/src/rate-limiter.js';
import { DEFAULT_VOICE_CHANNELS } from '../../services/realtime/src/voice/catalog.js';
import { TemporaryChannelRegistry } from '../../services/realtime/src/voice/temporary-channels.js';
import { VoiceRegistry } from '../../services/realtime/src/voice/registry.js';

/** Matches `createNoopChannelPort()`'s fixed synthesis of `DEFAULT_VOICE_CHANNELS` — used by tests
 * that assert on the full `voice:catalog` shape. */
const EXPECTED_NOOP_CATALOG_NODES = DEFAULT_VOICE_CHANNELS.map((channel, index) => ({
  nodeId: channel.channelId,
  kind: 'voice',
  name: channel.name,
  sortOrder: index,
  visibilityPolicy: 'everyone',
  joinPolicy: 'everyone',
  managePolicy: 'inherit',
  hasPassword: false,
  temporary: false,
}));

const FIXED_TIME = new Date('2026-08-18T00:00:00.000Z');
const CHALLENGE_TTL_MS = 10_000;

function makeContext(overrides: Partial<HandlerContext> = {}): HandlerContext {
  return {
    connectionId: 'conn-1',
    now: () => FIXED_TIME,
    heartbeat: { intervalMs: 15000, timeoutMs: 10000 },
    voiceRegistry: new VoiceRegistry(),
    identityChallengeTtlMs: CHALLENGE_TTL_MS,
    pendingChallenge: undefined,
    serverMetadata: { name: 'Test Server', capabilities: ['voice'] },
    authorization: createNoopAuthorizationPort(),
    chat: createNoopChatPort(),
    channels: createNoopChannelPort(),
    temporaryChannels: new TemporaryChannelRegistry(),
    channelPasswordRateLimiter: new RateLimiter({ maxMessages: 1000, windowMs: 60_000 }),
    profile: createNoopProfilePort(),
    presenceRegistry: new PresenceRegistry(),
    // Every ready-state test in this file exercises a handler reachable only after a real identity
    // proof would already have set this (see `requireIdentityId` in protocol-handlers.ts) — default
    // it here so tests that don't care about T9 authorization specifically don't each need to set
    // it, matching this file's own pre-T9 convention of a shared, overridable default context.
    identityId: 'default-identity',
    // T10 — mirrors `identityId` above for the same reason (`requireNickname`).
    nickname: 'default-nickname',
    ...overrides,
  };
}

/** A `createNoopAuthorizationPort()` with just the methods a given test cares about overridden —
 * lets T9 handler tests exercise permission-check-then-mutate wiring without a real SQLite store. */
function mockAuthorization(overrides: Partial<AuthorizationPort> = {}): AuthorizationPort {
  return { ...createNoopAuthorizationPort(), ...overrides };
}

/** T10 counterpart to `mockAuthorization` — lets chat handler tests exercise validate/authorize/
 * persist/broadcast wiring without a real SQLite store. */
function mockChat(overrides: Partial<ChatPort> = {}): ChatPort {
  return { ...createNoopChatPort(), ...overrides };
}

function replies(actions: readonly OutgoingAction[]): ServerMessage[] {
  return actions.filter((a) => a.kind === 'reply').map((a) => a.message);
}

function broadcasts(actions: readonly OutgoingAction[]): ServerMessage[] {
  return actions
    .filter(
      (a): a is Extract<OutgoingAction, { kind: 'broadcast-ready' }> =>
        a.kind === 'broadcast-ready',
    )
    .map((a) => a.message);
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
      type: 'server:authorization-state',
      groups: [],
      permissions: [],
    });
    expect(messages[2]).toMatchObject({
      type: 'voice:catalog',
      nodes: EXPECTED_NOOP_CATALOG_NODES,
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
    const registry = new VoiceRegistry();
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
    const registry = new VoiceRegistry();
    registry.join('conn-a', 'general', 'Rodrigo', 'identity-a', MAX_CHANNEL_PARTICIPANTS);

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
    const registry = new VoiceRegistry();
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
    const registry = new VoiceRegistry();
    registry.join('conn-a', 'general', 'Rodrigo', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    registry.join('conn-b', 'general', 'Arthur', 'identity-b', MAX_CHANNEL_PARTICIPANTS);

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
    const registry = new VoiceRegistry();
    const a = registry.join('conn-a', 'general', 'Rodrigo', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    registry.join('conn-b', 'general', 'Arthur', 'identity-b', MAX_CHANNEL_PARTICIPANTS);
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
    const registry = new VoiceRegistry();
    const a = registry.join('conn-a', 'general', 'A', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    const b = registry.join('conn-b', 'general', 'B', 'identity-b', MAX_CHANNEL_PARTICIPANTS);
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
    const registry = new VoiceRegistry();
    const a = registry.join('conn-a', 'general', 'A', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    const c = registry.join('conn-c', 'games', 'C', 'identity-c', MAX_CHANNEL_PARTICIPANTS);
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
    const registry = new VoiceRegistry();
    const a = registry.join('conn-a', 'general', 'A', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    const b = registry.join('conn-b', 'general', 'B', 'identity-b', MAX_CHANNEL_PARTICIPANTS);
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
    const registry = new VoiceRegistry();
    const a = registry.join('conn-a', 'general', 'A', 'identity-a', MAX_CHANNEL_PARTICIPANTS);
    const c = registry.join('conn-c', 'games', 'C', 'identity-c', MAX_CHANNEL_PARTICIPANTS);
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

// T9 follow-up (QA review): `kick`, `list-bans`, `list-groups`, `update-group`, `delete-group`, and
// `grant-group` had no coverage at any layer (wire-level or unit-level) — every other T9 handler was
// exercised over a real socket in `tests/dedicated-server/integration.test.ts`, but these six were
// verified only through `AuthorizationStore` unit tests, which never touch `protocol-handlers.ts`'s
// own permission-check-then-mutate wiring. This describe block closes that gap at the unit layer the
// module's own doc comment says it's meant to support ("unit-testable without any real socket").
describe('routeClientMessage — T9 authorization: kick/list-bans/list-groups/update-group/delete-group/grant-group', () => {
  it("list-groups replies with the port's group list, ungated (definitions are not secret)", () => {
    const ctx = makeContext({
      authorization: mockAuthorization({
        listGroups: () => [
          { groupId: 'member', name: 'Member', permissions: [], protectedGroup: true },
        ],
      }),
    });
    const result = routeClientMessage(
      { type: 'client:authorization-list-groups', id: 'lg1' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(replies(result.actions)).toEqual([
      {
        type: 'server:authorization-groups',
        id: 'lg1',
        groups: [{ groupId: 'member', name: 'Member', permissions: [], protectedGroup: true }],
      },
    ]);
  });

  it('list-bans is denied without moderation.ban', () => {
    const ctx = makeContext({ authorization: mockAuthorization({ can: () => false }) });
    const result = routeClientMessage(
      { type: 'client:authorization-list-bans', id: 'lb1' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('AUTHORIZATION_DENIED');
  });

  it("list-bans replies with the port's ban list when permitted", () => {
    const ctx = makeContext({
      authorization: mockAuthorization({
        can: () => true,
        listBans: () => [{ identityId: 'dv1_banned', createdAt: 1000 }],
      }),
    });
    const result = routeClientMessage(
      { type: 'client:authorization-list-bans', id: 'lb2' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(replies(result.actions)).toEqual([
      {
        type: 'server:authorization-bans',
        id: 'lb2',
        bans: [{ identityId: 'dv1_banned', createdAt: 1000 }],
      },
    ]);
  });

  it('update-group is denied without authorization.groups.manage', () => {
    const ctx = makeContext({ authorization: mockAuthorization({ can: () => false }) });
    const result = routeClientMessage(
      { type: 'client:authorization-update-group', id: 'ug1', groupId: 'moderator' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('AUTHORIZATION_DENIED');
  });

  it('update-group acks and forwards to the port when permitted', () => {
    let received: unknown;
    const ctx = makeContext({
      authorization: mockAuthorization({
        can: () => true,
        updateGroup: (params) => {
          received = params;
          return {
            ok: true,
            group: { groupId: 'moderator', name: 'Mod', permissions: [], protectedGroup: false },
          };
        },
      }),
    });
    const result = routeClientMessage(
      {
        type: 'client:authorization-update-group',
        id: 'ug2',
        groupId: 'moderator',
        name: 'Mod',
      },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(replies(result.actions)).toEqual([{ type: 'server:authorization-ack', id: 'ug2' }]);
    expect(received).toEqual({ groupId: 'moderator', name: 'Mod', permissions: undefined });
  });

  it('delete-group is denied without authorization.groups.manage', () => {
    const ctx = makeContext({ authorization: mockAuthorization({ can: () => false }) });
    const result = routeClientMessage(
      { type: 'client:authorization-delete-group', id: 'dg1', groupId: 'moderator' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('AUTHORIZATION_DENIED');
  });

  it('delete-group force-closes every online connection left with no admission basis', () => {
    const registry = new VoiceRegistry();
    registry.join('conn-victim', 'general', 'Victim', 'dv1_victim', MAX_CHANNEL_PARTICIPANTS);
    const ctx = makeContext({
      voiceRegistry: registry,
      authorization: mockAuthorization({
        can: () => true,
        deleteGroup: () => ({ ok: true, noLongerAdmitted: ['dv1_victim'] }),
      }),
    });
    const result = routeClientMessage(
      { type: 'client:authorization-delete-group', id: 'dg2', groupId: 'temp' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(replies(result.actions)).toEqual([{ type: 'server:authorization-ack', id: 'dg2' }]);
    const closeActions = result.actions.filter((a) => a.kind === 'close');
    expect(closeActions).toEqual([
      {
        kind: 'close',
        connectionId: 'conn-victim',
        code: 'INVITE_REQUIRED',
        message: 'Server-local authorization was revoked',
      },
    ]);
  });

  it('delete-group closes nothing when the port reports no one left unadmitted', () => {
    const ctx = makeContext({
      authorization: mockAuthorization({
        can: () => true,
        deleteGroup: () => ({ ok: true, noLongerAdmitted: [] }),
      }),
    });
    const result = routeClientMessage(
      { type: 'client:authorization-delete-group', id: 'dg3', groupId: 'temp' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.actions.some((a) => a.kind === 'close')).toBe(false);
  });

  it('grant-group is denied without authorization.memberships.manage', () => {
    const ctx = makeContext({ authorization: mockAuthorization({ can: () => false }) });
    const result = routeClientMessage(
      {
        type: 'client:authorization-grant-group',
        id: 'gg1',
        targetParticipantId: 'p1',
        groupId: 'member',
      },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('AUTHORIZATION_DENIED');
  });

  it('grant-group rejects a target participant that is not currently online', () => {
    const ctx = makeContext({ authorization: mockAuthorization({ can: () => true }) });
    const result = routeClientMessage(
      {
        type: 'client:authorization-grant-group',
        id: 'gg2',
        targetParticipantId: 'not-online',
        groupId: 'member',
      },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PARTICIPANT_NOT_FOUND');
  });

  it('grant-group resolves the target via VoiceRegistry, never a client-supplied identityId', () => {
    const registry = new VoiceRegistry();
    const joined = registry.join(
      'conn-target',
      'general',
      'Target',
      'dv1_target',
      MAX_CHANNEL_PARTICIPANTS,
    );
    if (!joined.ok) throw new Error('setup failed');
    let grantedIdentityId: string | undefined;
    const ctx = makeContext({
      connectionId: 'conn-admin',
      voiceRegistry: registry,
      authorization: mockAuthorization({
        can: () => true,
        grantGroup: (identityId) => {
          grantedIdentityId = identityId;
          return { ok: true, snapshot: { groups: [], permissions: [] } };
        },
      }),
    });
    const result = routeClientMessage(
      {
        type: 'client:authorization-grant-group',
        id: 'gg3',
        targetParticipantId: joined.participantId,
        groupId: 'member',
      },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(grantedIdentityId).toBe('dv1_target');
    expect(replies(result.actions)).toEqual([{ type: 'server:authorization-ack', id: 'gg3' }]);
    const notified = deliveries(result.actions);
    expect(notified).toHaveLength(1);
    expect(notified[0]?.connectionId).toBe('conn-target');
    expect(notified[0]?.message).toMatchObject({ type: 'server:authorization-state' });
  });

  it('kick is denied without moderation.kick', () => {
    const ctx = makeContext({ authorization: mockAuthorization({ can: () => false }) });
    const result = routeClientMessage(
      { type: 'client:authorization-kick', id: 'k1', targetParticipantId: 'p1' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('AUTHORIZATION_DENIED');
  });

  it('kick rejects a target participant that is not currently online', () => {
    const ctx = makeContext({ authorization: mockAuthorization({ can: () => true }) });
    const result = routeClientMessage(
      { type: 'client:authorization-kick', id: 'k2', targetParticipantId: 'not-online' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PARTICIPANT_NOT_FOUND');
  });

  it('kick closes the target connection with KICKED and creates no persistent ban', () => {
    const registry = new VoiceRegistry();
    const joined = registry.join(
      'conn-target',
      'general',
      'Target',
      'dv1_target',
      MAX_CHANNEL_PARTICIPANTS,
    );
    if (!joined.ok) throw new Error('setup failed');
    let banCalled = false;
    const ctx = makeContext({
      connectionId: 'conn-admin',
      voiceRegistry: registry,
      authorization: mockAuthorization({
        can: () => true,
        ban: () => {
          banCalled = true;
          return { ok: true };
        },
      }),
    });
    const result = routeClientMessage(
      {
        type: 'client:authorization-kick',
        id: 'k3',
        targetParticipantId: joined.participantId,
      },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(replies(result.actions)).toEqual([{ type: 'server:authorization-ack', id: 'k3' }]);
    expect(result.actions).toContainEqual({
      kind: 'close',
      connectionId: 'conn-target',
      code: 'KICKED',
      message: 'Kicked by an administrator',
    });
    expect(banCalled).toBe(false);
  });
});

// T10 — persistent server-side text chat handler tests. `ctx.chat` is always a mock (never a real
// SQLite store) so these stay unit-level and socket-free, matching this file's own stated intent.
describe('routeClientMessage — T10 chat: send/history', () => {
  it('server-scope send is denied without chat.server.send', () => {
    const ctx = makeContext({ authorization: mockAuthorization({ can: () => false }) });
    const result = routeClientMessage(
      { type: 'client:chat-send', id: 'cs1', scope: 'server', body: 'hello' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('AUTHORIZATION_DENIED');
  });

  it('server-scope send persists then broadcasts to every ready connection, sender included', () => {
    let sentParams: unknown;
    const ctx = makeContext({
      identityId: 'dv1_rodrigo',
      nickname: 'Rodrigo',
      authorization: mockAuthorization({ can: () => true }),
      chat: mockChat({
        sendMessage: (params) => {
          sentParams = params;
          return {
            ok: true,
            message: {
              messageId: 1,
              scope: 'server',
              senderNickname: 'Rodrigo',
              body: 'bora?',
              createdAt: 1000,
            },
          };
        },
      }),
    });
    const result = routeClientMessage(
      { type: 'client:chat-send', id: 'cs2', scope: 'server', body: 'bora?' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(sentParams).toEqual({
      scope: 'server',
      channelId: undefined,
      senderIdentityId: 'dv1_rodrigo',
      senderNickname: 'Rodrigo',
      body: 'bora?',
    });
    // Server-derived sender: never anything a raw client message could have supplied — there is no
    // such field on `client:chat-send` at all (T10 Section 29/30/74).
    const [broadcast] = broadcasts(result.actions);
    expect(broadcast).toMatchObject({
      type: 'server:chat-message',
      message: { messageId: 1, senderNickname: 'Rodrigo', body: 'bora?' },
    });
    expect(replies(result.actions)).toEqual([]);
  });

  it('does not broadcast anything when persistence fails', () => {
    const ctx = makeContext({
      authorization: mockAuthorization({ can: () => true }),
      chat: mockChat({
        sendMessage: () => ({ ok: false, code: 'INTERNAL_ERROR', message: 'db unavailable' }),
      }),
    });
    const result = routeClientMessage(
      { type: 'client:chat-send', id: 'cs3', scope: 'server', body: 'hello' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INTERNAL_ERROR');
  });

  it('channel-scope send rejects an unknown channel', () => {
    const ctx = makeContext({ authorization: mockAuthorization({ can: () => true }) });
    const result = routeClientMessage(
      {
        type: 'client:chat-send',
        id: 'cs4',
        scope: 'channel',
        channelId: 'nonexistent',
        body: 'hi',
      },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CHANNEL_NOT_FOUND');
  });

  it('channel-scope send requires current membership in that exact channel', () => {
    const registry = new VoiceRegistry();
    // Sender is in "games", tries to send to "general".
    registry.join('conn-1', 'games', 'X', 'identity-x', MAX_CHANNEL_PARTICIPANTS);
    const ctx = makeContext({
      voiceRegistry: registry,
      authorization: mockAuthorization({ can: () => true }),
    });
    const result = routeClientMessage(
      { type: 'client:chat-send', id: 'cs5', scope: 'channel', channelId: 'general', body: 'hi' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('NOT_IN_VOICE_CHANNEL');
  });

  it('channel-scope send is denied without chat.channel.send even when a member of the channel', () => {
    const registry = new VoiceRegistry();
    registry.join('conn-1', 'general', 'X', 'identity-x', MAX_CHANNEL_PARTICIPANTS);
    const ctx = makeContext({
      voiceRegistry: registry,
      authorization: mockAuthorization({ can: () => false }),
    });
    const result = routeClientMessage(
      { type: 'client:chat-send', id: 'cs6', scope: 'channel', channelId: 'general', body: 'hi' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('AUTHORIZATION_DENIED');
  });

  it('channel-scope send broadcasts only to current members of that channel, attaching senderParticipantId', () => {
    const registry = new VoiceRegistry();
    const sender = registry.join(
      'conn-a',
      'general',
      'Sender',
      'identity-a',
      MAX_CHANNEL_PARTICIPANTS,
    );
    registry.join('conn-b', 'general', 'Other', 'identity-b', MAX_CHANNEL_PARTICIPANTS);
    registry.join('conn-c', 'games', 'Elsewhere', 'identity-c', MAX_CHANNEL_PARTICIPANTS);
    if (!sender.ok) throw new Error('setup failed');
    const ctx = makeContext({
      connectionId: 'conn-a',
      voiceRegistry: registry,
      authorization: mockAuthorization({ can: () => true }),
      chat: mockChat({
        sendMessage: () => ({
          ok: true,
          message: {
            messageId: 1,
            scope: 'channel',
            channelId: 'general',
            senderNickname: 'Sender',
            body: 'gg',
            createdAt: 1000,
          },
        }),
      }),
    });
    const result = routeClientMessage(
      { type: 'client:chat-send', id: 'cs7', scope: 'channel', channelId: 'general', body: 'gg' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const delivered = deliveries(result.actions);
    expect(delivered.map((d) => d.connectionId).sort()).toEqual(['conn-a', 'conn-b']);
    for (const { message } of delivered) {
      expect(message).toMatchObject({
        type: 'server:chat-message',
        message: { senderParticipantId: sender.participantId },
      });
    }
  });

  it('history-request is available without any chat permission (reading is ungated)', () => {
    const ctx = makeContext({
      authorization: mockAuthorization({ can: () => false }),
      chat: mockChat({
        getHistory: () => ({
          messages: [
            { messageId: 1, scope: 'server', senderNickname: 'X', body: 'hi', createdAt: 1000 },
          ],
          hasMore: false,
          nextCursor: undefined,
        }),
      }),
    });
    const result = routeClientMessage(
      { type: 'client:chat-history-request', id: 'ch1', scope: 'server' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(replies(result.actions)).toEqual([
      {
        type: 'server:chat-history-page',
        id: 'ch1',
        messages: [
          { messageId: 1, scope: 'server', senderNickname: 'X', body: 'hi', createdAt: 1000 },
        ],
        hasMore: false,
      },
    ]);
  });

  it('history-request for an unknown channel is rejected without touching the store', () => {
    let called = false;
    const ctx = makeContext({
      chat: mockChat({
        getHistory: () => {
          called = true;
          return { messages: [], hasMore: false, nextCursor: undefined };
        },
      }),
    });
    const result = routeClientMessage(
      {
        type: 'client:chat-history-request',
        id: 'ch2',
        scope: 'channel',
        channelId: 'nonexistent',
      },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('CHANNEL_NOT_FOUND');
    expect(called).toBe(false);
  });

  it('history-request for a channel does not require current membership in it', () => {
    const registry = new VoiceRegistry();
    // Sender is not in "general" at all, but the channel exists on this server.
    let requestedScope: unknown;
    const ctx = makeContext({
      voiceRegistry: registry,
      chat: mockChat({
        getHistory: (params) => {
          requestedScope = params;
          return { messages: [], hasMore: false, nextCursor: undefined };
        },
      }),
    });
    const result = routeClientMessage(
      { type: 'client:chat-history-request', id: 'ch3', scope: 'channel', channelId: 'general' },
      'ready',
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(requestedScope).toMatchObject({ scope: 'channel', channelId: 'general' });
  });

  it('forwards an explicit limit/beforeMessageId cursor through to the store unchanged', () => {
    let requested: unknown;
    const ctx = makeContext({
      chat: mockChat({
        getHistory: (params) => {
          requested = params;
          return { messages: [], hasMore: false, nextCursor: undefined };
        },
      }),
    });
    routeClientMessage(
      {
        type: 'client:chat-history-request',
        id: 'ch4',
        scope: 'server',
        beforeMessageId: 42,
        limit: 7,
      },
      'ready',
      ctx,
    );
    expect(requested).toMatchObject({ beforeMessageId: 42, limit: 7 });
  });
});
