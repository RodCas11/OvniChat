// Shared raw-WebSocket protocol client helpers for T13.2's channel-administration E2E scripts
// (`e2e-channel-admin-smoke.mjs`, `e2e-channel-hidden-smoke.mjs`, `e2e-channel-temporary-smoke.mjs`,
// `e2e-reconnect-channel-smoke.mjs`). Mirrors `e2e-authorization.mjs`'s own inline `connectAdmin`/
// `nextMessage`/`nextMessages` helpers (T9's established precedent for "drive the admin side of an
// E2E flow with a lightweight raw WebSocket client, not a second Electron instance, when the
// protocol surface already has deep integration/unit coverage elsewhere") and
// `tests/dedicated-server/channels-integration.test.ts`'s own `waitForMessageOfType(s)` helper —
// extracted here, rather than re-inlined a third/fourth time, specifically because T13.2's own
// integration tests already document the load-bearing reason this is needed: every mutating
// `client:channel-*`/`client:authorization-grant-group`/`-revoke-group` handler also fans out a
// personalized `voice:catalog` (and sometimes `server:authorization-state`) broadcast alongside its
// direct reply, so a plain "the next message is the reply I asked for" assumption is unsafe for any
// of these scripts, not just one.
//
// Every message ever received on a given `ws` is buffered (see `ensureBuffer`/`bufferLength`) rather
// than only ever matched against transient, per-call listeners — found to be load-bearing while
// building this file's first version: a message that arrives in the gap between two `await` points
// (e.g. between `becomeServerAdmin` returning and this caller's own next `waitForMessageOfType`
// call), when no per-call listener was yet attached to observe it, would otherwise be silently lost
// forever. Every wait helper here checks this buffer first, then subscribes for future arrivals —
// this is the same class of bug `e2e-authorization.mjs`'s own doc comment describes ("racing once()
// listeners"), fixed here structurally rather than by careful call-ordering.
//
// `since` (an index into that buffer, from `bufferLength(ws)`) lets a caller explicitly ask for only
// a message that arrives *after* a captured point in time — needed anywhere a script waits for a
// *fresh* push of a message type it may have already received earlier (e.g. "wait for the next
// voice:catalog, not the stale one from connect time"). Defaults to `0` (search the whole history
// first) — the correct default for "did this connection ever receive one" checks, e.g. draining a
// connection's very first catalog.

import { generateIdentityKeyPair, signWithIdentityKey } from '@disco-voador/identity';
import { buildIdentityAuthPayload, CURRENT_PROTOCOL_VERSION } from '@disco-voador/protocol';
import { WebSocket } from 'ws';

function ensureBuffer(ws) {
  if (ws.__deskBuffer) return;
  ws.__deskBuffer = [];
  ws.__deskWaiters = [];
  ws.on('message', (data) => {
    let parsed;
    try {
      parsed = JSON.parse(data.toString('utf8'));
    } catch {
      return; // never expected in practice -- every server message here is JSON
    }
    ws.__deskBuffer.push(parsed);
    const index = ws.__deskBuffer.length - 1;
    for (const waiter of [...ws.__deskWaiters]) {
      if (index < waiter.since) continue;
      if (waiter.predicate(parsed)) {
        const i = ws.__deskWaiters.indexOf(waiter);
        if (i !== -1) ws.__deskWaiters.splice(i, 1);
        waiter.resolve(parsed);
      }
    }
  });
}

/** The number of messages received on `ws` so far — capture this immediately before an action whose
 * resulting message(s) must be observed fresh (never a stale, already-buffered one), then pass it as
 * `since` to a later wait call. */
export function bufferLength(ws) {
  ensureBuffer(ws);
  return ws.__deskBuffer.length;
}

/** The core primitive every other wait helper in this file is built on: checks the buffer (from
 * index `since` onward) for an already-arrived match first, then waits for a future one. */
export function waitForMessage(ws, predicate, description, options = {}) {
  ensureBuffer(ws);
  const since = options.since ?? 0;
  const timeoutMs = options.timeoutMs ?? 10_000;

  for (let i = since; i < ws.__deskBuffer.length; i += 1) {
    if (predicate(ws.__deskBuffer[i])) return Promise.resolve(ws.__deskBuffer[i]);
  }

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const i = ws.__deskWaiters.findIndex((w) => w.resolve === resolve);
      if (i !== -1) ws.__deskWaiters.splice(i, 1);
      reject(new Error(`Timed out waiting for: ${description}`));
    }, timeoutMs);
    ws.__deskWaiters.push({
      since,
      predicate,
      resolve: (msg) => {
        clearTimeout(timer);
        resolve(msg);
      },
    });
  });
}

