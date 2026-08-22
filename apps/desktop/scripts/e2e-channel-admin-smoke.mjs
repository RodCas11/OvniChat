// T13.2 "Channels & Server Administration" end-to-end proof (see
// `docs/architecture/CHANNELS_AND_SERVER_ADMINISTRATION.md` and `services/realtime/src/
// channel-port.ts`'s own design doc comment). Follows T9's own established, deliberate convention
// (see `e2e-authorization.mjs`'s header comment): the administrator side is driven by a lightweight
// raw WebSocket client (T13.2's admin protocol surface already has deep coverage in
// `tests/dedicated-server/channel-store.test.ts`/`channels-integration.test.ts`); the real Electron
// value here is proving a Guest's actual product journey — catalog visibility, a live ACL grant
// taking effect with no reconnect, a real password prompt/retry cycle, a live rename/reparent
// observed without reconnecting, voice-channel capacity, and full state (including chat) surviving a
// real Dedicated Server restart — through the genuine Main/Preload/Renderer/IPC stack.
//
// Scenario:
//   Admin creates GAMES (category) -> "Path of Exile" (voice, under GAMES) -> "Bossing" (voice,
//   under Path of Exile) -- proves depth > 1 and parentId correctness.
//   Admin restricts "Path of Exile": joinPolicy selected-groups[member], userLimit 2, a password.
//   Guest (real Electron) connects, auto-joins the open "general" channel (to get onto the wire as
//   an observable participant at all), and its own catalog is observed to already contain "Path of
//   Exile" (visible; only *join* is restricted).
//   Guest's own connection, still open, makes two further SCRIPTED join attempts (real production
//   `actions.join()` calls, fired by a fixed timer -- see `DesktopE2EVoiceConfig.channelAdminRetry`'s
//   own doc comment) against "Path of Exile": the first (before any grant) is rejected
//   CHANNEL_ACCESS_DENIED; between the two, Admin grants Guest's identity the "member" group live
//   AND renames "Path of Exile" -> "PoE Endgame" AND reparents "Bossing" under GAMES directly; the
//   second scripted attempt is rejected CHANNEL_PASSWORD_REQUIRED instead -- proving the live ACL
//   grant took effect with NO reconnect -- and Guest's own received catalog (observed via its
//   `disco-voador:voice-catalog-nodes:...` marker) reflects the rename/reparent, also with no
//   reconnect.
//   Two further Electron launches of the SAME profile (same persistent identity/granted group --
//   mirrors `e2e-authorization.mjs`'s own proven relaunch technique) prove the password itself: wrong
//   password -> CHANNEL_PASSWORD_INVALID, right password -> a real, successful join -- this one stays
//   connected (relay-only, no self-exit) so the capacity scenario below can use it as a genuine
//   occupant.
//   Capacity: two raw-WS participants (granted "member" the same live way) fill "Path of Exile" to
//   its userLimit of 2 alongside Guest; a third raw-WS join attempt is rejected CHANNEL_FULL; one
//   occupant leaves; the same attempt then succeeds.
//   The Dedicated Server restarts against the SAME data directory; a fresh raw-WS connection confirms
//   "PoE Endgame" (renamed), its ACL, its password, and "Bossing"'s new parent all survived, and a
//   chat message sent before the restart is retrievable after it.
//
// Like the other new T13.2 scripts in this directory, every raw-WS-only failure path throws instead
// of calling `process.exit()` mid-flight, so `finally` always runs. The three Electron-instance
// phases mirror `e2e-authorization.mjs`'s own `runInstance`-style helper.
//
// Prerequisites: `pnpm --filter @disco-voador/dedicated-server run build` and
// `pnpm --filter @disco-voador/desktop exec electron-forge package` must have already been run.

import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';

import { buildElectronE2EEnvironment } from './lib/electron-e2e-env.mjs';
import {
  connectAdmin,
  connectAndAuthenticate,
  freshId,
  joinVoice,
  leaveVoice,
  sendChatMessage,
  sendRequest,
  waitForMessage,
  waitForMessageOfType,
} from './lib/raw-protocol-client.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mainEntry = path.join(desktopDir, '.vite', 'build', 'main.cjs');
const INSTANCE_TIMEOUT_MS = 40_000;
const CORRECT_PASSWORD = 'correct-horse-battery-staple';
const WRONG_PASSWORD = 'wrong-password-attempt';
const PRE_RESTART_CHAT_BODY = `POE_PRE_RESTART_${String(Date.now())}`;

