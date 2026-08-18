import { randomUUID } from 'node:crypto';

import {
  CURRENT_PROTOCOL_VERSION,
  isSupportedProtocolVersion,
  type ClientHelloMessage,
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

export interface HandlerContext {
  readonly connectionId: string;
  readonly now: () => Date;
  readonly heartbeat: { readonly intervalMs: number; readonly timeoutMs: number };
  readonly voiceRegistry: VoiceRegistry;
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
    }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

function reply(message: ServerMessage): OutgoingAction {
  return { kind: 'reply', message };
}

function deliver(connectionId: string, message: ServerMessage): OutgoingAction {
  return { kind: 'deliver', connectionId, message };
}

export function handleClientHello(message: ClientHelloMessage, ctx: HandlerContext): ServerMessage {
  return {
    type: 'server:hello',
    id: message.id,
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    connectionId: ctx.connectionId,
    serverTime: ctx.now().toISOString(),
    heartbeat: { intervalMs: ctx.heartbeat.intervalMs, timeoutMs: ctx.heartbeat.timeoutMs },
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
    return {
      ok: true,
      nextState: 'ready',
      actions: [reply(handleClientHello(message, ctx)), reply(buildVoiceCatalogMessage(ctx))],
    };
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
  }
}
