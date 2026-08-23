import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  generateIdentityKeyPair,
  signWithIdentityKey,
  type IdentityKeyPair,
} from '@disco-voador/identity';
import { buildIdentityAuthPayload, CURRENT_PROTOCOL_VERSION } from '@disco-voador/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  createDedicatedServer,
  type DedicatedServerHandle,
} from '../../services/dedicated-server/src/create-dedicated-server.js';
import type { DedicatedServerConfig } from '../../services/dedicated-server/src/config.js';

/**
 * Real-network integration tests for the Dedicated Server product boundary (T8 Section 49/53):
 * every server here binds a real ephemeral localhost port and is driven by a real `ws`
 * `WebSocket` client — no mocked transport, matching the same philosophy
 * `tests/realtime/integration.test.ts` established for T2.
 */

function testConfig(overrides: Partial<DedicatedServerConfig> = {}): DedicatedServerConfig {
  return {
    name: 'Test Server',
    realtime: {
      host: '127.0.0.1',
      port: 0,
      maxConnections: 100,
      maxMessageBytes: 16 * 1024,
      handshakeTimeoutMs: 2_000,
      identityChallengeTtlMs: 2_000,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      rateLimit: { maxMessages: 100, windowMs: 10_000 },
      chatSendRateLimit: { maxMessages: 100, windowMs: 10_000 },
      chatHistoryRateLimit: { maxMessages: 100, windowMs: 10_000 },
      channelPasswordRateLimit: { maxMessages: 100, windowMs: 10_000 },
      profileMutationRateLimit: { maxMessages: 100, windowMs: 10_000 },
      avatarFetchRateLimit: { maxMessages: 100, windowMs: 10_000 },
      logLevel: 'error',
    },
    voiceChannels: [{ channelId: 'general', name: 'General' }],
    // T9: ':memory:' keeps these T8-era isolation/lifecycle tests fast and disk-free — they are
    // not about authorization persistence specifically (see authorization-store.test.ts for that).
    accessMode: 'open',
    dataDir: ':memory:',
    configFilePath: '(test)',
    configFileFound: false,
    ...overrides,
  };
}

function connect(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessages(
  ws: WebSocket,
  count: number,
  timeoutMs = 2000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const collected: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      ws.off('message', handleMessage);
      reject(new Error(`Timed out waiting for ${String(count)} messages`));
    }, timeoutMs);

    function handleMessage(data: Buffer): void {
      collected.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
      if (collected.length >= count) {
        clearTimeout(timer);
        ws.off('message', handleMessage);
        resolve(collected);
      }
    }

    ws.on('message', handleMessage);
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 2000): Promise<Record<string, unknown>> {
  return nextMessages(ws, 1, timeoutMs).then((messages) => messages[0] as Record<string, unknown>);
}

/** Drives the full hello -> challenge -> proof -> [hello, catalog] flow using exactly one
 * `nextMessage`/`nextMessages` listener active at a time — a second listener racing an already-
 * pending one would incorrectly resolve to whichever message arrives *first*, satisfying both
 * (each `message` listener fires on every emit, not one-per-call), not the specific message each
 * caller actually wants. Returns both `server:hello` and `voice:catalog` so callers never need a
 * separate racing listener of their own. */
async function handshake(
  ws: WebSocket,
  nickname = 'Tester',
  keyPair: IdentityKeyPair = generateIdentityKeyPair(),
): Promise<[Record<string, unknown>, Record<string, unknown>]> {
  const challengeReceived = nextMessage(ws);
  ws.send(
    JSON.stringify({
      type: 'client:hello',
      id: 'hello-1',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      client: { name: 'integration-test', version: '0.0.0' },
      nickname,
      publicKey: keyPair.publicKey,
    }),
  );
  const challenge = await challengeReceived;

  const payload = buildIdentityAuthPayload({
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    connectionId: challenge.connectionId as string,
    nonce: challenge.nonce as string,
    expiresAt: challenge.expiresAt as number,
    publicKey: keyPair.publicKey,
    nickname,
  });
  const signature = signWithIdentityKey(keyPair.privateKey, keyPair.publicKey, payload);

  // server:hello, server:authorization-state, voice:catalog, server:presence-snapshot,
  // server:profile-self-updated (T13.3's proactive push of this identity's own real persisted
  // profile) — all five must be drained here even though only two are returned, since the server
  // sends them back-to-back in one synchronous loop that can arrive as a single TCP burst; leaving
  // the fifth undrained risks it racing past whatever listener a caller attaches next.
  const replies = nextMessages(ws, 5);
  ws.send(JSON.stringify({ type: 'client:identity-proof', id: 'proof-1', signature }));
  const [serverHello, , catalog] = await replies;
  if (!serverHello || !catalog) throw new Error('handshake did not receive both messages');
  return [serverHello, catalog];
}

