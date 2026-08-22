// T13.2 ("Channels & Server Administration") Definition-of-Done screenshot evidence tool — NOT a
// permanent regression test and NOT wired to any `e2e:*` npm script, exactly mirroring
// `e2e-screenshot-capture.mjs`'s (T13.1) own precedent and its own doc comment's stated conventions:
// real Electron instances, real bookmarks/IPC/production actions, `console.info` marker-driven
// automation, and `Main`-process `webContents.capturePage()` calls triggered off those markers,
// driving already-existing UI buttons via `webContents.executeJavaScript` — "the exact same
// buttons/testids a human would click, clicked by script instead of a mouse."
//
// Unlike T13.1's tool, the representative server-side data here (the channel hierarchy, the
// password-protected and temporary channels, the "Moderator"/"Owner" groups, the two Lobby
// participants) is built via a lightweight raw WebSocket admin connection
// (`scripts/lib/raw-protocol-client.mjs`), per T9/T13.2's own established "drive the admin side of a
// scenario with a raw WS client, not a second Electron instance, when the protocol surface already
// has deep test coverage elsewhere" convention (see that file's own doc comment and
// `e2e-channel-admin-smoke.mjs`).
//
// Topology:
//   1. One real Dedicated Server, started with an empty `voiceChannels` seed (a temp config file) so
//      the legacy `general`/`games`/`afk` defaults never appear alongside this script's own
//      purpose-built hierarchy.
//   2. A raw-WS "Setup" connection redeems the one-time bootstrap token and builds:
//        GAMES (category) -> PoE Endgame (voice) -> Bossing, Mapping (voice subchannels)
//        GENERAL (category) -> Lobby (voice)
//        AFK (voice, top-level)
//        VIP Lounge (voice, top-level, password-protected)
//        Duo Room (voice, top-level, temporary)
//        "Moderator" group (a couple of real moderation permissions)
//        "Owner" group (every permission except `channels.password.bypass` — see its own creation
//        comment below for why this is a custom group, never the built-in `server-admin` one)
//      then restricts PoE Endgame's join policy to `selected-groups: [Moderator]` (real inheritance
//      source for Bossing/Mapping's own Edit-Channel ACL screenshot).
//   3. Two raw-WS participants ("Camila Ferreira", "João Pedro Alves") join Lobby and stay connected
//      throughout; a third ("Rafael Torres") joins Duo Room and stays connected, keeping the
//      temporary channel genuinely alive for its own screenshot.
//   4. A real Electron instance ("Server Admin") connects, auto-joins Lobby as an ordinary
//      participant (no token redeemed) — Setup observes its join, grants it the "Owner" group live
//      (mirroring `e2e-channel-admin-smoke.mjs`'s own live-grant proof: full admin rights land on an
//      already-connected session with no reconnect), then leaves Lobby again so the roster the
//      Admin's own screenshot shows is exactly Camila/João/Server Admin. `Main`'s own
//      `armE2EChannelAdminScreenshotCapture` (see `src/main/index.ts`) then drives every admin
//      surface and produces screenshots 01-11 and 13.
//   5. A second, independent real Electron instance ("Curious Guest") connects with no token
//      redeemed, auto-joins the open "AFK" channel, and `armE2EChannelGuestScreenshotCapture`
//      produces screenshot 12 — the same server's hierarchy with zero admin chrome.
//
// Prerequisites: `pnpm --filter @disco-voador/dedicated-server run build` and
// `pnpm --filter @disco-voador/desktop exec electron-forge package` must have already been run.

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { permissionKeySchema } from '@disco-voador/protocol';
import electronPath from 'electron';

import { buildElectronE2EEnvironment } from './lib/electron-e2e-env.mjs';
import {
  becomeServerAdmin,
  connectAndAuthenticate,
  freshId,
  joinVoice,
  leaveVoice,
  sendRequest,
  waitForMessage,
  waitForMessageOfType,
} from './lib/raw-protocol-client.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopDir, '.vite', 'build', 'main.cjs');
const OUTPUT_DIR =
  process.argv[2] ??
  'C:\\Users\\mutre\\AppData\\Local\\Temp\\claude\\e--Codigos-projeto-disco-voador\\8a73a95b-6ed7-47d7-9ff6-b6fd2dc4ff54\\scratchpad\\t13-2-screenshots';
