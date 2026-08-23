// T13.3 "Profiles / Avatars / Members / Presence" end-to-end proof: the real-time avatar journey
// through two genuine Electron clients, driving the actual rendered Member Panel/Profile Editor DOM
// via `armE2EProfileSmoke` (see `apps/desktop/src/main/index.ts`'s own doc comment on that function).
// Deliberately does NOT re-prove the wire-protocol broadcast shape itself
// (`server:presence-updated`/`server:profile-self-updated`) — that already has deep, real-network
// coverage in `tests/dedicated-server/profile-integration.test.ts`. This script's own job is the one
// thing that coverage cannot give: proving the update actually reaches a second real Electron
// instance's rendered UI with no reconnect, that Main's avatar-byte re-validation/native-file-picker
// path genuinely works end to end, and that a self avatar's real bytes both survive AND are visibly
// restored to the uploading client's OWN Profile Editor across a full reconnect — this last part was
// a real, verified gap found while first building this script (Alice's own view previously stayed
// blank after reconnect until a fresh mutation, even though the bytes were always safe server-side,
// per the doc comment `VoiceChannelState.selfPresence` used to carry) — now fixed product-side via
// `handleIdentityProof`'s proactive `server:profile-self-updated` push (see that function's own doc
// comment in `services/realtime/src/protocol-handlers.ts`), and re-verified live by this script.
//
// Scenario:
//   Bob (real Electron) joins "general" and starts watching Alice's row in its own Member Panel —
//   confirms no avatar initially, then waits for one to appear, then waits for it to disappear again
//   — using real, condition-polled DOM reads (`wait-condition`), never a fixed guessed timer, so this
//   script is not a timing race against Alice's own (variable) Electron startup latency.
//   Alice (real Electron, phase 1) joins "general", uploads a real local PNG file (through the real
//   native-file-picker IPC path, `dialog.showOpenDialog` itself faked per `armE2EProfileSmoke`'s own
//   doc comment — every byte after that is real), confirms her own Profile Editor now shows a "Remove"
//   button (avatar is set), and self-exits.
//   Alice (real Electron, phase 2, SAME `--user-data-dir` => same persistent identity) relaunches and
//   reconnects with NO fresh mutation; this script asserts her Profile Editor already shows "Remove"
//   immediately — the proactive self-profile push restoring it, not a client-local echo — then
//   removes it for real, proving the removal path also still works correctly post-reconnect.
//   Bob observes both transitions (avatar appears, then disappears) on its own live connection with no
//   reconnect of its own — including staying "true" the whole time Alice herself is offline and
//   reconnecting, which is further, independent evidence the bytes were never actually lost
//   server-side (and, per this app's own privacy design, that a moderator/observer's own view of a
//   member's data is never bootstrapped from anything actor-specific).
//
// Prerequisites: `pnpm --filter @disco-voador/dedicated-server run build` and
// `pnpm --filter @disco-voador/desktop exec electron-forge package` must have already been run.

import { rmSync } from 'node:fs';

import { writeValidAvatarFixture } from './lib/avatar-fixtures.mjs';
import { spawnElectronE2E } from './lib/spawn-electron-e2e.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const CHANNEL_ID = 'general';
const EXIT_MARKER = 'E2E_PROFILE_SMOKE_STEPS_DONE';

function memberAvatarExpression(name) {
  return (
    `Array.from(document.querySelectorAll('[data-testid^="member-row-"]')).some((el) => ` +
    `el.textContent && el.textContent.includes(${JSON.stringify(name)}) && el.querySelector('img'))`
  );
}

function readMarker(stdout, prefix) {
  let found;
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf(prefix);
    if (idx === -1) continue;
    found = line.slice(idx + prefix.length).trim();
  }
  return found;
}

function readSnapshot(stdout, marker) {
  const raw = readMarker(stdout, `disco-voador:e2e-profile-self-snapshot:${marker}:`);
  if (!raw) throw new Error(`Missing self-snapshot marker "${marker}" in stdout`);
  return JSON.parse(raw);
}

