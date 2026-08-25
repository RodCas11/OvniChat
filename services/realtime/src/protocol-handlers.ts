import { randomUUID } from 'node:crypto';

import {
  deriveIdentityId,
  generateIdentityChallengeNonce,
  verifyIdentitySignature,
} from '@disco-voador/identity';
import {
  CHAT_HISTORY_DEFAULT_PAGE_SIZE,
  CURRENT_PROTOCOL_VERSION,
  MAX_CHANNEL_DEPTH,
  MAX_CHANNEL_PARTICIPANTS,
  buildIdentityAuthPayload,
  isSupportedProtocolVersion,
  type ChannelNodeAdminView,
  type ChannelNodeView,
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
  type ClientChannelCreateCategoryMessage,
  type ClientChannelCreateVoiceMessage,
  type ClientChannelDeleteMessage,
  type ClientChannelGetEditableNodeMessage,
  type ClientChannelMoveMessage,
  type ClientChannelRemovePasswordMessage,
  type ClientChannelReorderMessage,
  type ClientChannelSetPasswordMessage,
  type ClientChannelUpdateMessage,
  type ClientChatHistoryRequestMessage,
  type ClientChatSendMessage,
  type ClientHelloMessage,
  type ClientIdentityProofMessage,
  type ClientMediaTrackSourceMessage,
  type ClientMessage,
  type ClientPingMessage,
  type ClientProfileClearAvatarMessage,
  type ClientProfileClearMemberStatusMessage,
  type ClientProfileRequestAvatarMessage,
  type ClientProfileSetAvatarMessage,
  type ClientProfileSetPresenceMessage,
  type ClientProfileSetStatusMessage,
  type ClientVoiceJoinMessage,
  type ClientVoiceLeaveMessage,
  type ClientWebrtcMessage,
  type ErrorCode,
  type MemberPresence,
  type ServerCapability,
  type ServerMessage,
} from '@disco-voador/protocol';

import type { AuthorizationPort, AuthorizationSnapshot } from './authorization-port.js';
import type { ChannelPort } from './channel-port.js';
import type { ChatPort } from './chat-port.js';
import type { ConnectionState } from './connection-state.js';
import { deriveMemberRoleBucket } from './presence/role-bucket.js';
import type { PresenceRegistry } from './presence/registry.js';
import type { ProfilePort } from './profile-port.js';
import type { RateLimiter } from './rate-limiter.js';
import type { MintedTurnCredentials, TurnCredentialPort } from './turn-credential-port.js';
import {
  maybeDestroyEmptyTemporaryChannel,
  type TemporaryChannelRegistry,
} from './voice/temporary-channels.js';
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
  /** T13.2 — the server-local persistent channel/category tree port (see `channel-port.ts`). */
  readonly channels: ChannelPort;
  /** T13.2 — in-memory, non-persistent "quick channel" registry (see `voice/temporary-channels.ts`). */
  readonly temporaryChannels: TemporaryChannelRegistry;
  /** T13.2 — per-connection rate limiter for `voice:join` attempts against a password-protected
   * channel, consulted only in that branch, before the `scryptSync`-backed check (see
   * `channel-port.ts`'s doc comment on the accepted blocking-cost tradeoff). Constructed once per
   * `Connection`, mirroring `chatSendRateLimiter`/`chatHistoryRateLimiter`. */
  readonly channelPasswordRateLimiter: RateLimiter;
  /** T13.3 — server-local persistent profile state (see `profile-port.ts`). */
  readonly profile: ProfilePort;
  /** T13.3 — in-memory, non-persistent online-presence registry (see `presence/registry.ts`). */
  readonly presenceRegistry: PresenceRegistry;
  /** T14 — TURN credential minting (see `turn-credential-port.ts`). */
  readonly turnCredentials: TurnCredentialPort;
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
    }
  | {
      /** T13.2 — pushes a *personalized* message to every currently-`ready` connection with a known
       * `identityId`, one call to `buildMessage` per recipient. Used for the channel-catalog
       * refresh: every mutating channel handler, plus the three existing group-membership handlers
       * (`handleAuthorizationGrantGroup`/`RevokeGroup`/`DeleteGroup`), returns this alongside their
       * other actions, since a group-membership change can change what a connection may see/join
       * even though no channel itself changed. `buildMessage` is a pure closure over
       * already-resolved data (never a socket) — still testable without one; a recipient for whom
       * it returns `undefined` receives nothing. */
      readonly kind: 'broadcast-ready-personalized';
      readonly buildMessage: (identityId: string) => ServerMessage | undefined;
    }
  | {
      /** T13.3 — pushes `message` to every currently-`ready` connection *except* the one that
       * triggered it (`Connection` excludes itself by its own connection id — see `connection.ts`).
       * Used exactly once: a freshly-online identity's `server:presence-updated`, since the
       * connecting connection itself receives the full `server:presence-snapshot` instead (which
       * already omits its own identity). */
      readonly kind: 'broadcast-ready-except-self';
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
      /** T15.2 — set on exactly the transition that pushed a `server:turn-credentials` message
       * (`handleIdentityProof`'s success path, and only when TURN is configured at all), carrying
       * that credential's own `expiresAt`. `Connection` uses it to arm the periodic re-mint/re-push
       * timer that keeps a long-lived connection from ever holding an expired credential (see
       * `turn-credential-refresh.ts`). Reported rather than acted on here so `routeClientMessage`
       * stays pure — it describes what happened, it never owns a timer. */
      readonly turnCredentialsExpiresAt?: string;
    }
  | { readonly ok: false; readonly code: ErrorCode; readonly message: string };

/**
 * The one place a `server:turn-credentials` message is built, shared by the initial post-auth push
 * (`handleIdentityProof`) and `Connection`'s later periodic refreshes, so the two can never drift
 * into subtly different payload shapes. Copies each ice-server object rather than passing the port's
 * own objects through, keeping the minted value immutable from a recipient's point of view.
 */
export function buildTurnCredentialsMessage(minted: MintedTurnCredentials): ServerMessage {
  return {
    type: 'server:turn-credentials',
    id: randomUUID(),
    iceServers: minted.iceServers.map((iceServer) => ({ ...iceServer })),
    expiresAt: minted.expiresAt,
  };
}

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

function broadcastToReadyExceptSelf(message: ServerMessage): OutgoingAction {
  return { kind: 'broadcast-ready-except-self', message };
}

/** T13.2 — the caller's own effective group ids, derived the one documented way
 * (`docs`/`channel-port.ts`'s own doc comment): `ChannelPort` never talks to `AuthorizationPort`
 * itself, so every ACL-evaluating call site resolves this once and passes it in explicitly. */
function effectiveGroupIdsFor(
  identityId: string,
  ctx: { readonly authorization: AuthorizationPort },
): readonly string[] {
  return ctx.authorization.getSnapshot(identityId).groups.map((group) => group.groupId);
}