const INSTANCE_TIMEOUT_MS = 60_000;
const VIP_LOUNGE_PASSWORD = 'harbor-lights-77';

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(mainEntry)) {
  fail(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first.`,
  );
}

mkdirSync(OUTPUT_DIR, { recursive: true });

function spawnCaptureInstance(label, extraEnv) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), `disco-voador-e2e-t13-2-${label}-`));
  const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
    cwd: desktopDir,
    env: buildElectronE2EEnvironment(process.env, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  const waiters = [];
  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(`[${label}] ${text}`);
    for (let i = waiters.length - 1; i >= 0; i -= 1) {
      if (stdout.includes(waiters[i].pattern)) {
        waiters[i].resolve();
        waiters.splice(i, 1);
      }
    }
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk.toString()}`));

  const exitedPromise = new Promise((resolve) => {
    child.once('exit', () => resolve());
  });

  function waitFor(pattern, timeoutMs = INSTANCE_TIMEOUT_MS) {
    if (stdout.includes(pattern)) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = waiters.findIndex((w) => w.resolve === resolve);
        if (idx !== -1) waiters.splice(idx, 1);
        reject(new Error(`[${label}] timed out waiting for: ${pattern}`));
      }, timeoutMs);
      waiters.push({
        pattern,
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
      });
    });
  }

  async function stop() {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await exitedPromise;
    }
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }

  return { label, waitFor, stop, exitedPromise };
}

async function stopServer(server) {
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGTERM');
    await new Promise((resolve) => {
      server.child.once('exit', () => resolve());
    });
  }
}

function reportFile(name) {
  const filePath = path.join(OUTPUT_DIR, name);
  if (!existsSync(filePath)) {
    console.error(`MISSING: ${filePath}`);
    return false;
  }
  const size = statSync(filePath).size;
  console.info(`${filePath} (${String(size)} bytes)`);
  return size > 1000;
}