/** Resolves once a message whose `type` is one of `types` arrives, silently ignoring any other
 * message type first (a personalized catalog refresh, an auth-state push, etc.) — see this file's
 * own top doc comment for why this, not a plain "next message", is the safe primitive here. */
export function waitForMessageOfTypes(ws, types, timeoutMs = 10_000, since = 0) {
  return waitForMessage(ws, (m) => types.includes(m.type), `one of [${types.join(', ')}]`, {
    timeoutMs,
    since,
  });
}

export function waitForMessageOfType(ws, type, timeoutMs = 10_000, since = 0) {
  return waitForMessageOfTypes(ws, [type], timeoutMs, since);
}

/** Opens a WebSocket and completes T7's identity handshake (hello -> challenge -> identity-proof),
 * returning once `server:hello` has arrived — this connection is now `ready`, but holds no
 * server-local authorization beyond whatever a fresh Guest gets by default (see
 * `docs/architecture/SERVER_AUTHORIZATION.md`). Every message this connection sends/receives for
 * the rest of its life is available on the returned `ws` for the caller to drive directly — this
 * helper does not wrap the whole protocol, only the one-time handshake every other message assumes
 * already happened.
 */
export async function connectAndAuthenticate(url, nickname, existingKeyPair) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  ensureBuffer(ws);

  // `existingKeyPair`, when given, reconnects as the SAME persistent identity a previous
  // connection already established (e.g. across a Dedicated Server restart) — `deriveIdentityId`
  // is a pure function of the public key, so any group memberships the server already granted this
  // identity (persisted server-side, independent of any one connection) apply immediately again,
  // with no need to re-redeem a bootstrap/invite token a second time.
  const keyPair = existingKeyPair ?? generateIdentityKeyPair();
  const challengePromise = waitForMessageOfType(ws, 'server:identity-challenge');
  ws.send(
    JSON.stringify({
      type: 'client:hello',
      id: 'hello-1',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      client: { name: 'e2e-channel-admin', version: '0.0.0' },
      nickname,
      publicKey: keyPair.publicKey,
    }),
  );
  const challenge = await challengePromise;

  const payload = buildIdentityAuthPayload({
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    connectionId: challenge.connectionId,
    nonce: challenge.nonce,
    expiresAt: challenge.expiresAt,
    publicKey: keyPair.publicKey,
    nickname,
  });
  const signature = signWithIdentityKey(keyPair.privateKey, keyPair.publicKey, payload);

  const helloPromise = waitForMessageOfType(ws, 'server:hello');
  ws.send(JSON.stringify({ type: 'client:identity-proof', id: 'proof-1', signature }));
  const hello = await helloPromise;

  return { ws, keyPair, identityId: hello.identityId };
}

/** Redeems `bootstrapToken` on an already-authenticated connection, granting it `server-admin`. */
export async function becomeServerAdmin(ws, bootstrapToken) {
  const since = bufferLength(ws);
  const redeemedPromise = waitForMessageOfType(
    ws,
    'server:authorization-token-redeemed',
    10_000,
    since,
  );
  ws.send(
    JSON.stringify({
      type: 'client:authorization-redeem-token',
      id: `redeem-bootstrap-${String(Date.now())}`,
      token: bootstrapToken,
    }),
  );
  const redeemed = await redeemedPromise;
  if (redeemed.group.groupId !== 'server-admin') {
    throw new Error(`Bootstrap redemption did not grant server-admin: ${JSON.stringify(redeemed)}`);
  }
}

/** Convenience wrapper: connect, authenticate, redeem the bootstrap token, then join the default
 * "general" voice channel — mirrors `e2e-authorization.mjs`'s own `connectAdmin` precedent exactly:
 * `voice:participant-joined` is only ever broadcast to *members of that same channel*, never
 * server-wide, so an admin identity that joins nothing itself can never observe another
 * connection's join at all — this is required for any later `client:authorization-grant-group`/
 * `-ban`/`-kick` call, all of which resolve their `targetParticipantId` via
 * `VoiceRegistry.findByParticipantId` (an *online* participant), never a client-supplied identity. */