/** T13.2 — a temporary channel's policy is always `'inherit'` by construction (no override field
 * exists on `TemporaryChannelRecord`), so its visibility resolves to exactly its resolved parent's
 * visibility (or the hardcoded root default of `'everyone'` when it has no parent) — see
 * `channel-port.ts`'s ACL-resolution doc comment. */
function temporaryChannelIsVisible(
  parentId: string | undefined,
  effectiveGroupIds: readonly string[],
  ctx: { readonly channels: ChannelPort },
): boolean {
  return (
    parentId === undefined || ctx.channels.getVisibleNode(parentId, effectiveGroupIds) !== undefined
  );
}

/** `true` iff `channelId` currently resolves to something `effectiveGroupIds` may see — either a
 * persisted `ChannelPort` node or a currently-visible temporary channel. Used by `handleChatSend`/
 * `handleChatHistoryRequest`'s channel-scope existence check, which (unlike `handleVoiceJoin`) has
 * no other reason to distinguish the two cases. */
function isVisibleChannelId(
  channelId: string,
  effectiveGroupIds: readonly string[],
  ctx: HandlerContext,
): boolean {
  if (ctx.channels.getVisibleNode(channelId, effectiveGroupIds)) return true;
  const temporaryRecord = ctx.temporaryChannels.get(channelId);
  return (
    temporaryRecord !== undefined &&
    temporaryChannelIsVisible(temporaryRecord.parentId, effectiveGroupIds, ctx)
  );
}

/** The subset of {@link HandlerContext} {@link buildFilteredVoiceCatalogMessage} actually needs —
 * narrowed so `Connection` can call it directly (abrupt-disconnect temporary-channel destruction
 * triggers the same personalized catalog refresh outside of `routeClientMessage`'s own action
 * pipeline — see `connection.ts`'s `cleanupVoiceMembership`) without constructing a full, mostly
 * irrelevant `HandlerContext`. */
export interface VoiceCatalogContext {
  readonly authorization: AuthorizationPort;
  readonly channels: ChannelPort;
  readonly temporaryChannels: TemporaryChannelRegistry;
  readonly voiceRegistry: VoiceRegistry;
  readonly chat: ChatPort;
  readonly now: () => Date;
}

/** Builds the full, per-connection-filtered `voice:catalog` snapshot: `ChannelPort`'s persisted
 * tree plus every currently-visible, non-stale temporary channel, merged. Also where opportunistic
 * temporary-channel zombie pruning happens — see `TemporaryChannelRegistry.pruneAndList`'s own doc
 * comment for why this call site, specifically, was chosen (this function already runs on every
 * connect/mutation/group-membership change, so pruning here piggybacks on already-frequent work
 * instead of a new background timer). */
export function buildFilteredVoiceCatalogMessage(
  ctx: VoiceCatalogContext,
  identityId: string,
): ServerMessage {
  const effectiveGroupIds = effectiveGroupIdsFor(identityId, ctx);
  const persisted = ctx.channels.getFilteredTree(effectiveGroupIds);
  const temporary: ChannelNodeView[] = [];
  const liveTemporaryRecords = ctx.temporaryChannels.pruneAndList(
    ctx.voiceRegistry,
    ctx.chat,
    ctx.now().getTime(),
  );
  for (const record of liveTemporaryRecords) {
    if (!temporaryChannelIsVisible(record.parentId, effectiveGroupIds, ctx)) continue;
    temporary.push({
      nodeId: record.channelId,
      kind: 'voice',
      parentId: record.parentId,
      name: record.name,
      sortOrder: record.createdAt,
      visibilityPolicy: 'inherit',
      joinPolicy: 'inherit',
      managePolicy: 'inherit',
      userLimit: undefined,
      hasPassword: false,
      temporary: true,
    });
  }
  return { type: 'voice:catalog', id: randomUUID(), nodes: [...persisted, ...temporary] };
}

function catalogRefreshAction(ctx: HandlerContext): OutgoingAction {
  return {
    kind: 'broadcast-ready-personalized',
    buildMessage: (identityId: string) => buildFilteredVoiceCatalogMessage(ctx, identityId),
  };
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
  const serverAvatarRef = ctx.profile.getServerProfile().avatarRef;
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
    ...(serverAvatarRef !== undefined ? { serverAvatarRef } : {}),
  };
}

// --- T13.3 profile/presence -------------------------------------------------------------------

/**
 * A member's current presence view, as broadcast/snapshotted to *other* clients — `undefined` iff
 * `identityId` is not currently online (defensive: every real call site only ever calls this for an
 * identity `PresenceRegistry` itself just reported as online). `roleBucket` is recomputed fresh here
 * every time, never cached (see `role-bucket.ts`'s own doc comment).
 */
function buildMemberPresenceView(
  identityId: string,
  ctx: HandlerContext,
): MemberPresence | undefined {
  const memberRef = ctx.presenceRegistry.getMemberRef(identityId);
  const nickname = ctx.presenceRegistry.getNickname(identityId);
  if (!memberRef || !nickname) return undefined;

  const profile = ctx.profile.getUserProfile(identityId);
  const effectiveGroupIds = effectiveGroupIdsFor(identityId, ctx);
  const roleBucket = deriveMemberRoleBucket(effectiveGroupIds, (permission) =>
    ctx.authorization.can(identityId, permission),
  );

  return {
    memberRef,
    displayName: nickname,
    presence: profile.presencePreference,
    ...(profile.customStatus !== undefined ? { customStatus: profile.customStatus } : {}),
    ...(profile.avatarRef !== undefined ? { avatarRef: profile.avatarRef } : {}),
    ...(roleBucket !== undefined ? { roleBucket } : {}),
  };
}

/** The full online-member snapshot for a connection that just became `ready` — every other
 * currently-online identity's presence view, never including `selfIdentityId`'s own entry (see
 * `serverPresenceSnapshotMessageSchema`'s own doc comment). Always called after
 * `PresenceRegistry.registerConnection` for `selfIdentityId` (see `handleIdentityProof`'s call
 * site), so `selfMemberRef` is always resolvable here in practice. */
function buildPresenceSnapshotMessage(ctx: HandlerContext, selfIdentityId: string): ServerMessage {
  const members: MemberPresence[] = [];
  for (const identityId of ctx.presenceRegistry.listOnlineIdentityIds()) {
    if (identityId === selfIdentityId) continue;
    const member = buildMemberPresenceView(identityId, ctx);
    if (member) members.push(member);
  }
  const selfMemberRef = ctx.presenceRegistry.getMemberRef(selfIdentityId);
  return {
    type: 'server:presence-snapshot',
    id: randomUUID(),
    members,
    ...(selfMemberRef !== undefined ? { selfMemberRef } : {}),
  };
}

