import { randomUUID } from 'node:crypto';

import {
  deriveIdentityId,
  generateIdentityChallengeNonce,
  verifyIdentitySignature,
} from '@disco-voador/identity';
import {
  CURRENT_PROTOCOL_VERSION,
  buildIdentityAuthPayload,
  isSupportedProtocolVersion,
  type ClientHelloMessage,
  type ClientIdentityProofMessage,
  type ClientMediaTrackSourceMessage,
  type ClientMessage,
  type ClientPingMessage,
  type ClientVoiceJoinMessage,
  type ClientVoiceLeaveMessage,
  type ClientWebrtcMessage,
  type ErrorCode,
  type ServerMessage,
} from '@disco-voador/protocol';

import type { ConnectionState } from './connection-state.js';
import type { VoiceRegistry } from './voice/registry.js';

/**
 * The identity claim and outstanding challenge for a connection currently in
 * `awaiting_identity_proof`. `Connection` owns the actual storage (see `connection.ts`) — this
 * type just describes its shape so `routeClientMessage` can stay pure: it receives the current
 * value as `ctx.pendingChallenge` and returns the next value as `RouteResult.pendingChallenge`,
 * rather than mutating anything itself.
 */
export interface PendingIdentityChallenge {
  readonly protocolVersion: number;
  readonly publicKey: string;
  readonly nickname: string;
  readonly nonce: string;
  readonly expiresAt: number;
}

export interface HandlerContext {
  readonly connectionId: string;
  readonly now: () => Date;
  readonly heartbeat: { readonly intervalMs: number; readonly timeoutMs: number };
  readonly voiceRegistry: VoiceRegistry;
  readonly identityChallengeTtlMs: number;
  /** The connection's outstanding identity challenge, if it is currently `awaiting_identity_proof`. */
  readonly pendingChallenge: PendingIdentityChallenge | undefined;
}

/**
 * A message to deliver as a result of processing one client message. `reply` goes back to the
 * sender; `deliver` goes to a *different*, server-identified connection (e.g. notifying other
 * channel members, or forwarding a signaling message) — `routeClientMessage` never sends
 * anything itself, it only describes what should be sent, so it stays pure and testable without
 * any real socket. `Connection`/`server.ts` carry these actions out.
 */
export type OutgoingAction =
  | { readonly kind: 'reply'; readonly message: ServerMessage }
  | { readonly kind: 'deliver'; readonly connectionId: string; readonly message: ServerMessage };

export type RouteResult =
  | {
      readonly ok: true;
      readonly nextState: ConnectionState;
      readonly actions: readonly OutgoingAction[];
      /** The connection's next `pendingChallenge` (see {@link HandlerContext}). `undefined` for
       * every transition except into `awaiting_identity_proof`, which clears any prior value —
       * a connection never carries a stale challenge into `ready` or back into `awaiting_hello`. */
      readonly pendingChallenge?: PendingIdentityChallenge;
    }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

function reply(message: ServerMessage): OutgoingAction {
  return { kind: 'reply', message };
}

function deliver(connectionId: string, message: ServerMessage): OutgoingAction {
  return { kind: 'deliver', connectionId, message };
}

/**
 * Issues a fresh identity challenge in answer to a structurally valid `client:hello`. The
 * connection does not become `ready` here — see `handleIdentityProof`, which is the only path
 * that can produce `server:hello`.
 */
function buildIdentityChallenge(
  message: ClientHelloMessage,
  ctx: HandlerContext,
): { readonly challenge: PendingIdentityChallenge; readonly serverMessage: ServerMessage } {
  const challenge: PendingIdentityChallenge = {
    protocolVersion: message.protocolVersion,
    publicKey: message.publicKey,
    nickname: message.nickname,
    nonce: generateIdentityChallengeNonce(),
    expiresAt: ctx.now().getTime() + ctx.identityChallengeTtlMs,
  };

  return {
    challenge,
    serverMessage: {
      type: 'server:identity-challenge',
      id: randomUUID(),
      connectionId: ctx.connectionId,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
    },
  };
}

function buildServerHello(
  replyToId: string,
  identityId: string,
  ctx: HandlerContext,
): ServerMessage {
  return {
    type: 'server:hello',
    id: replyToId,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    connectionId: ctx.connectionId,
    identityId,
    serverTime: ctx.now().toISOString(),
    heartbeat: { intervalMs: ctx.heartbeat.intervalMs, timeoutMs: ctx.heartbeat.timeoutMs },
  };
}

