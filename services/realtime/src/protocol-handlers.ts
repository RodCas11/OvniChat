import { randomUUID } from 'node:crypto';

import {
  deriveIdentityId,
  generateIdentityChallengeNonce,
  verifyIdentitySignature,
} from '@disco-voador/identity';
import {
  CHAT_HISTORY_DEFAULT_PAGE_SIZE,
  CURRENT_PROTOCOL_VERSION,
  buildIdentityAuthPayload,
  isSupportedProtocolVersion,
  type ChatMessageView,
  type ClientAuthorizationBanMessage,
  type ClientAuthorizationCreateGroupMessage,
  type ClientAuthorizationCreateTokenMessage,
  type ClientAuthorizationDeleteGroupMessage,
  type ClientAuthorizationGrantGroupMessage,
  type ClientAuthorizationKickMessage,
  type ClientAuthorizationListBansMessage,
  type ClientAuthorizationListGroupsMessage,
  type ClientAuthorizationRedeemTokenMessage,
  type ClientAuthorizationRevokeGroupMessage,
  type ClientAuthorizationUnbanMessage,
  type ClientAuthorizationUpdateGroupMessage,
  type ClientChatHistoryRequestMessage,
  type ClientChatSendMessage,
  type ClientHelloMessage,
  type ClientIdentityProofMessage,
  type ClientMediaTrackSourceMessage,
  type ClientMessage,
  type ClientPingMessage,
  type ClientVoiceJoinMessage,
  type ClientVoiceLeaveMessage,
  type ClientWebrtcMessage,
  type ErrorCode,
  type ServerCapability,
  type ServerMessage,
} from '@disco-voador/protocol';

import type { AuthorizationPort, AuthorizationSnapshot } from './authorization-port.js';
import type { ChatPort } from './chat-port.js';
import type { ConnectionState } from './connection-state.js';
import type { VoiceParticipantRecord, VoiceRegistry } from './voice/registry.js';

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
  /** T9 — the bearer token (if any) presented at `client:hello`, carried through to the admission
   * check `handleIdentityProof` performs once the signature verifies. */
  readonly serverToken: string | undefined;
}

export interface HandlerContext {
  readonly connectionId: string;
  readonly now: () => Date;
  readonly heartbeat: { readonly intervalMs: number; readonly timeoutMs: number };
  readonly voiceRegistry: VoiceRegistry;
  readonly identityChallengeTtlMs: number;
  /** The connection's outstanding identity challenge, if it is currently `awaiting_identity_proof`. */
  readonly pendingChallenge: PendingIdentityChallenge | undefined;
  /** T8 — the Dedicated Server's own display metadata, sent once in `server:hello`. Composition
   * config (`services/dedicated-server`), never client-supplied or negotiated. */
  readonly serverMetadata: {
    readonly name: string;
    readonly capabilities: readonly ServerCapability[];
  };
  /** T9 — the server-local authorization port (see `authorization-port.ts`). */
  readonly authorization: AuthorizationPort;
  /** T10 — the server-local persistent chat port (see `chat-port.ts`). */
  readonly chat: ChatPort;
  /** T9 — this connection's own server-verified identity, once known. `undefined` before the
   * identity proof succeeds; always defined for every message reachable only from `ready`
   * (enforced structurally by `routeClientMessage`'s own dispatch below, not re-checked in every
   * individual ready-state handler). */
  readonly identityId: string | undefined;
  /** T10 — the nickname claimed at `client:hello`, retained the same way `identityId` is (see
   * `RouteResult.nickname`'s doc comment). `undefined` before the identity proof succeeds; always
   * defined for every ready-state handler. */
  readonly nickname: string | undefined;
}