describe('Dedicated Server — real network integration', () => {
  const servers: DedicatedServerHandle[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.terminate();
    }
    for (const server of servers.splice(0)) {
      await server.stop();
    }
  });

  function track<T extends DedicatedServerHandle | WebSocket>(value: T): T {
    if (value instanceof WebSocket) sockets.push(value);
    else servers.push(value);
    return value;
  }

  it('starts, authenticates a real client, and delivers configured server name/capabilities/channels', async () => {
    const server = track(
      createDedicatedServer(
        testConfig({ name: 'My Server', voiceChannels: [{ channelId: 'lobby', name: 'Lobby' }] }),
      ),
    );
    const address = await server.start();
    const ws = track(await connect(`ws://${address.host}:${String(address.port)}`));

    const [serverHello, catalog] = await handshake(ws);

    expect(serverHello.serverName).toBe('My Server');
    expect(serverHello.serverCapabilities).toEqual(
      expect.arrayContaining(['voice', 'camera', 'screen-video', 'screen-audio']),
    );
    expect(typeof serverHello.identityId).toBe('string');
    expect(catalog).toMatchObject({
      type: 'voice:catalog',
      nodes: [{ nodeId: 'lobby', name: 'Lobby' }],
    });
  });

  it('two independent server instances are fully isolated: distinct metadata, no cross-talk', async () => {
    const serverA = track(
      createDedicatedServer(
        testConfig({
          name: 'Server A',
          voiceChannels: [{ channelId: 'a-channel', name: 'A Channel' }],
        }),
      ),
    );
    const serverB = track(
      createDedicatedServer(
        testConfig({
          name: 'Server B',
          voiceChannels: [{ channelId: 'b-channel', name: 'B Channel' }],
        }),
      ),
    );
    const addressA = await serverA.start();
    const addressB = await serverB.start();

    const wsA = track(await connect(`ws://${addressA.host}:${String(addressA.port)}`));
    const wsB = track(await connect(`ws://${addressB.host}:${String(addressB.port)}`));

    const [[helloA, catalogA], [helloB, catalogB]] = await Promise.all([
      handshake(wsA),
      handshake(wsB),
    ]);

    expect(helloA.serverName).toBe('Server A');
    expect(helloB.serverName).toBe('Server B');
    expect(helloA.connectionId).not.toBe(helloB.connectionId);
    expect((catalogA.nodes as unknown[])[0]).toMatchObject({ nodeId: 'a-channel' });
    expect((catalogB.nodes as unknown[])[0]).toMatchObject({ nodeId: 'b-channel' });

    // A participant joining Server A's channel must never be visible/reachable from Server B.
    const joinedA = nextMessage(wsA);
    wsA.send(
      JSON.stringify({ type: 'voice:join', id: 'j1', channelId: 'a-channel', displayName: 'A' }),
    );
    await joinedA;

    const errorAtB = nextMessage(wsB);
    wsB.send(
      JSON.stringify({ type: 'voice:join', id: 'j2', channelId: 'a-channel', displayName: 'B' }),
    );
    const rejection = await errorAtB;
    expect(rejection).toMatchObject({ type: 'server:error', code: 'CHANNEL_NOT_FOUND' });

    expect(serverA.connectionCount).toBe(1);
    expect(serverB.connectionCount).toBe(1);
  });

  it('the same local identity independently authenticates to two different servers with the same identityId', async () => {
    const keyPair = generateIdentityKeyPair();
    const serverA = track(createDedicatedServer(testConfig({ name: 'Server A' })));
    const serverB = track(createDedicatedServer(testConfig({ name: 'Server B' })));
    const addressA = await serverA.start();
    const addressB = await serverB.start();

    const wsA = track(await connect(`ws://${addressA.host}:${String(addressA.port)}`));
    const wsB = track(await connect(`ws://${addressB.host}:${String(addressB.port)}`));

    const [helloA] = await handshake(wsA, 'Tester', keyPair);
    const [helloB] = await handshake(wsB, 'Tester', keyPair);

    expect(helloA.identityId).toBe(helloB.identityId);
    expect(helloA.connectionId).not.toBe(helloB.connectionId);
  });

  it('rejects a second server bound to the same already-occupied port', async () => {
    const serverA = track(createDedicatedServer(testConfig()));
    const address = await serverA.start();

    const serverB = createDedicatedServer(
      testConfig({ realtime: { ...testConfig().realtime, port: address.port } }),
    );
    await expect(serverB.start()).rejects.toThrow();
  });

  it('graceful shutdown works in-process: stop() closes connections and the port is free again', async () => {
    const server = createDedicatedServer(testConfig());
    const address = await server.start();
    const ws = track(await connect(`ws://${address.host}:${String(address.port)}`));
    await handshake(ws);
    expect(server.connectionCount).toBe(1);

    const closed = new Promise<void>((resolve) => ws.once('close', resolve));
    await server.stop();
    await closed;

    // The same port is free again — a new server can bind it, proving stop() actually released
    // the OS-level listener, not merely stopped tracking connections.
    const secondServer = track(
      createDedicatedServer(
        testConfig({ realtime: { ...testConfig().realtime, port: address.port } }),
      ),
    );
    const secondAddress = await secondServer.start();
    expect(secondAddress.port).toBe(address.port);
  });

  it('server-full behavior is deterministic and client-visible', async () => {
    const server = track(
      createDedicatedServer(
        testConfig({ realtime: { ...testConfig().realtime, maxConnections: 1 } }),
      ),
    );
    const address = await server.start();

    const first = track(await connect(`ws://${address.host}:${String(address.port)}`));
    await handshake(first);
    expect(server.connectionCount).toBe(1);

    const second = new WebSocket(`ws://${address.host}:${String(address.port)}`);
    track(second);
    const errorMessage = nextMessage(second);
    const closed = new Promise<{ code: number }>((resolve) => {
      second.once('close', (code) => resolve({ code }));
    });

    expect(await errorMessage).toMatchObject({ type: 'server:error', code: 'SERVER_AT_CAPACITY' });
    expect((await closed).code).toBe(4503);
    expect(server.connectionCount).toBe(1);
  });
});

// --- T9 server-local authorization (real network) ------------------------------------------------

function nextClose(ws: WebSocket, timeoutMs = 2000): Promise<{ code: number; reason: string }> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for close')), timeoutMs);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString('utf8') });
    });
  });
}

/** Like `handshake()`, but also returns `server:authorization-state` and accepts an optional
 * `serverToken` for invite-only admission — kept separate from `handshake()` so the many existing
 * T8 tests above stay untouched by T9's additional message. */
async function handshakeWithAuthState(
  ws: WebSocket,
  nickname = 'Tester',
  keyPair: IdentityKeyPair = generateIdentityKeyPair(),
  serverToken?: string,
): Promise<[Record<string, unknown>, Record<string, unknown>, Record<string, unknown>]> {
  const challengeReceived = nextMessage(ws);
  ws.send(
    JSON.stringify({
      type: 'client:hello',
      id: 'hello-1',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      client: { name: 'integration-test', version: '0.0.0' },
      nickname,
      publicKey: keyPair.publicKey,
      ...(serverToken ? { serverToken } : {}),
    }),
  );
  const challenge = await challengeReceived;

  const payload = buildIdentityAuthPayload({
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    connectionId: challenge.connectionId as string,
    nonce: challenge.nonce as string,
    expiresAt: challenge.expiresAt as number,
    publicKey: keyPair.publicKey,
    nickname,
  });
  const signature = signWithIdentityKey(keyPair.privateKey, keyPair.publicKey, payload);

  // server:hello, server:authorization-state, voice:catalog, server:presence-snapshot,
  // server:profile-self-updated (T13.3's proactive push of this identity's own real persisted
  // profile) — all five must be drained here even though only three are returned, since the server
  // sends them back-to-back in one synchronous loop that can arrive as a single TCP burst; leaving
  // the remaining two undrained risks them racing past whatever a caller listens for next.
  const replies = nextMessages(ws, 5);
  ws.send(JSON.stringify({ type: 'client:identity-proof', id: 'proof-1', signature }));
  const [serverHello, authState, catalog] = await replies;
  if (!serverHello || !authState || !catalog) {
    throw new Error('handshake did not receive all three messages');
  }
  return [serverHello, authState, catalog];
}