export async function connectAdmin(url, nickname, bootstrapToken) {
  const { ws, keyPair, identityId } = await connectAndAuthenticate(url, nickname);
  await becomeServerAdmin(ws, bootstrapToken);
  await joinVoice(ws, 'general', nickname);
  return { ws, keyPair, identityId };
}

/** Joins a voice channel on an already-authenticated connection, returning the full
 * `server:voice-joined` message (participantId, current roster). Throws (with `.code` set) on
 * `server:error` — e.g. `CHANNEL_ACCESS_DENIED`/`CHANNEL_PASSWORD_REQUIRED`/`CHANNEL_FULL`. */
export async function joinVoice(ws, channelId, displayName, password) {
  const id = freshId('join');
  return sendRequest(
    ws,
    { type: 'voice:join', id, channelId, displayName, ...(password ? { password } : {}) },
    ['voice:joined'],
  );
}

export async function leaveVoice(ws) {
  const id = freshId('leave');
  return sendRequest(ws, { type: 'voice:leave', id }, ['voice:left']);
}

/**
 * Sends `client:chat-send` and waits for its confirmation. Deliberately NOT implemented via
 * `sendRequest`: per `packages/protocol/src/messages/chat.ts`'s own doc comment, `server:chat-
 * message`'s `id` is a fresh, server-generated broadcast id, never a reply that echoes the
 * request's own `id` (the sender receives the exact same broadcast every other recipient does —
 * that broadcast IS the send-succeeded confirmation, there is no separate ack) — a generic
 * `id`-echo-matching helper can never observe it. Matches instead on the message's own scope/
 * channelId/body actually round-tripping, which is a strictly stronger proof than an opaque ack
 * would have been anyway. Still throws (with `.code` set) on a real `server:error` correlated via
 * `replyTo` (e.g. `NOT_IN_VOICE_CHANNEL`/`AUTHORIZATION_DENIED`/`CHANNEL_NOT_FOUND`).
 */
export async function sendChatMessage(ws, scope, channelId, body) {
  const id = freshId('chat-send');
  const since = bufferLength(ws);
  const message = {
    type: 'client:chat-send',
    id,
    scope,
    ...(channelId !== undefined ? { channelId } : {}),
    body,
  };
  const replyPromise = waitForMessage(
    ws,
    (candidate) =>
      (candidate.type === 'server:chat-message' &&
        candidate.message.scope === scope &&
        candidate.message.channelId === channelId &&
        candidate.message.body === body) ||
      (candidate.type === 'server:error' && candidate.replyTo === id),
    `confirmation of client:chat-send (id=${id}, body=${body})`,
    { since },
  );
  ws.send(JSON.stringify(message));
  const reply = await replyPromise;
  if (reply.type === 'server:error') {
    const error = new Error(`client:chat-send rejected: ${reply.code} — ${reply.message}`);
    error.code = reply.code;
    throw error;
  }
  return reply;
}

/** Sends a `client:channel-*`/`client:authorization-*` request and waits for either its direct reply
 * (matched by `replyTo === id` for `server:error`, or the given `okTypes` for a success reply that
 * itself echoes the request's own `id`) — throws with the server's own message on `server:error`.
 * Centralizes the "every T13.2 mutation also fans out a catalog refresh" hazard described in this
 * file's own top doc comment: this never trusts "the next message" naively.
 */
export async function sendRequest(ws, message, okTypes) {
  const since = bufferLength(ws);
  const replyPromise = waitForMessage(
    ws,
    (candidate) =>
      (okTypes.includes(candidate.type) && candidate.id === message.id) ||
      (candidate.type === 'server:error' && candidate.replyTo === message.id),
    `reply to ${message.type} (id=${message.id})`,
    { since },
  );
  ws.send(JSON.stringify(message));
  const reply = await replyPromise;
  if (reply.type === 'server:error') {
    const error = new Error(`${message.type} rejected: ${reply.code} — ${reply.message}`);
    error.code = reply.code;
    throw error;
  }
  return reply;
}

let nextRequestId = 0;
export function freshId(prefix) {
  nextRequestId += 1;
  return `${prefix}-${String(Date.now())}-${String(nextRequestId)}`;
}