/**
 * A message to deliver as a result of processing one client message. `reply` goes back to the
 * sender; `deliver` goes to a *different*, server-identified connection (e.g. notifying other
 * channel members, or forwarding a signaling message); `close` (T9) forcibly closes a *different*
 * connection with a `server:error` + the matching close code (moderation: kick/ban) — the same
 * send-error-then-close policy `Connection.rejectAndClose` already applies to the connection
 * processing the current message, just targeted at another one. `routeClientMessage` never sends
 * or closes anything itself, it only describes what should happen, so it stays pure and testable
 * without any real socket. `Connection`/`server.ts` carry these actions out.
 */
export type OutgoingAction =
  | { readonly kind: 'reply'; readonly message: ServerMessage }
  | { readonly kind: 'deliver'; readonly connectionId: string; readonly message: ServerMessage }
  | {
      readonly kind: 'close';
      readonly connectionId: string;
      readonly code: ErrorCode;
      readonly message: string;
    }
  | {
      /** T10 — pushes `message` to every currently-`ready` connection (server-wide chat, which has
       * no bounded membership set the way a voice channel does — unlike channel-scoped chat, which
       * reuses the existing per-channel `deliver` fan-out via `VoiceRegistry.
       * getChannelMemberConnectionIds`). `routeClientMessage` stays pure either way: this is still
       * just *data* describing what should happen, resolved against `Connection`/`server.ts`'s own
       * connection roster only when the action is actually carried out. */
      readonly kind: 'broadcast-ready';
      readonly message: ServerMessage;
    };

export type RouteResult =
  | {
      readonly ok: true;
      readonly nextState: ConnectionState;
      readonly actions: readonly OutgoingAction[];
      /** The connection's next `pendingChallenge` (see {@link HandlerContext}). `undefined` for
       * every transition except into `awaiting_identity_proof`, which clears any prior value —
       * a connection never carries a stale challenge into `ready` or back into `awaiting_hello`. */
      readonly pendingChallenge?: PendingIdentityChallenge;
      /** T9 — set only on the one transition that authenticates a connection
       * (`handleIdentityProof`'s success path); `Connection` retains this for the connection's
       * lifetime (see `connection.ts`). */
      readonly identityId?: string;
      /** T10 — the nickname claimed at `client:hello`, set on the same transition as
       * `identityId` and retained for the connection's lifetime the same way. A nickname is
       * effectively immutable for a connection's lifetime (reconnecting under a different
       * nickname opens a *new* connection) — needed so chat sends can record `senderNicknameAtSend`
       * without re-deriving it from anywhere (see `docs/architecture/PERSISTENT_TEXT_CHAT.md`). */
      readonly nickname?: string;
    }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

function reply(message: ServerMessage): OutgoingAction {
  return { kind: 'reply', message };
}

function deliver(connectionId: string, message: ServerMessage): OutgoingAction {
  return { kind: 'deliver', connectionId, message };
}

function closeConnection(connectionId: string, code: ErrorCode, message: string): OutgoingAction {
  return { kind: 'close', connectionId, code, message };
}

function broadcastToReady(message: ServerMessage): OutgoingAction {
  return { kind: 'broadcast-ready', message };
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
    serverToken: message.serverToken,
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
    serverName: ctx.serverMetadata.name,
    serverCapabilities: [...ctx.serverMetadata.capabilities],
    serverTime: ctx.now().toISOString(),
    heartbeat: { intervalMs: ctx.heartbeat.intervalMs, timeoutMs: ctx.heartbeat.timeoutMs },
  };
}

function buildAuthorizationStateMessage(snapshot: AuthorizationSnapshot): ServerMessage {
  return {
    type: 'server:authorization-state',
    id: randomUUID(),
    groups: [...snapshot.groups],
    permissions: [...snapshot.permissions],
  };
}