/** The universal ack reply for every mutating `client:profile-*` message, always describing the
 * *actor's own* current profile snapshot — regardless of whether the mutation actually targeted
 * `'self'`, `'server'`, or `'member'` (see the individual `handleProfile*` functions' own doc
 * comments for why: there is no separate generic-ack message type for a `target: 'server'`/
 * `'member'` mutation, and the actor's own state is always well-defined and unaffected either way,
 * so reusing this one shape is a minimal, schema-conformant choice rather than a new message type). */
function buildProfileSelfUpdatedMessage(
  replyToId: string,
  identityId: string,
  ctx: HandlerContext,
): ServerMessage {
  const profile = ctx.profile.getUserProfile(identityId);
  return {
    type: 'server:profile-self-updated',
    id: replyToId,
    presence: ctx.presenceRegistry.isOnline(identityId) ? profile.presencePreference : 'offline',
    ...(profile.customStatus !== undefined ? { customStatus: profile.customStatus } : {}),
    ...(profile.avatarRef !== undefined ? { avatarRef: profile.avatarRef } : {}),
  };
}

/** Appends the `server:presence-updated` broadcast for `identityId`'s current view, iff it is
 * currently online (always true for every real call site: either the actor's own identity, or a
 * `memberRef`-resolved target that `PresenceRegistry` just confirmed is online).
 *
 * `excludeActingConnection` must be `true` iff `identityId` is the *acting* connection's own
 * identity (every `target: 'self'` call site) — that connection already received the same data via
 * its `reply(buildProfileSelfUpdatedMessage(...))`, and `serverPresenceUpdatedMessageSchema`'s own
 * doc comment promises this broadcast only ever reaches every *other* ready connection. It must stay
 * `false` for a moderator clearing a *different* member's avatar/status (`target: 'member'`): there,
 * `identityId` names the target, not the acting moderator, whose own connection still needs this
 * broadcast to update its own view of that member's row (its `reply` only confirms the moderator's
 * own action succeeded, not the target's new presence view). Getting this backwards previously
 * caused every user who changed their own profile to see a duplicate phantom row for themselves. */
function pushPresenceUpdate(
  identityId: string,
  ctx: HandlerContext,
  actions: OutgoingAction[],
  excludeActingConnection: boolean,
): void {
  const member = buildMemberPresenceView(identityId, ctx);
  if (member) {
    const message: ServerMessage = { type: 'server:presence-updated', id: randomUUID(), member };
    actions.push(
      excludeActingConnection ? broadcastToReadyExceptSelf(message) : broadcastToReady(message),
    );
  }
}

function decodeAvatarBase64(imageBase64: string): Buffer {
  return Buffer.from(imageBase64, 'base64');
}

function handleProfileSetAvatar(
  message: ClientProfileSetAvatarMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  if (message.target === 'server' && !ctx.authorization.can(identityId, 'server.manage')) {
    return {
      ok: false,
      code: 'AUTHORIZATION_DENIED',
      message: 'Not permitted to manage the server avatar',
    };
  }

  const rawBytes = decodeAvatarBase64(message.imageBase64);
  const result =
    message.target === 'server'
      ? ctx.profile.setServerAvatar(message.format, rawBytes)
      : ctx.profile.setUserAvatar(identityId, message.format, rawBytes);
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }

  const actions: OutgoingAction[] = [
    reply(buildProfileSelfUpdatedMessage(message.id, identityId, ctx)),
  ];
  if (message.target === 'self') pushPresenceUpdate(identityId, ctx, actions, true);
  return { ok: true, nextState: 'ready', actions };
}

function handleProfileClearAvatar(
  message: ClientProfileClearAvatarMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);

  if (message.target === 'server') {
    if (!ctx.authorization.can(identityId, 'server.manage')) {
      return {
        ok: false,
        code: 'AUTHORIZATION_DENIED',
        message: 'Not permitted to manage the server avatar',
      };
    }
    ctx.profile.clearServerAvatar();
    return {
      ok: true,
      nextState: 'ready',
      actions: [reply(buildProfileSelfUpdatedMessage(message.id, identityId, ctx))],
    };
  }

  if (message.target === 'member') {
    if (!ctx.authorization.can(identityId, 'moderation.profile.clear')) {
      return {
        ok: false,
        code: 'AUTHORIZATION_DENIED',
        message: "Not permitted to clear another member's avatar",
      };
    }
    // Schema guarantees `memberRef` is present whenever `target === 'member'` (see
    // `clientProfileClearAvatarMessageSchema`'s `.refine()`s) — never reachable any other way.
    const memberRef = message.memberRef;
    if (memberRef === undefined) {
      throw new Error('Invariant violated: target "member" with no memberRef');
    }
    const targetIdentityId = ctx.presenceRegistry.findIdentityByMemberRef(memberRef);
    if (!targetIdentityId) {
      return {
        ok: false,
        code: 'MEMBER_NOT_FOUND',
        message: 'That member is not currently online',
      };
    }
    ctx.profile.clearUserAvatar(targetIdentityId);
    const actions: OutgoingAction[] = [
      reply(buildProfileSelfUpdatedMessage(message.id, identityId, ctx)),
    ];
    pushPresenceUpdate(targetIdentityId, ctx, actions, false);
    return { ok: true, nextState: 'ready', actions };
  }

  // target === 'self'
  ctx.profile.clearUserAvatar(identityId);
  const actions: OutgoingAction[] = [
    reply(buildProfileSelfUpdatedMessage(message.id, identityId, ctx)),
  ];
  pushPresenceUpdate(identityId, ctx, actions, true);
  return { ok: true, nextState: 'ready', actions };
}

function handleProfileSetStatus(
  message: ClientProfileSetStatusMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  ctx.profile.setCustomStatus(identityId, message.customStatus);
  const actions: OutgoingAction[] = [
    reply(buildProfileSelfUpdatedMessage(message.id, identityId, ctx)),
  ];
  pushPresenceUpdate(identityId, ctx, actions, true);
  return { ok: true, nextState: 'ready', actions };
}

function handleProfileClearMemberStatus(
  message: ClientProfileClearMemberStatusMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  if (!ctx.authorization.can(identityId, 'moderation.profile.clear')) {
    return {
      ok: false,
      code: 'AUTHORIZATION_DENIED',
      message: "Not permitted to clear another member's status",
    };
  }
  const targetIdentityId = ctx.presenceRegistry.findIdentityByMemberRef(message.memberRef);
  if (!targetIdentityId) {
    return { ok: false, code: 'MEMBER_NOT_FOUND', message: 'That member is not currently online' };
  }
  ctx.profile.setCustomStatus(targetIdentityId, undefined);
  const actions: OutgoingAction[] = [
    reply(buildProfileSelfUpdatedMessage(message.id, identityId, ctx)),
  ];
  pushPresenceUpdate(targetIdentityId, ctx, actions, false);
  return { ok: true, nextState: 'ready', actions };
}