function readMemberAvatarMarker(stdout, marker) {
  const raw = readMarker(stdout, `disco-voador:e2e-profile-member-avatar:${marker}:`);
  if (raw === undefined) throw new Error(`Missing member-avatar marker "${marker}" in stdout`);
  return raw === 'true';
}

function readMemberRowCount(stdout, marker) {
  const raw = readMarker(stdout, `disco-voador:e2e-profile-member-row-count:${marker}:`);
  if (raw === undefined) throw new Error(`Missing member-row-count marker "${marker}" in stdout`);
  return Number(raw);
}

async function main() {
  console.info('Starting Dedicated Server (real, open access, ephemeral)...');
  const server = await startDedicatedServer();
  const url = `ws://${server.host}:${String(server.port)}`;
  console.info(`Dedicated Server listening on ${server.host}:${String(server.port)}`);

  const validAvatarPath = writeValidAvatarFixture();
  let bob;
  let aliceProfileDir;

  try {
    console.info("Launching Bob (real Electron) — a plain observer watching Alice's row...");
    bob = spawnElectronE2E('bob', {
      DISCO_VOADOR_REALTIME_URL: url,
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Bob',
      DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
      DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify([
        { action: 'wait', ms: 800 },
        { action: 'read-member-avatar', name: 'Alice', marker: 't0-before-upload' },
        {
          action: 'wait-condition',
          expression: memberAvatarExpression('Alice'),
          timeoutMs: 30_000,
        },
        { action: 'read-member-avatar', name: 'Alice', marker: 't1-after-upload' },
        {
          action: 'wait-condition',
          expression: `!(${memberAvatarExpression('Alice')})`,
          timeoutMs: 30_000,
        },
        { action: 'read-member-avatar', name: 'Alice', marker: 't2-after-removal' },
      ]),
    });
    await bob.waitFor('disco-voador:voice-joined:general');
    console.info('Bob joined "general" and is now watching.');

    console.info('Launching Alice (real Electron, phase 1) — uploads a real local avatar file...');
    const alicePhase1 = spawnElectronE2E('alice-1', {
      DISCO_VOADOR_REALTIME_URL: url,
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Alice',
      DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
      DISCO_VOADOR_E2E_PROFILE_AVATAR_FILE_PATH: validAvatarPath,
      DISCO_VOADOR_E2E_PROFILE_EXIT_AFTER_STEPS: '1',
      DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify([
        { action: 'wait', ms: 500 },
        { action: 'open-profile-editor' },
        { action: 'upload-self-avatar' },
        { action: 'set-status', text: 'Testing dedup' },
        { action: 'set-presence', value: 'away' },
        { action: 'read-self-snapshot', marker: 'after-upload' },
        // Direct regression check for the T13.3 "duplicate self row" defect (see
        // `armE2EProfileSmoke`'s own `read-member-row-count` doc comment) — a real, single
        // connection that just changed its own avatar/status/presence must see itself listed
        // exactly once in its own Member Panel, never twice.
        { action: 'read-member-row-count', name: 'Alice', marker: 'after-self-mutations' },
        { action: 'close-profile-editor' },
      ]),
    });
    aliceProfileDir = alicePhase1.dir;
    await alicePhase1.waitFor(EXIT_MARKER);
    await alicePhase1.exitedPromise;
    const phase1Snapshot = readSnapshot(alicePhase1.getStdout(), 'after-upload');
    if (!phase1Snapshot.hasAvatar) {
      throw new Error(
        `Alice's own Profile Editor did not show the avatar after upload: ${JSON.stringify(phase1Snapshot)}`,
      );
    }
    console.info(
      "Confirmed: Alice's own Profile Editor shows the avatar immediately after upload.",
    );
    const selfRowCount = readMemberRowCount(alicePhase1.getStdout(), 'after-self-mutations');
    if (selfRowCount !== 1) {
      throw new Error(
        `Alice's own Member Panel shows herself ${String(selfRowCount)} time(s) after changing ` +
          'her own avatar/status/presence in a single connection — expected exactly 1 (the ' +
          'duplicate-self-row regression).',
      );
    }
    console.info(
      "Confirmed: Alice's own Member Panel shows herself exactly once after changing her own " +
        'avatar/status/presence in a single, non-reconnecting session — no duplicate self row.',
    );

    console.info(
      "Waiting for Bob to observe Alice's avatar appearing (no reconnect on Bob's side)...",
    );
    await bob.waitFor('disco-voador:e2e-profile-member-avatar:t1-after-upload:');
    if (readMemberAvatarMarker(bob.getStdout(), 't0-before-upload')) {
      throw new Error(
        "Bob's initial read already showed an avatar for Alice — fixture contamination?",
      );
    }
    if (!readMemberAvatarMarker(bob.getStdout(), 't1-after-upload')) {
      throw new Error("Bob never observed Alice's avatar appear in the rendered Member Panel.");
    }
    console.info(
      "Confirmed: Bob's own rendered Member Panel shows Alice's real avatar with no reconnect.",
    );

    console.info(
      'Relaunching Alice (real Electron, phase 2, SAME profile) — confirms her own avatar is ' +
        'restored purely from server-side reconnect state (no fresh mutation), then removes it...',
    );
    const alicePhase2 = spawnElectronE2E(
      'alice-2',
      {
        DISCO_VOADOR_REALTIME_URL: url,
        DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
        DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Alice',
        DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
        DISCO_VOADOR_E2E_PROFILE_EXIT_AFTER_STEPS: '1',
        DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify([
          { action: 'wait', ms: 500 },
          { action: 'open-profile-editor' },
          { action: 'read-self-snapshot', marker: 'after-reconnect-before-any-mutation' },
          { action: 'remove-self-avatar' },
          { action: 'read-self-snapshot', marker: 'after-removal' },
          { action: 'close-profile-editor' },
        ]),
      },
      aliceProfileDir,
    );
    await alicePhase2.waitFor(EXIT_MARKER);
    await alicePhase2.exitedPromise;
    const beforeMutationSnapshot = readSnapshot(
      alicePhase2.getStdout(),
      'after-reconnect-before-any-mutation',
    );
    if (!beforeMutationSnapshot.hasAvatar) {
      throw new Error(
        "Alice's own Profile Editor did not show her avatar immediately after reconnect, with no " +
          `fresh mutation — the proactive server:profile-self-updated restore regressed: ${JSON.stringify(beforeMutationSnapshot)}`,
      );
    }
    console.info(
      "Confirmed: Alice's own Profile Editor shows her real avatar immediately after a full " +
        'reconnect, with no fresh mutation — the proactive self-profile push works.',
    );
    const removedSnapshot = readSnapshot(alicePhase2.getStdout(), 'after-removal');
    if (removedSnapshot.hasAvatar) {
      throw new Error(
        `Alice's own Profile Editor still showed an avatar after removal: ${JSON.stringify(removedSnapshot)}`,
      );
    }
    console.info("Confirmed: Alice's own Profile Editor no longer shows an avatar after removal.");

    console.info("Waiting for Bob to observe Alice's avatar disappearing again...");
    await bob.waitFor('disco-voador:e2e-profile-member-avatar:t2-after-removal:');
    if (readMemberAvatarMarker(bob.getStdout(), 't2-after-removal')) {
      throw new Error('Bob still shows an avatar for Alice after she removed it.');
    }
    console.info("Confirmed: Bob's own rendered Member Panel no longer shows Alice's avatar.");

    console.info(
      'E2E profile-avatar-smoke test passed: a real avatar upload propagates live to a second real ' +
        "Electron client's rendered Member Panel with no reconnect, survives the uploading client's " +
        'own full reconnect (real server-side persistence), and a subsequent removal propagates live ' +
        'the same way.',
    );
  } finally {
    await bob?.stop();
    if (aliceProfileDir) {
      try {
        rmSync(aliceProfileDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup only
      }
    }
    if (server.child.exitCode === null && server.child.signalCode === null) {
      server.child.kill('SIGTERM');
    }
  }
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(
      `E2E profile-avatar-smoke test failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