/**
 * Verifies `client:identity-proof` against the connection's outstanding challenge. Only ever
 * reachable from `awaiting_identity_proof` with a non-expired challenge still present — every
 * other case (no challenge, expired, wrong signature) is a distinct rejection, never a silent
 * fallback. On success, the server derives `identityId` itself from the verified public key
 * (`deriveIdentityId`) — the client never supplies it — and then (T9) evaluates server-local
 * admission (ban check, invite-only requirements) before the connection can ever reach `ready`.
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

  const admission = ctx.authorization.admit({
    identityId,
    nickname: challenge.nickname,
    serverToken: challenge.serverToken,
  });
  if (!admission.ok) {
    return { ok: false, code: admission.code, message: admission.message };
  }

  return {
    ok: true,
    nextState: 'ready',
    identityId,
    nickname: challenge.nickname,
    actions: [
      reply(buildServerHello(message.id, identityId, ctx)),
      reply(buildAuthorizationStateMessage(admission)),
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

function toWireParticipant(
  record: VoiceParticipantRecord,
  ctx: HandlerContext,
): { participantId: string; displayName: string; groups: { groupId: string; name: string }[] } {
  return {
    participantId: record.participantId,
    displayName: record.displayName,
    groups: [...ctx.authorization.getPublicBadges(record.identityId)],
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

/** Every `ready`-state handler is only ever reached with a defined `ctx.identityId` — the
 * connection cannot be `ready` without having authenticated (see `routeClientMessage` below,
 * where every branch that can produce a ready-state message follows the identity-proof
 * transition). Centralized here rather than repeating a null-check in every handler. */
function requireIdentityId(ctx: HandlerContext): string {
  if (!ctx.identityId) {
    throw new Error('Invariant violated: ready-state handler reached with no identityId');
  }
  return ctx.identityId;
}

/** T10 — mirrors {@link requireIdentityId}: every ready-state handler is reachable only after
 * `handleIdentityProof` set both fields on the same success transition (see `RouteResult.nickname`'s
 * doc comment), so an absent value here is a genuine invariant violation, not a normal case to
 * handle gracefully. */
function requireNickname(ctx: HandlerContext): string {
  if (!ctx.nickname) {
    throw new Error('Invariant violated: ready-state handler reached with no nickname');
  }
  return ctx.nickname;
}