async function main() {
  const emptySeedConfigDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-t13-2-server-cfg-'));
  const emptySeedConfigPath = path.join(emptySeedConfigDir, 'server-config.json');
  // An empty `voiceChannels` seed means the legacy `general`/`games`/`afk` defaults are never
  // created — this script builds its own, fully representative hierarchy from scratch instead (see
  // `services/dedicated-server/src/channels/store.ts`'s own `seedFreshDatabase` doc comment).
  writeFileSync(emptySeedConfigPath, JSON.stringify({ voiceChannels: [] }), 'utf8');

  let server;
  let setupWs;
  let camilaWs;
  let joaoWs;
  let rafaelWs;
  let adminInstance;
  let guestInstance;

  try {
    console.info(
      'Starting Dedicated Server (empty seed — this script builds its own hierarchy)...',
    );
    server = await startDedicatedServer({
      DISCO_VOADOR_SERVER_CONFIG_PATH: emptySeedConfigPath,
    });
    const url = `ws://${server.host}:${String(server.port)}`;
    console.info(`Dedicated Server listening on ${server.host}:${String(server.port)}`);
    if (!server.bootstrapToken) throw new Error('Expected a bootstrap token on first startup');

    console.info('Connecting Setup (raw WS) and redeeming the bootstrap token...');
    const setup = await connectAndAuthenticate(url, 'Setup');
    setupWs = setup.ws;
    await becomeServerAdmin(setupWs, server.bootstrapToken);
    await waitForMessageOfType(setupWs, 'voice:catalog');

    console.info('Building the real channel hierarchy...');
    const games = await sendRequest(
      setupWs,
      { type: 'client:channel-create-category', id: freshId('create-games'), name: 'GAMES' },
      ['server:channel-created'],
    );
    const gamesId = games.node.nodeId;

    const poe = await sendRequest(
      setupWs,
      {
        type: 'client:channel-create-voice',
        id: freshId('create-poe'),
        name: 'PoE Endgame',
        parentId: gamesId,
      },
      ['server:channel-created'],
    );
    const poeId = poe.node.nodeId;

    const bossing = await sendRequest(
      setupWs,
      {
        type: 'client:channel-create-voice',
        id: freshId('create-bossing'),
        name: 'Bossing',
        parentId: poeId,
      },
      ['server:channel-created'],
    );
    const bossingId = bossing.node.nodeId;

    const mapping = await sendRequest(
      setupWs,
      {
        type: 'client:channel-create-voice',
        id: freshId('create-mapping'),
        name: 'Mapping',
        parentId: poeId,
      },
      ['server:channel-created'],
    );
    const mappingId = mapping.node.nodeId;

    const generalCategory = await sendRequest(
      setupWs,
      { type: 'client:channel-create-category', id: freshId('create-general'), name: 'GENERAL' },
      ['server:channel-created'],
    );
    const generalCategoryId = generalCategory.node.nodeId;

    const lobby = await sendRequest(
      setupWs,
      {
        type: 'client:channel-create-voice',
        id: freshId('create-lobby'),
        name: 'Lobby',
        parentId: generalCategoryId,
      },
      ['server:channel-created'],
    );
    const lobbyId = lobby.node.nodeId;

    const afk = await sendRequest(
      setupWs,
      { type: 'client:channel-create-voice', id: freshId('create-afk'), name: 'AFK' },
      ['server:channel-created'],
    );
    const afkId = afk.node.nodeId;

    const vipLounge = await sendRequest(
      setupWs,
      { type: 'client:channel-create-voice', id: freshId('create-vip'), name: 'VIP Lounge' },
      ['server:channel-created'],
    );
    const vipLoungeId = vipLounge.node.nodeId;
    await sendRequest(
      setupWs,
      {
        type: 'client:channel-set-password',
        id: freshId('set-vip-password'),
        nodeId: vipLoungeId,
        password: VIP_LOUNGE_PASSWORD,
      },
      ['server:channel-ack'],
    );

    const duoRoom = await sendRequest(
      setupWs,
      {
        type: 'client:channel-create-voice',
        id: freshId('create-duo'),
        name: 'Duo Room',
        temporary: true,
      },
      ['server:channel-created'],
    );
    const duoRoomId = duoRoom.node.nodeId;

    console.info(
      `GAMES=${gamesId} PoE Endgame=${poeId} Bossing=${bossingId} Mapping=${mappingId} ` +
        `GENERAL=${generalCategoryId} Lobby=${lobbyId} AFK=${afkId} VIP Lounge=${vipLoungeId} ` +
        `Duo Room=${duoRoomId}`,
    );

    console.info('Creating the "Moderator" group with real moderation permissions...');
    await sendRequest(
      setupWs,
      {
        type: 'client:authorization-create-group',
        id: freshId('create-moderator-group'),
        name: 'Moderator',
        permissions: ['moderation.kick', 'moderation.ban'],
      },
      ['server:authorization-ack'],
    );
    const groupsList = await sendRequest(
      setupWs,
      { type: 'client:authorization-list-groups', id: freshId('list-groups') },
      ['server:authorization-groups'],
    );
    const moderatorGroup = groupsList.groups.find((g) => g.name === 'Moderator');
    if (!moderatorGroup) throw new Error('"Moderator" group was not found after creation');
    console.info(`Moderator group id=${moderatorGroup.groupId}`);

    // A CUSTOM near-omnipotent group, not the built-in `server-admin` group: the built-in group's
    // permission set is always the *complete* registry (see `permissions.ts`'s own doc comment,
    // "cannot be edited") — including `channels.password.bypass`, which would make the Admin
    // instance's own attempt to join the password-protected "VIP Lounge" below succeed silently
    // instead of producing the real password prompt this task's screenshot 08 needs. Every other
    // admin surface this script's screenshots exercise only needs the permissions actually listed
    // here, so this is a strictly more complete, still fully real proof (a real Server Admin
    // deployment could configure exactly this).
    console.info('Creating the "Owner" group (full admin rights, no password bypass)...');
    const ownerPermissions = permissionKeySchema.options.filter(
      (permission) => permission !== 'channels.password.bypass',
    );
    await sendRequest(
      setupWs,
      {
        type: 'client:authorization-create-group',
        id: freshId('create-owner-group'),
        name: 'Owner',
        permissions: ownerPermissions,
      },
      ['server:authorization-ack'],
    );
    const groupsListAfterOwner = await sendRequest(
      setupWs,
      { type: 'client:authorization-list-groups', id: freshId('list-groups-2') },
      ['server:authorization-groups'],
    );
    const ownerGroup = groupsListAfterOwner.groups.find((g) => g.name === 'Owner');
    if (!ownerGroup) throw new Error('"Owner" group was not found after creation');
    console.info(`Owner group id=${ownerGroup.groupId}`);

    console.info(
      'Restricting "PoE Endgame" join policy to Selected groups [Moderator] (a real inheritance ' +
        "source for Bossing/Mapping's own Edit-Channel screenshot)...",
    );
    await sendRequest(
      setupWs,
      {
        type: 'client:channel-update',
        id: freshId('restrict-poe'),
        nodeId: poeId,
        joinPolicy: 'selected-groups',
        joinGroupIds: [moderatorGroup.groupId],
      },
      ['server:channel-ack'],
    );

    console.info('Two real participants join "Lobby"; one joins the temporary "Duo Room"...');
    const camila = await connectAndAuthenticate(url, 'Camila Ferreira');
    camilaWs = camila.ws;
    await waitForMessageOfType(camilaWs, 'voice:catalog');
    await joinVoice(camilaWs, lobbyId, 'Camila Ferreira');

    const joao = await connectAndAuthenticate(url, 'João Pedro Alves');
    joaoWs = joao.ws;
    await waitForMessageOfType(joaoWs, 'voice:catalog');
    await joinVoice(joaoWs, lobbyId, 'João Pedro Alves');

    const rafael = await connectAndAuthenticate(url, 'Rafael Torres');
    rafaelWs = rafael.ws;
    await waitForMessageOfType(rafaelWs, 'voice:catalog');
    await joinVoice(rafaelWs, duoRoomId, 'Rafael Torres');
    console.info('Confirmed: Lobby has 2 real occupants; Duo Room is genuinely alive with 1.');

    // --- Admin instance -----------------------------------------------------------------------
    // Setup itself must also be a member of Lobby before it can ever observe the Admin instance's
    // own `voice:participant-joined` there — see `raw-protocol-client.mjs`'s `connectAdmin` doc
    // comment: this event is only ever broadcast to members of the *same* channel, never
    // server-wide. Setup leaves again immediately after granting below, so the Admin's own roster
    // screenshot shows only the real participants (Camila, João, Server Admin).
    console.info("Setup joins Lobby too, so it can observe the Admin instance's own join...");
    await joinVoice(setupWs, lobbyId, 'Setup');

    console.info('Launching the Server Admin Electron instance (joins Lobby with no token yet)...');
    adminInstance = spawnCaptureInstance('admin', {
      DISCO_VOADOR_E2E_CONNECT_URL: url,
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: lobbyId,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Server Admin',
      DISCO_VOADOR_E2E_T132_SCREENSHOT_ADMIN_DIR: OUTPUT_DIR,
      DISCO_VOADOR_E2E_T132_SCREENSHOT_ADMIN_GROUP_ID: ownerGroup.groupId,
      DISCO_VOADOR_E2E_T132_SCREENSHOT_POE_ENDGAME_ID: poeId,
      DISCO_VOADOR_E2E_T132_SCREENSHOT_BOSSING_ID: bossingId,
      DISCO_VOADOR_E2E_T132_SCREENSHOT_MAPPING_ID: mappingId,
      DISCO_VOADOR_E2E_T132_SCREENSHOT_VIP_LOUNGE_ID: vipLoungeId,
    });

    console.info('Waiting for Setup to observe the Admin instance joining Lobby...');
    const adminJoinedLobby = await waitForMessage(
      setupWs,
      (m) => m.type === 'voice:participant-joined' && m.participant.displayName === 'Server Admin',
      'voice:participant-joined for "Server Admin"',
    );
    console.info('Granting "Owner" live to the already-connected Admin instance...');
    await sendRequest(
      setupWs,
      {
        type: 'client:authorization-grant-group',
        id: freshId('grant-owner'),
        targetParticipantId: adminJoinedLobby.participant.participantId,
        groupId: ownerGroup.groupId,
      },
      ['server:authorization-ack'],
    );
    console.info(
      "Setup leaves Lobby again — the Admin's own roster shot must show only real users...",
    );
    await leaveVoice(setupWs);

    console.info('Waiting for every T13.2 admin screenshot to be saved...');
    const adminScreenshots = [
      '01-channel-hierarchy-admin-1920x1080.png',
      '09-temporary-channel.png',
      '02-channel-context-menu-admin.png',
      '08-channel-password-prompt.png',
      '10-server-settings-channels.png',
      '04-create-category.png',
      '03-create-channel.png',
      '05-edit-channel.png',
      '07-channel-permissions.png',
      '06-move-channel.png',
      '11-server-settings-permissions.png',
      '13-admin-1366x768.png',
    ];
    for (const name of adminScreenshots) {
      await adminInstance.waitFor(`E2E_SCREENSHOT_SAVED:${name}`);
      console.info(`${name} saved.`);
    }
    await adminInstance.waitFor('E2E_CHANNEL_ADMIN_SCREENSHOT_CAPTURE_DONE');
    await adminInstance.exitedPromise;
    console.info('Admin instance finished.');

    // --- Guest instance ------------------------------------------------------------------------
    console.info('Launching the Curious Guest Electron instance (no token redeemed)...');
    guestInstance = spawnCaptureInstance('guest', {
      DISCO_VOADOR_E2E_CONNECT_URL: url,
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: afkId,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Curious Guest',
      DISCO_VOADOR_E2E_T132_SCREENSHOT_GUEST_DIR: OUTPUT_DIR,
    });
    await guestInstance.waitFor('E2E_SCREENSHOT_SAVED:12-channel-sidebar-normal-user.png');
    console.info('12-channel-sidebar-normal-user.png saved.');
    await guestInstance.waitFor('E2E_CHANNEL_GUEST_SCREENSHOT_CAPTURE_DONE');
    await guestInstance.exitedPromise;
    console.info('Guest instance finished.');

    console.info('\n--- Screenshot files ---');
    const allNames = [
      '01-channel-hierarchy-admin-1920x1080.png',
      '02-channel-context-menu-admin.png',
      '03-create-channel.png',
      '04-create-category.png',
      '05-edit-channel.png',
      '06-move-channel.png',
      '07-channel-permissions.png',
      '08-channel-password-prompt.png',
      '09-temporary-channel.png',
      '10-server-settings-channels.png',
      '11-server-settings-permissions.png',
      '12-channel-sidebar-normal-user.png',
      '13-admin-1366x768.png',
    ];
    const allOk = allNames.map(reportFile).every(Boolean);
    if (!allOk) {
      fail('One or more screenshots are missing or implausibly small.');
    }
    console.info(`\nAll ${String(allNames.length)} screenshots captured successfully.`);
  } finally {
    setupWs?.close();
    camilaWs?.close();
    joaoWs?.close();
    rafaelWs?.close();
    await adminInstance?.stop();
    await guestInstance?.stop();
    if (server) await stopServer(server);
    try {
      rmSync(emptySeedConfigDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    fail(
      `T13.2 screenshot capture crashed: ${error instanceof Error ? error.stack : String(error)}`,
    );
  });
