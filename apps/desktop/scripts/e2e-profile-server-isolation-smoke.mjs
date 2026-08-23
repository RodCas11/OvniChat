// T13.3 "Profiles / Avatars / Members / Presence" per-Dedicated-Server profile isolation proof — the
// hard product rule that each Dedicated Server owns fully independent profile data, and that
// switching the active connection must never show stale/mixed avatar, status, or presence from a
// previously (or concurrently) connected different server. Uses the SAME persistent client identity
// (`--user-data-dir` reused across every launch, mirroring `e2e-channel-admin-smoke.mjs`'s own
// relaunch-same-profile technique) against TWO real, independently-running Dedicated Server
// instances — the strongest real proof available, since identity is the one thing genuinely shared
// across both servers (by design, per ADR 0011) while every profile field must not be.
//
// Deliberately proves persistence/isolation through a THIRD PARTY on each server (ObserverA/
// ObserverB, each a real, long-running Electron instance connected for the whole test) rather than
// relying solely on the mutating identity's own client-side self-view after a reconnect. This
// remains the strongest available evidence even now that `handleIdentityProof`'s proactive
// `server:profile-self-updated` push makes the mutating identity's own self-view reliable too (see
// `e2e-profile-avatar-smoke.mjs`'s own "after-reconnect" assertion, which now directly exercises
// that restore path): a third party's rendered Member Panel is a fully independent signal, driven
// only by the real, server-computed presence broadcast, never by anything the reconnecting client
// asserts about itself — exactly the same reasoning `e2e-profile-avatar-smoke.mjs`'s own "Bob"
// already relies on for its live-update proof. This script's own `read-self-snapshot` checks at each
// connect (`a1-initial`/`b1-initial`) independently corroborate the same isolation claim from the
// mutating identity's own (now-correct) point of view.
//
// Scenario: ObserverA stays connected to Server A the whole time; ObserverB stays connected to Server
// B the whole time — each pre-armed with a `wait-condition`-driven step sequence (never a fixed
// guessed timer) that brackets the identity's own reconnect: (1) wait for the row to appear with the
// right content, (2) wait for it to disappear entirely (the identity moved to the other server), (3)
// wait for it to reappear with the SAME content as before (not blank, not the other server's content).
// The same identity ("SameIdentity") connects to Server A, uploads avatar A / sets status
// "On Server A" / presence "away"; connects to Server B (fresh — confirms zero trace of Server A's
// data) and sets a genuinely different avatar B / status "On Server B" / presence "dnd"; reconnects to
// Server A again (ObserverA must see "On Server A" survive); reconnects to Server B again (ObserverB
// must see "On Server B" survive).
//
// Prerequisites: `pnpm --filter @disco-voador/dedicated-server run build` and
// `pnpm --filter @disco-voador/desktop exec electron-forge package` must have already been run.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { buildPng } from './lib/avatar-fixtures.mjs';
import { spawnElectronE2E } from './lib/spawn-electron-e2e.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const CHANNEL_ID = 'general';
const EXIT_MARKER = 'E2E_PROFILE_SMOKE_STEPS_DONE';
const IDENTITY_NAME = 'SameIdentity';
const LONG_TIMEOUT_MS = 90_000;

function rowExistsExpression(name) {
  return (
    `Array.from(document.querySelectorAll('[data-testid^="member-row-"]')).some((el) => ` +
    `el.textContent && el.textContent.includes(${JSON.stringify(name)}))`
  );
}

function rowContainsExpression(name, substring) {
  return (
    `Array.from(document.querySelectorAll('[data-testid^="member-row-"]')).some((el) => ` +
    `el.textContent && el.textContent.includes(${JSON.stringify(name)}) && ` +
    `el.textContent.includes(${JSON.stringify(substring)}))`
  );
}

function readLastMarker(stdout, prefix) {
  let found;
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf(prefix);
    if (idx === -1) continue;
    found = line.slice(idx + prefix.length);
  }
  return found;
}

function readSnapshot(stdout, marker) {
  const raw = readLastMarker(stdout, `disco-voador:e2e-profile-self-snapshot:${marker}:`);
  if (!raw) throw new Error(`Missing self-snapshot marker "${marker}" in stdout`);
  return JSON.parse(raw.trim());
}