function handleProfileSetPresence(
  message: ClientProfileSetPresenceMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  ctx.profile.setPresencePreference(identityId, message.presence);
  const actions: OutgoingAction[] = [
    reply(buildProfileSelfUpdatedMessage(message.id, identityId, ctx)),
  ];
  pushPresenceUpdate(identityId, ctx, actions, true);
  return { ok: true, nextState: 'ready', actions };
}

/** No permission gating for any target (self/server/member) — reading avatar bytes is no more
 * sensitive than the `avatarRef` hash/revision every `server:presence-snapshot`/`-updated` already
 * broadcasts to every ready connection unconditionally; this just supplies the actual bytes behind
 * a ref a client already legitimately has. Mirrors `client:chat-history-request`'s own "reading
 * requires no permission beyond being an admitted, ready connection" asymmetry with its send-side
 * permission gating. */
function handleProfileRequestAvatar(
  message: ClientProfileRequestAvatarMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);

  let avatarData: ReturnType<ProfilePort['getUserAvatarData']>;
  if (message.target === 'self') {
    avatarData = ctx.profile.getUserAvatarData(identityId);
  } else if (message.target === 'server') {
    avatarData = ctx.profile.getServerAvatarData();
  } else {
    // Schema guarantees `memberRef` is present whenever `target === 'member'`.
    const memberRef = message.memberRef;
    if (memberRef === undefined) {
      throw new Error('Invariant violated: target "member" with no memberRef');
    }
    const targetIdentityId = ctx.presenceRegistry.findIdentityByMemberRef(memberRef);
    if (!targetIdentityId) {
      return {
        ok: false,
        code: 'MEMBER_NOT_FOUND',
        message: 'That member is not currently online',
      };
    }
    avatarData = ctx.profile.getUserAvatarData(targetIdentityId);
  }

  if (!avatarData) {
    // `MEMBER_NOT_FOUND` is also used, by extension, for a self/server request when no avatar is
    // currently set — there is no separate "nothing to return" code, and this is the closest
    // existing non-fatal shape (see `errors.ts`'s own doc comment).
    return { ok: false, code: 'MEMBER_NOT_FOUND', message: 'No avatar is currently set' };
  }

  return {
    ok: true,
    nextState: 'ready',
    actions: [
      reply({
        type: 'server:profile-avatar-data',
        id: message.id,
        format: avatarData.format,
        imageBase64: avatarData.bytes.toString('base64'),
        avatarRef: avatarData.avatarRef,
      }),
    ],
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

  // T13.3 — registers this connection's presence exactly once, at the moment it first reaches
  // `ready` (mirrors T13.2's own `voice:catalog` initial push happening at this exact call site).
  const presenceResult = ctx.presenceRegistry.registerConnection(
    identityId,
    ctx.connectionId,
    challenge.nickname,
  );

  const turnCredentials = ctx.turnCredentials.mint();

  const actions: OutgoingAction[] = [
    reply(buildServerHello(message.id, identityId, ctx)),
    reply(buildAuthorizationStateMessage(admission)),
    reply(buildFilteredVoiceCatalogMessage(ctx, identityId)),
    reply(buildPresenceSnapshotMessage(ctx, identityId)),
    // T13.3 — closes the "no self-profile read endpoint" gap: without this, a returning identity's
    // own previously-persisted presence/status/avatar is invisible to its own client until it makes
    // a new mutation (see `VoiceChannelState.selfPresence`'s own doc comment on that limitation).
    // `buildProfileSelfUpdatedMessage` is reused as-is (same shape `client:profile-*` mutations reply
    // with) but with a fresh id — this is a proactive push, not a reply to anything the client sent,
    // and `onProfileSelfUpdated` already tolerates an unmatched id (it only *optionally* resolves a
    // pending request by id, and unconditionally applies the state update either way).
    reply(buildProfileSelfUpdatedMessage(randomUUID(), identityId, ctx)),
    // T14 — only when this Dedicated Server actually has TURN configured (see
    // `turn-credential-port.ts`'s own doc comment); never sent at all otherwise, and never with an
    // empty `iceServers` array either way. T15.2 — this is now the *first* of possibly several
    // pushes on the same connection rather than a one-shot; see `RouteResult.turnCredentialsExpiresAt`.
    ...(turnCredentials ? [reply(buildTurnCredentialsMessage(turnCredentials))] : []),
  ];
  // Only a genuine 0->1 transition for this identity is announced to everyone else — if this
  // identity already had another live connection, it was already visible as online, so no
  // `server:presence-updated` is needed (see `PresenceRegistry.registerConnection`'s own doc
  // comment).
  if (presenceResult.becameOnline) {
    const member = buildMemberPresenceView(identityId, ctx);
    if (member) {
      actions.push(
        broadcastToReadyExceptSelf({ type: 'server:presence-updated', id: randomUUID(), member }),
      );
    }
  }

  return {
    ok: true,
    nextState: 'ready',
    identityId,
    nickname: challenge.nickname,
    actions,
    ...(turnCredentials ? { turnCredentialsExpiresAt: turnCredentials.expiresAt } : {}),
  };
}

export function handleClientPing(message: ClientPingMessage): ServerMessage {
  return { type: 'server:pong', id: message.id };
}

function toWireParticipant(
  record: VoiceParticipantRecord,
  ctx: HandlerContext,
): {
  participantId: string;
  displayName: string;
  groups: { groupId: string; name: string }[];
  identityRef: string;
  memberRef: string;
} {
  return {
    participantId: record.participantId,
    displayName: record.displayName,
    groups: [...ctx.authorization.getPublicBadges(record.identityId)],
    identityRef: ctx.profile.getOrCreateIdentityRef(record.identityId),
    memberRef: resolveMemberRefForVoiceParticipant(record.identityId, record.participantId, ctx),
  };
}

/**
 * `PresenceRegistry.getMemberRef` is typed `string | undefined` only because it is a general lookup
 * — for a real, currently-joined voice participant this is structurally always defined (reaching
 * `ready` always registers presence first; see `PresenceRegistry`'s own doc comment), exactly the
 * same invariant `buildMemberPresenceView` already relies on elsewhere in this file. Falling back to
 * `participantId` (never a real `memberRef`, but a validly-shaped, harmless opaque string) rather
 * than throwing keeps this defensive-not-load-bearing: in the practically-unreachable case this ever
 * fired, the affected client would simply find no matching `state.members` entry and render the
 * ordinary no-avatar fallback, never a crash or a real correlation to the wrong person.
 */