describe('Dedicated Server — T9 authorization (real network)', () => {
  const servers: DedicatedServerHandle[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.terminate();
    }
    for (const server of servers.splice(0)) {
      await server.stop();
    }
  });

  function track<T extends DedicatedServerHandle | WebSocket>(value: T): T {
    if (value instanceof WebSocket) sockets.push(value);
    else servers.push(value);
    return value;
  }

  async function startServer(
    overrides: Partial<DedicatedServerConfig> = {},
  ): Promise<{ server: DedicatedServerHandle; url: string }> {
    const server = track(createDedicatedServer(testConfig(overrides)));
    const address = await server.start();
    return { server, url: `ws://${address.host}:${String(address.port)}` };
  }

  it('a fresh server exposes a one-time bootstrap token, redeemable over the wire to become Server Admin', async () => {
    const { server, url } = await startServer();
    expect(server.bootstrapToken).toMatch(/^DV-ADMIN-/u);

    const ws = track(await connect(url));
    const [, authState] = await handshakeWithAuthState(ws);
    expect(authState).toMatchObject({ groups: [{ groupId: 'guest' }] });

    const redeemed = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: 'client:authorization-redeem-token',
        id: 'redeem-1',
        token: server.bootstrapToken,
      }),
    );
    expect(await redeemed).toMatchObject({
      type: 'server:authorization-token-redeemed',
      group: { groupId: 'server-admin' },
    });
  });

  it('invite-only: connecting with no token is rejected with INVITE_REQUIRED and the connection closes', async () => {
    const { url } = await startServer({ accessMode: 'invite-only' });
    const ws = track(await connect(url));

    const keyPair = generateIdentityKeyPair();
    const challengeReceived = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: 'client:hello',
        id: 'hello-1',
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        client: { name: 'integration-test', version: '0.0.0' },
        nickname: 'Nobody',
        publicKey: keyPair.publicKey,
      }),
    );
    const challenge = await challengeReceived;
    const payload = buildIdentityAuthPayload({
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      connectionId: challenge.connectionId as string,
      nonce: challenge.nonce as string,
      expiresAt: challenge.expiresAt as number,
      publicKey: keyPair.publicKey,
      nickname: 'Nobody',
    });
    const signature = signWithIdentityKey(keyPair.privateKey, keyPair.publicKey, payload);

    const errorReceived = nextMessage(ws);
    const closed = nextClose(ws);
    ws.send(JSON.stringify({ type: 'client:identity-proof', id: 'proof-1', signature }));

    expect(await errorReceived).toMatchObject({ type: 'server:error', code: 'INVITE_REQUIRED' });
    expect((await closed).code).toBe(4420);
  });

  it('invite-only: a valid invite token in client:hello admits and grants Member', async () => {
    const { server, url } = await startServer({ accessMode: 'invite-only' });

    // On a fresh invite-only server the bootstrap token doubles as the operator's own admission
    // credential (T9's own lockout-avoidance fix) — supplied directly in client:hello, since a
    // plain Guest connection attempt with no token would itself be rejected INVITE_REQUIRED before
    // ever reaching `ready` to redeem anything.
    const adminWs = track(await connect(url));
    const [, adminAuthState] = await handshakeWithAuthState(
      adminWs,
      'Admin',
      generateIdentityKeyPair(),
      server.bootstrapToken,
    );
    expect(adminAuthState).toMatchObject({ groups: [{ groupId: 'server-admin' }] });

    const inviteCreated = nextMessage(adminWs);
    adminWs.send(
      JSON.stringify({
        type: 'client:authorization-create-token',
        id: 'create-invite-1',
        tokenKind: 'invite',
        groupId: 'member',
      }),
    );
    const inviteMessage = (await inviteCreated) as { token: string };
    expect(inviteMessage.token).toMatch(/^DV-INVITE-/u);

    const memberWs = track(await connect(url));
    const [, memberAuthState] = await handshakeWithAuthState(
      memberWs,
      'NewMember',
      generateIdentityKeyPair(),
      inviteMessage.token,
    );
    expect(memberAuthState).toMatchObject({ groups: [{ groupId: 'member' }] });
  });

  it('an administrator can ban an online participant, whose connection is closed immediately', async () => {
    const { server, url } = await startServer();

    const adminWs = track(await connect(url));
    await handshakeWithAuthState(adminWs, 'Admin');
    // Redeeming a token also triggers a fresh server:authorization-state push (see
    // protocol-handlers.ts's handleAuthorizationRedeemToken) — both replies must be drained here,
    // or the leftover authorization-state message would desync the next nextMessage() call below
    // (the "racing once()/undrained-reply listeners" bug class this project has hit before; see
    // apps/desktop/scripts/e2e-authorization.mjs's own connectAdmin() for the same fix).
    const adminRedeemed = nextMessages(adminWs, 2);
    adminWs.send(
      JSON.stringify({
        type: 'client:authorization-redeem-token',
        id: 'redeem-1',
        token: server.bootstrapToken,
      }),
    );
    await adminRedeemed;
    const adminJoined = nextMessage(adminWs);
    adminWs.send(
      JSON.stringify({ type: 'voice:join', id: 'j1', channelId: 'general', displayName: 'Admin' }),
    );
    await adminJoined;

    const targetKeyPair = generateIdentityKeyPair();
    const targetWs = track(await connect(url));
    // Admin is already `ready`, so T13.3 presence delivers it a live `server:presence-updated` the
    // moment Target's handshake completes (a 0->1 online transition) — drained here before it can
    // be mistaken for the voice:participant-joined broadcast below.
    const adminNotifiedOfTargetOnline = nextMessage(adminWs);
    await handshakeWithAuthState(targetWs, 'Target', targetKeyPair);
    expect(await adminNotifiedOfTargetOnline).toMatchObject({ type: 'server:presence-updated' });
    // The admin, already in the channel, will receive a voice:participant-joined broadcast the
    // moment Target joins — drain it explicitly so it can never be mistaken for the ban ack below.
    const adminNotifiedOfTarget = nextMessage(adminWs);
    const targetJoined = nextMessage(targetWs);
    targetWs.send(
      JSON.stringify({ type: 'voice:join', id: 'j2', channelId: 'general', displayName: 'Target' }),
    );
    const targetJoinedMessage = (await targetJoined) as { participantId: string };
    expect(await adminNotifiedOfTarget).toMatchObject({ type: 'voice:participant-joined' });

    const banAck = nextMessage(adminWs);
    const targetClosed = nextClose(targetWs);
    adminWs.send(
      JSON.stringify({
        type: 'client:authorization-ban',
        id: 'ban-1',
        targetParticipantId: targetJoinedMessage.participantId,
      }),
    );

    expect(await banAck).toMatchObject({ type: 'server:authorization-ack', id: 'ban-1' });
    expect((await targetClosed).code).toBe(4421);

    // The same banned identity reconnecting is rejected before it ever reaches ready.
    const reconnectWs = track(await connect(url));
    const reconnectChallenge = nextMessage(reconnectWs);
    reconnectWs.send(
      JSON.stringify({
        type: 'client:hello',
        id: 'hello-reconnect',
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        client: { name: 'integration-test', version: '0.0.0' },
        nickname: 'Target',
        publicKey: targetKeyPair.publicKey,
      }),
    );
    const challenge = await reconnectChallenge;
    const payload = buildIdentityAuthPayload({
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      connectionId: challenge.connectionId as string,
      nonce: challenge.nonce as string,
      expiresAt: challenge.expiresAt as number,
      publicKey: targetKeyPair.publicKey,
      nickname: 'Target',
    });
    const signature = signWithIdentityKey(
      targetKeyPair.privateKey,
      targetKeyPair.publicKey,
      payload,
    );
    const rejection = nextMessage(reconnectWs);
    const rejectionClosed = nextClose(reconnectWs);
    reconnectWs.send(
      JSON.stringify({ type: 'client:identity-proof', id: 'proof-reconnect', signature }),
    );
    expect(await rejection).toMatchObject({ type: 'server:error', code: 'BANNED' });
    expect((await rejectionClosed).code).toBe(4421);

    // A restart does not un-ban — the same server instance still reports it, and the admin
    // connection (never banned) remains the only successfully ready connection throughout.
    expect(server.connectionCount).toBe(1);
  });

  it('a Guest cannot perform an admin-only action (server-side enforcement, not just hidden UI)', async () => {
    const { url } = await startServer();
    const ws = track(await connect(url));
    await handshakeWithAuthState(ws, 'JustAGuest');

    const rejection = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: 'client:authorization-create-group',
        id: 'create-1',
        name: 'Sneaky',
        permissions: ['server.manage'],
      }),
    );
    expect(await rejection).toMatchObject({
      type: 'server:error',
      code: 'AUTHORIZATION_DENIED',
    });
    // Non-fatal — the connection must stay open after a denied authorization attempt.
    const pong = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'client:ping', id: 'ping-1' }));
    expect(await pong).toEqual({ type: 'server:pong', id: 'ping-1' });
  });

  it('revoking an invite-only identity down to no remaining admission basis force-closes its live connection (T9 Section 63)', async () => {
    const { server, url } = await startServer({ accessMode: 'invite-only' });

    const adminWs = track(await connect(url));
    await handshakeWithAuthState(
      adminWs,
      'Admin',
      generateIdentityKeyPair(),
      server.bootstrapToken,
    );
    const adminJoined = nextMessage(adminWs);
    adminWs.send(
      JSON.stringify({ type: 'voice:join', id: 'j1', channelId: 'general', displayName: 'Admin' }),
    );
    await adminJoined;

    const inviteCreated = nextMessage(adminWs);
    adminWs.send(
      JSON.stringify({
        type: 'client:authorization-create-token',
        id: 'create-invite-1',
        tokenKind: 'invite',
        groupId: 'member',
      }),
    );
    const inviteMessage = (await inviteCreated) as { token: string };

    const targetWs = track(await connect(url));
    const adminNotifiedOfTargetOnline = nextMessage(adminWs);
    await handshakeWithAuthState(
      targetWs,
      'Target',
      generateIdentityKeyPair(),
      inviteMessage.token,
    );
    // Admin is already `ready`, so T13.3 presence delivers it a live `server:presence-updated` the
    // moment Target's handshake completes (a 0->1 online transition) — drained here first.
    expect(await adminNotifiedOfTargetOnline).toMatchObject({ type: 'server:presence-updated' });
    const adminNotifiedOfTarget = nextMessage(adminWs);
    const targetJoined = nextMessage(targetWs);
    targetWs.send(
      JSON.stringify({ type: 'voice:join', id: 'j2', channelId: 'general', displayName: 'Target' }),
    );
    const targetJoinedMessage = (await targetJoined) as { participantId: string };
    const targetParticipantJoined = (await adminNotifiedOfTarget) as {
      participant: { participantId: string };
    };
    expect(targetParticipantJoined.participant.participantId).toBe(
      targetJoinedMessage.participantId,
    );

    // Target's only persistent membership is 'member', granted by the invite just redeemed. Once
    // it is revoked, an invite-only identity with zero remaining memberships has no admission basis
    // left at all (AuthorizationStore.revokeGroup's `stillAdmitted: false` — see
    // docs/architecture/SERVER_AUTHORIZATION.md's "Admission flow") -- the live connection must be
    // force-closed immediately, not left authorized-but-stale until it happens to reconnect.
    const revokeAck = nextMessage(adminWs);
    const targetRejection = nextMessage(targetWs);
    const targetClosed = nextClose(targetWs);
    adminWs.send(
      JSON.stringify({
        type: 'client:authorization-revoke-group',
        id: 'revoke-1',
        targetParticipantId: targetJoinedMessage.participantId,
        groupId: 'member',
      }),
    );

    expect(await revokeAck).toMatchObject({ type: 'server:authorization-ack', id: 'revoke-1' });
    // T9 follow-up (security/QA review): the force-close uses `INVITE_REQUIRED`, not
    // `AUTHORIZATION_DENIED` -- the latter has no entry in `CLOSE_CODE_BY_ERROR` (by design, for
    // the ordinary non-fatal denial case) and would fall back to a misleading `INTERNAL_ERROR` WS
    // close code. `INVITE_REQUIRED` both has a real close-code mapping (4420) and accurately
    // describes why the connection can no longer stay open: the identity has no admission basis
    // left under this server's current access rules.
    expect(await targetRejection).toMatchObject({
      type: 'server:error',
      code: 'INVITE_REQUIRED',
    });
    const closeEvent = (await targetClosed) as { code: number };
    expect(closeEvent.code).toBe(4420);
  });

  it('a bootstrap token from Server A is invalid on Server B (T9 Section 52)', async () => {
    const { server: serverA } = await startServer({ name: 'Server A' });
    const { url: urlB } = await startServer({ name: 'Server B' });

    const wsB = track(await connect(urlB));
    await handshakeWithAuthState(wsB, 'Tester');

    const rejection = nextMessage(wsB);
    wsB.send(
      JSON.stringify({
        type: 'client:authorization-redeem-token',
        id: 'redeem-1',
        token: serverA.bootstrapToken,
      }),
    );
    expect(await rejection).toMatchObject({ type: 'server:error', code: 'TOKEN_INVALID' });
  });
});

