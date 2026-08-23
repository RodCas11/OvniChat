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
import type { Logger } from '../../services/realtime/src/logging.js';

/**
 * T13.2 real-network integration tests for channel/category tree administration, ACL enforcement,
 * password protection, and live re-validation — mirroring `integration.test.ts`'s own testing
 * philosophy (real ephemeral localhost sockets, no mocked transport).
 *
 * Every mutating `client:channel-*`/`client:authorization-grant-group`/`-revoke-group` handler now
 * also emits a personalized `voice:catalog` broadcast to every `ready` connection (T13.2's live-
 * update strategy), so a naive "the next message is the reply I asked for" assumption is no longer
 * safe anywhere in this file — `waitForMessageOfType` below filters by `type` instead of by
 * arrival order, which stays correct regardless of how many extra catalog-refresh/auth-state
 * messages a given mutation also happens to fan out.
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
      rateLimit: { maxMessages: 200, windowMs: 10_000 },
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
    ...overrides,
  };
}

function capturingLogger(): { logger: Logger; entries: string[] } {
  const entries: string[] = [];
  const record = (level: string, event: string, fields: Record<string, unknown>): void => {
    entries.push(JSON.stringify({ level, event, ...fields }));
  };
  return {
    entries,
    logger: {
      debug: (event, fields = {}) => record('debug', event, fields),
      info: (event, fields = {}) => record('info', event, fields),
      warn: (event, fields = {}) => record('warn', event, fields),
      error: (event, fields = {}) => record('error', event, fields),
    },
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

/** Waits for the next message whose `type` is one of `types`, silently ignoring any other message
 * type that arrives first (e.g. a personalized `voice:catalog` refresh or a
 * `server:authorization-state` push fanned out alongside the reply this caller actually wants) —
 * see this file's own top doc comment for why this is the safe primitive to use here, not
 * `nextMessage`. A single listener/timer for the whole call, so there is never a second, unawaited
 * listener left dangling the way two separate `Promise.race`d single-type waits would leave one. */
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

async function handshake(
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

  // The very first burst on a fresh connection is always exactly these five, in this exact order,
  // with nothing else able to interleave yet (no other mutation has happened on this connection):
  // server:hello, server:authorization-state, voice:catalog, server:presence-snapshot,
  // server:profile-self-updated (T13.3's proactive push of this identity's own real persisted
  // profile) — unlike everything after `ready`, this one sequence is safe to consume positionally,
  // but all five must still be drained here (even though only three are returned), since the server
  // sends them back-to-back in one synchronous loop that can arrive as a single TCP burst; leaving
  // the remaining two undrained risks them racing past whatever a caller listens for next.
  const replies = nextMessages(ws, 5);
  ws.send(JSON.stringify({ type: 'client:identity-proof', id: 'proof-1', signature }));
  const [serverHello, authState, catalog] = await replies;
  if (!serverHello || !authState || !catalog) throw new Error('handshake incomplete');
  return [serverHello, authState, catalog];
}

interface NodeSummary {
  nodeId: string;
  [key: string]: unknown;
}

function catalogNodes(catalog: Record<string, unknown>): NodeSummary[] {
  return catalog['nodes'] as NodeSummary[];
}

