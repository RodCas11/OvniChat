// T9 authorization E2E (Section 78): a real Electron client's full server-local authorization
// journey against a real Dedicated Server -- connect as a non-persistent Guest, redeem an invite
// token to become Member, get banned by an administrator, fail to reconnect while banned, get
// unbanned, and successfully reconnect -- proving real product wiring (T7 identity + T9
// authorization) through the actual Electron Main/Preload/Renderer/IPC stack, not just the
// protocol layer (already exhaustively covered by `tests/dedicated-server/integration.test.ts`'s
// real-socket suite).
//
// The administrator side (bootstrap redemption, invite-token creation, ban, unban) is driven by a
// lightweight raw WebSocket client within this script, not a second Electron instance -- T9's own
// spec explicitly allows this ("the test does not need to exercise every admin UI visual path if
// integration tests cover protocol deeply"), and that surface already has real-socket Vitest
// coverage. The real Electron value here is proving the *connecting user's* journey end to end,
// including the same local identity relaunched three times against the same `--user-data-dir`
// (mirroring `e2e-identity-persistence.mjs`'s proven relaunch technique) to observe how admission
// changes across a ban/unban cycle.
//
// Prerequisites: `pnpm --filter @disco-voador/dedicated-server run build` and
// `pnpm --filter @disco-voador/desktop exec electron-forge package` must have already been run.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generateIdentityKeyPair, signWithIdentityKey } from '@disco-voador/identity';
import { buildIdentityAuthPayload, CURRENT_PROTOCOL_VERSION } from '@disco-voador/protocol';
import electronPath from 'electron';
import { WebSocket } from 'ws';

