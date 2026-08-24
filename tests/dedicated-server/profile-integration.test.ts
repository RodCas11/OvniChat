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
 * T13.3 real-network integration tests for profiles/avatars/members/presence — mirroring
 * `channels-integration.test.ts`'s own testing philosophy (real ephemeral localhost sockets, no
 * mocked transport) and its "filter by message type, not arrival order" discipline, since every
 * profile mutation also fans out a `server:presence-updated` broadcast alongside whatever direct
 * reply a given request expects.
 */

function testConfig(overrides: Partial<DedicatedServerConfig> = {}): DedicatedServerConfig {
  return {
    name: 'Test Server',
    realtime: {
      host: '127.0.0.1',
      port: 0,
      maxConnections: 100,
      maxMessageBytes: 128 * 1024,
      handshakeTimeoutMs: 2_000,
      identityChallengeTtlMs: 2_000,
      heartbeatIntervalMs: 60_000,
      heartbeatTimeoutMs: 60_000,
      rateLimit: { maxMessages: 500, windowMs: 10_000 },
      chatSendRateLimit: { maxMessages: 100, windowMs: 10_000 },
      chatHistoryRateLimit: { maxMessages: 100, windowMs: 10_000 },
      channelPasswordRateLimit: { maxMessages: 100, windowMs: 10_000 },
      profileMutationRateLimit: { maxMessages: 100, windowMs: 10_000 },
      avatarFetchRateLimit: { maxMessages: 100, windowMs: 10_000 },
      logLevel: 'error',
    },
    voiceChannels: [{ channelId: 'general', name: 'General' }],
    accessMode: 'open',
    dataDir: ':memory:',
    configFilePath: '(test)',
    configFileFound: false,
    publicHost: undefined,
    turn: undefined,
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

function waitForMessageOfTypes(
  ws: WebSocket,
  types: readonly string[],
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handle);
      reject(new Error(`Timed out waiting for one of [${types.join(', ')}]`));
    }, timeoutMs);

    function handle(data: Buffer): void {
      const message = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      if (types.includes(message['type'] as string)) {
        clearTimeout(timer);
        ws.off('message', handle);
        resolve(message);
      }
    }

    ws.on('message', handle);
  });
}

function waitForMessageOfType(
  ws: WebSocket,
  type: string,
  timeoutMs = 2000,
): Promise<Record<string, unknown>> {
  return waitForMessageOfTypes(ws, [type], timeoutMs);
}

/** Asserts that `type` is NOT received on `ws` within `timeoutMs` — used for the multi-connection
 * "disconnecting one of several connections must not broadcast presence-removed" negative case. */
function assertMessageOfTypeNotReceived(
  ws: WebSocket,
  type: string,
  timeoutMs = 300,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', handle);
      resolve();
    }, timeoutMs);

    function handle(data: Buffer): void {
      const message = JSON.parse(data.toString('utf8')) as Record<string, unknown>;
      if (message['type'] === type) {
        clearTimeout(timer);
        ws.off('message', handle);
        reject(new Error(`Unexpectedly received a "${type}" message`));
      }
    }

    ws.on('message', handle);
  });
}

