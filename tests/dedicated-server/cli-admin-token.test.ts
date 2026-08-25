import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  generateIdentityKeyPair,
  signWithIdentityKey,
  type IdentityKeyPair,
} from '@disco-voador/identity';
import { buildIdentityAuthPayload, CURRENT_PROTOCOL_VERSION } from '@disco-voador/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import {
  AdminTokenCliError,
  mintServerAdminRecoveryToken,
  resolvesToSameRealPath,
} from '../../services/dedicated-server/src/cli-admin-token.js';
import { AuthorizationStore } from '../../services/dedicated-server/src/authorization/store.js';
import { SERVER_ADMIN_GROUP_ID } from '../../services/dedicated-server/src/authorization/permissions.js';
import type { DedicatedServerConfig } from '../../services/dedicated-server/src/config.js';
import {
  createDedicatedServer,
  type DedicatedServerHandle,
} from '../../services/dedicated-server/src/create-dedicated-server.js';

/**
 * T15 — `cli-admin-token.ts` tests. Two layers, matching this repo's existing convention (see
 * `mint-turn-credentials.test.ts` for pure-logic unit coverage vs `integration.test.ts` for
 * real-network proof):
 *
 * 1. Direct, fast tests of {@link mintServerAdminRecoveryToken} against a real (but standalone,
 *    non-running-server) `AuthorizationStore` file — the "never silently re-bootstrap" failure
 *    path, and a real store-level redemption proof.
 * 2. One real-network integration test: a genuine `DedicatedServerHandle` is started (simulating
 *    the live running server an operator would target) and, *while it is still running*, this same
 *    CLI logic function opens its own separate `AuthorizationStore` instance against the exact same
 *    data directory/file — proving genuinely new same-file concurrent-access safety no existing
 *    test covers (existing tests only prove cross-*file* isolation between different servers' own
 *    separate data directories).
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
    publicHost: undefined,
    deploymentScope: 'local',
    turn: undefined,
    ...overrides,
  };
}

describe('mintServerAdminRecoveryToken — direct store-level tests', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dv-cli-admin-token-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('fails with a clear AdminTokenCliError and never creates a store when the data directory has never been started', async () => {
    const authPath = path.join(dir, 'authorization.sqlite');

    await expect(mintServerAdminRecoveryToken(testConfig({ dataDir: dir }))).rejects.toThrow(
      AdminTokenCliError,
    );
    await expect(mintServerAdminRecoveryToken(testConfig({ dataDir: dir }))).rejects.toThrow(
      /never been started/u,
    );

    // The whole point of the pre-check: no fresh authorization.sqlite (and therefore no silent
    // re-bootstrap) was ever created as a side effect of the failed attempts above.
    expect(existsSync(authPath)).toBe(false);
  });

  it('fails with a clear AdminTokenCliError when the data directory itself does not exist at all', async () => {
    const missingDir = path.join(dir, 'never-created');
    await expect(mintServerAdminRecoveryToken(testConfig({ dataDir: missingDir }))).rejects.toThrow(
      AdminTokenCliError,
    );
  });

  it('mints a real Server Admin privilege token, genuinely redeemable via the store, once-only', async () => {
    const authPath = path.join(dir, 'authorization.sqlite');
    // Simulate "the server was started at least once before" by opening (and closing) a real
    // AuthorizationStore against this exact path first — this is what actually creates and seeds
    // the file, exactly like a real server's first startup does.
    const bootstrap = new AuthorizationStore(authPath, { accessMode: 'open' });
    bootstrap.close();

    const minted = await mintServerAdminRecoveryToken(testConfig({ dataDir: dir }));
    expect(minted.token).toMatch(/^DV-PRIV-/u);
    expect(minted.expiresAt).toBeDefined();
    // Bounded, sane default (24h) — not unbounded, not absurdly short.
    const now = Date.now();
    expect(minted.expiresAt).toBeGreaterThan(now);
    expect(minted.expiresAt).toBeLessThanOrEqual(now + 24 * 60 * 60 * 1000 + 5_000);

    const store = new AuthorizationStore(authPath, { accessMode: 'open' });
    const redeemed = store.redeemToken('identity-a', minted.token);
    expect(redeemed).toMatchObject({ ok: true, group: { groupId: SERVER_ADMIN_GROUP_ID } });

    const second = store.redeemToken('identity-b', minted.token);
    expect(second).toMatchObject({ ok: false, code: 'TOKEN_ALREADY_USED' });
    store.close();
  });
});

// --- Real-network same-file concurrent-access proof ----------------------------------------------

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

async function handshake(
  ws: WebSocket,
  nickname = 'Tester',
  keyPair: IdentityKeyPair = generateIdentityKeyPair(),
): Promise<Record<string, unknown>> {
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
  // server:profile-self-updated — same five-message burst every other integration test in this
  // suite drains (see integration.test.ts's own handshakeWithAuthState doc comment).
  const replies = nextMessages(ws, 5);
  ws.send(JSON.stringify({ type: 'client:identity-proof', id: 'proof-1', signature }));
  const [serverHello] = await replies;
  if (!serverHello) throw new Error('handshake incomplete');
  return serverHello;
}

describe('cli-admin-token — real-network same-file concurrent-access proof', () => {
  const servers: DedicatedServerHandle[] = [];
  const sockets: WebSocket[] = [];
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dv-cli-admin-token-live-'));
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) {
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.terminate();
    }
    for (const server of servers.splice(0)) {
      await server.stop();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  function track<T extends DedicatedServerHandle | WebSocket>(value: T): T {
    if (value instanceof WebSocket) sockets.push(value);
    else servers.push(value);
    return value;
  }

  it(
    'mints a token from a separate AuthorizationStore instance while the real server is still ' +
      'running, without disrupting it, and the minted token is genuinely redeemable exactly once ' +
      'through the real protocol',
    async () => {
      const server = track(createDedicatedServer(testConfig({ dataDir: dir })));
      const address = await server.start();
      const url = `ws://${address.host}:${String(address.port)}`;

      // A connection already `ready` before the recovery token is minted — proves the live server
      // keeps serving existing connections throughout the concurrent open below.
      const preExistingWs = track(await connect(url));
      await handshake(preExistingWs, 'AlreadyConnected');

      // The CLI's own logic function, opening a second, independent AuthorizationStore instance
      // against the exact same file the live server's own store already has open — this is the
      // genuinely new claim under test.
      const minted = await mintServerAdminRecoveryToken(server.config);
      expect(minted.token).toMatch(/^DV-PRIV-/u);

      // The pre-existing connection is still alive and responsive — minting did not disrupt the
      // live server.
      const pong = nextMessage(preExistingWs);
      preExistingWs.send(JSON.stringify({ type: 'client:ping', id: 'ping-after-mint' }));
      expect(await pong).toEqual({ type: 'server:pong', id: 'ping-after-mint' });
      expect(server.connectionCount).toBe(1);

      // The minted token is genuinely redeemable via the real protocol against the still-running
      // server.
      const redeemerWs = track(await connect(url));
      await handshake(redeemerWs, 'Recoverer');

      const redeemed = nextMessages(redeemerWs, 2);
      redeemerWs.send(
        JSON.stringify({
          type: 'client:authorization-redeem-token',
          id: 'redeem-recovery-1',
          token: minted.token,
        }),
      );
      const [redemption] = await redeemed;
      expect(redemption).toMatchObject({
        type: 'server:authorization-token-redeemed',
        group: { groupId: SERVER_ADMIN_GROUP_ID },
      });

      // A second redemption attempt with the exact same token, from a different connection, fails.
      const secondRedeemerWs = track(await connect(url));
      await handshake(secondRedeemerWs, 'SecondRecoverer');

      const rejection = nextMessage(secondRedeemerWs);
      secondRedeemerWs.send(
        JSON.stringify({
          type: 'client:authorization-redeem-token',
          id: 'redeem-recovery-2',
          token: minted.token,
        }),
      );
      expect(await rejection).toMatchObject({ type: 'server:error', code: 'TOKEN_ALREADY_USED' });
    },
  );
});

describe('resolvesToSameRealPath', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dv-cli-admin-token-realpath-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns false for two genuinely different real files, true for a path matching itself', () => {
    const a = path.join(dir, 'a.js');
    const b = path.join(dir, 'b.js');
    writeFileSync(a, '// a\n');
    writeFileSync(b, '// b\n');
    expect(resolvesToSameRealPath(a, a)).toBe(true);
    expect(resolvesToSameRealPath(a, b)).toBe(false);
  });

  it('returns false for a nonexistent path rather than throwing', () => {
    expect(resolvesToSameRealPath(path.join(dir, 'nope.js'), path.join(dir, 'also-nope.js'))).toBe(
      false,
    );
  });

  // T15 — the real bug found on the real VPS: native deployments invoke this script through
  // /opt/chantivo/current, a symlinked directory, while `import.meta.url` resolves to the real
  // (symlink-traversed) release path underneath it — `main()` silently never ran, so a locked-out
  // operator following the documented `admin-token create` recovery procedure got no token and no
  // error. This proves the exact fixed comparison against a real symlink on the real filesystem.
  // `'junction'` avoids requiring elevated privileges for the directory link on Windows.
  it('treats a file reached through a symlinked directory as matching its real path — the exact native-deployment shape (/opt/chantivo/current -> releases/<version>)', () => {
    const releasesRoot = path.join(dir, 'releases', '0.1.0');
    mkdirSync(releasesRoot, { recursive: true });
    const realFile = path.join(releasesRoot, 'cli-admin-token.js');
    writeFileSync(realFile, '// compiled entrypoint\n');

    const currentLink = path.join(dir, 'current');
    symlinkSync(releasesRoot, currentLink, 'junction');
    const pathThroughSymlink = path.join(currentLink, 'cli-admin-token.js');

    expect(path.resolve(pathThroughSymlink)).not.toBe(path.resolve(realFile));
    expect(resolvesToSameRealPath(pathThroughSymlink, realFile)).toBe(true);
  });
});