function resolveMemberRefForVoiceParticipant(
  identityId: string,
  participantId: string,
  ctx: HandlerContext,
): string {
  return ctx.presenceRegistry.getMemberRef(identityId) ?? participantId;
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

/** T13.2 — checks only the visibility+join axes of `ChannelPort.checkJoin` (capacity/password are
 * irrelevant to *re*-validating someone already inside), by supplying values that structurally
 * cannot fail those two other checks (`currentMemberCount: 0`, `bypassPassword: true`) — see
 * `revalidateChannelMembership`'s own doc comment for why this reuse is safe. */
function stillHasChannelAccess(
  channelId: string,
  effectiveGroupIds: readonly string[],
  ctx: HandlerContext,
): boolean {
  return ctx.channels.checkJoin({
    nodeId: channelId,
    effectiveGroupIds,
    currentMemberCount: 0,
    password: undefined,
    bypassPassword: true,
  }).ok;
}

/**
 * The one shared "re-validate current members of channel X, force-leave anyone who now fails"
 * function (T13.2), called from every trigger that can narrow a currently-joined member's
 * visibility/join rights out from under them: `handleChannelUpdate` (policy narrowed),
 * `handleChannelDelete` (node gone), and all three authorization group handlers (an identity's
 * rights changed) — never duplicated across those call sites. A currently-joined member who loses
 * access is force-left (the same leave/notify-left fan-out `handleVoiceLeave` already builds) and
 * additionally told why via `server:voice-removed-by-policy` — distinct from a self-initiated
 * `voice:left` or a moderation `KICKED`/`BANNED` close.
 *
 * Never called for a *temporary* channel (its policy is always `'inherit'`, so it is never subject
 * to a policy-narrowing mutation) — `ChannelPort.checkJoin` on an unknown-to-it temporary
 * `channelId` reports `NOT_FOUND`, which would incorrectly force-leave every member the very next
 * time this ran for an unrelated reason, so this function is only ever invoked with a real
 * `ChannelPort` node id.
 */
function revalidateChannelMembership(channelId: string, ctx: HandlerContext): OutgoingAction[] {
  const actions: OutgoingAction[] = [];
  for (const connectionId of ctx.voiceRegistry.getChannelMemberConnectionIds(channelId)) {
    const participant = ctx.voiceRegistry.getParticipant(connectionId);
    if (!participant) continue;
    const effectiveGroupIds = effectiveGroupIdsFor(participant.identityId, ctx);
    if (stillHasChannelAccess(channelId, effectiveGroupIds, ctx)) continue;

    const left = ctx.voiceRegistry.leave(connectionId);
    if (!left) continue;
    actions.push(
      ...notifyParticipantLeft(
        left.channelId,
        left.participantId,
        left.remainingMemberConnectionIds,
      ),
      deliver(connectionId, {
        type: 'server:voice-removed-by-policy',
        id: randomUUID(),
        channelId: left.channelId,
        reason: 'access-revoked',
      }),
    );
    const destroyed = maybeDestroyEmptyTemporaryChannel(
      left.channelId,
      ctx.temporaryChannels,
      ctx.voiceRegistry,
      ctx.chat,
    );
    if (destroyed.destroyed) actions.push(catalogRefreshAction(ctx));
  }
  return actions;
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

/** Maps a `ChannelPort.checkJoin` failure code to the wire `ErrorCode` `handleVoiceJoin` returns. */
function channelJoinErrorCode(
  code: 'NOT_FOUND' | 'ACCESS_DENIED' | 'FULL' | 'PASSWORD_REQUIRED' | 'PASSWORD_INVALID',
): ErrorCode {
  switch (code) {
    case 'NOT_FOUND':
      return 'CHANNEL_NOT_FOUND';
    case 'ACCESS_DENIED':
      return 'CHANNEL_ACCESS_DENIED';
    case 'FULL':
      return 'CHANNEL_FULL';
    case 'PASSWORD_REQUIRED':
      return 'CHANNEL_PASSWORD_REQUIRED';
    case 'PASSWORD_INVALID':
      return 'CHANNEL_PASSWORD_INVALID';
  }
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

  const effectiveGroupIds = effectiveGroupIdsFor(identityId, ctx);
  const persistedNode = ctx.channels.getVisibleNode(message.channelId, effectiveGroupIds);
  const temporaryRecord = persistedNode ? undefined : ctx.temporaryChannels.get(message.channelId);
  const temporaryVisible =
    temporaryRecord !== undefined &&
    temporaryChannelIsVisible(temporaryRecord.parentId, effectiveGroupIds, ctx);

  if (!persistedNode && !temporaryVisible) {
    return {
      ok: false,
      code: 'CHANNEL_NOT_FOUND',
      message: `Unknown voice channel "${message.channelId}"`,
    };
  }

  const currentMemberCount = ctx.voiceRegistry.getChannelMemberConnectionIds(
    message.channelId,
  ).length;
  let capacityLimit = MAX_CHANNEL_PARTICIPANTS;

  if (persistedNode) {
    capacityLimit = Math.min(
      persistedNode.userLimit ?? MAX_CHANNEL_PARTICIPANTS,
      MAX_CHANNEL_PARTICIPANTS,
    );

    // Rate-limited only in the branch where the target node actually has a password, before the
    // scryptSync-backed check inside `checkJoin` — see `HandlerContext.channelPasswordRateLimiter`'s
    // own doc comment for the accepted blocking-cost tradeoff this mitigates.
    if (persistedNode.hasPassword && !ctx.channelPasswordRateLimiter.tryConsume()) {
      return {
        ok: false,
        code: 'CHANNEL_PASSWORD_RATE_LIMITED',
        message: 'Too many password attempts',
      };
    }

    const bypassPassword = ctx.authorization.can(identityId, 'channels.password.bypass');
    const joinCheck = ctx.channels.checkJoin({
      nodeId: message.channelId,
      effectiveGroupIds,
      currentMemberCount,
      password: message.password,
      bypassPassword,
    });
    if (!joinCheck.ok) {
      return {
        ok: false,
        code: channelJoinErrorCode(joinCheck.code),
        message: 'Cannot join this voice channel',
      };
    }
  } else if (currentMemberCount >= capacityLimit) {
    // A temporary channel is always inherit/everyone-joinable and never password-protected — the
    // only way to reject one is the numeric capacity ceiling.
    return {
      ok: false,
      code: 'CHANNEL_FULL',
      message: `Voice channel "${message.channelId}" is full`,
    };
  }

  const outcome = ctx.voiceRegistry.join(
    ctx.connectionId,
    message.channelId,
    message.displayName,
    identityId,
    capacityLimit,
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
    // Switching out of a temporary channel can leave it empty too — same destroy-on-empty rule as
    // an explicit `voice:leave` or an abrupt disconnect (see `temporary-channels.ts`).
    const destroyed = maybeDestroyEmptyTemporaryChannel(
      outcome.previous.channelId,
      ctx.temporaryChannels,
      ctx.voiceRegistry,
      ctx.chat,
    );
    if (destroyed.destroyed) actions.push(catalogRefreshAction(ctx));
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
          identityRef: ctx.profile.getOrCreateIdentityRef(identityId),
          memberRef: resolveMemberRefForVoiceParticipant(identityId, outcome.participantId, ctx),
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

  const destroyed = maybeDestroyEmptyTemporaryChannel(
    left.channelId,
    ctx.temporaryChannels,
    ctx.voiceRegistry,
    ctx.chat,
  );
  if (destroyed.destroyed) actions.push(catalogRefreshAction(ctx));

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
  // T13.2 — a group currently referenced by some channel node's ACL cannot be deleted first; the
  // operator must remove it from every channel policy that names it before the group id itself can
  // be deleted, so a channel's ACL can never silently start referencing a group id that no longer
  // exists. Checked *before* ever touching the authorization store.
  if (ctx.channels.isGroupReferenced(message.groupId)) {
    return {
      ok: false,
      code: 'GROUP_IN_USE_BY_CHANNEL_POLICY',
      message: 'This group is still referenced by a channel policy',
    };
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
  // T13.2 — a group-membership change can change what any connection may see/join in the channel
  // tree even though no channel itself changed; re-validate every currently-joined member of every
  // channel this identity's revoked membership might affect. Deleting a *group* can affect any
  // number of identities/channels at once, so this walks every active node rather than a single
  // channel id (contrast `handleAuthorizationGrantGroup`/`RevokeGroup`, which affect one identity).
  for (const nodeId of ctx.channels.listActiveNodeIds()) {
    actions.push(...revalidateChannelMembership(nodeId, ctx));
  }
  // The personalized catalog refresh is added *last*, after every close action above: a connection
  // about to be force-closed for losing its admission basis entirely must never receive one more
  // application message first — `broadcastToReadyPersonalized` only reaches connections still
  // `ready` at the moment it runs, so ordering this after `closeConnection` naturally excludes them.
  actions.push(catalogRefreshAction(ctx));
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
  // T13.2 — a granted group can only ever *widen* the target's access, never narrow it, so no
  // re-validation of their current channel membership is needed here (contrast `handleAuthorization
  // RevokeGroup`, below, where it can narrow access and force-leave is possible).
  actions.push(catalogRefreshAction(ctx));
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
  } else {
    if (target.record.connectionId !== ctx.connectionId) {
      actions.push(
        deliver(target.record.connectionId, buildAuthorizationStateMessage(result.snapshot)),
      );
    }
    // T13.2 — revoking a group can narrow the target's channel access; re-validate their current
    // voice membership (if any) against the channel they are actually in right now.
    const currentChannelId = ctx.voiceRegistry.getParticipant(
      target.record.connectionId,
    )?.channelId;
    if (currentChannelId !== undefined) {
      actions.push(...revalidateChannelMembership(currentChannelId, ctx));
    }
  }
  // Last, for the same reason `handleAuthorizationDeleteGroup` orders it last — a connection being
  // force-closed above must never receive one more application message first.
  actions.push(catalogRefreshAction(ctx));
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
    // T13.2 — a hidden channel and an absent one are structurally indistinguishable (same
    // `CHANNEL_NOT_FOUND` code either way) — closes the "raw history/send request by guessed
    // channelId" leak (see `channel-port.ts`'s own doc comment on this privacy guarantee).
    if (!isVisibleChannelId(channelId, effectiveGroupIdsFor(identityId, ctx), ctx)) {
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
  const identityId = requireIdentityId(ctx);
  // No permission check: reading history requires no permission beyond being an admitted, `ready`
  // connection (T10 Section 8) — only *visibility* now gates it (T13.2), never a send-style
  // permission key. Deliberately asymmetric with `handleChatSend`'s membership/permission checks —
  // documented, not accidental.
  let channelId: string | undefined;
  if (message.scope === 'channel') {
    channelId = requireChannelId(message.channelId);
    // T13.2 — closes the "raw history request by guessed/known channelId" leak: a hidden channel is
    // rejected with the exact same code an unknown one would be.
    if (!isVisibleChannelId(channelId, effectiveGroupIdsFor(identityId, ctx), ctx)) {
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

// --- T13.2 channel/category administration handlers -------------------------------------------

function channelAck(replyToId: string): OutgoingAction {
  return reply({ type: 'server:channel-ack', id: replyToId });
}

function handleChannelCreateCategory(
  message: ClientChannelCreateCategoryMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  const effectiveGroupIds = effectiveGroupIdsFor(identityId, ctx);
  const authorized =
    message.parentId === undefined
      ? ctx.authorization.can(identityId, 'channels.create')
      : ctx.authorization.can(identityId, 'channels.manage') ||
        ctx.channels.hasManageRights(message.parentId, effectiveGroupIds);
  if (!authorized) {
    return { ok: false, code: 'AUTHORIZATION_DENIED', message: 'Not permitted to create channels' };
  }
  const result = ctx.channels.createCategory({
    name: message.name,
    parentId: message.parentId,
    actorEffectiveGroupIds: effectiveGroupIds,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }
  return {
    ok: true,
    nextState: 'ready',
    actions: [
      reply({ type: 'server:channel-created', id: message.id, node: result.node }),
      catalogRefreshAction(ctx),
    ],
  };
}

/** Walks `nodeId`'s ancestor chain via `ChannelPort.getVisibleNode` to compute its 0-based depth
 * (root = 0), matching `ChannelStore`'s own internal `depthOf` semantics exactly. Used only to
 * validate a *temporary* channel's proposed parent against the same `MAX_CHANNEL_DEPTH` bound
 * persistent creation enforces internally — a temporary channel is never actually inserted into
 * `ChannelStore`, so that store's own internal depth check never runs for it; this reuses the
 * existing `getVisibleNode` read path (the same one every other handler already calls) rather than
 * re-implementing tree traversal against a second, parallel data source. */
function depthOfVisibleNode(
  nodeId: string,
  effectiveGroupIds: readonly string[],
  ctx: HandlerContext,
): number {
  let depth = 0;
  let currentId: string | undefined = nodeId;
  const seen = new Set<string>();
  while (currentId !== undefined && !seen.has(currentId)) {
    seen.add(currentId);
    const node = ctx.channels.getVisibleNode(currentId, effectiveGroupIds);
    if (!node?.parentId) break;
    depth += 1;
    currentId = node.parentId;
  }
  return depth;
}

function handleChannelCreateVoice(
  message: ClientChannelCreateVoiceMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  const effectiveGroupIds = effectiveGroupIdsFor(identityId, ctx);
  const authorized =
    message.parentId === undefined
      ? ctx.authorization.can(identityId, 'channels.create')
      : ctx.authorization.can(identityId, 'channels.manage') ||
        ctx.channels.hasManageRights(message.parentId, effectiveGroupIds);
  if (!authorized) {
    return { ok: false, code: 'AUTHORIZATION_DENIED', message: 'Not permitted to create channels' };
  }

  if (message.temporary === true) {
    // Parent validation mirrors `ChannelPort.createVoiceChannel`'s own rules (must exist, must be
    // visible to the creator, must not exceed `MAX_CHANNEL_DEPTH`) — reused via the existing
    // `getVisibleNode` read path rather than duplicated against `ChannelStore` internals, since a
    // temporary channel is never actually inserted there for that store's own checks to run.
    if (message.parentId !== undefined) {
      const parent = ctx.channels.getVisibleNode(message.parentId, effectiveGroupIds);
      if (!parent) {
        return {
          ok: false,
          code: 'CHANNEL_PARENT_INVALID',
          message: `Unknown or invisible parent "${message.parentId}"`,
        };
      }
      const parentDepth = depthOfVisibleNode(message.parentId, effectiveGroupIds, ctx);
      if (parentDepth + 1 > MAX_CHANNEL_DEPTH - 1) {
        return {
          ok: false,
          code: 'CHANNEL_PARENT_INVALID',
          message: 'Maximum channel nesting depth exceeded',
        };
      }
    }

    // No atomic auto-join by design (coordinator decision) — creation and joining remain two
    // separate client-issued messages; the client sends an ordinary `voice:join` for this returned
    // `nodeId` next, entirely reusing existing join logic (including `handleVoiceJoin`'s temporary-
    // channel branch, already implemented) unchanged.
    const record = ctx.temporaryChannels.create({
      name: message.name,
      parentId: message.parentId,
      createdByIdentityId: identityId,
      now: ctx.now().getTime(),
    });
    // A temporary channel's policy is always `'inherit'` by construction (no override field exists
    // on `TemporaryChannelRecord`) with empty group-id lists — it is never reorderable or
    // ACL-overridable, matching how it is already merged into the filtered catalog view.
    const node: ChannelNodeAdminView = {
      nodeId: record.channelId,
      kind: 'voice',
      ...(record.parentId ? { parentId: record.parentId } : {}),
      name: record.name,
      sortOrder: 0,
      visibilityPolicy: 'inherit',
      visibilityGroupIds: [],
      joinPolicy: 'inherit',
      joinGroupIds: [],
      managePolicy: 'inherit',
      manageGroupIds: [],
      hasPassword: false,
      temporary: true,
    };
    return {
      ok: true,
      nextState: 'ready',
      actions: [
        reply({ type: 'server:channel-created', id: message.id, node }),
        catalogRefreshAction(ctx),
      ],
    };
  }

  const result = ctx.channels.createVoiceChannel({
    name: message.name,
    parentId: message.parentId,
    actorEffectiveGroupIds: effectiveGroupIds,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }
  return {
    ok: true,
    nextState: 'ready',
    actions: [
      reply({ type: 'server:channel-created', id: message.id, node: result.node }),
      catalogRefreshAction(ctx),
    ],
  };
}

function handleChannelUpdate(
  message: ClientChannelUpdateMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  const effectiveGroupIds = effectiveGroupIdsFor(identityId, ctx);
  // Security fix (T13.2 review): `hasManageRights` alone does not check Visibility, so without this
  // precondition a local delegated-Manage grant on a node hidden from the actor by an ancestor's
  // Visibility restriction would leak the node's existence/content via this handler — breaking the
  // "existence and visibility are the same check" guarantee `handleChannelMove`/`handleChannelDelete`
  // already enforce this same way. Mirrors those two handlers' exact pattern.
  if (!ctx.channels.getVisibleNode(message.nodeId, effectiveGroupIds)) {
    return { ok: false, code: 'CHANNEL_NOT_FOUND', message: 'Unknown channel/category' };
  }
  const authorized =
    ctx.authorization.can(identityId, 'channels.manage') ||
    ctx.channels.hasManageRights(message.nodeId, effectiveGroupIds);
  if (!authorized) {
    return {
      ok: false,
      code: 'AUTHORIZATION_DENIED',
      message: 'Not permitted to manage this channel',
    };
  }
  const result = ctx.channels.updateNode({
    nodeId: message.nodeId,
    actorEffectiveGroupIds: effectiveGroupIds,
    name: message.name,
    visibilityPolicy: message.visibilityPolicy,
    visibilityGroupIds: message.visibilityGroupIds,
    joinPolicy: message.joinPolicy,
    joinGroupIds: message.joinGroupIds,
    managePolicy: message.managePolicy,
    manageGroupIds: message.manageGroupIds,
    userLimit: message.userLimit,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }
  return {
    ok: true,
    nextState: 'ready',
    actions: [
      channelAck(message.id),
      catalogRefreshAction(ctx),
      ...revalidateChannelMembership(message.nodeId, ctx),
    ],
  };
}

function handleChannelMove(message: ClientChannelMoveMessage, ctx: HandlerContext): RouteResult {
  const identityId = requireIdentityId(ctx);
  const effectiveGroupIds = effectiveGroupIdsFor(identityId, ctx);
  const currentNode = ctx.channels.getVisibleNode(message.nodeId, effectiveGroupIds);
  if (!currentNode) {
    return { ok: false, code: 'CHANNEL_NOT_FOUND', message: 'Unknown channel/category' };
  }
  const hasGlobal = ctx.authorization.can(identityId, 'channels.manage');
  // Filesystem-directory-permission semantics: moving requires Manage on *both* the source and the
  // destination parent (or the global override) — a channel-local Manage grant lets an operator
  // administer that subtree but never sever/move it out from under its parent without also holding
  // Manage at the destination. Root (`undefined` parent) has no local Manage holder at all, so only
  // the global override authorizes a move into/out of the root level.
  const sourceOk =
    hasGlobal ||
    (currentNode.parentId !== undefined &&
      ctx.channels.hasManageRights(currentNode.parentId, effectiveGroupIds));
  const destinationOk =
    hasGlobal ||
    (message.newParentId !== undefined &&
      ctx.channels.hasManageRights(message.newParentId, effectiveGroupIds));
  if (!sourceOk || !destinationOk) {
    return {
      ok: false,
      code: 'AUTHORIZATION_DENIED',
      message: 'Not permitted to move this channel',
    };
  }
  const result = ctx.channels.moveNode({
    nodeId: message.nodeId,
    newParentId: message.newParentId,
    actorEffectiveGroupIds: effectiveGroupIds,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }
  return {
    ok: true,
    nextState: 'ready',
    actions: [
      channelAck(message.id),
      catalogRefreshAction(ctx),
      ...revalidateChannelMembership(message.nodeId, ctx),
    ],
  };
}

function handleChannelReorder(
  message: ClientChannelReorderMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  const effectiveGroupIds = effectiveGroupIdsFor(identityId, ctx);
  const hasGlobal = ctx.authorization.can(identityId, 'channels.manage');
  const authorized =
    hasGlobal ||
    (message.parentId !== undefined &&
      ctx.channels.hasManageRights(message.parentId, effectiveGroupIds));
  if (!authorized) {
    return {
      ok: false,
      code: 'AUTHORIZATION_DENIED',
      message: 'Not permitted to reorder these channels',
    };
  }
  const result = ctx.channels.reorderChildren({
    parentId: message.parentId,
    orderedNodeIds: message.orderedNodeIds,
    actorEffectiveGroupIds: effectiveGroupIds,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }
  return {
    ok: true,
    nextState: 'ready',
    actions: [channelAck(message.id), catalogRefreshAction(ctx)],
  };
}

function handleChannelDelete(
  message: ClientChannelDeleteMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  const effectiveGroupIds = effectiveGroupIdsFor(identityId, ctx);
  const node = ctx.channels.getVisibleNode(message.nodeId, effectiveGroupIds);
  if (!node) {
    return { ok: false, code: 'CHANNEL_NOT_FOUND', message: 'Unknown channel/category' };
  }
  const hasGlobal = ctx.authorization.can(identityId, 'channels.delete');
  // Deleting requires Manage on the node's *parent* (or global `channels.delete`) — never Manage on
  // the node itself (see this file's own doc comment / `channel-port.ts`'s design notes).
  const authorized =
    hasGlobal ||
    (node.parentId !== undefined && ctx.channels.hasManageRights(node.parentId, effectiveGroupIds));
  if (!authorized) {
    return {
      ok: false,
      code: 'AUTHORIZATION_DENIED',
      message: 'Not permitted to delete this channel',
    };
  }
  const result = ctx.channels.deleteNode({
    nodeId: message.nodeId,
    actorEffectiveGroupIds: effectiveGroupIds,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }
  return {
    ok: true,
    nextState: 'ready',
    actions: [
      channelAck(message.id),
      catalogRefreshAction(ctx),
      ...revalidateChannelMembership(message.nodeId, ctx),
    ],
  };
}

function handleChannelSetPassword(
  message: ClientChannelSetPasswordMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  const effectiveGroupIds = effectiveGroupIdsFor(identityId, ctx);
  // Security fix (T13.2 review) — see `handleChannelUpdate`'s identical precondition doc comment.
  if (!ctx.channels.getVisibleNode(message.nodeId, effectiveGroupIds)) {
    return { ok: false, code: 'CHANNEL_NOT_FOUND', message: 'Unknown channel/category' };
  }
  const authorized =
    ctx.authorization.can(identityId, 'channels.manage') ||
    ctx.channels.hasManageRights(message.nodeId, effectiveGroupIds);
  if (!authorized) {
    return {
      ok: false,
      code: 'AUTHORIZATION_DENIED',
      message: 'Not permitted to manage this channel',
    };
  }
  const result = ctx.channels.setPassword({
    nodeId: message.nodeId,
    password: message.password,
    actorEffectiveGroupIds: effectiveGroupIds,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }
  return {
    ok: true,
    nextState: 'ready',
    actions: [channelAck(message.id), catalogRefreshAction(ctx)],
  };
}

function handleChannelRemovePassword(
  message: ClientChannelRemovePasswordMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  const effectiveGroupIds = effectiveGroupIdsFor(identityId, ctx);
  // Security fix (T13.2 review) — see `handleChannelUpdate`'s identical precondition doc comment.
  if (!ctx.channels.getVisibleNode(message.nodeId, effectiveGroupIds)) {
    return { ok: false, code: 'CHANNEL_NOT_FOUND', message: 'Unknown channel/category' };
  }
  const authorized =
    ctx.authorization.can(identityId, 'channels.manage') ||
    ctx.channels.hasManageRights(message.nodeId, effectiveGroupIds);
  if (!authorized) {
    return {
      ok: false,
      code: 'AUTHORIZATION_DENIED',
      message: 'Not permitted to manage this channel',
    };
  }
  const result = ctx.channels.removePassword({
    nodeId: message.nodeId,
    actorEffectiveGroupIds: effectiveGroupIds,
  });
  if (!result.ok) {
    return { ok: false, code: result.code, message: result.message };
  }
  return {
    ok: true,
    nextState: 'ready',
    actions: [channelAck(message.id), catalogRefreshAction(ctx)],
  };
}

function handleChannelGetEditableNode(
  message: ClientChannelGetEditableNodeMessage,
  ctx: HandlerContext,
): RouteResult {
  const identityId = requireIdentityId(ctx);
  const effectiveGroupIds = effectiveGroupIdsFor(identityId, ctx);
  // Security fix (T13.2 review) — see `handleChannelUpdate`'s identical precondition doc comment.
  // Especially important here: this is the one handler that returns the *full* admin detail view
  // (name, parentId, userLimit, hasPassword, and all three group-id lists) for a node — exactly the
  // content this task's privacy guarantee promises a hidden node never leaks.
  if (!ctx.channels.getVisibleNode(message.nodeId, effectiveGroupIds)) {
    return { ok: false, code: 'CHANNEL_NOT_FOUND', message: 'Unknown channel/category' };
  }
  const authorized =
    ctx.authorization.can(identityId, 'channels.manage') ||
    ctx.channels.hasManageRights(message.nodeId, effectiveGroupIds);
  if (!authorized) {
    return {
      ok: false,
      code: 'AUTHORIZATION_DENIED',
      message: 'Not permitted to view this channel',
    };
  }
  const node = ctx.channels.getEditableNode(message.nodeId);
  if (!node) {
    return { ok: false, code: 'CHANNEL_NOT_FOUND', message: 'Unknown channel/category' };
  }
  return {
    ok: true,
    nextState: 'ready',
    actions: [reply({ type: 'server:channel-editable-node', id: message.id, node })],
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
    case 'client:channel-create-category':
      return handleChannelCreateCategory(message, ctx);
    case 'client:channel-create-voice':
      return handleChannelCreateVoice(message, ctx);
    case 'client:channel-update':
      return handleChannelUpdate(message, ctx);
    case 'client:channel-move':
      return handleChannelMove(message, ctx);
    case 'client:channel-reorder':
      return handleChannelReorder(message, ctx);
    case 'client:channel-delete':
      return handleChannelDelete(message, ctx);
    case 'client:channel-set-password':
      return handleChannelSetPassword(message, ctx);
    case 'client:channel-remove-password':
      return handleChannelRemovePassword(message, ctx);
    case 'client:channel-get-editable-node':
      return handleChannelGetEditableNode(message, ctx);
    case 'client:profile-set-avatar':
      return handleProfileSetAvatar(message, ctx);
    case 'client:profile-clear-avatar':
      return handleProfileClearAvatar(message, ctx);
    case 'client:profile-set-status':
      return handleProfileSetStatus(message, ctx);
    case 'client:profile-clear-member-status':
      return handleProfileClearMemberStatus(message, ctx);
    case 'client:profile-set-presence':
      return handleProfileSetPresence(message, ctx);
    case 'client:profile-request-avatar':
      return handleProfileRequestAvatar(message, ctx);
  }
}