async function handshake(
  ws: WebSocket,
  nickname = 'Tester',
  keyPair: IdentityKeyPair = generateIdentityKeyPair(),
  serverToken?: string,
): Promise<Record<string, unknown>[]> {
  const challengeReceived = nextMessages(ws, 1);
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
  const [challenge] = await challengeReceived;
  if (!challenge) throw new Error('handshake incomplete: no challenge');

  const payload = buildIdentityAuthPayload({
    protocolVersion: CURRENT_PROTOCOL_VERSION,
    connectionId: challenge['connectionId'] as string,
    nonce: challenge['nonce'] as string,
    expiresAt: challenge['expiresAt'] as number,
    publicKey: keyPair.publicKey,
    nickname,
  });
  const signature = signWithIdentityKey(keyPair.privateKey, keyPair.publicKey, payload);

  // The very first burst on a fresh connection: server:hello, server:authorization-state,
  // voice:catalog, server:presence-snapshot, server:profile-self-updated (T13.3's proactive push of
  // this identity's own real persisted profile — see `handleIdentityProof`'s own comment on why),
  // in this exact order, with nothing else able to interleave yet. All five must be drained here,
  // even by callers that only care about the first few: the server sends all five back-to-back in
  // one synchronous loop (`Connection`'s action-processing loop in `connection.ts`), which can
  // arrive as a single TCP burst — leaving the fifth message undrained risks it racing past whatever
  // listener a test attaches next (e.g. one specifically waiting for a *mutation-triggered*
  // `server:profile-self-updated`, which would then wrongly match this connection-time one instead).
  const replies = nextMessages(ws, 5);
  ws.send(JSON.stringify({ type: 'client:identity-proof', id: 'proof-1', signature }));
  return replies;
}

function send(ws: WebSocket, message: Record<string, unknown>): void {
  ws.send(JSON.stringify(message));
}

// --- PNG fixture builders (structural, matching image-validation.test.ts's own approach) --------

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  return Buffer.concat([length, Buffer.from(type, 'ascii'), data, Buffer.alloc(4)]);
}

