// T13.3 "Profiles / Avatars / Members / Presence" server-avatar proof. Deliberately does NOT
// duplicate `tests/dedicated-server/profile-integration.test.ts`'s own wire-level coverage of this
// exact scenario ("target:'server' avatar mutation is rejected without server.manage and accepted
// with it" and "server:hello carries the current server avatarRef once one has been set") — that
// integration test already proves the protocol-level authorization boundary and the "no live
// broadcast, only a fresh server:hello sees it" gap with a real second raw-WS connection. This
// script's own job is the part that coverage cannot give: driving the REAL Server Settings -> Server
// Profile UI through a real Electron instance (native-file-picker IPC path included), and confirming
// the honest product-boundary rule that the whole "Server Profile" nav entry is absent (not merely
// disabled) for a non-admin, using the real rendered DOM.
//
// Scenario:
//   Admin (real Electron) joins "general"; a lightweight raw-WS connection (already redeemed the
//   bootstrap token) creates an "Owner" group holding `server.manage` and grants it to Admin's
//   identity live (the exact established technique `armE2EChannelAdminScreenshotCapture`'s own doc
//   comment documents) — Admin never needs to redeem anything itself through the UI.
//   Admin opens Server Settings -> Server Profile and uploads a real local avatar file through the
//   real native-file-picker IPC path (faked only at the OS-dialog-chrome layer, per
//   `armE2EProfileSmoke`'s own doc comment) — confirms its own optimistic preview renders a real
//   `<img>`, then exits.
//   Admin relaunches (SAME profile => same persistent identity, already holding "Owner" from before)
//   as a genuinely FRESH connection and confirms Server Profile shows the avatar via the real,
//   non-optimistic `state.serverInfo.serverAvatarRef` code path — proving persistence is visible on a
//   fresh connect, not merely the uploading session's own local echo.
//   A separate, unrelated Guest (real Electron, no group at all) confirms the "Server Profile" nav
//   entry never renders in Server Settings at all.
//
// Prerequisites: `pnpm --filter @disco-voador/dedicated-server run build` and
// `pnpm --filter @disco-voador/desktop exec electron-forge package` must have already been run.

import { rmSync } from 'node:fs';

import { writeValidAvatarFixture } from './lib/avatar-fixtures.mjs';
import {
  bufferLength,
  connectAdmin,
  freshId,
  sendRequest,
  waitForMessage,
  waitForMessageOfType,
} from './lib/raw-protocol-client.mjs';
import { spawnElectronE2E } from './lib/spawn-electron-e2e.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const CHANNEL_ID = 'general';
const EXIT_MARKER = 'E2E_PROFILE_SMOKE_STEPS_DONE';
const OWNER_GROUP_NAME = 'Owner';

function readMarker(stdout, prefix) {
  let found;
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf(prefix);
    if (idx === -1) continue;
    found = line.slice(idx + prefix.length).trim();
  }
  return found;
}

function readBoolMarker(stdout, prefix, marker) {
  const raw = readMarker(stdout, `${prefix}${marker}:`);
  if (raw === undefined) throw new Error(`Missing marker "${prefix}${marker}:" in stdout`);
  return raw === 'true';
}

async function findGroupIdByName(adminWs, name) {
  // `since` matters here: this connection may already have an earlier, now-stale
  // `server:authorization-groups` reply sitting in its buffer (e.g. from a previous lookup for a
  // different group) — a bare `waitForMessageOfType` with the default `since: 0` would happily
  // resolve against that stale one instead of this call's own fresh reply (see
  // `raw-protocol-client.mjs`'s own top-of-file doc comment on exactly this hazard).
  const since = bufferLength(adminWs);
  const groupsMessage = waitForMessageOfType(adminWs, 'server:authorization-groups', 10_000, since);
  adminWs.send(JSON.stringify({ type: 'client:authorization-list-groups', id: freshId('list') }));
  const result = await groupsMessage;
  const match = result.groups.find((g) => g.name === name);
  if (!match) throw new Error(`group "${name}" not found`);
  return match.groupId;
}