function readRowTextMarker(stdout, marker) {
  const raw = readLastMarker(stdout, `disco-voador:e2e-profile-member-row-text:${marker}:`);
  if (raw === undefined) throw new Error(`Missing member-row-text marker "${marker}" in stdout`);
  return raw.trim();
}

async function stopServer(server) {
  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGTERM');
    await new Promise((resolve) => {
      server.child.once('exit', () => resolve());
    });
  }
}

/** The long-running observer for one server: appears with the right status, disappears when the
 * identity moves to the other server, then reappears with the SAME status (never blank, never the
 * other server's status) once the identity reconnects. */
function spawnObserver(label, url, expectedStatus) {
  return spawnElectronE2E(label, {
    DISCO_VOADOR_REALTIME_URL: url,
    DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
    DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: `Observer-${label}`,
    DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
    DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify([
      {
        action: 'wait-condition',
        expression: rowContainsExpression(IDENTITY_NAME, expectedStatus),
        timeoutMs: LONG_TIMEOUT_MS,
      },
      { action: 'read-member-row-text', name: IDENTITY_NAME, marker: `${label}-first-sighting` },
      {
        action: 'wait-condition',
        expression: `!(${rowExistsExpression(IDENTITY_NAME)})`,
        timeoutMs: LONG_TIMEOUT_MS,
      },
      {
        action: 'wait-condition',
        expression: rowContainsExpression(IDENTITY_NAME, expectedStatus),
        timeoutMs: LONG_TIMEOUT_MS,
      },
      { action: 'read-member-row-text', name: IDENTITY_NAME, marker: `${label}-after-reconnect` },
    ]),
  });
}