import { buildElectronE2EEnvironment } from './lib/electron-e2e-env.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopDir, '.vite', 'build', 'main.cjs');
const INSTANCE_TIMEOUT_MS = 30_000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(mainEntry)) {
  fail(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first (this also produces .vite/build/).`,
  );
}

// --- Raw WebSocket admin client (mirrors services/dedicated-server/scripts/smoke.mjs) ----------

function nextMessage(ws, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for a message')), timeoutMs);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString('utf8')));
    });
  });
}

function nextMessages(ws, count, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const collected = [];
    const timer = setTimeout(() => {
      ws.off('message', handleMessage);
      reject(new Error(`Timed out waiting for ${String(count)} messages`));
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

async function connectAdmin(url, bootstrapToken) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const keyPair = generateIdentityKeyPair();
  const nickname = 'Admin';
  const challengePromise = nextMessage(ws);
  ws.send(
    JSON.stringify({
      type: 'client:hello',
      id: 'hello-1',
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      client: { name: 'e2e-authorization', version: '0.0.0' },
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

  const repliesPromise = nextMessages(ws, 3); // server:hello, server:authorization-state, voice:catalog
  ws.send(JSON.stringify({ type: 'client:identity-proof', id: 'proof-1', signature }));
  await repliesPromise;

  // Become Server Admin. Redeeming a token also triggers a fresh server:authorization-state push
  // (see protocol-handlers.ts's handleAuthorizationRedeemToken) -- both must be drained here via
  // one queued listener, or the leftover authorization-state message would desync every subsequent
  // nextMessage() call downstream (the same "racing once() listeners" bug class this project has
  // hit before -- see tests/dedicated-server/integration.test.ts's own handshake() helper).
  const repliesAfterRedeemPromise = nextMessages(ws, 2);
  ws.send(
    JSON.stringify({
      type: 'client:authorization-redeem-token',
      id: 'redeem-bootstrap',
      token: bootstrapToken,
    }),
  );
  const [redeemed] = await repliesAfterRedeemPromise;
  if (
    redeemed.type !== 'server:authorization-token-redeemed' ||
    redeemed.group.groupId !== 'server-admin'
  ) {
    throw new Error(`Bootstrap redemption failed: ${JSON.stringify(redeemed)}`);
  }

  // Join the default channel so voice:participant-joined events reveal Target's participantId.
  const joinedPromise = nextMessage(ws);
  ws.send(
    JSON.stringify({
      type: 'voice:join',
      id: 'admin-join',
      channelId: 'general',
      displayName: 'Admin',
    }),
  );
  await joinedPromise;

  return ws;
}

async function createInviteToken(adminWs, groupId) {
  const createdPromise = nextMessage(adminWs);
  adminWs.send(
    JSON.stringify({
      type: 'client:authorization-create-token',
      id: `create-invite-${String(Date.now())}`,
      tokenKind: 'invite',
      groupId,
    }),
  );
  const created = await createdPromise;
  if (created.type !== 'server:authorization-token-created') {
    throw new Error(`Token creation failed: ${JSON.stringify(created)}`);
  }
  return created.token;
}

/** Resolves once `voice:participant-joined` names `displayName`, giving the admin the target's
 * server-issued `participantId` -- never a client-supplied value. */
function waitForParticipantJoined(adminWs, displayName, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      adminWs.off('message', handleMessage);
      reject(new Error(`Timed out waiting for ${displayName} to join`));
    }, timeoutMs);

    function handleMessage(data) {
      const message = JSON.parse(data.toString('utf8'));
      if (
        message.type === 'voice:participant-joined' &&
        message.participant?.displayName === displayName
      ) {
        clearTimeout(timer);
        adminWs.off('message', handleMessage);
        resolve(message.participant.participantId);
      }
    }

    adminWs.on('message', handleMessage);
  });
}

async function banParticipant(adminWs, targetParticipantId) {
  const ackPromise = nextMessage(adminWs);
  adminWs.send(
    JSON.stringify({ type: 'client:authorization-ban', id: 'ban-1', targetParticipantId }),
  );
  const ack = await ackPromise;
  if (ack.type !== 'server:authorization-ack')
    throw new Error(`Ban failed: ${JSON.stringify(ack)}`);
}

async function unbanIdentity(adminWs, identityId) {
  const ackPromise = nextMessage(adminWs);
  adminWs.send(JSON.stringify({ type: 'client:authorization-unban', id: 'unban-1', identityId }));
  const ack = await ackPromise;
  if (ack.type !== 'server:authorization-ack')
    throw new Error(`Unban failed: ${JSON.stringify(ack)}`);
}

// --- Real Electron "Target" instances -----------------------------------------------------------

/**
 * Launches one unpackaged Electron instance and waits for it to exit *on its own* --
 * `DISCO_VOADOR_E2E_EXIT_ON_MARKER` (in `extraEnv`) tells Main which console marker to watch for
 * before calling `app.exit()` (see `armE2EAuthorizationExit` in `main/index.ts`). Deliberately
 * never `kill()`s this process on the success path: relaunching the *same* `--user-data-dir`
 * shortly after an externally-killed (not self-exited) instance produced a real, reproducible
 * `safeStorage`/DPAPI `decryptString` failure reading the same, never-corrupted `identity.json` --
 * found live while building this script. Electron's own orderly `app.exit()` shutdown does not
 * have this problem, matching the same technique `e2e-identity-persistence.mjs`'s own
 * relaunch-same-profile pattern already relies on.
 *
 * `sideEffectMarkerPattern`/`onSideEffectMarker`, if given, run a one-time side effect (here: the
 * admin banning this instance) partway through this instance's life, *before* it exits -- needed
 * because the exit marker itself (`BANNED`) can only ever appear *after* that side effect happens.
 */
function runInstance(label, userDataDir, extraEnv, sideEffectMarkerPattern, onSideEffectMarker) {
  return new Promise((resolve) => {
    const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
      cwd: desktopDir,
      env: buildElectronE2EEnvironment(process.env, extraEnv),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let settled = false;
    let sideEffectTriggered = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ stdout, exited: false });
    }, INSTANCE_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(`[${label}] ${text}`);
      if (!sideEffectTriggered && sideEffectMarkerPattern && sideEffectMarkerPattern.test(stdout)) {
        sideEffectTriggered = true;
        Promise.resolve(onSideEffectMarker?.()).catch((error) => {
          process.stderr.write(`[${label}] side effect failed: ${String(error)}\n`);
        });
      }
    });
    child.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk.toString()}`));

    child.on('exit', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, exited: true });
    });
  });
}

function extractLocalIdentityId(stdout) {
  return /disco-voador:local-identity-ready:(\S+)/.exec(stdout)?.[1];
}