/**
 * Verifies `client:identity-proof` against the connection's outstanding challenge. Only ever
 * reachable from `awaiting_identity_proof` with a non-expired challenge still present — every
 * other case (no challenge, expired, wrong signature) is a distinct rejection, never a silent
 * fallback. On success, the server derives `identityId` itself from the verified public key
 * (`deriveIdentityId`) — the client never supplies it, and there is nothing here to trust from
 * the client beyond the public key it already committed to at `client:hello`.
 */
function handleIdentityProof(
  message: ClientIdentityProofMessage,
  ctx: HandlerContext,
): RouteResult {
  const challenge = ctx.pendingChallenge;
  if (!challenge) {
    return {
      ok: false,
      code: 'IDENTITY_PROTOCOL_ERROR',
      message: 'No outstanding identity challenge',
    };
  }

  if (ctx.now().getTime() > challenge.expiresAt) {
    return { ok: false, code: 'IDENTITY_CHALLENGE_EXPIRED', message: 'Identity challenge expired' };
  }

  const payload = buildIdentityAuthPayload({
    protocolVersion: challenge.protocolVersion,
    connectionId: ctx.connectionId,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
    publicKey: challenge.publicKey,
    nickname: challenge.nickname,
  });

  let verified: boolean;
  try {
    verified = verifyIdentitySignature(challenge.publicKey, payload, message.signature);
  } catch {
    // Defensive only: packages/protocol's schema already guarantees publicKey/signature are the
    // right length and alphabet before this ever runs, so verifyIdentitySignature should never
    // throw here in practice — but a public key it genuinely cannot process is a distinct,
    // specifically-coded failure, not an INTERNAL_ERROR.
    return {
      ok: false,
      code: 'IDENTITY_INVALID_PUBLIC_KEY',
      message: 'Public key could not be processed',
    };
  }

  if (!verified) {
    return {
      ok: false,
      code: 'IDENTITY_INVALID_SIGNATURE',
      message: 'Signature verification failed',
    };
  }

  const identityId = deriveIdentityId(challenge.publicKey);

  return {
    ok: true,
    nextState: 'ready',
    actions: [
      reply(buildServerHello(message.id, identityId, ctx)),
      reply(buildVoiceCatalogMessage(ctx)),
    ],
  };
}

export function handleClientPing(message: ClientPingMessage): ServerMessage {
  return { type: 'server:pong', id: message.id };
}

function buildVoiceCatalogMessage(ctx: HandlerContext): ServerMessage {
  return {
    type: 'voice:catalog',
    id: randomUUID(),
    channels: [...ctx.voiceRegistry.listChannels()],
  };
}

function notifyParticipantLeft(
  channelId: string,
  participantId: string,
  remainingMemberConnectionIds: readonly string[],
): OutgoingAction[] {
  return remainingMemberConnectionIds.map((connectionId) =>
    deliver(connectionId, {
      type: 'voice:participant-left',
      id: randomUUID(),
      channelId,
      participantId,
    }),
  );
}

function handleVoiceJoin(message: ClientVoiceJoinMessage, ctx: HandlerContext): RouteResult {
  const outcome = ctx.voiceRegistry.join(ctx.connectionId, message.channelId, message.displayName);
  if (!outcome.ok) {
    return { ok: false, code: outcome.code, message: outcome.reason };
  }

  const actions: OutgoingAction[] = [];

  if (outcome.previous) {
    actions.push(
      ...notifyParticipantLeft(
        outcome.previous.channelId,
        outcome.previous.participantId,
        outcome.previous.remainingMemberConnectionIds,
      ),
    );
  }

  actions.push(
    reply({
      type: 'voice:joined',
      id: message.id,
      channelId: outcome.channelId,
      participantId: outcome.participantId,
      participants: [...outcome.existingParticipants],
    }),
  );

  for (const memberConnectionId of outcome.existingMemberConnectionIds) {
    actions.push(
      deliver(memberConnectionId, {
        type: 'voice:participant-joined',
        id: randomUUID(),
        channelId: outcome.channelId,
        participant: { participantId: outcome.participantId, displayName: outcome.displayName },
      }),
    );
  }

  return { ok: true, nextState: 'ready', actions };
}

function handleVoiceLeave(message: ClientVoiceLeaveMessage, ctx: HandlerContext): RouteResult {
  const left = ctx.voiceRegistry.leave(ctx.connectionId);
  if (!left) {
    return {
      ok: false,
      code: 'NOT_IN_VOICE_CHANNEL',
      message: 'Not currently in a voice channel',
    };
  }

  const actions: OutgoingAction[] = [
    reply({ type: 'voice:left', id: message.id, channelId: left.channelId }),
    ...notifyParticipantLeft(left.channelId, left.participantId, left.remainingMemberConnectionIds),
  ];

  return { ok: true, nextState: 'ready', actions };
}

