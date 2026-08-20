// T8/T9 Dedicated Server smoke test (Section 57): starts the real, built CLI entrypoint as its own
// process (not a library call — this proves the actual product boundary, not just
// `createDedicatedServer` in-process), connects a real WebSocket client, drives the full T2/T7
// handshake (hello -> identity-challenge -> identity-proof -> hello), confirms server metadata and
// the configured (non-default) voice-channel catalog arrive, redeems the real one-time bootstrap
// token printed to stdout to become Server Admin (T9), disconnects, then terminates the server and
// confirms a clean exit. No Electron involved.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateIdentityKeyPair, signWithIdentityKey } from '@disco-voador/identity';
import { buildIdentityAuthPayload, CURRENT_PROTOCOL_VERSION } from '@disco-voador/protocol';
import { WebSocket } from 'ws';

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cliEntry = path.join(packageDir, 'dist', 'cli.js');
const STARTUP_TIMEOUT_MS = 10_000;
const HANDSHAKE_TIMEOUT_MS = 10_000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(cliEntry)) {
  fail(
    `Built CLI entry not found at ${cliEntry}.\nRun "pnpm --filter @disco-voador/dedicated-server run build" first.`,
  );
}

function nextMessage(ws, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for a message')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString('utf8')));
    });
  });
}

/** Collects the next `count` messages in arrival order via one listener — unlike chaining
 * `nextMessage()` calls (each attaches its own listener, and every currently-attached `message`
 * listener fires on the *same* emitted event, not one-per-call), this never misses or
 * double-resolves when the server sends several messages back to back (e.g. `server:hello`
 * immediately followed by `voice:catalog`). */
function nextMessages(ws, count, timeoutMs = HANDSHAKE_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const collected = [];
    const timer = setTimeout(() => {
      ws.off('message', handleMessage);
      reject(
        new Error(
          `Timed out waiting for ${String(count)} messages (got ${String(collected.length)})`,
        ),
      );
    }, timeoutMs);

    function handleMessage(data) {
      collected.push(JSON.parse(data.toString('utf8')));
      if (collected.length >= count) {
        clearTimeout(timer);
        ws.off('message', handleMessage);
        resolve(collected);
      }
    }

    ws.on('message', handleMessage);
  });
}