async function main() {
  console.info('Starting Dedicated Server (open access)...');
  const { child: serverChild, host, port, bootstrapToken } = await startDedicatedServer();
  const url = `ws://${host}:${String(port)}`;
  console.info(`Dedicated Server listening on ${host}:${String(port)}`);
  if (!bootstrapToken) fail('Expected a bootstrap token on first startup');

  const userDataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-authz-'));
  let adminWs;

  try {
    console.info('Connecting the admin (raw protocol client) and redeeming the bootstrap token...');
    adminWs = await connectAdmin(url, bootstrapToken);
    console.info('Admin is now Server Admin.');

    console.info('Creating a Member invite token...');
    const inviteToken = await createInviteToken(adminWs, 'member');

    console.info('Launching Target, which will redeem the invite token, then get banned...');
    const targetJoinedPromise = waitForParticipantJoined(adminWs, 'Target');
    let targetParticipantId;
    const firstRun = await runInstance(
      'target-1',
      userDataDir,
      {
        DISCO_VOADOR_REALTIME_URL: 'ws://127.0.0.1:1',
        DISCO_VOADOR_E2E_CONNECT_URL: url,
        DISCO_VOADOR_E2E_REDEEM_TOKEN: inviteToken,
        DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
        DISCO_VOADOR_E2E_AUTHORIZATION: '1',
        DISCO_VOADOR_E2E_EXIT_ON_MARKER: 'disco-voador:server-error:BANNED',
        DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
        DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Target',
      },
      // The redemption side effect (join observed -> ban) fires partway through this instance's
      // life; the instance itself then observes BANNED on its own connection and self-exits.
      /disco-voador:my-groups:member/u,
      async () => {
        targetParticipantId = await targetJoinedPromise;
        console.info(`Admin observed Target join as participant ${targetParticipantId}.`);
        console.info('Admin bans Target...');
        await banParticipant(adminWs, targetParticipantId);
      },
    );
    if (!firstRun.exited) fail('Target (run 1) never exited.');
    if (!/disco-voador:my-groups:member/u.test(firstRun.stdout)) {
      fail('Target never reported becoming Member after redeeming the invite.');
    }
    if (!/disco-voador:server-error:BANNED/u.test(firstRun.stdout)) {
      fail('Target never observed its own live ban.');
    }
    const targetIdentityId = extractLocalIdentityId(firstRun.stdout);
    if (!targetIdentityId) fail('Target never reported its local identityId.');
    if (!targetParticipantId) fail('Admin never observed Target join the voice channel.');
    console.info(`Target became Member then was banned live (identityId ${targetIdentityId}).`);

    console.info('Relaunching Target (same profile) -- must be rejected while banned...');
    const secondRun = await runInstance('target-2-banned', userDataDir, {
      DISCO_VOADOR_REALTIME_URL: 'ws://127.0.0.1:1',
      DISCO_VOADOR_E2E_CONNECT_URL: url,
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      DISCO_VOADOR_E2E_AUTHORIZATION: '1',
      DISCO_VOADOR_E2E_EXIT_ON_MARKER: 'disco-voador:server-error:BANNED',
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Target',
    });
    if (!secondRun.exited || !/disco-voador:server-error:BANNED/u.test(secondRun.stdout)) {
      fail('Banned Target was not rejected with BANNED on reconnect.');
    }
    console.info('Confirmed: banned Target cannot reconnect.');

    console.info('Admin unbans Target...');
    await unbanIdentity(adminWs, targetIdentityId);

    console.info('Relaunching Target (same profile) -- must succeed and remain Member...');
    const thirdRun = await runInstance('target-3-unbanned', userDataDir, {
      DISCO_VOADOR_REALTIME_URL: 'ws://127.0.0.1:1',
      DISCO_VOADOR_E2E_CONNECT_URL: url,
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      DISCO_VOADOR_E2E_AUTHORIZATION: '1',
      DISCO_VOADOR_E2E_EXIT_ON_MARKER: 'disco-voador:my-groups:member',
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Target',
    });
    if (
      !thirdRun.exited ||
      !/disco-voador:my-groups:member/u.test(thirdRun.stdout) ||
      /disco-voador:server-error:BANNED/u.test(thirdRun.stdout)
    ) {
      fail('Unbanned Target failed to reconnect as Member.');
    }
    const finalIdentityId = extractLocalIdentityId(thirdRun.stdout);
    if (finalIdentityId !== targetIdentityId) {
      fail(
        `Reconnected Target reported a different identityId (${String(finalIdentityId)} !== ${targetIdentityId}) -- the local identity must never change across this flow.`,
      );
    }

    console.info(
      'E2E authorization test passed: bootstrap -> Server Admin, invite redemption -> Member, ' +
        'ban -> rejected reconnect, unban -> successful reconnect as the same persistent identity.',
    );
    process.exit(0);
  } finally {
    adminWs?.close();
    serverChild.kill();
    rmSync(userDataDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  fail(`E2E authorization test crashed: ${error instanceof Error ? error.message : String(error)}`);
});