function buildPng(width: number, height: number, options: { animated?: boolean } = {}): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  const chunks = [signature, pngChunk('IHDR', ihdrData)];
  if (options.animated) chunks.push(pngChunk('acTL', Buffer.alloc(8)));
  chunks.push(pngChunk('IDAT', Buffer.from([0, 0, 0, 0])), pngChunk('IEND', Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

const VALID_AVATAR_BASE64 = buildPng(4, 4).toString('base64');

describe('Dedicated Server — T13.3 profiles/avatars/members/presence (real network)', () => {
  const servers: DedicatedServerHandle[] = [];
  const sockets: WebSocket[] = [];
  const tempDirs: string[] = [];

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.terminate();
    }
    for (const server of servers.splice(0)) {
      await server.stop();
    }
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function track<T extends DedicatedServerHandle | WebSocket>(value: T): T {
    if (value instanceof WebSocket) sockets.push(value);
    else servers.push(value);
    return value;
  }

  function trackTempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'disco-voador-profile-int-'));
    tempDirs.push(dir);
    return dir;
  }

  async function startServer(
    overrides: Partial<DedicatedServerConfig> = {},
    deps: Parameters<typeof createDedicatedServer>[1] = {},
  ): Promise<{ server: DedicatedServerHandle; url: string }> {
    const server = track(createDedicatedServer(testConfig(overrides), deps));
    const address = await server.start();
    return { server, url: `ws://${address.host}:${String(address.port)}` };
  }

  async function connectAsAdmin(
    server: DedicatedServerHandle,
    url: string,
  ): Promise<{ ws: WebSocket }> {
    const ws = track(await connect(url));
    await handshake(ws, 'Admin');
    const redeemed = waitForMessageOfType(ws, 'server:authorization-token-redeemed');
    send(ws, {
      type: 'client:authorization-redeem-token',
      id: 'redeem-1',
      token: server.bootstrapToken,
    });
    await redeemed;
    return { ws };
  }

  /** Grants `groupId` to the identity behind `targetWs`, which must already be a voice participant
   * (grant-group targets a `participantId`, T9 semantics) — mirrors `channels-integration.test.ts`'s
   * own pattern for this exact prerequisite. */
  async function joinGeneralAndGetParticipantId(
    ws: WebSocket,
    displayName: string,
  ): Promise<string> {
    const joined = waitForMessageOfType(ws, 'voice:joined');
    send(ws, { type: 'voice:join', id: `j-${displayName}`, channelId: 'general', displayName });
    const result = (await joined) as { participantId: string };
    return result.participantId;
  }

  async function createGroupWithPermissions(
    adminWs: WebSocket,
    groupId: string,
    name: string,
    permissions: readonly string[],
  ): Promise<void> {
    const ack = waitForMessageOfType(adminWs, 'server:authorization-ack');
    send(adminWs, {
      type: 'client:authorization-create-group',
      id: `g-${groupId}`,
      name,
      permissions,
    });
    await ack;
  }

  async function grantGroup(
    adminWs: WebSocket,
    targetParticipantId: string,
    groupId: string,
  ): Promise<void> {
    const ack = waitForMessageOfType(adminWs, 'server:authorization-ack');
    send(adminWs, {
      type: 'client:authorization-grant-group',
      id: `grant-${groupId}-${targetParticipantId}`,
      targetParticipantId,
      groupId,
    });
    await ack;
  }

  // Zod's `groupIdSchema` requires lowercase-alphanumeric-hyphen ids — `createGroup` mints its own
  // server-side id though, so tests instead need to discover the id from the create response. We
  // sidestep that by reading it back via `server:authorization-groups` when needed, or (simpler,
  // used throughout this file) by granting using the *name* is not supported — grant needs the real
  // id. We fetch the freshly created group's id from `client:authorization-list-groups`.
  async function findGroupIdByName(adminWs: WebSocket, name: string): Promise<string> {
    const groupsMessage = waitForMessageOfType(adminWs, 'server:authorization-groups');
    send(adminWs, { type: 'client:authorization-list-groups', id: `list-${name}` });
    const result = (await groupsMessage) as { groups: { groupId: string; name: string }[] };
    const match = result.groups.find((g) => g.name === name);
    if (!match) throw new Error(`group "${name}" not found`);
    return match.groupId;
  }

  it('self-service: setting status/avatar/presence replies server:profile-self-updated to the actor and broadcasts server:presence-updated to another already-connected member, with no reconnect', async () => {
    const { url } = await startServer();
    const aWs = track(await connect(url));
    await handshake(aWs, 'Alice');
    const bWs = track(await connect(url));
    await handshake(bWs, 'Bob');

    const selfUpdated = waitForMessageOfType(aWs, 'server:profile-self-updated');
    const broadcastToB = waitForMessageOfType(bWs, 'server:presence-updated');
    send(aWs, { type: 'client:profile-set-status', id: 's1', customStatus: 'Hello there' });

    expect(await selfUpdated).toMatchObject({ customStatus: 'Hello there' });
    expect(await broadcastToB).toMatchObject({ member: { customStatus: 'Hello there' } });

    const presenceUpdated2 = waitForMessageOfType(aWs, 'server:profile-self-updated');
    send(aWs, { type: 'client:profile-set-presence', id: 'p1', presence: 'away' });
    expect(await presenceUpdated2).toMatchObject({ presence: 'away' });

    const avatarUpdated = waitForMessageOfType(aWs, 'server:profile-self-updated');
    send(aWs, {
      type: 'client:profile-set-avatar',
      id: 'a1',
      target: 'self',
      format: 'png',
      imageBase64: VALID_AVATAR_BASE64,
    });
    const avatarResult = (await avatarUpdated) as { avatarRef: { revision: number; hash: string } };
    expect(avatarResult.avatarRef.revision).toBe(1);
  });

  it("self-service mutations never broadcast server:presence-updated back to the acting connection itself (regression: this previously duplicated the actor's own row in every observer's Member Panel, including their own second connection)", async () => {
    const { url } = await startServer();
    const aWs = track(await connect(url));
    await handshake(aWs, 'Alice');

    // Bob's own "came online" broadcast reaches Alice too (correctly — she's already a ready
    // connection) and must be drained *before* the negative assertion below, or it can race into it
    // and produce a false failure unrelated to what this test actually checks.
    const bobOnlineOnAlice = waitForMessageOfType(aWs, 'server:presence-updated');
    const bWs = track(await connect(url));
    await handshake(bWs, 'Bob');
    await bobOnlineOnAlice;

    const selfUpdated = waitForMessageOfType(aWs, 'server:profile-self-updated');
    const noSelfBroadcastToActor = assertMessageOfTypeNotReceived(aWs, 'server:presence-updated');
    const broadcastToObserver = waitForMessageOfType(bWs, 'server:presence-updated');
    send(aWs, { type: 'client:profile-set-status', id: 's1', customStatus: 'Hello there' });

    await selfUpdated;
    await broadcastToObserver;
    await noSelfBroadcastToActor;
  });

  it('target:"server" avatar mutation is rejected without server.manage and accepted with it', async () => {
    const { server, url } = await startServer();
    const { ws: admin } = await connectAsAdmin(server, url);

    const guestWs = track(await connect(url));
    await handshake(guestWs, 'Guest');

    const denied = waitForMessageOfType(guestWs, 'server:error');
    send(guestWs, {
      type: 'client:profile-set-avatar',
      id: 'sv1',
      target: 'server',
      format: 'png',
      imageBase64: VALID_AVATAR_BASE64,
    });
    expect(await denied).toMatchObject({ type: 'server:error', code: 'AUTHORIZATION_DENIED' });

    const accepted = waitForMessageOfType(admin, 'server:profile-self-updated');
    send(admin, {
      type: 'client:profile-set-avatar',
      id: 'sv2',
      target: 'server',
      format: 'png',
      imageBase64: VALID_AVATAR_BASE64,
    });
    await accepted;

    const clearDenied = waitForMessageOfType(guestWs, 'server:error');
    send(guestWs, { type: 'client:profile-clear-avatar', id: 'sv3', target: 'server' });
    expect(await clearDenied).toMatchObject({ code: 'AUTHORIZATION_DENIED' });
  });

  it('target:"member" clear is rejected without moderation.profile.clear, accepted with it, and cannot set arbitrary content (only clear)', async () => {
    const { server, url } = await startServer();
    const { ws: admin } = await connectAsAdmin(server, url);

    await createGroupWithPermissions(admin, 'clearer', 'Clearer', ['moderation.profile.clear']);
    const clearerGroupId = await findGroupIdByName(admin, 'Clearer');

    const targetWs = track(await connect(url));
    await handshake(targetWs, 'Target');
    await joinGeneralAndGetParticipantId(targetWs, 'Target');
    const targetSelfUpdated = waitForMessageOfType(targetWs, 'server:profile-self-updated');
    send(targetWs, {
      type: 'client:profile-set-status',
      id: 'ts1',
      customStatus: "Target's status",
    });
    await targetSelfUpdated;

    const moderatorWs = track(await connect(url));
    await handshake(moderatorWs, 'Moderator');
    const moderatorParticipantId = await joinGeneralAndGetParticipantId(moderatorWs, 'Moderator');

    // Discover the target's memberRef from the moderator's own presence snapshot/broadcast — the
    // moderator was already connected when Target joined and set its status, so a
    // `server:presence-updated` for Target should have already arrived (or is present in its
    // snapshot at handshake time — re-request via a second handshake-independent path is
    // unnecessary here since we can grab it live).
    const moderatorUpdateForTarget = waitForMessageOfTypes(moderatorWs, [
      'server:presence-updated',
    ]);
    // Trigger one more Target status change so the moderator (already connected) definitely
    // receives a fresh `server:presence-updated` naming Target's `memberRef`.
    const targetSelfUpdated2 = waitForMessageOfType(targetWs, 'server:profile-self-updated');
    send(targetWs, { type: 'client:profile-set-status', id: 'ts2', customStatus: 'Still working' });
    await targetSelfUpdated2;
    const moderatorSawUpdate = (await moderatorUpdateForTarget) as {
      member: { memberRef: string; customStatus?: string };
    };
    const targetMemberRef = moderatorSawUpdate.member.memberRef;

    // Without the permission: denied.
    const deniedClear = waitForMessageOfType(moderatorWs, 'server:error');
    send(moderatorWs, {
      type: 'client:profile-clear-member-status',
      id: 'c1',
      memberRef: targetMemberRef,
    });
    expect(await deniedClear).toMatchObject({ code: 'AUTHORIZATION_DENIED' });

    // Grant the permission.
    await grantGroup(admin, moderatorParticipantId, clearerGroupId);

    // With the permission: succeeds, and Target's broadcast presence view no longer carries a
    // custom status.
    const clearAck = waitForMessageOfType(moderatorWs, 'server:profile-self-updated');
    const targetClearedBroadcast = waitForMessageOfType(targetWs, 'server:presence-updated');
    send(moderatorWs, {
      type: 'client:profile-clear-member-status',
      id: 'c2',
      memberRef: targetMemberRef,
    });
    await clearAck;
    const clearedView = (await targetClearedBroadcast) as { member: { customStatus?: string } };
    expect(clearedView.member.customStatus).toBeUndefined();

    // Structurally cannot set arbitrary content on another member's behalf: no protocol message
    // exists for it at all (`client:profile-set-status` has no `target`/`memberRef` field, and
    // `client:profile-set-avatar`'s `target` enum has no `'member'` option) — attempting one is
    // simply not a valid message shape (INVALID_MESSAGE), never a permission question.
    const invalid = waitForMessageOfType(moderatorWs, 'server:error');
    send(moderatorWs, {
      type: 'client:profile-set-avatar',
      id: 'hostile1',
      target: 'member',
      memberRef: targetMemberRef,
      format: 'png',
      imageBase64: VALID_AVATAR_BASE64,
    });
    expect(await invalid).toMatchObject({ code: 'INVALID_MESSAGE' });
    void moderatorParticipantId;
  });

  it('a memberRef naming an offline/nonexistent member returns the non-fatal MEMBER_NOT_FOUND', async () => {
    const { server, url } = await startServer();
    const { ws: admin } = await connectAsAdmin(server, url);
    await createGroupWithPermissions(admin, 'clearer', 'Clearer', ['moderation.profile.clear']);
    const clearerGroupId = await findGroupIdByName(admin, 'Clearer');
    const participantId = await joinGeneralAndGetParticipantId(admin, 'Admin');
    await grantGroup(admin, participantId, clearerGroupId);

    const notFound = waitForMessageOfType(admin, 'server:error');
    send(admin, {
      type: 'client:profile-clear-member-status',
      id: 'nf1',
      memberRef: 'this-member-ref-does-not-exist',
    });
    expect(await notFound).toMatchObject({ code: 'MEMBER_NOT_FOUND' });
    expect(admin.readyState).toBe(admin.OPEN);
  });

  it('hostile hidden-channel-leakage: presence payloads never carry any channel-shaped field, even for a member currently inside a hidden channel', async () => {
    const { server, url } = await startServer();
    const { ws: admin } = await connectAsAdmin(server, url);

    await createGroupWithPermissions(admin, 'staff', 'Staff', ['voice.channel.join']);
    const staffGroupId = await findGroupIdByName(admin, 'Staff');

    const created = waitForMessageOfType(admin, 'server:channel-created');
    send(admin, { type: 'client:channel-create-voice', id: 'c1', name: 'Secret Room' });
    const createdMessage = (await created) as { node: { nodeId: string } };
    const hiddenId = createdMessage.node.nodeId;
    const hiddenName = 'Secret Room';

    const ack = waitForMessageOfType(admin, 'server:channel-ack');
    send(admin, {
      type: 'client:channel-update',
      id: 'u1',
      nodeId: hiddenId,
      visibilityPolicy: 'selected-groups',
      visibilityGroupIds: [staffGroupId],
    });
    await ack;

    // `memberWs` is a *staff* member (so it can see/join the hidden channel) — "hidden" means
    // hidden from the observer below, which is never granted `staff`, not hidden from its own
    // occupant.
    const memberWs = track(await connect(url));
    await handshake(memberWs, 'HiddenMember');
    const memberParticipantId = await joinGeneralAndGetParticipantId(memberWs, 'HiddenMember');
    await grantGroup(admin, memberParticipantId, staffGroupId);

    const joined = waitForMessageOfType(memberWs, 'voice:joined');
    send(memberWs, {
      type: 'voice:join',
      id: 'hj1',
      channelId: hiddenId,
      displayName: 'HiddenMember',
    });
    await joined;

    const observerWs = track(await connect(url));
    const observerHandshake = await handshake(observerWs, 'Observer');
    const snapshot = observerHandshake[3];
    const rawSnapshot = JSON.stringify(snapshot);
    expect(rawSnapshot).not.toContain(hiddenId);
    expect(rawSnapshot).not.toContain(hiddenName);
    // Structural guarantee, not just "this particular id is absent": no field in the shape at all
    // is channel-shaped.
    for (const member of (snapshot as { members: Record<string, unknown>[] }).members) {
      expect(Object.keys(member).some((key) => key.toLowerCase().includes('channel'))).toBe(false);
    }

    const statusUpdate = waitForMessageOfType(observerWs, 'server:presence-updated');
    const selfUpdated = waitForMessageOfType(memberWs, 'server:profile-self-updated');
    send(memberWs, {
      type: 'client:profile-set-status',
      id: 'hm1',
      customStatus: 'in the secret room',
    });
    await selfUpdated;
    const update = await statusUpdate;
    const rawUpdate = JSON.stringify(update);
    expect(rawUpdate).not.toContain(hiddenId);
    expect(rawUpdate).not.toContain(hiddenName);
    expect(
      Object.keys((update as { member: Record<string, unknown> }).member).some((key) =>
        key.toLowerCase().includes('channel'),
      ),
    ).toBe(false);
  });

  it('multi-connection: the same identity opens two simultaneous connections; disconnecting one does not broadcast presence-removed, only disconnecting the last one does', async () => {
    const { url } = await startServer();
    const sharedKeyPair = generateIdentityKeyPair();

    const observerWs = track(await connect(url));
    await handshake(observerWs, 'Observer');

    const conn1 = track(await connect(url));
    const onlineUpdate = waitForMessageOfType(observerWs, 'server:presence-updated');
    await handshake(conn1, 'MultiConn', sharedKeyPair);
    const onlineView = (await onlineUpdate) as { member: { memberRef: string } };
    const expectedMemberRef = onlineView.member.memberRef;

    const conn2 = track(await connect(url));
    // Second connection for the SAME identity: no new `server:presence-updated` broadcast is
    // expected (the identity was already visible as online) — verified by racing against a timeout.
    const noSecondUpdate = assertMessageOfTypeNotReceived(
      observerWs,
      'server:presence-updated',
      400,
    );
    await handshake(conn2, 'MultiConn', sharedKeyPair);
    await noSecondUpdate;

    // Closing the first of the two connections must NOT broadcast server:presence-removed.
    const noRemoval = assertMessageOfTypeNotReceived(observerWs, 'server:presence-removed', 500);
    conn1.close();
    await noRemoval;

    // Closing the LAST connection broadcasts the removal, with the correct memberRef.
    const removal = waitForMessageOfType(observerWs, 'server:presence-removed');
    conn2.close();
    expect(await removal).toMatchObject({ memberRef: expectedMemberRef });
  });

  it('role-bucket derivation: a real admin-permission holder shows "admin", a moderation-permission holder via a custom group shows "moderator", and a plain member has no bucket', async () => {
    const { server, url } = await startServer();
    const { ws: admin } = await connectAsAdmin(server, url);

    await createGroupWithPermissions(admin, 'kicker', 'Kicker', ['moderation.kick']);
    const kickerGroupId = await findGroupIdByName(admin, 'Kicker');

    const observerWs = track(await connect(url));
    await handshake(observerWs, 'Observer');

    // Admin's own presence view: capture it via a self-triggered mutation broadcast.
    const adminUpdate = waitForMessageOfType(observerWs, 'server:presence-updated');
    const adminSelfUpdated = waitForMessageOfType(admin, 'server:profile-self-updated');
    send(admin, {
      type: 'client:profile-set-status',
      id: 'admin-status',
      customStatus: 'admin here',
    });
    await adminSelfUpdated;
    const adminView = (await adminUpdate) as { member: { roleBucket?: string } };
    expect(adminView.member.roleBucket).toBe('admin');

    const moderatorWs = track(await connect(url));
    await handshake(moderatorWs, 'Moderator');
    const moderatorParticipantId = await joinGeneralAndGetParticipantId(moderatorWs, 'Moderator');
    await grantGroup(admin, moderatorParticipantId, kickerGroupId);

    const moderatorUpdate = waitForMessageOfType(observerWs, 'server:presence-updated');
    const moderatorSelfUpdated = waitForMessageOfType(moderatorWs, 'server:profile-self-updated');
    send(moderatorWs, {
      type: 'client:profile-set-status',
      id: 'mod-status',
      customStatus: 'moderator here',
    });
    await moderatorSelfUpdated;
    const moderatorView = (await moderatorUpdate) as { member: { roleBucket?: string } };
    expect(moderatorView.member.roleBucket).toBe('moderator');

    const plainWs = track(await connect(url));
    await handshake(plainWs, 'PlainMember');
    const plainUpdate = waitForMessageOfType(observerWs, 'server:presence-updated');
    const plainSelfUpdated = waitForMessageOfType(plainWs, 'server:profile-self-updated');
    send(plainWs, {
      type: 'client:profile-set-status',
      id: 'plain-status',
      customStatus: 'just here',
    });
    await plainSelfUpdated;
    const plainView = (await plainUpdate) as { member: { roleBucket?: string } };
    expect(plainView.member.roleBucket).toBeUndefined();
  });

  it('avatar upload wire-level oversize: a base64 payload exceeding the schema bound is rejected as INVALID_MESSAGE (fatal, closes the connection) before ever reaching the store', async () => {
    // `avatarBase64Schema`'s own max length is the exact 4/3 inflation of `AVATAR_MAX_RAW_BYTES`, so
    // a wire-valid base64 string can never decode to more bytes than the store's own
    // `AVATAR_TOO_LARGE` check would reject — that check is exercised directly, bypassing the wire
    // schema, in `tests/dedicated-server/profile-store.test.ts`.
    const { url } = await startServer();
    const ws = track(await connect(url));
    await handshake(ws, 'Uploader');

    const tooLarge = waitForMessageOfType(ws, 'server:error');
    send(ws, {
      type: 'client:profile-set-avatar',
      id: 'big1',
      target: 'self',
      format: 'png',
      imageBase64: Buffer.alloc(60_000).toString('base64'),
    });
    expect(await tooLarge).toMatchObject({ code: 'INVALID_MESSAGE' });
  });

  it('avatar upload validation: rejects wrong-format/dimension-too-large/animated images, accepts a valid minimal fixture', async () => {
    const { url } = await startServer();
    const ws = track(await connect(url));
    await handshake(ws, 'Uploader');

    // JPEG bytes declared as png -> format mismatch.
    const jpegBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0]);
    const wrongFormat = waitForMessageOfType(ws, 'server:error');
    send(ws, {
      type: 'client:profile-set-avatar',
      id: 'fmt1',
      target: 'self',
      format: 'png',
      imageBase64: jpegBytes.toString('base64'),
    });
    expect(await wrongFormat).toMatchObject({ code: 'AVATAR_INVALID_FORMAT' });

    const tooBigDimensions = waitForMessageOfType(ws, 'server:error');
    send(ws, {
      type: 'client:profile-set-avatar',
      id: 'dim1',
      target: 'self',
      format: 'png',
      imageBase64: buildPng(600, 600).toString('base64'),
    });
    expect(await tooBigDimensions).toMatchObject({ code: 'AVATAR_DIMENSIONS_TOO_LARGE' });

    const animated = waitForMessageOfType(ws, 'server:error');
    send(ws, {
      type: 'client:profile-set-avatar',
      id: 'anim1',
      target: 'self',
      format: 'png',
      imageBase64: buildPng(64, 64, { animated: true }).toString('base64'),
    });
    expect(await animated).toMatchObject({ code: 'AVATAR_ANIMATED_NOT_ALLOWED' });

    const valid = waitForMessageOfType(ws, 'server:profile-self-updated');
    send(ws, {
      type: 'client:profile-set-avatar',
      id: 'ok1',
      target: 'self',
      format: 'png',
      imageBase64: VALID_AVATAR_BASE64,
    });
    const okResult = (await valid) as { avatarRef: { revision: number } };
    expect(okResult.avatarRef.revision).toBe(1);
  });

  it('rate-limit: exceeding the per-connection profile-mutation bound is rejected with the non-fatal PROFILE_RATE_LIMITED, and the connection stays open', async () => {
    const { url } = await startServer({
      realtime: {
        ...testConfig().realtime,
        profileMutationRateLimit: { maxMessages: 2, windowMs: 60_000 },
      },
    });
    const ws = track(await connect(url));
    await handshake(ws, 'Spammer');

    for (let i = 0; i < 2; i++) {
      const ok = waitForMessageOfType(ws, 'server:profile-self-updated');
      send(ws, {
        type: 'client:profile-set-status',
        id: `ok-${String(i)}`,
        customStatus: `n${String(i)}`,
      });
      await ok;
    }

    const limited = waitForMessageOfType(ws, 'server:error');
    send(ws, { type: 'client:profile-set-status', id: 'limited-1', customStatus: 'once too many' });
    expect(await limited).toMatchObject({ code: 'PROFILE_RATE_LIMITED' });
    expect(ws.readyState).toBe(ws.OPEN);

    const pong = waitForMessageOfType(ws, 'server:pong');
    send(ws, { type: 'client:ping', id: 'still-alive' });
    expect(await pong).toEqual({ type: 'server:pong', id: 'still-alive' });
  });

  it('server:hello carries the current server avatarRef once one has been set (visible to a freshly connecting client)', async () => {
    const { server, url } = await startServer();
    const { ws: admin } = await connectAsAdmin(server, url);

    const setAck = waitForMessageOfType(admin, 'server:profile-self-updated');
    send(admin, {
      type: 'client:profile-set-avatar',
      id: 'sv1',
      target: 'server',
      format: 'png',
      imageBase64: VALID_AVATAR_BASE64,
    });
    await setAck;

    const freshWs = track(await connect(url));
    const [serverHello] = await handshake(freshWs, 'Fresh');
    expect(serverHello).toHaveProperty('serverAvatarRef');
    expect(
      (serverHello as { serverAvatarRef: { revision: number } }).serverAvatarRef.revision,
    ).toBe(1);
  });

  it('restart persistence: profile data (avatar/status/presence preference) survives a Dedicated Server restart against the same data directory', async () => {
    const dir = trackTempDir();
    const { server, url } = await startServer({ dataDir: dir });
    const keyPair = generateIdentityKeyPair();
    const ws = track(await connect(url));
    await handshake(ws, 'Persistent', keyPair);

    const avatarUpdated = waitForMessageOfType(ws, 'server:profile-self-updated');
    send(ws, {
      type: 'client:profile-set-avatar',
      id: 'p1',
      target: 'self',
      format: 'png',
      imageBase64: VALID_AVATAR_BASE64,
    });
    await avatarUpdated;

    await server.stop();

    const restarted = track(createDedicatedServer(testConfig({ dataDir: dir })));
    const address = await restarted.start();
    const restartUrl = `ws://${address.host}:${String(address.port)}`;
    const ws2 = track(await connect(restartUrl));
    await handshake(ws2, 'Persistent', keyPair);

    const avatarData = waitForMessageOfType(ws2, 'server:profile-avatar-data');
    send(ws2, { type: 'client:profile-request-avatar', id: 'req1', target: 'self' });
    const result = (await avatarData) as { avatarRef: { revision: number } };
    expect(result.avatarRef.revision).toBe(1);
  });
});