async function main() {
  console.info('Starting TWO independent Dedicated Server instances (real, ephemeral)...');
  const serverA = await startDedicatedServer();
  const serverB = await startDedicatedServer();
  const urlA = `ws://${serverA.host}:${String(serverA.port)}`;
  const urlB = `ws://${serverB.host}:${String(serverB.port)}`;
  console.info(`Server A listening on ${serverA.host}:${String(serverA.port)}`);
  console.info(`Server B listening on ${serverB.host}:${String(serverB.port)}`);

  const fixtureDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-isolation-avatars-'));
  const avatarAPath = path.join(fixtureDir, 'avatar-a.png');
  const avatarBPath = path.join(fixtureDir, 'avatar-b.png');
  writeFileSync(avatarAPath, buildPng(4, 4));
  writeFileSync(avatarBPath, buildPng(8, 8));

  let profileDir;
  let observerA;
  let observerB;

  async function runIdentityPhase(label, url, avatarPath, steps) {
    const instance = spawnElectronE2E(
      label,
      {
        DISCO_VOADOR_REALTIME_URL: url,
        DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
        DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: IDENTITY_NAME,
        DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
        ...(avatarPath ? { DISCO_VOADOR_E2E_PROFILE_AVATAR_FILE_PATH: avatarPath } : {}),
        DISCO_VOADOR_E2E_PROFILE_EXIT_AFTER_STEPS: '1',
        DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify(steps),
      },
      profileDir,
    );
    profileDir ??= instance.dir;
    await instance.waitFor(EXIT_MARKER);
    await instance.exitedPromise;
    return instance.getStdout();
  }

  try {
    console.info('Launching ObserverA (stays connected to Server A the whole time)...');
    observerA = spawnObserver('A', urlA, 'On Server A');
    await observerA.waitFor('disco-voador:voice-joined:general');

    console.info('Launching ObserverB (stays connected to Server B the whole time)...');
    observerB = spawnObserver('B', urlB, 'On Server B');
    await observerB.waitFor('disco-voador:voice-joined:general');

    console.info('Phase 1: connect to Server A, confirm a fresh identity has no prior data...');
    const phase1Stdout = await runIdentityPhase('server-a-1', urlA, avatarAPath, [
      { action: 'wait', ms: 500 },
      { action: 'open-profile-editor' },
      { action: 'read-self-snapshot', marker: 'a1-initial' },
      { action: 'upload-self-avatar' },
      { action: 'set-status', text: 'On Server A' },
      { action: 'set-presence', value: 'away' },
      { action: 'close-profile-editor' },
    ]);
    const a1Initial = readSnapshot(phase1Stdout, 'a1-initial');
    if (a1Initial.hasAvatar || a1Initial.status !== '' || a1Initial.presence !== 'online') {
      throw new Error(
        `Server A's fresh identity did not start from a clean profile: ${JSON.stringify(a1Initial)}`,
      );
    }
    console.info('Confirmed: a fresh identity on Server A starts from a clean profile.');

    console.info('Waiting for ObserverA to see the real "On Server A" status appear...');
    await observerA.waitFor('disco-voador:e2e-profile-member-row-text:A-first-sighting:');
    console.info(
      `Confirmed (ObserverA): ${readRowTextMarker(observerA.getStdout(), 'A-first-sighting')}`,
    );

    console.info(
      "Phase 2: SAME identity connects to Server B — must show ZERO trace of Server A's data...",
    );
    const phase2Stdout = await runIdentityPhase('server-b-1', urlB, avatarBPath, [
      { action: 'wait', ms: 500 },
      { action: 'open-profile-editor' },
      { action: 'read-self-snapshot', marker: 'b1-initial' },
      { action: 'upload-self-avatar' },
      { action: 'set-status', text: 'On Server B' },
      { action: 'set-presence', value: 'dnd' },
      { action: 'close-profile-editor' },
    ]);
    const b1Initial = readSnapshot(phase2Stdout, 'b1-initial');
    if (b1Initial.hasAvatar || b1Initial.status !== '' || b1Initial.presence !== 'online') {
      throw new Error(
        `Server B showed contamination from Server A on first connect: ${JSON.stringify(b1Initial)}`,
      );
    }
    console.info(
      "Confirmed: the SAME identity's connection to Server B shows a clean profile — no avatar, no " +
        'status, default presence — despite already holding real data on Server A.',
    );

    console.info('Waiting for ObserverB to see the real "On Server B" status appear...');
    await observerB.waitFor('disco-voador:e2e-profile-member-row-text:B-first-sighting:');
    console.info(
      `Confirmed (ObserverB): ${readRowTextMarker(observerB.getStdout(), 'B-first-sighting')}`,
    );

    console.info(
      'Phase 3: reconnecting to Server A — ObserverA (unaffected by anything on Server B, and ' +
        'already primed to detect the offline gap in between) must see "On Server A" again...',
    );
    await runIdentityPhase('server-a-2', urlA, undefined, [{ action: 'wait', ms: 800 }]);
    await observerA.waitFor('disco-voador:e2e-profile-member-row-text:A-after-reconnect:');
    const aReconnectedText = readRowTextMarker(observerA.getStdout(), 'A-after-reconnect');
    if (!aReconnectedText.includes('On Server A') || aReconnectedText.includes('On Server B')) {
      throw new Error(`ObserverA saw the wrong content after reconnect: "${aReconnectedText}"`);
    }
    console.info(`Confirmed (ObserverA, a real third party): "${aReconnectedText}"`);

    console.info('Phase 4: reconnecting to Server B — ObserverB must see "On Server B" again...');
    await runIdentityPhase('server-b-2', urlB, undefined, [{ action: 'wait', ms: 800 }]);
    await observerB.waitFor('disco-voador:e2e-profile-member-row-text:B-after-reconnect:');
    const bReconnectedText = readRowTextMarker(observerB.getStdout(), 'B-after-reconnect');
    if (!bReconnectedText.includes('On Server B') || bReconnectedText.includes('On Server A')) {
      throw new Error(`ObserverB saw the wrong content after reconnect: "${bReconnectedText}"`);
    }
    console.info(`Confirmed (ObserverB, a real third party): "${bReconnectedText}"`);

    console.info(
      'E2E profile-server-isolation-smoke test passed: the same client identity switching between ' +
        'two independently-running Dedicated Servers never shows stale/mixed avatar/status/presence ' +
        'from the other server, in either direction, across repeated reconnects — proven via a real ' +
        "third-party observer on each server, independent of the mutating identity's own (now also " +
        'correctly self-restoring — see `e2e-profile-avatar-smoke.mjs`) reconnect behavior.',
    );
  } finally {
    await observerA?.stop();
    await observerB?.stop();
    if (profileDir) {
      try {
        rmSync(profileDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup only
      }
    }
    try {
      rmSync(fixtureDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
    await stopServer(serverA);
    await stopServer(serverB);
  }
}

main()
  .then(() => {
    process.exitCode = 0;
  })
  .catch((error) => {
    console.error(
      `E2E profile-server-isolation-smoke test failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