function buildForwardedSignal(
  message: ClientWebrtcMessage,
  sourceParticipantId: string,
): ServerMessage {
  switch (message.type) {
    case 'webrtc:offer':
      return { type: 'webrtc:offer', id: randomUUID(), sourceParticipantId, sdp: message.sdp };
    case 'webrtc:answer':
      return { type: 'webrtc:answer', id: randomUUID(), sourceParticipantId, sdp: message.sdp };
    case 'webrtc:ice-candidate':
      return {
        type: 'webrtc:ice-candidate',
        id: randomUUID(),
        sourceParticipantId,
        candidate: message.candidate,
      };
  }
}

function handleWebrtcSignal(message: ClientWebrtcMessage, ctx: HandlerContext): RouteResult {
  const resolved = ctx.voiceRegistry.resolveSignalingTarget(
    ctx.connectionId,
    message.targetParticipantId,
  );
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, message: resolved.reason };
  }

  const forwarded = buildForwardedSignal(message, resolved.sourceParticipantId);
  return {
    ok: true,
    nextState: 'ready',
    actions: [deliver(resolved.targetConnectionId, forwarded)],
  };
}

/**
 * Forwards a track's semantic source (camera vs. screen-video — see `media.ts` in
 * `packages/protocol`) to the one peer it concerns, with the sender's identity substituted
 * server-side — structurally identical to `handleWebrtcSignal`, and deliberately so: `mid` is
 * scoped to a single peer connection (see `midSchema`'s doc comment), so unlike an earlier
 * broadcast-based design, this has exactly one correct target, the same as an offer/answer/ICE
 * candidate.
 */
function handleMediaTrackSource(
  message: ClientMediaTrackSourceMessage,
  ctx: HandlerContext,
): RouteResult {
  const resolved = ctx.voiceRegistry.resolveSignalingTarget(
    ctx.connectionId,
    message.targetParticipantId,
  );
  if (!resolved.ok) {
    return { ok: false, code: resolved.code, message: resolved.reason };
  }

  const forwarded: ServerMessage = {
    type: 'media:track-source',
    id: randomUUID(),
    sourceParticipantId: resolved.sourceParticipantId,
    mid: message.mid,
    source: message.source,
  };

  return {
    ok: true,
    nextState: 'ready',
    actions: [deliver(resolved.targetConnectionId, forwarded)],
  };
}

/**
 * The single decision table for "given this validated message and the connection's current
 * state, what happens." Pure and Electron/WebSocket-free — the full state x message-type matrix,
 * including voice/signaling authorization, is unit-testable without any real socket. Whether a
 * given `ok:false` result actually closes the connection is decided by the caller
 * (`Connection`/`connection.ts`), derived from whether the error code has an assigned close code
 * — see `errors.ts` in `packages/protocol` for the fatal-vs-non-fatal split.
 */
export function routeClientMessage(
  message: ClientMessage,
  state: ConnectionState,
  ctx: HandlerContext,
): RouteResult {
  if (message.type === 'client:hello') {
    if (state !== 'awaiting_hello') {
      return { ok: false, code: 'UNEXPECTED_MESSAGE', message: 'Duplicate client:hello' };
    }
    if (!isSupportedProtocolVersion(message.protocolVersion)) {
      return {
        ok: false,
        code: 'UNSUPPORTED_PROTOCOL',
        message: `Unsupported protocol version ${String(message.protocolVersion)}`,
      };
    }
    const { challenge, serverMessage } = buildIdentityChallenge(message, ctx);
    return {
      ok: true,
      nextState: 'awaiting_identity_proof',
      actions: [reply(serverMessage)],
      pendingChallenge: challenge,
    };
  }

  if (message.type === 'client:identity-proof') {
    if (state !== 'awaiting_identity_proof') {
      return {
        ok: false,
        code: 'IDENTITY_PROTOCOL_ERROR',
        message: 'No outstanding identity challenge',
      };
    }
    return handleIdentityProof(message, ctx);
  }

  if (state !== 'ready') {
    return { ok: false, code: 'HANDSHAKE_REQUIRED', message: 'Handshake not completed' };
  }

  switch (message.type) {
    case 'client:ping':
      return { ok: true, nextState: state, actions: [reply(handleClientPing(message))] };
    case 'voice:join':
      return handleVoiceJoin(message, ctx);
    case 'voice:leave':
      return handleVoiceLeave(message, ctx);
    case 'webrtc:offer':
    case 'webrtc:answer':
    case 'webrtc:ice-candidate':
      return handleWebrtcSignal(message, ctx);
    case 'media:track-source':
      return handleMediaTrackSource(message, ctx);
  }
}