if (!existsSync(mainEntry)) {
  throw new Error(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first (this also produces .vite/build/).`,
  );
}

/** Extracts every `disco-voador:voice-catalog-nodes:<json>` payload from accumulated stdout, in the
 * order they appeared — mirrors `e2e-text-chat-persistence.mjs`'s own `extractMarkerPayloads`. */
function extractCatalogSnapshots(stdout) {
  const prefix = 'disco-voador:voice-catalog-nodes:';
  const snapshots = [];
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf(prefix);
    if (idx === -1) continue;
    try {
      snapshots.push(JSON.parse(line.slice(idx + prefix.length)));
    } catch {
      // ignore a partial/interleaved line — see e2e-text-chat-persistence.mjs's identical comment
    }
  }
  return snapshots;
}

function firstIndexOf(haystack, needle) {
  return haystack.indexOf(needle);
}

/** Spawns one Electron instance against a caller-chosen profile. `exitOnMarker`, if given, arms
 * `armE2EChannelAdminExit` (self-`app.exit()` once that substring appears — safe to relaunch the
 * same profile afterward); if omitted, the instance is relay-only and must be `stop()`-ed externally
 * (used for the "stays connected for the capacity scenario" phase — mirrors
 * `e2e-text-chat-persistence.mjs`'s own external-kill convention, safe here specifically because
 * this script never relaunches the same profile again afterward). */
function spawnGuestInstance(label, userDataDir, realtimeUrl, extraEnv, exitOnMarker) {
  const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
    cwd: desktopDir,
    env: buildElectronE2EEnvironment(process.env, {
      DISCO_VOADOR_REALTIME_URL: realtimeUrl,
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      DISCO_VOADOR_E2E_CHANNEL_ADMIN: '1',
      ...(exitOnMarker ? { DISCO_VOADOR_E2E_EXIT_ON_MARKER: exitOnMarker } : {}),
      ...extraEnv,
    }),
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
        reject(new Error(`[${label}] timed out waiting for marker: ${pattern}`));
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
  }

  return { label, waitFor, stop, exitedPromise, getStdout: () => stdout };
}

/** Real filesystem check (T13.2 "password proof"): after a real password-protected join, no file
 * under this Electron profile's `userData` directory may contain the plaintext password anywhere —
 * a real, on-disk verification, not merely a code-reading claim. Recurses through every regular
 * file (bounded — this is a freshly created, tiny E2E profile directory, never a real user's). */
function assertPasswordNeverPersisted(userDataDir, plaintextPassword) {
  const stack = [userDataDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      let stats;
      try {
        stats = statSync(fullPath);
      } catch {
        continue;
      }
      // Bounded — never read a huge cache/log blob byte-for-byte; every file this profile could
      // plausibly persist the password into (settings.json, identity.json) is tiny.
      if (stats.size > 5 * 1024 * 1024) continue;
      let content;
      try {
        content = readFileSync(fullPath, 'utf8');
      } catch {
        continue; // binary/undecodable file — cannot contain the plaintext password as UTF-8 text
      }
      if (content.includes(plaintextPassword)) {
        throw new Error(`Password proof failed: "${fullPath}" contains the plaintext password.`);
      }
    }
  }
}

async function stopServer(server) {
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGTERM');
    await new Promise((resolve) => {
      server.child.once('exit', () => resolve());
    });
  }
}

/** Raw-WS convenience: joins the open "general" channel (to become an online participant at all),
 * has Admin observe the join and grant it "member" live, then leaves "general" again — mirrors the
 * exact `resolveTarget`-by-online-participantId constraint every T9/T13.2 admin action shares (see
 * `protocol-handlers.ts`'s `resolveTarget`). Used for the two extra raw-WS capacity participants. */
async function grantMemberViaGeneralChannel(adminWs, participantWs, displayName) {
  const adminSeesJoinPromise = waitForMessage(
    adminWs,
    (m) => m.type === 'voice:participant-joined' && m.participant.displayName === displayName,
    `voice:participant-joined for ${displayName}`,
  );
  await joinVoice(participantWs, 'general', displayName);
  const joinedEvent = await adminSeesJoinPromise;
  await sendRequest(
    adminWs,
    {
      type: 'client:authorization-grant-group',
      id: freshId('grant'),
      targetParticipantId: joinedEvent.participant.participantId,
      groupId: 'member',
    },
    ['server:authorization-ack'],
  );
  await leaveVoice(participantWs);
}

async function main() {
  const dataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-channel-admin-data-'));
  const guestUserDataDir = mkdtempSync(
    path.join(tmpdir(), 'disco-voador-e2e-channel-admin-guest-'),
  );
  let server;
  let adminWs;
  let cWs;
  let dWs;
  let guestPhase3;

  try {
    console.info('Starting Dedicated Server (real, file-backed data directory)...');
    server = await startDedicatedServer({ DISCO_VOADOR_SERVER_DATA_DIR: dataDir });
    const url = `ws://${server.host}:${String(server.port)}`;
    console.info(`Dedicated Server listening on ${server.host}:${String(server.port)}`);
    if (!server.bootstrapToken) throw new Error('Expected a bootstrap token on first startup');

    console.info('Connecting Admin and redeeming the bootstrap token...');
    const admin = await connectAdmin(url, 'Admin', server.bootstrapToken);
    adminWs = admin.ws;
    await waitForMessageOfType(adminWs, 'voice:catalog');

    console.info('Admin creates GAMES -> "Path of Exile" -> "Bossing"...');
    const games = await sendRequest(
      adminWs,
      { type: 'client:channel-create-category', id: freshId('create-games'), name: 'GAMES' },
      ['server:channel-created'],
    );
    const gamesId = games.node.nodeId;

    const poe = await sendRequest(
      adminWs,
      {
        type: 'client:channel-create-voice',
        id: freshId('create-poe'),
        name: 'Path of Exile',
        parentId: gamesId,
      },
      ['server:channel-created'],
    );
    const poeId = poe.node.nodeId;
    if (poe.node.parentId !== gamesId) {
      throw new Error(`"Path of Exile" was not created under GAMES: ${JSON.stringify(poe.node)}`);
    }

    const bossing = await sendRequest(
      adminWs,
      {
        type: 'client:channel-create-voice',
        id: freshId('create-bossing'),
        name: 'Bossing',
        parentId: poeId,
      },
      ['server:channel-created'],
    );
    const bossingId = bossing.node.nodeId;
    if (bossing.node.parentId !== poeId) {
      throw new Error(
        `"Bossing" was not created under Path of Exile: ${JSON.stringify(bossing.node)}`,
      );
    }
    console.info(`GAMES=${gamesId}, Path of Exile=${poeId}, Bossing=${bossingId}`);

    console.info(
      'Admin restricts "Path of Exile": joinPolicy selected-groups[member], userLimit 2...',
    );
    await sendRequest(
      adminWs,
      {
        type: 'client:channel-update',
        id: freshId('update-poe'),
        nodeId: poeId,
        joinPolicy: 'selected-groups',
        joinGroupIds: ['member'],
        userLimit: 2,
      },
      ['server:channel-ack'],
    );
    console.info('Admin sets a password on "Path of Exile"...');
    await sendRequest(
      adminWs,
      {
        type: 'client:channel-set-password',
        id: freshId('set-password'),
        nodeId: poeId,
        password: CORRECT_PASSWORD,
      },
      ['server:channel-ack'],
    );

    // --- Phase 1: real Electron Guest -- catalog visibility, live ACL grant with no reconnect, ----
    // ------------ live rename/reparent observed with no reconnect ---------------------------------
    console.info(
      'Launching Guest (real Electron): auto-joins "general", then two scripted retries...',
    );
    const guestPhase1 = spawnGuestInstance(
      'guest-1',
      guestUserDataDir,
      url,
      {
        DISCO_VOADOR_E2E_CONNECT_URL: url,
        DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
        DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Guest',
        DISCO_VOADOR_E2E_CHANNEL_ADMIN_RETRY_CHANNEL: poeId,
        DISCO_VOADOR_E2E_CHANNEL_ADMIN_RETRY1_AFTER_MS: '2000',
        DISCO_VOADOR_E2E_CHANNEL_ADMIN_RETRY2_AFTER_MS: '8000',
      },
      'disco-voador:server-error:CHANNEL_PASSWORD_REQUIRED',
    );

    await guestPhase1.waitFor('disco-voador:voice-joined:general');
    console.info(
      'Guest joined "general". Confirming its own catalog already contains "Path of Exile"...',
    );
    await guestPhase1.waitFor(`"nodeId":"${poeId}"`);
    const initialSnapshot = extractCatalogSnapshots(guestPhase1.getStdout()).at(-1);
    const initialPoeEntry = initialSnapshot?.find((n) => n.nodeId === poeId);
    if (!initialPoeEntry || initialPoeEntry.name !== 'Path of Exile') {
      throw new Error(
        `Guest's initial catalog did not show "Path of Exile": ${JSON.stringify(initialSnapshot)}`,
      );
    }
    console.info(
      'Confirmed: Guest sees "Path of Exile" in its own catalog (visible, not yet joinable).',
    );

    console.info('Waiting for the first scripted retry to be rejected CHANNEL_ACCESS_DENIED...');
    await guestPhase1.waitFor('disco-voador:server-error:CHANNEL_ACCESS_DENIED');
    const accessDeniedIndex = firstIndexOf(
      guestPhase1.getStdout(),
      'disco-voador:server-error:CHANNEL_ACCESS_DENIED',
    );
    console.info('Confirmed: rejected CHANNEL_ACCESS_DENIED (Guest does not yet hold "member").');

    console.info(
      'Admin grants Guest the "member" group live, renames "Path of Exile" -> "PoE Endgame", and ' +
        'reparents "Bossing" directly under GAMES -- all while Guest stays connected...',
    );
    const guestJoinedGeneralEvent = await waitForMessage(
      adminWs,
      (m) => m.type === 'voice:participant-joined' && m.participant.displayName === 'Guest',
      'voice:participant-joined for Guest',
    );
    await sendRequest(
      adminWs,
      {
        type: 'client:authorization-grant-group',
        id: freshId('grant-guest'),
        targetParticipantId: guestJoinedGeneralEvent.participant.participantId,
        groupId: 'member',
      },
      ['server:authorization-ack'],
    );
    await sendRequest(
      adminWs,
      {
        type: 'client:channel-update',
        id: freshId('rename-poe'),
        nodeId: poeId,
        name: 'PoE Endgame',
      },
      ['server:channel-ack'],
    );
    await sendRequest(
      adminWs,
      {
        type: 'client:channel-move',
        id: freshId('move-bossing'),
        nodeId: bossingId,
        newParentId: gamesId,
      },
      ['server:channel-ack'],
    );
    console.info('Admin actions acknowledged.');

    console.info(
      'Waiting for the second scripted retry to be rejected CHANNEL_PASSWORD_REQUIRED (replacing ' +
        'CHANNEL_ACCESS_DENIED -- proves the live grant took effect with no reconnect)...',
    );
    await guestPhase1.waitFor('disco-voador:server-error:CHANNEL_PASSWORD_REQUIRED');
    const passwordRequiredIndex = firstIndexOf(
      guestPhase1.getStdout(),
      'disco-voador:server-error:CHANNEL_PASSWORD_REQUIRED',
    );
    if (passwordRequiredIndex <= accessDeniedIndex) {
      throw new Error(
        'CHANNEL_PASSWORD_REQUIRED did not occur strictly after CHANNEL_ACCESS_DENIED.',
      );
    }
    console.info(
      'Confirmed: the live "member" grant took effect on the SAME connection, no reconnect.',
    );

    console.info(
      "Confirming Guest's own (still-connected) catalog now reflects the rename/reparent...",
    );
    // `armE2EChannelAdminExit` self-exits once the marker above already appeared; wait for the
    // process to actually finish before reading its final stdout.
    await guestPhase1.exitedPromise;
    const finalSnapshots = extractCatalogSnapshots(guestPhase1.getStdout());
    const lastSnapshot = finalSnapshots.at(-1);
    const renamedPoe = lastSnapshot?.find((n) => n.nodeId === poeId);
    const movedBossing = lastSnapshot?.find((n) => n.nodeId === bossingId);
    if (!renamedPoe || renamedPoe.name !== 'PoE Endgame') {
      throw new Error(
        `Guest's final catalog did not show the rename: ${JSON.stringify(renamedPoe)}`,
      );
    }
    if (!movedBossing || movedBossing.parentId !== gamesId) {
      throw new Error(
        `Guest's final catalog did not show Bossing's new parent: ${JSON.stringify(movedBossing)}`,
      );
    }
    console.info(
      'Confirmed: the already-connected Guest observed both the rename and the reparent without ' +
        'ever reconnecting.',
    );

    // --- Phase 2: wrong password (relaunch, same profile => same persistent identity/group) -------
    console.info('Relaunching Guest (same profile) with the WRONG password...');
    const guestPhase2 = spawnGuestInstance(
      'guest-2-wrong-password',
      guestUserDataDir,
      url,
      {
        DISCO_VOADOR_E2E_CONNECT_URL: url,
        DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: poeId,
        DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Guest',
        DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_PASSWORD: WRONG_PASSWORD,
      },
      'disco-voador:server-error:CHANNEL_PASSWORD_INVALID',
    );
    await guestPhase2.exitedPromise;
    if (!guestPhase2.getStdout().includes('disco-voador:server-error:CHANNEL_PASSWORD_INVALID')) {
      throw new Error('Wrong password did not produce CHANNEL_PASSWORD_INVALID.');
    }
    console.info('Confirmed: the wrong password is rejected with CHANNEL_PASSWORD_INVALID.');

    // --- Phase 3: right password -- real, successful join; stays connected for the capacity -------
    // ------------ scenario below (relay-only, no self-exit) ----------------------------------------
    console.info('Relaunching Guest (same profile) with the CORRECT password; stays connected...');
    guestPhase3 = spawnGuestInstance(
      'guest-3-correct-password',
      guestUserDataDir,
      url,
      {
        DISCO_VOADOR_E2E_CONNECT_URL: url,
        DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: poeId,
        DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Guest',
        DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_PASSWORD: CORRECT_PASSWORD,
      },
      undefined, // relay-only -- must stay connected for the capacity scenario below
    );
    await guestPhase3.waitFor(`disco-voador:voice-joined:${poeId}`);
    console.info('Confirmed: Guest successfully joined "PoE Endgame" with the correct password.');

    console.info(
      "Password proof: checking every file under Guest's own userData directory for the " +
        'plaintext password (must never be persisted anywhere)...',
    );
    assertPasswordNeverPersisted(guestUserDataDir, CORRECT_PASSWORD);
    assertPasswordNeverPersisted(guestUserDataDir, WRONG_PASSWORD);
    console.info(
      "Confirmed: no file in the Client's own profile ever contains the plaintext password.",
    );

    // --- Capacity: fill to userLimit (2), confirm CHANNEL_FULL, then confirm recovery --------------
    console.info('Filling "PoE Endgame" to its userLimit (2) with a raw-WS participant "C"...');
    const c = await connectAndAuthenticate(url, 'C');
    cWs = c.ws;
    await waitForMessageOfType(cWs, 'voice:catalog');
    await grantMemberViaGeneralChannel(adminWs, cWs, 'C');
    await joinVoice(cWs, poeId, 'C', CORRECT_PASSWORD);
    console.info('C joined -- "PoE Endgame" is now at capacity (Guest + C = 2/2).');

    console.info('Raw-WS participant "D" attempts to join -- expect CHANNEL_FULL...');
    const d = await connectAndAuthenticate(url, 'D');
    dWs = d.ws;
    await waitForMessageOfType(dWs, 'voice:catalog');
    await grantMemberViaGeneralChannel(adminWs, dWs, 'D');
    let capacityError;
    try {
      // Capacity is checked before the password step (see `channel-port.ts`'s documented evaluation
      // order: visibility -> join policy -> capacity -> password) -- D does not need the real
      // password to observe CHANNEL_FULL specifically.
      await joinVoice(dWs, poeId, 'D');
      throw new Error('D was able to join a channel already at its userLimit.');
    } catch (error) {
      if (!error.code) throw error;
      capacityError = error;
    }
    if (capacityError.code !== 'CHANNEL_FULL') {
      throw new Error(`Expected CHANNEL_FULL, got ${capacityError.code}`);
    }
    console.info('Confirmed: CHANNEL_FULL, as expected.');

    console.info('C leaves -- D retries and must now succeed...');
    await leaveVoice(cWs);
    await joinVoice(dWs, poeId, 'D', CORRECT_PASSWORD);
    console.info("Confirmed: once capacity freed up, D's retry succeeded.");

    // --- Restart persistence -------------------------------------------------------------------
    // Sent via `dWs`, not `adminWs`: `handleChatSend`'s channel-scope branch requires *current*
    // voice membership in that exact channel (T10 Section 8) -- Admin never actually joined "PoE
    // Endgame" itself (every admin action above was a channel-administration message, not a voice
    // join), whereas D is a genuine member at this point.
    console.info('D sends one chat message in "PoE Endgame" before the restart...');
    await sendChatMessage(dWs, 'channel', poeId, PRE_RESTART_CHAT_BODY);

    console.info('Tearing down every live connection before restarting the server...');
    await guestPhase3.stop();
    dWs.close();
    adminWs.close();
    await stopServer(server);

    console.info('Restarting the Dedicated Server against the SAME data directory...');
    server = await startDedicatedServer({ DISCO_VOADOR_SERVER_DATA_DIR: dataDir });
    const restartedUrl = `ws://${server.host}:${String(server.port)}`;
    console.info(`Dedicated Server listening again on ${server.host}:${String(server.port)}`);

    console.info('Connecting fresh and confirming every mutation survived the restart...');
    const fresh = await connectAndAuthenticate(restartedUrl, 'Verifier');
    const freshCatalog = await waitForMessageOfType(fresh.ws, 'voice:catalog');
    const freshPoe = freshCatalog.nodes.find((n) => n.nodeId === poeId);
    const freshBossing = freshCatalog.nodes.find((n) => n.nodeId === bossingId);
    if (!freshPoe || freshPoe.name !== 'PoE Endgame') {
      throw new Error(`Rename did not survive the restart: ${JSON.stringify(freshPoe)}`);
    }
    if (!freshPoe.hasPassword) {
      throw new Error('Password did not survive the restart.');
    }
    if (!freshBossing || freshBossing.parentId !== gamesId) {
      throw new Error(
        `Bossing's new parent did not survive the restart: ${JSON.stringify(freshBossing)}`,
      );
    }
    console.info('Confirmed: rename, password, and reparent all survived the restart.');

    console.info('Confirming the ACL (joinPolicy selected-groups[member]) survived the restart...');
    // `Verifier` is a fresh identity with no "member" grant -- if the ACL survived, this must still
    // be rejected (CHANNEL_ACCESS_DENIED comes before the password check, so this alone proves the
    // join-policy restriction, independent of the password check just proven above).
    let verifierError;
    try {
      await joinVoice(fresh.ws, poeId, 'Verifier', CORRECT_PASSWORD);
      throw new Error('A fresh, ungranted identity was able to join the ACL-restricted channel.');
    } catch (error) {
      if (!error.code) throw error;
      verifierError = error;
    }
    if (verifierError.code !== 'CHANNEL_ACCESS_DENIED') {
      throw new Error(`Expected CHANNEL_ACCESS_DENIED, got ${verifierError.code}`);
    }
    console.info('Confirmed: the join-policy ACL survived the restart.');

    console.info('Confirming the pre-restart chat message survived...');
    // Reading history requires no permission/membership beyond visibility (T10 Section 8, see
    // `handleChatHistoryRequest`'s own doc comment) -- already proven above via `Verifier`'s ACL
    // rejection (a non-visible channel would instead reject this with CHANNEL_NOT_FOUND); no fresh
    // group grant is needed here.
    const historyPage = await sendRequest(
      fresh.ws,
      {
        type: 'client:chat-history-request',
        id: freshId('chat-history-verify'),
        scope: 'channel',
        channelId: poeId,
      },
      ['server:chat-history-page'],
    );
    if (!historyPage.messages.some((m) => m.body === PRE_RESTART_CHAT_BODY)) {
      throw new Error('The pre-restart chat message did not survive the restart.');
    }
    fresh.ws.close();
    console.info('Confirmed: the pre-restart chat message survived the restart.');

    console.info(
      'E2E channel-admin-smoke test passed: full T13.2 administration journey proven end to end -- ' +
        'nested category/channel creation, live ACL grant with no reconnect, live rename/reparent ' +
        'observed with no reconnect, password prompt (wrong then right), the password never ' +
        'persisted on disk, voice-channel capacity (fill/full/recover), and every mutation plus a ' +
        'chat message surviving a real Dedicated Server restart.',
    );
  } finally {
    adminWs?.close();
    cWs?.close();
    dWs?.close();
    await guestPhase3?.stop();
    if (server) await stopServer(server);
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
    try {
      rmSync(guestUserDataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  }
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(
      `E2E channel-admin-smoke test failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