async function main() {
  console.info('Starting Dedicated Server (real, ephemeral)...');
  const server = await startDedicatedServer();
  const url = `ws://${server.host}:${String(server.port)}`;
  console.info(`Dedicated Server listening on ${server.host}:${String(server.port)}`);
  if (!server.bootstrapToken) throw new Error('Expected a bootstrap token on first startup');

  const validAvatarPath = writeValidAvatarFixture();
  let adminRaw;
  let adminProfileDir;
  let guest;

  try {
    console.info('Connecting a raw-WS Admin and redeeming the bootstrap token...');
    adminRaw = await connectAdmin(url, 'AdminRaw', server.bootstrapToken);

    console.info('Creating an "Owner" group holding server.manage...');
    // Explicit group membership REPLACES the implicit Guest baseline, never adds to it (T9 —
    // `AuthorizationStore`'s own `effectiveGroupIds` returns the identity's real memberships only,
    // falling back to `[GUEST_GROUP_ID]` solely when there are none at all) — so this group must
    // also carry the same baseline `voice.channel.join`/`chat.*` permissions Guest/Member already
    // default to, or AdminUser's own auto-join to "general" (needed just to get onto the wire and be
    // observable at all) would itself be rejected the instant it holds this custom group.
    await sendRequest(
      adminRaw.ws,
      {
        type: 'client:authorization-create-group',
        id: freshId('create-owner'),
        name: OWNER_GROUP_NAME,
        permissions: [
          'server.manage',
          'voice.channel.join',
          'chat.server.send',
          'chat.channel.send',
        ],
      },
      ['server:authorization-ack'],
    );
    const ownerGroupId = await findGroupIdByName(adminRaw.ws, OWNER_GROUP_NAME);
    console.info(`"Owner" group id: ${ownerGroupId}`);

    console.info('Launching Admin (real Electron) — joins "general" as an ordinary participant...');
    const adminElectronPhase1 = spawnElectronE2E('admin-1', {
      DISCO_VOADOR_REALTIME_URL: url,
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'AdminUser',
      DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
      DISCO_VOADOR_E2E_PROFILE_AVATAR_FILE_PATH: validAvatarPath,
      DISCO_VOADOR_E2E_PROFILE_EXIT_AFTER_STEPS: '1',
      DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify([
        { action: 'wait-group', groupId: ownerGroupId, timeoutMs: 20_000 },
        { action: 'open-server-settings' },
        { action: 'click', selector: '[data-testid="server-settings-nav-profile"]' },
        { action: 'wait', ms: 300 },
        { action: 'upload-server-avatar' },
        { action: 'read-server-avatar-visible', marker: 'admin-upload' },
        { action: 'close-server-settings' },
      ]),
    });
    adminProfileDir = adminElectronPhase1.dir;

    console.info(
      'Waiting for Admin\'s Electron identity to join, then granting it "Owner" live...',
    );
    const joinedEvent = await waitForMessage(
      adminRaw.ws,
      (m) => m.type === 'voice:participant-joined' && m.participant.displayName === 'AdminUser',
      'voice:participant-joined for AdminUser',
    );
    await sendRequest(
      adminRaw.ws,
      {
        type: 'client:authorization-grant-group',
        id: freshId('grant-owner'),
        targetParticipantId: joinedEvent.participant.participantId,
        groupId: ownerGroupId,
      },
      ['server:authorization-ack'],
    );
    console.info('Granted "Owner" (server.manage) to AdminUser live.');

    await adminElectronPhase1.waitFor(EXIT_MARKER);
    await adminElectronPhase1.exitedPromise;
    if (
      !readBoolMarker(
        adminElectronPhase1.getStdout(),
        'disco-voador:e2e-profile-server-avatar-visible:',
        'admin-upload',
      )
    ) {
      throw new Error('Server Profile did not show an avatar right after Admin uploaded it.');
    }
    console.info('Confirmed: Server Profile shows the uploaded avatar in the uploading session.');

    console.info(
      'Relaunching Admin (SAME profile => already holds "Owner") as a genuinely FRESH connection...',
    );
    const adminElectronPhase2 = spawnElectronE2E(
      'admin-2',
      {
        DISCO_VOADOR_REALTIME_URL: url,
        DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
        DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'AdminUser',
        DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
        DISCO_VOADOR_E2E_PROFILE_EXIT_AFTER_STEPS: '1',
        DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify([
          { action: 'wait', ms: 500 },
          { action: 'open-server-settings' },
          { action: 'click', selector: '[data-testid="server-settings-nav-profile"]' },
          { action: 'wait', ms: 300 },
          { action: 'read-server-avatar-visible', marker: 'fresh-connect' },
          { action: 'close-server-settings' },
        ]),
      },
      adminProfileDir,
    );
    await adminElectronPhase2.waitFor(EXIT_MARKER);
    await adminElectronPhase2.exitedPromise;
    if (
      !readBoolMarker(
        adminElectronPhase2.getStdout(),
        'disco-voador:e2e-profile-server-avatar-visible:',
        'fresh-connect',
      )
    ) {
      throw new Error(
        'A fresh connection did not show the server avatar (persistence not visible).',
      );
    }
    console.info(
      'Confirmed: a genuinely fresh connection (no re-upload) shows the server avatar — real ' +
        'server-side persistence via server:hello, matching the documented "no live broadcast, only a ' +
        'fresh connect sees it" behavior.',
    );

    console.info(
      'Creating a "ChannelAdmin" group (channels.manage, but NOT server.manage) — this Guest must ' +
        'still be able to OPEN Server Settings (proving the narrower, real gate is specifically on ' +
        '"Server Profile," not on Server Settings as a whole)...',
    );
    await sendRequest(
      adminRaw.ws,
      {
        type: 'client:authorization-create-group',
        id: freshId('create-channel-admin'),
        name: 'ChannelAdmin',
        permissions: [
          'channels.manage',
          'voice.channel.join',
          'chat.server.send',
          'chat.channel.send',
        ],
      },
      ['server:authorization-ack'],
    );
    const channelAdminGroupId = await findGroupIdByName(adminRaw.ws, 'ChannelAdmin');

    console.info('Launching Guest (real Electron, "ChannelAdmin" but never "server.manage")...');
    guest = spawnElectronE2E('guest', {
      DISCO_VOADOR_REALTIME_URL: url,
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'PlainGuest',
      DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
      DISCO_VOADOR_E2E_PROFILE_EXIT_AFTER_STEPS: '1',
      DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify([
        { action: 'wait-group', groupId: channelAdminGroupId, timeoutMs: 20_000 },
        { action: 'open-server-settings' },
        { action: 'read-server-nav-profile-visible', marker: 'guest' },
        { action: 'close-server-settings' },
      ]),
    });
    const guestJoinedEvent = await waitForMessage(
      adminRaw.ws,
      (m) => m.type === 'voice:participant-joined' && m.participant.displayName === 'PlainGuest',
      'voice:participant-joined for PlainGuest',
    );
    await sendRequest(
      adminRaw.ws,
      {
        type: 'client:authorization-grant-group',
        id: freshId('grant-channel-admin'),
        targetParticipantId: guestJoinedEvent.participant.participantId,
        groupId: channelAdminGroupId,
      },
      ['server:authorization-ack'],
    );
    await guest.waitFor(EXIT_MARKER);
    await guest.exitedPromise;
    if (
      readBoolMarker(guest.getStdout(), 'disco-voador:e2e-profile-server-nav-visible:', 'guest')
    ) {
      throw new Error('A non-admin Guest saw the "Server Profile" nav entry — it must be absent.');
    }
    console.info(
      'Confirmed: a non-admin Guest never sees the "Server Profile" nav entry at all (absent, not ' +
        'merely disabled).',
    );

    console.info(
      'E2E server-avatar-smoke test passed: a real Server Settings -> Server Profile upload works ' +
        'end to end through the native-file-picker IPC path, persists visibly to a genuinely fresh ' +
        'connection, and the whole Server Profile surface is absent for a non-admin.',
    );
  } finally {
    adminRaw?.ws.close();
    await guest?.stop();
    if (adminProfileDir) {
      try {
        rmSync(adminProfileDir, { recursive: true, force: true });
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
      `E2E server-avatar-smoke test failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