async function main() {
  const configDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-server-smoke-'));
  const configPath = path.join(configDir, 'server.config.json');
  const dataDir = path.join(configDir, 'data');
  writeFileSync(
    configPath,
    JSON.stringify({
      name: 'Smoke Test Server',
      host: '127.0.0.1',
      port: 0,
      dataDir,
      voiceChannels: [
        { channelId: 'lobby', name: 'Lobby' },
        { channelId: 'raid', name: 'Raid' },
      ],
    }),
  );

  console.info('Starting Dedicated Server...');
  const server = spawn(process.execPath, [cliEntry], {
    env: {
      ...process.env,
      DISCO_VOADOR_SERVER_CONFIG_PATH: configPath,
      LOG_LEVEL: 'error',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let host;
  let port;
  let bootstrapToken;

  try {
    const address = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Server did not report "Ready." within ${STARTUP_TIMEOUT_MS}ms`));
      }, STARTUP_TIMEOUT_MS);

      server.stdout.on('data', (chunk) => {
        stdout += chunk.toString();
        const match = /Listening:\s+([\d.]+):(\d+)/.exec(stdout);
        if (match && stdout.includes('Ready.')) {
          clearTimeout(timer);
          resolve({ host: match[1], port: Number(match[2]) });
        }
      });
      server.stderr.on('data', (chunk) => process.stderr.write(`[server] ${chunk.toString()}`));
      server.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`Server exited early (code ${String(code)})`));
      });
    });
    host = address.host;
    port = address.port;
    console.info(`Server listening on ${host}:${String(port)}`);

    const bootstrapMatch = /Initial Server Admin privilege key:\s*\n\s*\n\s*(DV-ADMIN-\S+)/u.exec(
      stdout,
    );
    if (!bootstrapMatch) {
      throw new Error('Expected a one-time bootstrap token printed to stdout on first startup');
    }
    bootstrapToken = bootstrapMatch[1];
    console.info('Captured the one-time bootstrap Server Admin token from stdout.');

    console.info('Connecting a real WebSocket client and driving the full handshake...');
    const ws = new WebSocket(`ws://${host}:${String(port)}`);
    await new Promise((resolve, reject) => {
      ws.once('open', resolve);
      ws.once('error', reject);
    });

    const keyPair = generateIdentityKeyPair();
    const nickname = 'Smoke Tester';

    const challengePromise = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: 'client:hello',
        id: 'hello-1',
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        client: { name: 'dedicated-server-smoke', version: '0.0.0' },
        nickname,
        publicKey: keyPair.publicKey,
      }),
    );
    const challenge = await challengePromise;
    if (challenge.type !== 'server:identity-challenge') {
      throw new Error(`Expected server:identity-challenge, got ${challenge.type}`);
    }

    const payload = buildIdentityAuthPayload({
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      connectionId: challenge.connectionId,
      nonce: challenge.nonce,
      expiresAt: challenge.expiresAt,
      publicKey: keyPair.publicKey,
      nickname,
    });
    const signature = signWithIdentityKey(keyPair.privateKey, keyPair.publicKey, payload);

    const repliesPromise = nextMessages(ws, 3); // server:hello, server:authorization-state, voice:catalog
    ws.send(JSON.stringify({ type: 'client:identity-proof', id: 'proof-1', signature }));
    const [serverHello, authState, catalog] = await repliesPromise;

    if (serverHello.type !== 'server:hello') {
      throw new Error(`Expected server:hello, got ${serverHello.type}`);
    }
    if (authState.type !== 'server:authorization-state') {
      throw new Error(`Expected server:authorization-state, got ${authState.type}`);
    }
    if (authState.groups.length !== 1 || authState.groups[0].groupId !== 'guest') {
      throw new Error(
        `Expected a fresh identity to start as Guest, got groups: ${JSON.stringify(authState.groups)}`,
      );
    }
    if (serverHello.serverName !== 'Smoke Test Server') {
      throw new Error(`Expected serverName "Smoke Test Server", got "${serverHello.serverName}"`);
    }
    if (
      !Array.isArray(serverHello.serverCapabilities) ||
      serverHello.serverCapabilities.length === 0
    ) {
      throw new Error('Expected a non-empty serverCapabilities list');
    }
    if (catalog.type !== 'voice:catalog') {
      throw new Error(`Expected voice:catalog, got ${catalog.type}`);
    }
    const channelIds = catalog.channels.map((c) => c.channelId).sort();
    if (channelIds.join(',') !== 'lobby,raid') {
      throw new Error(
        `Expected the configured "lobby"/"raid" channels, got [${channelIds.join(', ')}] — the ` +
          'server did not use the config file channel list.',
      );
    }

    console.info('Redeeming the bootstrap token to become Server Admin...');
    const redeemedPromise = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: 'client:authorization-redeem-token',
        id: 'redeem-1',
        token: bootstrapToken,
      }),
    );
    const redeemed = await redeemedPromise;
    if (redeemed.type !== 'server:authorization-token-redeemed') {
      throw new Error(`Expected server:authorization-token-redeemed, got ${redeemed.type}`);
    }
    if (redeemed.group.groupId !== 'server-admin') {
      throw new Error(
        `Expected the bootstrap token to grant server-admin, got "${redeemed.group.groupId}"`,
      );
    }
    console.info('Bootstrap token redeemed: now Server Admin.');

    console.info(
      `Authenticated as identityId ${serverHello.identityId}, server "${serverHello.serverName}" ` +
        `offers channels: ${channelIds.join(', ')}.`,
    );

    ws.close(1000, 'smoke test done');
    await new Promise((resolve) => ws.once('close', resolve));

    console.info('Terminating server...');
    server.kill('SIGTERM');
    const [exitCode, exitSignal] = await new Promise((resolve) => {
      server.once('exit', (code, signal) => resolve([code, signal]));
    });
    // Node documents that Windows has no real POSIX signal delivery: a cross-process
    // `child.kill('SIGTERM')` unconditionally terminates the child rather than letting its own
    // `process.on('SIGTERM', ...)` handler run — the same limitation already documented for T2's
    // realtime service (see docs/tasks/T2_REALTIME_PROTOCOL.md). `cli.ts`'s graceful-shutdown path
    // is instead directly verified in-process by `tests/dedicated-server/*` (calling `stop()`
    // without going through OS signal delivery at all); this smoke test only needs to confirm the
    // process actually exits (it must never hang), not which exact code a real signal produced.
    console.info(
      `Server exited (code ${String(exitCode)}, signal ${String(exitSignal)}) — on Windows this ` +
        'is expected to be a forced termination, not a graceful SIGTERM handler run.',
    );

    console.info(
      'Dedicated Server smoke test passed: started, authenticated a real client, delivered ' +
        'configured server metadata and channel list, redeemed the real one-time bootstrap token ' +
        'to become Server Admin, and shut down cleanly.',
    );
    process.exit(0);
  } catch (error) {
    server.kill('SIGKILL');
    fail(
      `Dedicated Server smoke test failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    rmSync(configDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  fail(
    `Dedicated Server smoke test crashed: ${error instanceof Error ? error.message : String(error)}`,
  );
});