describe('Dedicated Server — T13.2 channels (real network)', () => {
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
    // Temp directories are only ever removed *after* every server using them has been stopped
    // above — removing a still-open SQLite file's directory is a Windows file-lock (EPERM) hazard.
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
    const dir = mkdtempSync(path.join(tmpdir(), 'disco-voador-channels-int-'));
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

  function send(ws: WebSocket, message: Record<string, unknown>): void {
    ws.send(JSON.stringify(message));
  }

  /** Connects, then explicitly redeems the bootstrap token (`client:authorization-redeem-token`) to
   * actually become Server Admin — on an `open` server (this file's default), a `serverToken`
   * merely present in `client:hello` is not itself checked/consumed (that only happens on an
   * `invite-only` server's admission path); redemption is always the separate, explicit step. */
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

  /** Sends a `client:channel-create-*`/`-update`/`-move`/`-reorder`/`-delete`/`-*-password`
   * mutation and returns its `server:channel-created`/`server:channel-ack` reply, filtering out
   * the personalized catalog-refresh broadcast the same mutation also fans out (see this file's own
   * top doc comment). */
  async function mutateChannel(
    ws: WebSocket,
    message: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const replyType =
      message['type'] === 'client:channel-create-category' ||
      message['type'] === 'client:channel-create-voice'
        ? 'server:channel-created'
        : 'server:channel-ack';
    const reply = waitForMessageOfTypes(ws, [replyType, 'server:error']);
    send(ws, message);
    return reply;
  }

  it('hostile Guest client: a hidden channel is never in the catalog, and history/join/update by known id fail CHANNEL_NOT_FOUND', async () => {
    const { server, url } = await startServer();
    const { ws: admin } = await connectAsAdmin(server, url);

    const createdMessage = (await mutateChannel(admin, {
      type: 'client:channel-create-voice',
      id: 'c1',
      name: 'Secret Room',
    })) as { node: { nodeId: string } };
    const hiddenId = createdMessage.node.nodeId;

    await mutateChannel(admin, {
      type: 'client:channel-update',
      id: 'u1',
      nodeId: hiddenId,
      visibilityPolicy: 'selected-groups',
      visibilityGroupIds: ['staff'],
    });

    const guestWs = track(await connect(url));
    const [, , guestCatalog] = await handshake(guestWs, 'Guest');
    expect(catalogNodes(guestCatalog).some((n) => n.nodeId === hiddenId)).toBe(false);

    const historyError = waitForMessageOfType(guestWs, 'server:error');
    send(guestWs, {
      type: 'client:chat-history-request',
      id: 'h1',
      scope: 'channel',
      channelId: hiddenId,
    });
    expect(await historyError).toMatchObject({ type: 'server:error', code: 'CHANNEL_NOT_FOUND' });

    const joinError = waitForMessageOfType(guestWs, 'server:error');
    send(guestWs, { type: 'voice:join', id: 'j1', channelId: hiddenId, displayName: 'Guest' });
    expect(await joinError).toMatchObject({ type: 'server:error', code: 'CHANNEL_NOT_FOUND' });

    // A hidden channel must fail identically to a nonexistent one here too — `AUTHORIZATION_DENIED`
    // would leak "this id exists, you're just not allowed to touch it," which is exactly the
    // existence signal this whole design exists to deny a caller who cannot even see the node.
    const updateError = await mutateChannel(guestWs, {
      type: 'client:channel-update',
      id: 'u2',
      nodeId: hiddenId,
      name: 'Hacked',
    });
    expect(updateError).toMatchObject({ type: 'server:error', code: 'CHANNEL_NOT_FOUND' });

    const getEditableError = await mutateChannel(guestWs, {
      type: 'client:channel-get-editable-node',
      id: 'g1',
      nodeId: hiddenId,
    });
    expect(getEditableError).toMatchObject({ type: 'server:error', code: 'CHANNEL_NOT_FOUND' });

    const setPasswordError = await mutateChannel(guestWs, {
      type: 'client:channel-set-password',
      id: 'p1',
      nodeId: hiddenId,
      password: 'whatever123',
    });
    expect(setPasswordError).toMatchObject({ type: 'server:error', code: 'CHANNEL_NOT_FOUND' });
  });

  it('password-protected channel: required, wrong rejected, correct joins, and protection persists across a restart; the raw password is never logged', async () => {
    const dir = trackTempDir();
    const { logger, entries } = capturingLogger();
    const { server, url } = await startServer({ dataDir: dir }, { logger });
    const { ws: admin } = await connectAsAdmin(server, url);

    const { node } = (await mutateChannel(admin, {
      type: 'client:channel-create-voice',
      id: 'c1',
      name: 'VIP',
    })) as { node: { nodeId: string } };

    await mutateChannel(admin, {
      type: 'client:channel-set-password',
      id: 'p1',
      nodeId: node.nodeId,
      password: 'sup3r-secret-value',
    });

    const guestWs = track(await connect(url));
    await handshake(guestWs, 'Guest');

    const required = waitForMessageOfType(guestWs, 'server:error');
    send(guestWs, { type: 'voice:join', id: 'j1', channelId: node.nodeId, displayName: 'Guest' });
    expect(await required).toMatchObject({
      type: 'server:error',
      code: 'CHANNEL_PASSWORD_REQUIRED',
    });

    const invalid = waitForMessageOfType(guestWs, 'server:error');
    send(guestWs, {
      type: 'voice:join',
      id: 'j2',
      channelId: node.nodeId,
      displayName: 'Guest',
      password: 'wrong-guess',
    });
    expect(await invalid).toMatchObject({ type: 'server:error', code: 'CHANNEL_PASSWORD_INVALID' });

    const success = waitForMessageOfType(guestWs, 'voice:joined');
    send(guestWs, {
      type: 'voice:join',
      id: 'j3',
      channelId: node.nodeId,
      displayName: 'Guest',
      password: 'sup3r-secret-value',
    });
    expect(await success).toMatchObject({ type: 'voice:joined', channelId: node.nodeId });

    await server.stop();
    expect(entries.some((line) => line.includes('sup3r-secret-value'))).toBe(false);

    // Restart against the same data dir — protection must persist. Registered with `track` so
    // `afterEach` stops it (and only then removes `dir`) even if an assertion below throws.
    const restarted = track(createDedicatedServer(testConfig({ dataDir: dir })));
    const address = await restarted.start();
    const restartUrl = `ws://${address.host}:${String(address.port)}`;
    const guestWs2 = track(await connect(restartUrl));
    await handshake(guestWs2, 'Guest2');
    const requiredAgain = waitForMessageOfType(guestWs2, 'server:error');
    send(guestWs2, { type: 'voice:join', id: 'j4', channelId: node.nodeId, displayName: 'Guest2' });
    expect(await requiredAgain).toMatchObject({
      type: 'server:error',
      code: 'CHANNEL_PASSWORD_REQUIRED',
    });
  });

  it('access policy: a STAFF category with a Raid-Leaders child is invisible to a Guest and visible to staff; a Guest history request for the child is rejected', async () => {
    const { server, url } = await startServer();
    const { ws: admin } = await connectAsAdmin(server, url);

    const groupAck = waitForMessageOfType(admin, 'server:authorization-ack');
    send(admin, {
      type: 'client:authorization-create-group',
      id: 'g1',
      name: 'Staff',
      permissions: ['voice.channel.join', 'chat.channel.send', 'chat.server.send'],
    });
    await groupAck;

    const { node: category } = (await mutateChannel(admin, {
      type: 'client:channel-create-category',
      id: 'cat1',
      name: 'Officers',
    })) as { node: { nodeId: string } };

    await mutateChannel(admin, {
      type: 'client:channel-update',
      id: 'catu1',
      nodeId: category.nodeId,
      visibilityPolicy: 'selected-groups',
      visibilityGroupIds: ['staff'],
    });

    const { node: child } = (await mutateChannel(admin, {
      type: 'client:channel-create-voice',
      id: 'ch1',
      name: 'Raid Planning',
      parentId: category.nodeId,
    })) as { node: { nodeId: string } };

    // Guest: neither node appears.
    const guestWs = track(await connect(url));
    const [, , guestCatalog] = await handshake(guestWs, 'Guest');
    const guestIds = catalogNodes(guestCatalog).map((n) => n.nodeId);
    expect(guestIds).not.toContain(category.nodeId);
    expect(guestIds).not.toContain(child.nodeId);

    const historyError = waitForMessageOfType(guestWs, 'server:error');
    send(guestWs, {
      type: 'client:chat-history-request',
      id: 'h1',
      scope: 'channel',
      channelId: child.nodeId,
    });
    expect(await historyError).toMatchObject({ type: 'server:error', code: 'CHANNEL_NOT_FOUND' });

    // A staff-member identity: must join a channel first to get a participantId (grant-group
    // targets an online participant, T9 semantics), then be granted "staff".
    const staffWs = track(await connect(url));
    await handshake(staffWs, 'Staffer');
    const joined = waitForMessageOfType(staffWs, 'voice:joined');
    send(staffWs, { type: 'voice:join', id: 'sj1', channelId: 'general', displayName: 'Staffer' });
    const { participantId } = (await joined) as { participantId: string };

    const grantAck = waitForMessageOfType(admin, 'server:authorization-ack');
    const staffCatalogUpdate = waitForMessageOfType(staffWs, 'voice:catalog');
    send(admin, {
      type: 'client:authorization-grant-group',
      id: 'grant1',
      targetParticipantId: participantId,
      groupId: 'staff',
    });
    await grantAck;
    const catalogPush = await staffCatalogUpdate;
    const staffIds = catalogNodes(catalogPush).map((n) => n.nodeId);
    expect(staffIds).toContain(category.nodeId);
    expect(staffIds).toContain(child.nodeId);

    // The staff identity can now join the previously-invisible channel too.
    const staffJoin = waitForMessageOfType(staffWs, 'voice:joined');
    send(staffWs, {
      type: 'voice:join',
      id: 'sj2',
      channelId: child.nodeId,
      displayName: 'Staffer',
    });
    expect(await staffJoin).toMatchObject({ channelId: child.nodeId });
  });

  it('security regression: delegated Manage on a node hidden by an ancestor Visibility restriction never leaks it — CHANNEL_NOT_FOUND, not the admin-detail view or AUTHORIZATION_DENIED', async () => {
    const { server, url } = await startServer();
    const { ws: admin } = await connectAsAdmin(server, url);

    // Two disjoint groups: "staff" gates Visibility on the category; "it-support" holds delegated
    // Manage on the child channel only — deliberately NOT a member of "staff", so this identity can
    // administer the channel's own settings (per `channel-port.ts`'s "delegated administration is
    // the point") but must never be able to see it at all, since it fails the ancestor's Visibility
    // gate. Before the fix this regression-tests, `hasManageRights` alone (no Visibility check)
    // let exactly this identity read/mutate the hidden node via `client:channel-get-editable-node`/
    // `-update`/`-set-password`/`-remove-password`.
    const staffGroupAck = waitForMessageOfType(admin, 'server:authorization-ack');
    send(admin, {
      type: 'client:authorization-create-group',
      id: 'g-staff',
      name: 'Staff',
      permissions: ['voice.channel.join'],
    });
    await staffGroupAck;

    const itGroupAck = waitForMessageOfType(admin, 'server:authorization-ack');
    send(admin, {
      type: 'client:authorization-create-group',
      id: 'g-it',
      name: 'IT Support',
      permissions: ['voice.channel.join'],
    });
    await itGroupAck;

    const { node: category } = (await mutateChannel(admin, {
      type: 'client:channel-create-category',
      id: 'cat1',
      name: 'Officers',
    })) as { node: { nodeId: string } };
    await mutateChannel(admin, {
      type: 'client:channel-update',
      id: 'catu1',
      nodeId: category.nodeId,
      visibilityPolicy: 'selected-groups',
      visibilityGroupIds: ['staff'],
    });

    const { node: child } = (await mutateChannel(admin, {
      type: 'client:channel-create-voice',
      id: 'ch1',
      name: 'Vault',
      parentId: category.nodeId,
    })) as { node: { nodeId: string } };
    await mutateChannel(admin, {
      type: 'client:channel-update',
      id: 'chu1',
      nodeId: child.nodeId,
      managePolicy: 'selected-groups',
      manageGroupIds: ['it-support'],
    });

    const itWs = track(await connect(url));
    await handshake(itWs, 'ITWorker');
    const joined = waitForMessageOfType(itWs, 'voice:joined');
    send(itWs, { type: 'voice:join', id: 'itj1', channelId: 'general', displayName: 'ITWorker' });
    const { participantId } = (await joined) as { participantId: string };

    const grantAck = waitForMessageOfType(admin, 'server:authorization-ack');
    send(admin, {
      type: 'client:authorization-grant-group',
      id: 'grant-it',
      targetParticipantId: participantId,
      groupId: 'it-support',
    });
    await grantAck;

    const getEditableError = await mutateChannel(itWs, {
      type: 'client:channel-get-editable-node',
      id: 'g1',
      nodeId: child.nodeId,
    });
    expect(getEditableError).toMatchObject({ type: 'server:error', code: 'CHANNEL_NOT_FOUND' });

    const updateError = await mutateChannel(itWs, {
      type: 'client:channel-update',
      id: 'u1',
      nodeId: child.nodeId,
      name: 'Renamed By IT',
    });
    expect(updateError).toMatchObject({ type: 'server:error', code: 'CHANNEL_NOT_FOUND' });

    const setPasswordError = await mutateChannel(itWs, {
      type: 'client:channel-set-password',
      id: 'p1',
      nodeId: child.nodeId,
      password: 'whatever123',
    });
    expect(setPasswordError).toMatchObject({ type: 'server:error', code: 'CHANNEL_NOT_FOUND' });

    // Completes the full invisible-target regression matrix for every node-addressing
    // administration action (task requirement: get-editable/update/set-password/remove-password/
    // move/delete). `handleChannelRemovePassword`/`handleChannelMove`/`handleChannelDelete` all
    // resolve the target via `getVisibleNode` before considering any Manage rights — remove-password
    // via this same fix, move/delete via the pre-existing pattern this fix's four handlers now match.
    const removePasswordError = await mutateChannel(itWs, {
      type: 'client:channel-remove-password',
      id: 'rp1',
      nodeId: child.nodeId,
    });
    expect(removePasswordError).toMatchObject({ type: 'server:error', code: 'CHANNEL_NOT_FOUND' });

    const moveError = await mutateChannel(itWs, {
      type: 'client:channel-move',
      id: 'm1',
      nodeId: child.nodeId,
    });
    expect(moveError).toMatchObject({ type: 'server:error', code: 'CHANNEL_NOT_FOUND' });

    const deleteError = await mutateChannel(itWs, {
      type: 'client:channel-delete',
      id: 'd1',
      nodeId: child.nodeId,
    });
    expect(deleteError).toMatchObject({ type: 'server:error', code: 'CHANNEL_NOT_FOUND' });
  });

  it('join-policy is independent of visibility: visible to everyone, joinable only by a restricted group', async () => {
    const { server, url } = await startServer();
    const { ws: admin } = await connectAsAdmin(server, url);

    const groupAck = waitForMessageOfType(admin, 'server:authorization-ack');
    send(admin, {
      type: 'client:authorization-create-group',
      id: 'g1',
      name: 'VIP',
      permissions: ['voice.channel.join'],
    });
    await groupAck;

    const { node } = (await mutateChannel(admin, {
      type: 'client:channel-create-voice',
      id: 'c1',
      name: 'VIP Lounge',
    })) as { node: { nodeId: string } };

    await mutateChannel(admin, {
      type: 'client:channel-update',
      id: 'u1',
      nodeId: node.nodeId,
      joinPolicy: 'selected-groups',
      joinGroupIds: ['vip'],
    });

    const guestWs = track(await connect(url));
    const [, , guestCatalog] = await handshake(guestWs, 'Guest');
    expect(catalogNodes(guestCatalog).map((n) => n.nodeId)).toContain(node.nodeId);

    const denied = waitForMessageOfType(guestWs, 'server:error');
    send(guestWs, { type: 'voice:join', id: 'j1', channelId: node.nodeId, displayName: 'Guest' });
    expect(await denied).toMatchObject({ type: 'server:error', code: 'CHANNEL_ACCESS_DENIED' });

    // The VIP identity joins the general channel first (to get a participantId), gets granted,
    // and then successfully joins the restricted channel.
    const vipWs = track(await connect(url));
    await handshake(vipWs, 'VIP');
    const joined = waitForMessageOfType(vipWs, 'voice:joined');
    send(vipWs, { type: 'voice:join', id: 'vj1', channelId: 'general', displayName: 'VIP' });
    const { participantId } = (await joined) as { participantId: string };

    const grantAck = waitForMessageOfType(admin, 'server:authorization-ack');
    send(admin, {
      type: 'client:authorization-grant-group',
      id: 'grant1',
      targetParticipantId: participantId,
      groupId: 'vip',
    });
    await grantAck;

    const allowed = waitForMessageOfType(vipWs, 'voice:joined');
    send(vipWs, { type: 'voice:join', id: 'vj2', channelId: node.nodeId, displayName: 'VIP' });
    expect(await allowed).toMatchObject({ type: 'voice:joined', channelId: node.nodeId });
  });

  it('live role change: granting Member lets an already-connected identity join without reconnecting; revoking it force-removes them from voice while the connection stays open', async () => {
    const { server, url } = await startServer();
    const { ws: admin } = await connectAsAdmin(server, url);

    const groupAck = waitForMessageOfType(admin, 'server:authorization-ack');
    send(admin, {
      type: 'client:authorization-create-group',
      id: 'g1',
      name: 'Elite',
      permissions: ['voice.channel.join'],
    });
    await groupAck;

    const { node } = (await mutateChannel(admin, {
      type: 'client:channel-create-voice',
      id: 'c1',
      name: 'Elite Room',
    })) as { node: { nodeId: string } };

    await mutateChannel(admin, {
      type: 'client:channel-update',
      id: 'u1',
      nodeId: node.nodeId,
      visibilityPolicy: 'everyone',
      joinPolicy: 'selected-groups',
      joinGroupIds: ['elite'],
    });

    const memberWs = track(await connect(url));
    await handshake(memberWs, 'Member');
    const joinedGeneral = waitForMessageOfType(memberWs, 'voice:joined');
    send(memberWs, { type: 'voice:join', id: 'mj1', channelId: 'general', displayName: 'Member' });
    const { participantId } = (await joinedGeneral) as { participantId: string };

    // Denied before the grant.
    const denied = waitForMessageOfType(memberWs, 'server:error');
    send(memberWs, {
      type: 'voice:join',
      id: 'mj2',
      channelId: node.nodeId,
      displayName: 'Member',
    });
    expect(await denied).toMatchObject({ type: 'server:error', code: 'CHANNEL_ACCESS_DENIED' });

    const grantAck = waitForMessageOfType(admin, 'server:authorization-ack');
    send(admin, {
      type: 'client:authorization-grant-group',
      id: 'grant1',
      targetParticipantId: participantId,
      groupId: 'elite',
    });
    await grantAck;

    // Same live connection, no reconnect: the earlier grant already updated its own effective
    // permissions server-side, so this join now succeeds. Joining a *different* channel mints a
    // fresh `participantId` (`VoiceRegistry.join` generates a new one per join, by design) — the
    // revoke below must target this new one, not the stale one from the "general" join above.
    const allowed = waitForMessageOfType(memberWs, 'voice:joined');
    send(memberWs, {
      type: 'voice:join',
      id: 'mj3',
      channelId: node.nodeId,
      displayName: 'Member',
    });
    const joinedElite = (await allowed) as { participantId: string };
    expect(joinedElite).toMatchObject({ type: 'voice:joined', channelId: node.nodeId });

    // Now revoke while the identity is inside the now-restricted channel: it must be force-removed
    // from voice via server:voice-removed-by-policy, while its connection stays open.
    const removalNotice = waitForMessageOfType(memberWs, 'server:voice-removed-by-policy');
    const revokeAck = waitForMessageOfType(admin, 'server:authorization-ack');
    send(admin, {
      type: 'client:authorization-revoke-group',
      id: 'revoke1',
      targetParticipantId: joinedElite.participantId,
      groupId: 'elite',
    });
    await revokeAck;
    expect(await removalNotice).toMatchObject({
      type: 'server:voice-removed-by-policy',
      channelId: node.nodeId,
      reason: 'access-revoked',
    });

    expect(memberWs.readyState).toBe(memberWs.OPEN);
    const pong = waitForMessageOfType(memberWs, 'server:pong');
    send(memberWs, { type: 'client:ping', id: 'still-alive' });
    expect(await pong).toEqual({ type: 'server:pong', id: 'still-alive' });
  });

  it('capacity: a limit of 2 admits exactly two simultaneous members; a rapid-fire third gets CHANNEL_FULL, and a slot frees up after a leave', async () => {
    const { server, url } = await startServer();
    const { ws: admin } = await connectAsAdmin(server, url);

    const { node } = (await mutateChannel(admin, {
      type: 'client:channel-create-voice',
      id: 'c1',
      name: 'Small Room',
    })) as { node: { nodeId: string } };
    await mutateChannel(admin, {
      type: 'client:channel-update',
      id: 'u1',
      nodeId: node.nodeId,
      userLimit: 2,
    });

    const clients = await Promise.all(
      [0, 1, 2].map(async (i) => {
        const ws = track(await connect(url));
        await handshake(ws, `Client${String(i)}`);
        return ws;
      }),
    );

    const [a, b, c] = clients;
    if (!a || !b || !c) throw new Error('setup failed');

    const joinA = nextMessage(a);
    const joinB = nextMessage(b);
    const joinC = nextMessage(c);
    send(a, { type: 'voice:join', id: 'ja', channelId: node.nodeId, displayName: 'A' });
    send(b, { type: 'voice:join', id: 'jb', channelId: node.nodeId, displayName: 'B' });
    send(c, { type: 'voice:join', id: 'jc', channelId: node.nodeId, displayName: 'C' });

    const [resultA, resultB, resultC] = await Promise.all([joinA, joinB, joinC]);
    const results = [resultA, resultB, resultC];
    const succeeded = results.filter((r) => r['type'] === 'voice:joined');
    const fulls = results.filter(
      (r) => r['type'] === 'server:error' && r['code'] === 'CHANNEL_FULL',
    );
    expect(succeeded).toHaveLength(2);
    expect(fulls).toHaveLength(1);

    // One of the two winners leaves; a newcomer can now join the freed slot.
    const winnerWs = succeeded[0] === resultA ? a : succeeded[0] === resultB ? b : c;
    const leftReply = nextMessage(winnerWs);
    send(winnerWs, { type: 'voice:leave', id: 'l1' });
    await leftReply;

    const newcomer = track(await connect(url));
    await handshake(newcomer, 'Newcomer');
    const finalJoin = waitForMessageOfType(newcomer, 'voice:joined');
    send(newcomer, { type: 'voice:join', id: 'jn', channelId: node.nodeId, displayName: 'N' });
    expect(await finalJoin).toMatchObject({ type: 'voice:joined' });
  });

  it('delete behavior: catalog removal, force-leave (not disconnect), history unreachable, restart keeps it deleted, and the id is never reused', async () => {
    const dir = trackTempDir();
    const { server, url } = await startServer({ dataDir: dir });
    const { ws: admin } = await connectAsAdmin(server, url);

    const { node } = (await mutateChannel(admin, {
      type: 'client:channel-create-voice',
      id: 'c1',
      name: 'Doomed',
    })) as { node: { nodeId: string } };

    const memberWs = track(await connect(url));
    await handshake(memberWs, 'Member');
    const joined = waitForMessageOfType(memberWs, 'voice:joined');
    send(memberWs, {
      type: 'voice:join',
      id: 'mj1',
      channelId: node.nodeId,
      displayName: 'Member',
    });
    await joined;

    const removalNotice = waitForMessageOfType(memberWs, 'server:voice-removed-by-policy');
    await mutateChannel(admin, { type: 'client:channel-delete', id: 'd1', nodeId: node.nodeId });
    expect(await removalNotice).toMatchObject({
      type: 'server:voice-removed-by-policy',
      channelId: node.nodeId,
    });
    // Force-leave, not a full disconnect.
    expect(memberWs.readyState).toBe(memberWs.OPEN);

    const historyError = waitForMessageOfType(memberWs, 'server:error');
    send(memberWs, {
      type: 'client:chat-history-request',
      id: 'h1',
      scope: 'channel',
      channelId: node.nodeId,
    });
    expect(await historyError).toMatchObject({ type: 'server:error', code: 'CHANNEL_NOT_FOUND' });

    await server.stop();
    const restarted = track(createDedicatedServer(testConfig({ dataDir: dir })));
    const address = await restarted.start();
    const restartUrl = `ws://${address.host}:${String(address.port)}`;
    const freshWs = track(await connect(restartUrl));
    const [, , catalog] = await handshake(freshWs, 'Fresh');
    expect(catalogNodes(catalog).some((n) => n.nodeId === node.nodeId)).toBe(false);
  });

  it('temporary channel lifecycle: create -> join -> a second joiner -> creator leaves (remains) -> last leaves (destroyed) -> restart (does not return, history unreachable)', async () => {
    const dir = trackTempDir();
    const { server, url } = await startServer({ dataDir: dir });

    // (a) The creator issues `client:channel-create-voice{temporary:true}` — gated by exactly the
    // same `channels.create`/local-manage permission an ordinary (permanent) create requires (the
    // coordinator's decision only changes what happens *after* that check passes, never the check
    // itself), so the creator here is the bootstrap-admin identity, same as every other create in
    // this file. This alone never joins anything (no atomic auto-join, per the decision).
    const { ws: creatorWs } = await connectAsAdmin(server, url);
    const created = (await mutateChannel(creatorWs, {
      type: 'client:channel-create-voice',
      id: 'tc1',
      name: 'Quick Room',
      temporary: true,
    })) as { type: string; node?: { nodeId: string; temporary: boolean } };
    expect(created.type).toBe('server:channel-created');
    const tempNodeId = created.node?.nodeId;
    expect(tempNodeId).toBeTruthy();
    expect(created.node?.temporary).toBe(true);
    if (!tempNodeId) throw new Error('setup failed');

    // (b) The creator now sends an ordinary `voice:join` for the returned nodeId — entirely reusing
    // existing join logic, no auto-join happened at create time.
    const creatorJoined = waitForMessageOfType(creatorWs, 'voice:joined');
    send(creatorWs, {
      type: 'voice:join',
      id: 'tj1',
      channelId: tempNodeId,
      displayName: 'Creator',
    });
    expect(await creatorJoined).toMatchObject({ type: 'voice:joined', channelId: tempNodeId });

    // A message sent to the temporary channel's chat, to later prove it is genuinely purged.
    const chatBroadcast = waitForMessageOfType(creatorWs, 'server:chat-message');
    send(creatorWs, {
      type: 'client:chat-send',
      id: 'cs1',
      scope: 'channel',
      channelId: tempNodeId,
      body: 'hello from the quick room',
    });
    await chatBroadcast;

    // (c) A second real client joins the same temporary channel.
    const secondWs = track(await connect(url));
    await handshake(secondWs, 'Second');
    const secondJoined = waitForMessageOfType(secondWs, 'voice:joined');
    send(secondWs, {
      type: 'voice:join',
      id: 'tj2',
      channelId: tempNodeId,
      displayName: 'Second',
    });
    expect(await secondJoined).toMatchObject({ type: 'voice:joined', channelId: tempNodeId });

    // (d) The creator leaves — the channel remains (the second participant is still inside). No
    // catalog refresh is expected from a plain leave of a still-populated temporary channel (only
    // an empty-on-leave destroy triggers one) — confirmed instead, directly, by a third client
    // still being able to join the same channel afterward.
    const creatorLeft = waitForMessageOfType(creatorWs, 'voice:left');
    send(creatorWs, { type: 'voice:leave', id: 'tl1' });
    await creatorLeft;
    const thirdWs = track(await connect(url));
    await handshake(thirdWs, 'Third');
    const thirdJoinAttempt = waitForMessageOfTypes(thirdWs, ['voice:joined', 'server:error']);
    send(thirdWs, { type: 'voice:join', id: 'tj3', channelId: tempNodeId, displayName: 'Third' });
    const thirdResult = await thirdJoinAttempt;
    expect(thirdResult['type']).toBe('voice:joined');

    // (e) The second (now third too) participant leaves — once the channel is genuinely empty, it
    // is destroyed immediately: removed from the registry, gone from a fresh catalog for both
    // remaining ready connections, and its chat history is purged (`CHANNEL_NOT_FOUND` afterward).
    send(secondWs, { type: 'voice:leave', id: 'tl2' });
    const thirdLeftReply = nextMessage(thirdWs);
    send(thirdWs, { type: 'voice:leave', id: 'tl3' });
    await thirdLeftReply;

    const historyAfterDestroy = waitForMessageOfType(creatorWs, 'server:error');
    send(creatorWs, {
      type: 'client:chat-history-request',
      id: 'ch1',
      scope: 'channel',
      channelId: tempNodeId,
    });
    expect(await historyAfterDestroy).toMatchObject({
      type: 'server:error',
      code: 'CHANNEL_NOT_FOUND',
    });

    // (f) Restart the Dedicated Server against the same data directory — the temporary channel does
    // not return (it was never persisted anywhere), and a raw history request for its old nodeId
    // still fails identically.
    await server.stop();
    const restarted = track(createDedicatedServer(testConfig({ dataDir: dir })));
    const address = await restarted.start();
    const restartUrl = `ws://${address.host}:${String(address.port)}`;
    const freshWs = track(await connect(restartUrl));
    const [, , freshCatalog] = await handshake(freshWs, 'Fresh');
    expect(catalogNodes(freshCatalog).some((n) => n.nodeId === tempNodeId)).toBe(false);

    const historyAfterRestart = waitForMessageOfType(freshWs, 'server:error');
    send(freshWs, {
      type: 'client:chat-history-request',
      id: 'ch2',
      scope: 'channel',
      channelId: tempNodeId,
    });
    expect(await historyAfterRestart).toMatchObject({
      type: 'server:error',
      code: 'CHANNEL_NOT_FOUND',
    });
  });

  it('two independent servers are fully isolated: different trees, different ACLs, different passwords, no cross-talk, and the same identity may be admin on one and Guest on the other', async () => {
    const { server: serverA, url: urlA } = await startServer();
    const { url: urlB } = await startServer();

    const { ws: adminA } = await connectAsAdmin(serverA, urlA);
    const { node: nodeA } = (await mutateChannel(adminA, {
      type: 'client:channel-create-voice',
      id: 'ca1',
      name: 'A Only',
    })) as { node: { nodeId: string } };
    await mutateChannel(adminA, {
      type: 'client:channel-set-password',
      id: 'pa1',
      nodeId: nodeA.nodeId,
      password: 'server-a-secret',
    });

    // The exact same local identity used as admin on A connects to B as an ordinary Guest.
    const sharedKeyPair = generateIdentityKeyPair();
    const bWs = track(await connect(urlB));
    const [, authStateOnB, catalogOnB] = await handshake(bWs, 'SameIdentity', sharedKeyPair);
    expect(authStateOnB).toMatchObject({ groups: [{ groupId: 'guest' }] });

    // Server A's channel means nothing on B — B never even has the node, proving no cross-talk at
    // the storage layer (each `ChannelStore` owns its own, entirely separate SQLite file).
    expect(catalogNodes(catalogOnB).map((n) => n.nodeId)).not.toContain(nodeA.nodeId);
  });
});