describe('Dedicated Server — T10 persistent text chat (real network)', () => {
  const servers: DedicatedServerHandle[] = [];
  const sockets: WebSocket[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.terminate();
    }
    for (const server of servers.splice(0)) {
      await server.stop();
    }
  });

  function track<T extends DedicatedServerHandle | WebSocket>(value: T): T {
    if (value instanceof WebSocket) sockets.push(value);
    else servers.push(value);
    return value;
  }

  async function startServer(
    overrides: Partial<DedicatedServerConfig> = {},
  ): Promise<{ server: DedicatedServerHandle; url: string }> {
    const server = track(createDedicatedServer(testConfig(overrides)));
    const address = await server.start();
    return { server, url: `ws://${address.host}:${String(address.port)}` };
  }

  it('server chat is persisted then broadcast live to every ready connection, including the sender', async () => {
    const { url } = await startServer();
    const wsA = track(await connect(url));
    const wsB = track(await connect(url));
    await handshakeWithAuthState(wsA, 'Rodrigo');
    // A is already `ready`, so T13.3 presence delivers it a live `server:presence-updated` the
    // moment B's handshake completes (a 0->1 online transition) — drained here first.
    const aNotifiedOfBOnline = nextMessage(wsA);
    await handshakeWithAuthState(wsB, 'Arthur');
    expect(await aNotifiedOfBOnline).toMatchObject({ type: 'server:presence-updated' });

    const receivedByA = nextMessage(wsA);
    const receivedByB = nextMessage(wsB);
    wsA.send(
      JSON.stringify({ type: 'client:chat-send', id: 'send-1', scope: 'server', body: 'bora?' }),
    );

    for (const received of [await receivedByA, await receivedByB]) {
      expect(received).toMatchObject({
        type: 'server:chat-message',
        message: { scope: 'server', senderNickname: 'Rodrigo', body: 'bora?' },
      });
    }
  });

  it('channel chat is delivered only to current members of that channel', async () => {
    const { url } = await startServer({
      voiceChannels: [{ channelId: 'general', name: 'General' }],
    });
    const wsA = track(await connect(url));
    const wsB = track(await connect(url));
    const wsC = track(await connect(url));
    await handshakeWithAuthState(wsA, 'A');
    // A is already `ready`, so T13.3 presence delivers it a live `server:presence-updated` the
    // moment B's handshake completes — drained here first (and likewise for C below).
    const aNotifiedOfBOnline = nextMessage(wsA);
    await handshakeWithAuthState(wsB, 'B');
    expect(await aNotifiedOfBOnline).toMatchObject({ type: 'server:presence-updated' });

    const notifiedOfCOnlineByA = nextMessage(wsA);
    const notifiedOfCOnlineByB = nextMessage(wsB);
    await handshakeWithAuthState(wsC, 'C');
    expect(await notifiedOfCOnlineByA).toMatchObject({ type: 'server:presence-updated' });
    expect(await notifiedOfCOnlineByB).toMatchObject({ type: 'server:presence-updated' });

    const aJoined = nextMessage(wsA);
    wsA.send(
      JSON.stringify({ type: 'voice:join', id: 'j1', channelId: 'general', displayName: 'A' }),
    );
    await aJoined;
    const bJoinedNotice = nextMessage(wsA);
    const bJoined = nextMessage(wsB);
    wsB.send(
      JSON.stringify({ type: 'voice:join', id: 'j2', channelId: 'general', displayName: 'B' }),
    );
    await bJoinedNotice;
    await bJoined;
    // C never joins any voice channel.

    const receivedByA = nextMessage(wsA);
    const receivedByB = nextMessage(wsB);
    let cReceivedAnything = false;
    wsC.once('message', () => {
      cReceivedAnything = true;
    });

    wsA.send(
      JSON.stringify({
        type: 'client:chat-send',
        id: 'send-2',
        scope: 'channel',
        channelId: 'general',
        body: 'gg',
      }),
    );

    for (const received of [await receivedByA, await receivedByB]) {
      expect(received).toMatchObject({
        type: 'server:chat-message',
        message: { scope: 'channel', channelId: 'general', body: 'gg' },
      });
    }
    // Give C's socket a turn to (not) receive anything before asserting a negative.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(cReceivedAnything).toBe(false);
    wsC.removeAllListeners('message');
  });

  it('sending channel chat while not a member of that channel is rejected (non-fatal)', async () => {
    const { url } = await startServer({
      voiceChannels: [{ channelId: 'general', name: 'General' }],
    });
    const ws = track(await connect(url));
    await handshakeWithAuthState(ws, 'Tester');

    const rejection = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: 'client:chat-send',
        id: 'send-3',
        scope: 'channel',
        channelId: 'general',
        body: 'hi',
      }),
    );
    expect(await rejection).toMatchObject({ type: 'server:error', code: 'NOT_IN_VOICE_CHANNEL' });
    // Non-fatal: the connection stays open and can still ping.
    const pong = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'client:ping', id: 'ping-1' }));
    expect(await pong).toMatchObject({ type: 'server:pong' });
  });

  it('history requests return a bounded, deterministically-ordered page over the real socket', async () => {
    const { url } = await startServer();
    const ws = track(await connect(url));
    await handshakeWithAuthState(ws, 'Sender');

    for (const body of ['one', 'two', 'three']) {
      const sent = nextMessage(ws);
      ws.send(
        JSON.stringify({ type: 'client:chat-send', id: `send-${body}`, scope: 'server', body }),
      );
      await sent;
    }

    const page = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: 'client:chat-history-request',
        id: 'history-1',
        scope: 'server',
        limit: 2,
      }),
    );
    const result = (await page) as {
      messages: { body: string }[];
      hasMore: boolean;
      nextCursor: number;
    };
    expect(result.messages.map((m) => m.body)).toEqual(['two', 'three']);
    expect(result.hasMore).toBe(true);

    const olderPage = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: 'client:chat-history-request',
        id: 'history-2',
        scope: 'server',
        limit: 2,
        beforeMessageId: result.nextCursor,
      }),
    );
    const olderResult = (await olderPage) as { messages: { body: string }[]; hasMore: boolean };
    expect(olderResult.messages.map((m) => m.body)).toEqual(['one']);
    expect(olderResult.hasMore).toBe(false);
  });

  it('reading channel chat history does not require current membership in that channel', async () => {
    const { url } = await startServer({
      voiceChannels: [{ channelId: 'general', name: 'General' }],
    });
    const wsA = track(await connect(url));
    const wsB = track(await connect(url));
    await handshakeWithAuthState(wsA, 'A');
    await handshakeWithAuthState(wsB, 'B');

    const aJoined = nextMessage(wsA);
    wsA.send(
      JSON.stringify({ type: 'voice:join', id: 'j1', channelId: 'general', displayName: 'A' }),
    );
    await aJoined;
    const sent = nextMessage(wsA);
    wsA.send(
      JSON.stringify({
        type: 'client:chat-send',
        id: 'send-4',
        scope: 'channel',
        channelId: 'general',
        body: 'left something here',
      }),
    );
    await sent;

    // B never joins "general" at all, but can still read its history.
    const page = nextMessage(wsB);
    wsB.send(
      JSON.stringify({
        type: 'client:chat-history-request',
        id: 'history-3',
        scope: 'channel',
        channelId: 'general',
      }),
    );
    const result = (await page) as { messages: { body: string }[] };
    expect(result.messages.map((m) => m.body)).toEqual(['left something here']);
  });

  it('a Guest sending chat persists the message but creates no T9 authorization membership row', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dv-chat-data-minimization-'));
    try {
      const { url } = await startServer({ dataDir: dir });
      const ws = track(await connect(url));
      const [, authState] = await handshakeWithAuthState(ws, 'Guest');
      expect(authState).toMatchObject({ groups: [{ groupId: 'guest' }] });

      const sent = nextMessage(ws);
      ws.send(
        JSON.stringify({ type: 'client:chat-send', id: 'send-5', scope: 'server', body: 'hi' }),
      );
      await sent;

      // Stop the server so both SQLite files are flushed/closed before independent inspection.
      for (const server of servers.splice(0)) await server.stop();

      const authDb = new DatabaseSync(path.join(dir, 'authorization.sqlite'));
      const memberships = authDb
        .prepare('SELECT * FROM identity_group_memberships')
        .all() as unknown[];
      expect(memberships).toEqual([]);
      authDb.close();

      const chatDb = new DatabaseSync(path.join(dir, 'chat.sqlite'));
      const messages = chatDb.prepare('SELECT body FROM chat_messages').all() as {
        body: string;
      }[];
      expect(messages).toEqual([{ body: 'hi' }]);
      chatDb.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('chat history survives a server restart against the same data directory', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dv-chat-restart-'));
    try {
      const first = await startServer({ dataDir: dir });
      const ws1 = track(await connect(first.url));
      await handshakeWithAuthState(ws1, 'A');
      const sent = nextMessage(ws1);
      ws1.send(
        JSON.stringify({
          type: 'client:chat-send',
          id: 'send-6',
          scope: 'server',
          body: 'PERSIST_ACROSS_RESTART',
        }),
      );
      await sent;

      for (const server of servers.splice(0)) await server.stop();
      for (const ws of sockets.splice(0)) ws.terminate();

      const second = await startServer({ dataDir: dir });
      const ws2 = track(await connect(second.url));
      await handshakeWithAuthState(ws2, 'B');
      const page = nextMessage(ws2);
      ws2.send(
        JSON.stringify({ type: 'client:chat-history-request', id: 'history-4', scope: 'server' }),
      );
      const result = (await page) as { messages: { body: string }[] };
      expect(result.messages.map((m) => m.body)).toEqual(['PERSIST_ACROSS_RESTART']);

      // Close the second server's SQLite handles before removing the directory — Windows refuses
      // to delete a file a still-open handle holds.
      for (const server of servers.splice(0)) await server.stop();
      for (const ws of sockets.splice(0)) ws.terminate();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('chat and authorization operations both work correctly in the same process (joint composition)', async () => {
    const { server, url } = await startServer();
    const ws = track(await connect(url));
    const [, authState] = await handshakeWithAuthState(ws, 'Admin');
    expect(authState).toMatchObject({ groups: [{ groupId: 'guest' }] });

    // An authorization operation (bootstrap redemption)...
    const redeemed = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: 'client:authorization-redeem-token',
        id: 'redeem-1',
        token: server.bootstrapToken,
      }),
    );
    expect(await redeemed).toMatchObject({ group: { groupId: 'server-admin' } });

    // ...interleaved with a chat operation, both against the same running server process.
    const sent = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: 'client:chat-send',
        id: 'send-7',
        scope: 'server',
        body: 'both work',
      }),
    );
    expect(await sent).toMatchObject({ message: { body: 'both work' } });

    // The admin action actually took effect (independent of the chat send).
    const groupsReply = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'client:authorization-list-groups', id: 'lg-1' }));
    expect(await groupsReply).toMatchObject({ type: 'server:authorization-groups' });
  });

  it('two independent servers share no chat history (cross-server isolation)', async () => {
    const { url: urlA } = await startServer({ name: 'Server A' });
    const { url: urlB } = await startServer({ name: 'Server B' });

    const wsA = track(await connect(urlA));
    await handshakeWithAuthState(wsA, 'A');
    const sentOnA = nextMessage(wsA);
    wsA.send(
      JSON.stringify({ type: 'client:chat-send', id: 'send-8', scope: 'server', body: 'SECRET_A' }),
    );
    await sentOnA;

    const wsB = track(await connect(urlB));
    await handshakeWithAuthState(wsB, 'B');
    const pageOnB = nextMessage(wsB);
    wsB.send(
      JSON.stringify({ type: 'client:chat-history-request', id: 'history-5', scope: 'server' }),
    );
    const resultOnB = (await pageOnB) as { messages: unknown[] };
    expect(resultOnB.messages).toEqual([]);
  });

  /** Builds a full `DedicatedServerConfig.realtime` override with a tiny chat-specific rate-limit
   * bucket — `startServer`'s `overrides` is a shallow spread, so overriding `realtime` at all means
   * supplying every field, not just the one under test (mirrors `testConfig`'s own defaults). */
  function realtimeWithChatRateLimits(overrides: {
    readonly chatSendRateLimit?: { readonly maxMessages: number; readonly windowMs: number };
    readonly chatHistoryRateLimit?: { readonly maxMessages: number; readonly windowMs: number };
  }): DedicatedServerConfig['realtime'] {
    return {
      host: '127.0.0.1',
      port: 0,
      maxConnections: 100,
      maxMessageBytes: 16 * 1024,
      handshakeTimeoutMs: 2_000,
      identityChallengeTtlMs: 2_000,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      rateLimit: { maxMessages: 100, windowMs: 10_000 },
      chatSendRateLimit: { maxMessages: 100, windowMs: 10_000 },
      chatHistoryRateLimit: { maxMessages: 100, windowMs: 10_000 },
      channelPasswordRateLimit: { maxMessages: 100, windowMs: 10_000 },
      profileMutationRateLimit: { maxMessages: 100, windowMs: 10_000 },
      avatarFetchRateLimit: { maxMessages: 100, windowMs: 10_000 },
      logLevel: 'error',
      ...overrides,
    };
  }

  it('exceeding the chat-send rate limit yields non-fatal CHAT_RATE_LIMITED; the connection stays open', async () => {
    const { url } = await startServer({
      realtime: realtimeWithChatRateLimits({
        chatSendRateLimit: { maxMessages: 1, windowMs: 10_000 },
      }),
    });
    const ws = track(await connect(url));
    await handshakeWithAuthState(ws, 'Spammer');

    const firstSend = nextMessage(ws);
    ws.send(
      JSON.stringify({ type: 'client:chat-send', id: 'rl-send-1', scope: 'server', body: 'one' }),
    );
    expect(await firstSend).toMatchObject({ type: 'server:chat-message' });

    const limited = nextMessage(ws);
    ws.send(
      JSON.stringify({ type: 'client:chat-send', id: 'rl-send-2', scope: 'server', body: 'two' }),
    );
    expect(await limited).toMatchObject({ type: 'server:error', code: 'CHAT_RATE_LIMITED' });

    // Non-fatal (unlike the generic transport-level RATE_LIMITED): the connection stays open.
    const pong = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'client:ping', id: 'ping-after-rl' }));
    expect(await pong).toMatchObject({ type: 'server:pong' });
  });

  it('exceeding the chat-history rate limit yields non-fatal CHAT_RATE_LIMITED; the connection stays open', async () => {
    const { url } = await startServer({
      realtime: realtimeWithChatRateLimits({
        chatHistoryRateLimit: { maxMessages: 1, windowMs: 10_000 },
      }),
    });
    const ws = track(await connect(url));
    await handshakeWithAuthState(ws, 'Reader');

    const firstPage = nextMessage(ws);
    ws.send(
      JSON.stringify({ type: 'client:chat-history-request', id: 'rl-hist-1', scope: 'server' }),
    );
    expect(await firstPage).toMatchObject({ type: 'server:chat-history-page' });

    const limited = nextMessage(ws);
    ws.send(
      JSON.stringify({ type: 'client:chat-history-request', id: 'rl-hist-2', scope: 'server' }),
    );
    expect(await limited).toMatchObject({ type: 'server:error', code: 'CHAT_RATE_LIMITED' });

    const pong = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'client:ping', id: 'ping-after-rl-2' }));
    expect(await pong).toMatchObject({ type: 'server:pong' });
  });

  it('a chat message body over the 4000-character limit is rejected as INVALID_MESSAGE and the connection closes', async () => {
    const { url } = await startServer();
    const ws = track(await connect(url));
    await handshakeWithAuthState(ws, 'Sender');

    const rejection = nextMessage(ws);
    const closed = nextClose(ws);
    ws.send(
      JSON.stringify({
        type: 'client:chat-send',
        id: 'oversized-1',
        scope: 'server',
        body: 'x'.repeat(4001),
      }),
    );
    expect(await rejection).toMatchObject({ type: 'server:error', code: 'INVALID_MESSAGE' });
    expect((await closed).code).toBe(4400);
  });

  it('a history request with limit over 100 is rejected as INVALID_MESSAGE, never partially processed', async () => {
    const { url } = await startServer();
    const ws = track(await connect(url));
    await handshakeWithAuthState(ws, 'Reader');

    const rejection = nextMessage(ws);
    const closed = nextClose(ws);
    ws.send(
      JSON.stringify({
        type: 'client:chat-history-request',
        id: 'oversized-limit-1',
        scope: 'server',
        limit: 101,
      }),
    );
    expect(await rejection).toMatchObject({ type: 'server:error', code: 'INVALID_MESSAGE' });
    expect((await closed).code).toBe(4400);
  });

  it('sending server chat without chat.server.send permission is rejected server-side, over a raw socket', async () => {
    const { server, url } = await startServer();

    const adminWs = track(await connect(url));
    await handshakeWithAuthState(adminWs, 'Admin');
    const redeemed = nextMessage(adminWs);
    adminWs.send(
      JSON.stringify({
        type: 'client:authorization-redeem-token',
        id: 'redeem-perm-1',
        token: server.bootstrapToken,
      }),
    );
    await redeemed;

    // Strip chat.server.send from Guest's default permission set — matches T9 Section 65's own
    // "an operator can restrict Guest's default permissions" expectation.
    const updated = nextMessage(adminWs);
    adminWs.send(
      JSON.stringify({
        type: 'client:authorization-update-group',
        id: 'strip-guest-send',
        groupId: 'guest',
        permissions: ['voice.channel.join', 'chat.channel.send'],
      }),
    );
    expect(await updated).toMatchObject({ type: 'server:authorization-ack' });

    const guestWs = track(await connect(url));
    const [, guestAuthState] = await handshakeWithAuthState(guestWs, 'Guest');
    expect(guestAuthState).toMatchObject({ groups: [{ groupId: 'guest' }] });

    const rejection = nextMessage(guestWs);
    guestWs.send(
      JSON.stringify({ type: 'client:chat-send', id: 'denied-1', scope: 'server', body: 'hi' }),
    );
    expect(await rejection).toMatchObject({ type: 'server:error', code: 'AUTHORIZATION_DENIED' });

    // Non-fatal: the guest connection stays open.
    const pong = nextMessage(guestWs);
    guestWs.send(JSON.stringify({ type: 'client:ping', id: 'ping-after-denied' }));
    expect(await pong).toMatchObject({ type: 'server:pong' });
  });

  it('a Unicode/emoji message body round-trips byte-for-byte through send, live receipt, persist, restart, and history', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dv-chat-unicode-'));
    const UNICODE_BODY = 'olá 👽🛸 café — 日本語 — Здравствуйте';
    try {
      const first = await startServer({ dataDir: dir });
      const senderWs = track(await connect(first.url));
      await handshakeWithAuthState(senderWs, 'A');
      // Sender is already `ready`, so T13.3 presence delivers it a live `server:presence-updated`
      // the moment the receiver's handshake completes — drained here first.
      const senderNotifiedOfReceiverOnline = nextMessage(senderWs);
      const receiverWs = track(await connect(first.url));
      await handshakeWithAuthState(receiverWs, 'B');
      expect(await senderNotifiedOfReceiverOnline).toMatchObject({
        type: 'server:presence-updated',
      });

      const liveReceived = nextMessage(receiverWs);
      const sentAck = nextMessage(senderWs);
      senderWs.send(
        JSON.stringify({
          type: 'client:chat-send',
          id: 'unicode-1',
          scope: 'server',
          body: UNICODE_BODY,
        }),
      );
      expect(await sentAck).toMatchObject({ message: { body: UNICODE_BODY } });
      expect(await liveReceived).toMatchObject({ message: { body: UNICODE_BODY } });

      for (const server of servers.splice(0)) await server.stop();
      for (const ws of sockets.splice(0)) ws.terminate();

      const second = await startServer({ dataDir: dir });
      const freshWs = track(await connect(second.url));
      await handshakeWithAuthState(freshWs, 'C');
      const page = nextMessage(freshWs);
      freshWs.send(
        JSON.stringify({
          type: 'client:chat-history-request',
          id: 'unicode-history-1',
          scope: 'server',
        }),
      );
      const result = (await page) as { messages: { body: string }[] };
      expect(result.messages.map((m) => m.body)).toEqual([UNICODE_BODY]);

      for (const server of servers.splice(0)) await server.stop();
      for (const ws of sockets.splice(0)) ws.terminate();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a stored <script> body survives a restart and is delivered as literal text on the wire, never re-encoded or stripped', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dv-chat-xss-'));
    const HOSTILE_BODY = '<script>window.__OWNED = true</script>';
    try {
      const first = await startServer({ dataDir: dir });
      const ws1 = track(await connect(first.url));
      await handshakeWithAuthState(ws1, 'A');
      const sent = nextMessage(ws1);
      ws1.send(
        JSON.stringify({
          type: 'client:chat-send',
          id: 'xss-1',
          scope: 'server',
          body: HOSTILE_BODY,
        }),
      );
      expect(await sent).toMatchObject({ message: { body: HOSTILE_BODY } });

      for (const server of servers.splice(0)) await server.stop();
      for (const ws of sockets.splice(0)) ws.terminate();

      const second = await startServer({ dataDir: dir });
      const ws2 = track(await connect(second.url));
      await handshakeWithAuthState(ws2, 'B');
      const page = nextMessage(ws2);
      ws2.send(
        JSON.stringify({
          type: 'client:chat-history-request',
          id: 'xss-history-1',
          scope: 'server',
        }),
      );
      const result = (await page) as { messages: { body: string }[] };
      // Exactly the literal string, byte-for-byte — the wire protocol/store never HTML-escapes or
      // interprets it; safety comes entirely from the client never rendering it via
      // `dangerouslySetInnerHTML` (see ChatPanel.tsx), never from mangling the stored content.
      expect(result.messages.map((m) => m.body)).toEqual([HOSTILE_BODY]);

      for (const server of servers.splice(0)) await server.stop();
      for (const ws of sockets.splice(0)) ws.terminate();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('nickname-at-send is fixed permanently: reconnecting under a new nickname never rewrites an old message', async () => {
    const keyPair = generateIdentityKeyPair();
    const { url } = await startServer();

    const firstWs = track(await connect(url));
    await handshakeWithAuthState(firstWs, 'OldNick', keyPair);
    const sent = nextMessage(firstWs);
    firstWs.send(
      JSON.stringify({
        type: 'client:chat-send',
        id: 'nick-1',
        scope: 'server',
        body: 'message under old nickname',
      }),
    );
    expect(await sent).toMatchObject({ message: { senderNickname: 'OldNick' } });
    firstWs.terminate();

    // Same identity key pair, different nickname — a genuine reconnect under a new display name.
    const secondWs = track(await connect(url));
    await handshakeWithAuthState(secondWs, 'NewNick', keyPair);
    const page = nextMessage(secondWs);
    secondWs.send(
      JSON.stringify({
        type: 'client:chat-history-request',
        id: 'nick-history-1',
        scope: 'server',
      }),
    );
    const result = (await page) as { messages: { senderNickname: string; body: string }[] };
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]).toMatchObject({
      senderNickname: 'OldNick',
      body: 'message under old nickname',
    });
  });
});