function handleVoiceJoin(message: ClientVoiceJoinMessage, ctx: HandlerContext): RouteResult {
  const identityId = requireIdentityId(ctx);
  if (!ctx.authorization.can(identityId, 'voice.channel.join')) {
    return {
      ok: false,
      code: 'AUTHORIZATION_DENIED',
      message: 'Not permitted to join voice channels',
    };
  }

  const outcome = ctx.voiceRegistry.join(
    ctx.connectionId,
    message.channelId,
    message.displayName,
    identityId,
  );
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
      participants: outcome.existingParticipants.map((p) => toWireParticipant(p, ctx)),
    }),
  );

  for (const memberConnectionId of outcome.existingMemberConnectionIds) {
    actions.push(
      deliver(memberConnectionId, {
        type: 'voice:participant-joined',
        id: randomUUID(),
        channelId: outcome.channelId,
        participant: {
          participantId: outcome.participantId,
          displayName: outcome.displayName,
          groups: [...ctx.authorization.getPublicBadges(identityId)],
        },
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

// --- T9 authorization handlers -----------------------------------------------------------------

function ack(replyToId: string): OutgoingAction {
  return reply({ type: 'server:authorization-ack', id: replyToId });
}

function handleAuthorizationRedeemToken(
  message: ClientAuthorizationRedeemTokenMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  const result = ctx.authorization.redeemToken(identityId, message.token);
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }
  return {
    ok: true,
    nextState: 'ready',
    actions: [
      reply({ type: 'server:authorization-token-redeemed', id: message.id, group: result.group }),
      reply(buildAuthorizationStateMessage(ctx.authorization.getSnapshot(identityId))),
    ],
  };
}

function handleAuthorizationCreateToken(
  message: ClientAuthorizationCreateTokenMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  if (!ctx.authorization.can(identityId, 'authorization.tokens.manage')) {
    return { ok: false, code: 'AUTHORIZATION_DENIED', message: 'Not permitted to manage tokens' };
  }
  const result = ctx.authorization.createToken({
    tokenKind: message.tokenKind,
    groupId: message.groupId,
    expiresInMs: message.expiresInMs,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: `Unknown group "${message.groupId}"` };
  }
  return {
    ok: true,
    nextState: 'ready',
    actions: [
      reply({
        type: 'server:authorization-token-created',
        id: message.id,
        token: result.token,
        tokenKind: result.tokenKind,
        groupId: result.groupId,
        expiresAt: result.expiresAt,
      }),
    ],
  };
}

function handleAuthorizationListGroups(
  message: ClientAuthorizationListGroupsMessage,
  ctx: HandlerContext,
): RouteResult {
  return {
    ok: true,
    nextState: 'ready',
    actions: [
      reply({
        type: 'server:authorization-groups',
        id: message.id,
        groups: [...ctx.authorization.listGroups()],
      }),
    ],
  };
}

function handleAuthorizationCreateGroup(
  message: ClientAuthorizationCreateGroupMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  if (!ctx.authorization.can(identityId, 'authorization.groups.manage')) {
    return { ok: false, code: 'AUTHORIZATION_DENIED', message: 'Not permitted to manage groups' };
  }
  const result = ctx.authorization.createGroup({
    name: message.name,
    permissions: message.permissions,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: 'Failed to create group' };
  }
  return { ok: true, nextState: 'ready', actions: [ack(message.id)] };
}

function handleAuthorizationUpdateGroup(
  message: ClientAuthorizationUpdateGroupMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  if (!ctx.authorization.can(identityId, 'authorization.groups.manage')) {
    return { ok: false, code: 'AUTHORIZATION_DENIED', message: 'Not permitted to manage groups' };
  }
  const result = ctx.authorization.updateGroup({
    groupId: message.groupId,
    name: message.name,
    permissions: message.permissions,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }
  return { ok: true, nextState: 'ready', actions: [ack(message.id)] };
}

function handleAuthorizationDeleteGroup(
  message: ClientAuthorizationDeleteGroupMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  if (!ctx.authorization.can(identityId, 'authorization.groups.manage')) {
    return { ok: false, code: 'AUTHORIZATION_DENIED', message: 'Not permitted to manage groups' };
  }
  const result = ctx.authorization.deleteGroup(message.groupId);
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }

  const actions: OutgoingAction[] = [ack(message.id)];
  // Mirrors `handleAuthorizationRevokeGroup`'s `stillAdmitted` symmetry (T9 follow-up, security
  // review): deleting a custom group can leave an `invite-only` identity with no remaining
  // admission basis just as revoking one can, so any of its live connections are force-closed the
  // same way, rather than silently continuing under the Guest baseline for the rest of the session.
  for (const identityId of result.noLongerAdmitted) {
    for (const record of ctx.voiceRegistry.findAllByIdentityId(identityId)) {
      actions.push(
        closeConnection(
          record.connectionId,
          'INVITE_REQUIRED',
          'Server-local authorization was revoked',
        ),
      );
    }
  }
  return { ok: true, nextState: 'ready', actions };
}

/** Shared by grant/revoke/kick/ban: resolves a `targetParticipantId` to the online participant's
 * own `identityId`, never trusting a client-supplied identity value (T9 Section 37). */
function resolveTarget(
  targetParticipantId: string,
  ctx: HandlerContext,
): { readonly ok: true; readonly record: VoiceParticipantRecord } | { readonly ok: false } {
  const record = ctx.voiceRegistry.findByParticipantId(targetParticipantId);
  if (!record) return { ok: false };
  return { ok: true, record };
}

function handleAuthorizationGrantGroup(
  message: ClientAuthorizationGrantGroupMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  if (!ctx.authorization.can(identityId, 'authorization.memberships.manage')) {
    return {
      ok: false,
      code: 'AUTHORIZATION_DENIED',
      message: 'Not permitted to manage memberships',
    };
  }
  const target = resolveTarget(message.targetParticipantId, ctx);
  if (!target.ok) {
    return { ok: false, code: 'PARTICIPANT_NOT_FOUND', message: 'Target participant not found' };
  }
  const result = ctx.authorization.grantGroup(target.record.identityId, message.groupId);
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }

  const actions: OutgoingAction[] = [ack(message.id)];
  if (target.record.connectionId !== ctx.connectionId) {
    actions.push(
      deliver(target.record.connectionId, buildAuthorizationStateMessage(result.snapshot)),
    );
  }
  return { ok: true, nextState: 'ready', actions };
}

function handleAuthorizationRevokeGroup(
  message: ClientAuthorizationRevokeGroupMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  if (!ctx.authorization.can(identityId, 'authorization.memberships.manage')) {
    return {
      ok: false,
      code: 'AUTHORIZATION_DENIED',
      message: 'Not permitted to manage memberships',
    };
  }
  const target = resolveTarget(message.targetParticipantId, ctx);
  if (!target.ok) {
    return { ok: false, code: 'PARTICIPANT_NOT_FOUND', message: 'Target participant not found' };
  }
  const result = ctx.authorization.revokeGroup(target.record.identityId, message.groupId);
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }

  const actions: OutgoingAction[] = [ack(message.id)];
  // T9 Section 63: if this revocation leaves the target with no admission basis at all under the
  // server's current access rules, its live connection is closed rather than left in a stale
  // authorized state until it happens to reconnect.
  if (!result.stillAdmitted) {
    // Close code `INVITE_REQUIRED` (not `AUTHORIZATION_DENIED`, which has no fatal mapping in
    // `CLOSE_CODE_BY_ERROR` and would otherwise fall back to a misleading `INTERNAL_ERROR` — QA
    // finding, T9 follow-up): the identity genuinely no longer satisfies this server's current
    // admission rules, which is exactly what `INVITE_REQUIRED` communicates.
    actions.push(
      closeConnection(
        target.record.connectionId,
        'INVITE_REQUIRED',
        'Server-local authorization was revoked',
      ),
    );
  } else if (target.record.connectionId !== ctx.connectionId) {
    actions.push(
      deliver(target.record.connectionId, buildAuthorizationStateMessage(result.snapshot)),
    );
  }
  return { ok: true, nextState: 'ready', actions };
}

function handleAuthorizationKick(
  message: ClientAuthorizationKickMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  if (!ctx.authorization.can(identityId, 'moderation.kick')) {
    return { ok: false, code: 'AUTHORIZATION_DENIED', message: 'Not permitted to kick' };
  }
  const target = resolveTarget(message.targetParticipantId, ctx);
  if (!target.ok) {
    return { ok: false, code: 'PARTICIPANT_NOT_FOUND', message: 'Target participant not found' };
  }
  return {
    ok: true,
    nextState: 'ready',
    actions: [
      ack(message.id),
      closeConnection(target.record.connectionId, 'KICKED', 'Kicked by an administrator'),
    ],
  };
}

function handleAuthorizationBan(
  message: ClientAuthorizationBanMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  if (!ctx.authorization.can(identityId, 'moderation.ban')) {
    return { ok: false, code: 'AUTHORIZATION_DENIED', message: 'Not permitted to ban' };
  }
  const target = resolveTarget(message.targetParticipantId, ctx);
  if (!target.ok) {
    return { ok: false, code: 'PARTICIPANT_NOT_FOUND', message: 'Target participant not found' };
  }
  ctx.authorization.ban(target.record.identityId, message.durationMs, message.reason);
  return {
    ok: true,
    nextState: 'ready',
    actions: [
      ack(message.id),
      closeConnection(target.record.connectionId, 'BANNED', 'Banned by an administrator'),
    ],
  };
}

function handleAuthorizationUnban(
  message: ClientAuthorizationUnbanMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  if (!ctx.authorization.can(identityId, 'moderation.ban')) {
    return { ok: false, code: 'AUTHORIZATION_DENIED', message: 'Not permitted to unban' };
  }
  ctx.authorization.unban(message.identityId);
  return { ok: true, nextState: 'ready', actions: [ack(message.id)] };
}

function handleAuthorizationListBans(
  message: ClientAuthorizationListBansMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  if (!ctx.authorization.can(identityId, 'moderation.ban')) {
    return { ok: false, code: 'AUTHORIZATION_DENIED', message: 'Not permitted to view bans' };
  }
  return {
    ok: true,
    nextState: 'ready',
    actions: [
      reply({
        type: 'server:authorization-bans',
        id: message.id,
        bans: [...ctx.authorization.listBans()],
      }),
    ],
  };
}

/** T10 — attaches `senderParticipantId` to a just-persisted, about-to-broadcast message iff the
 * sender is currently an online voice participant: always present for a channel-scoped send (T10
 * requires current channel membership to send there — see `handleChatSend`), present only
 * conditionally for a server-scoped send (the sender may or may not currently be in any voice
 * channel). Never used for a history page — a historical sender's current online status is not
 * reconstructed (T10 Section 11: runtime-only, never persisted, never re-derived after the fact). */
function withLiveSenderParticipantId(view: ChatMessageView, ctx: HandlerContext): ChatMessageView {
  const participantId = ctx.voiceRegistry.getParticipant(ctx.connectionId)?.participantId;
  return participantId ? { ...view, senderParticipantId: participantId } : view;
}

/** Both `client:chat-send` and `client:chat-history-request` are schema-validated (`.refine()` in
 * `packages/protocol`) so that `channelId` is present exactly when `scope === 'channel'` — but a
 * `.refine()` narrows at runtime only, not in TypeScript's inferred type, so every channel-scope
 * branch below re-asserts it once via this helper rather than repeating a non-null assertion at
 * every use site. Never actually reachable any other way given schema validation already ran. */
function requireChannelId(channelId: string | undefined): string {
  if (channelId === undefined) {
    throw new Error('Invariant violated: channel-scope chat message with no channelId');
  }
  return channelId;
}

function handleChatSend(message: ClientChatSendMessage, ctx: HandlerContext): RouteResult {
  const identityId = requireIdentityId(ctx);
  const nickname = requireNickname(ctx);

  let channelId: string | undefined;
  if (message.scope === 'channel') {
    channelId = requireChannelId(message.channelId);
    if (!ctx.voiceRegistry.isKnownChannel(channelId)) {
      return {
        ok: false,
        code: 'CHANNEL_NOT_FOUND',
        message: `Unknown voice channel "${channelId}"`,
      };
    }
    // Sending channel chat requires *current* membership in that exact channel (T10 Section 8: this
    // repository's existing model already scopes signaling/track-source the same way) — reading its
    // history does not (see `handleChatHistoryRequest`). Deliberately asymmetric; documented in
    // `docs/architecture/PERSISTENT_TEXT_CHAT.md`.
    const participant = ctx.voiceRegistry.getParticipant(ctx.connectionId);
    if (!participant || participant.channelId !== channelId) {
      return {
        ok: false,
        code: 'NOT_IN_VOICE_CHANNEL',
        message: 'Must be in this voice channel to send chat there',
      };
    }
    if (!ctx.authorization.can(identityId, 'chat.channel.send')) {
      return {
        ok: false,
        code: 'AUTHORIZATION_DENIED',
        message: 'Not permitted to send channel chat',
      };
    }
  } else if (!ctx.authorization.can(identityId, 'chat.server.send')) {
    return {
      ok: false,
      code: 'AUTHORIZATION_DENIED',
      message: 'Not permitted to send server chat',
    };
  }

  const result = ctx.chat.sendMessage({
    scope: message.scope,
    channelId,
    senderIdentityId: identityId,
    senderNickname: nickname,
    body: message.body,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }

  const broadcastMessage: ServerMessage = {
    type: 'server:chat-message',
    id: randomUUID(),
    message: withLiveSenderParticipantId(result.message, ctx),
  };

  // Server-wide chat has no bounded membership set to enumerate (unlike a voice channel), so it
  // uses the dedicated ready-connection-roster broadcast action; channel chat reuses the existing
  // per-channel `deliver` fan-out, identical in shape to `voice:participant-joined`'s.
  if (channelId === undefined) {
    return { ok: true, nextState: 'ready', actions: [broadcastToReady(broadcastMessage)] };
  }
  const memberConnectionIds = ctx.voiceRegistry.getChannelMemberConnectionIds(channelId);
  return {
    ok: true,
    nextState: 'ready',
    actions: memberConnectionIds.map((connectionId) => deliver(connectionId, broadcastMessage)),
  };
}

function handleChatHistoryRequest(
  message: ClientChatHistoryRequestMessage,
  ctx: HandlerContext,
): RouteResult {
  requireIdentityId(ctx);
  // No permission check: reading history requires no permission beyond being an admitted, `ready`
  // connection (T10 Section 8) — this repository has no channel-visibility ACL beyond server
  // admission, and inventing one was explicitly out of scope for T10 (see
  // `docs/architecture/PERSISTENT_TEXT_CHAT.md`'s "Reading channel chat" section). Deliberately
  // asymmetric with `handleChatSend`'s membership/permission checks — documented, not accidental.
  let channelId: string | undefined;
  if (message.scope === 'channel') {
    channelId = requireChannelId(message.channelId);
    if (!ctx.voiceRegistry.isKnownChannel(channelId)) {
      return {
        ok: false,
        code: 'CHANNEL_NOT_FOUND',
        message: `Unknown voice channel "${channelId}"`,
      };
    }
  }

  const page = ctx.chat.getHistory({
    scope: message.scope,
    channelId,
    beforeMessageId: message.beforeMessageId,
    limit: message.limit ?? CHAT_HISTORY_DEFAULT_PAGE_SIZE,
  });

  return {
    ok: true,
    nextState: 'ready',
    actions: [
      reply({
        type: 'server:chat-history-page',
        id: message.id,
        messages: [...page.messages],
        hasMore: page.hasMore,
        ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
      }),
    ],
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
    case 'client:authorization-redeem-token':
      return handleAuthorizationRedeemToken(message, ctx);
    case 'client:authorization-create-token':
      return handleAuthorizationCreateToken(message, ctx);
    case 'client:authorization-list-groups':
      return handleAuthorizationListGroups(message, ctx);
    case 'client:authorization-create-group':
      return handleAuthorizationCreateGroup(message, ctx);
    case 'client:authorization-update-group':
      return handleAuthorizationUpdateGroup(message, ctx);
    case 'client:authorization-delete-group':
      return handleAuthorizationDeleteGroup(message, ctx);
    case 'client:authorization-grant-group':
      return handleAuthorizationGrantGroup(message, ctx);
    case 'client:authorization-revoke-group':
      return handleAuthorizationRevokeGroup(message, ctx);
    case 'client:authorization-kick':
      return handleAuthorizationKick(message, ctx);
    case 'client:authorization-ban':
      return handleAuthorizationBan(message, ctx);
    case 'client:authorization-unban':
      return handleAuthorizationUnban(message, ctx);
    case 'client:authorization-list-bans':
      return handleAuthorizationListBans(message, ctx);
    case 'client:chat-send':
      return handleChatSend(message, ctx);
    case 'client:chat-history-request':
      return handleChatHistoryRequest(message, ctx);
  }
}
