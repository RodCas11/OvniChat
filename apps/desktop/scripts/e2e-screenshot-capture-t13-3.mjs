// T13.3 "Profiles / Avatars / Members / Presence" Definition-of-Done screenshot evidence tool —
// mirrors `e2e-screenshot-capture-t13-2.mjs`'s own precedent exactly: throwaway automation added
// solely to produce real screenshots from an actual running Electron instance, never a permanent
// regression test, never added to `package.json`'s `scripts` (run manually via
// `node scripts/e2e-screenshot-capture-t13-3.mjs`). Drives `armE2EProfileSmoke`'s
// `DISCO_VOADOR_E2E_PROFILE_STEPS` step vocabulary (see that function's own doc comment in
// `apps/desktop/src/main/index.ts`) instead of a bespoke capture function, since T13.3's own QA pass
// already needed that generic vocabulary for the new E2E scripts.
//
// Four real Electron instances against one real Dedicated Server:
//   AvatarRejectDemo — a throwaway instance solely to capture the animated-avatar rejection error
//     state (needs its own dedicated `dialog.showOpenDialog` fake pointing at an animated fixture,
//     which cannot coexist with the other instances' valid-avatar fake in the same process).
//   AdminUser — granted a custom "Owner" group (server.manage) live after joining, the same
//     established "real, already-connected UI session picks up full admin rights with no reconnect"
//     technique `armE2EChannelAdminScreenshotCapture` already documents for T13.2. Captures the
//     Profile Editor (own avatar/status, then presence changed to Away) and the Server Profile admin
//     section. Stays connected for the rest of the run so the other two instances' Member Panels show
//     a real "Admin" badge.
//   ModUser — granted a custom "Moderator" group (moderation.kick + moderation.profile.clear) live.
//     Sets its own avatar/status, then waits for PlainUser to appear and captures PlainUser's member
//     popover with real moderation actions visible. Stays connected until the very end.
//   PlainUser — launched last (after Admin/Mod are already fully set up), so its own Member Panel
//     screenshot genuinely shows all three with real avatars/presence/grouping. Captures the Member
//     Panel, a normal (non-moderator) member popover of AdminUser, the Server Settings nav with
//     "Server Profile" absent, and the bottom UserControlBar.
//
// Prerequisites: `pnpm --filter @disco-voador/dedicated-server run build` and
// `pnpm --filter @disco-voador/desktop exec electron-forge package` must have already been run.

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeAnimatedAvatarFixture, writeValidAvatarFixture } from './lib/avatar-fixtures.mjs';
import {
  bufferLength,
  connectAdmin,
  freshId,
  sendRequest,
  waitForMessage,
} from './lib/raw-protocol-client.mjs';
import { spawnElectronE2E } from './lib/spawn-electron-e2e.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const CHANNEL_ID = 'general';
const captureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../docs/tasks/screenshots/t13-3',
);

function rowContainsExpression(name, substring) {
  return (
    `Array.from(document.querySelectorAll('[data-testid^="member-row-"]')).some((el) => ` +
    `el.textContent && el.textContent.includes(${JSON.stringify(name)}) && ` +
    `el.textContent.includes(${JSON.stringify(substring)}))`
  );
}

async function findGroupId(adminWs, name) {
  // `since` matters: a stale, already-buffered `server:authorization-groups` reply from an earlier
  // lookup must never satisfy this one (see `e2e-server-avatar-smoke.mjs`'s identical fix/comment).
  const since = bufferLength(adminWs);
  const groupsMessage = waitForMessage(
    adminWs,
    (m) => m.type === 'server:authorization-groups',
    'server:authorization-groups',
    { since },
  );
  adminWs.send(JSON.stringify({ type: 'client:authorization-list-groups', id: freshId('list') }));
  const result = await groupsMessage;
  const match = result.groups.find((g) => g.name === name);
  if (!match) throw new Error(`group "${name}" not found`);
  return match.groupId;
}

async function main() {
  if (!existsSync(captureDir)) mkdirSync(captureDir, { recursive: true });

  console.info('Starting Dedicated Server (real, ephemeral)...');
  const server = await startDedicatedServer();
  const url = `ws://${server.host}:${String(server.port)}`;
  console.info(`Dedicated Server listening on ${server.host}:${String(server.port)}`);
  if (!server.bootstrapToken) throw new Error('Expected a bootstrap token on first startup');

  const validAvatarPath = writeValidAvatarFixture();
  const animatedAvatarPath = writeAnimatedAvatarFixture();

  const adminRaw = await connectAdmin(url, 'AdminRaw', server.bootstrapToken);
  await sendRequest(
    adminRaw.ws,
    {
      type: 'client:authorization-create-group',
      id: freshId('create-owner'),
      name: 'Owner',
      permissions: ['server.manage', 'voice.channel.join', 'chat.server.send', 'chat.channel.send'],
    },
    ['server:authorization-ack'],
  );
  const ownerGroupId = await findGroupId(adminRaw.ws, 'Owner');
  await sendRequest(
    adminRaw.ws,
    {
      type: 'client:authorization-create-group',
      id: freshId('create-moderator'),
      name: 'Moderator',
      permissions: [
        'moderation.kick',
        'moderation.profile.clear',
        'voice.channel.join',
        'chat.server.send',
        'chat.channel.send',
      ],
    },
    ['server:authorization-ack'],
  );
  const moderatorGroupId = await findGroupId(adminRaw.ws, 'Moderator');
  // Holds `channels.manage` (enough to open Server Settings at all, per `ServerSettingsModal.tsx`'s
  // own entry-point gate) but deliberately NEVER `server.manage` — the specific, narrow case
  // screenshot 09 needs: Server Settings genuinely open, "Server Profile" genuinely absent from its
  // nav. Kept as its own short-lived identity, never the same one used for the Member Panel/popover
  // screenshots (04/05), since holding `channels.manage` would itself earn an "Admin" role-bucket
  // badge (per `role-bucket.ts`) and misrepresent those screenshots' own "plain member" framing.
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
  const channelAdminGroupId = await findGroupId(adminRaw.ws, 'ChannelAdmin');
  console.info(
    `Owner group: ${ownerGroupId}; Moderator group: ${moderatorGroupId}; ChannelAdmin group: ${channelAdminGroupId}`,
  );

  let avatarRejectDemo;
  let hiddenProfileDemo;
  let adminUser;
  let modUser;
  let plainUser;

  try {
    console.info('=== AvatarRejectDemo: capturing the animated-avatar rejection error state ===');
    avatarRejectDemo = spawnElectronE2E('reject-demo', {
      DISCO_VOADOR_REALTIME_URL: url,
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'RejectDemo',
      DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
      DISCO_VOADOR_E2E_PROFILE_AVATAR_FILE_PATH: animatedAvatarPath,
      DISCO_VOADOR_E2E_PROFILE_EXIT_AFTER_STEPS: '1',
      DISCO_VOADOR_E2E_PROFILE_SCREENSHOT_DIR: captureDir,
      DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify([
        { action: 'resize', width: 1920, height: 1080 },
        { action: 'open-profile-editor' },
        { action: 'attempt-upload-self-avatar', ms: 800 },
        { action: 'wait', ms: 300 },
        { action: 'screenshot', name: '03-avatar-upload-rejected.png' },
      ]),
    });
    await avatarRejectDemo.waitFor('E2E_SCREENSHOT_SAVED:03-avatar-upload-rejected.png');
    await avatarRejectDemo.stop();
    console.info('Saved 03-avatar-upload-rejected.png');

    console.info(
      '=== HiddenProfileDemo: Server Settings open, "Server Profile" nav absent for a non-admin ===',
    );
    hiddenProfileDemo = spawnElectronE2E('hidden-profile-demo', {
      DISCO_VOADOR_REALTIME_URL: url,
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'ChannelAdminUser',
      DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
      DISCO_VOADOR_E2E_PROFILE_EXIT_AFTER_STEPS: '1',
      DISCO_VOADOR_E2E_PROFILE_SCREENSHOT_DIR: captureDir,
      DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify([
        { action: 'resize', width: 1920, height: 1080 },
        { action: 'wait-group', groupId: channelAdminGroupId, timeoutMs: 20_000 },
        { action: 'open-server-settings' },
        { action: 'wait', ms: 300 },
        { action: 'screenshot', name: '09-server-settings-hidden-profile.png' },
        { action: 'close-server-settings' },
      ]),
    });
    const channelAdminJoined = await waitForMessage(
      adminRaw.ws,
      (m) =>
        m.type === 'voice:participant-joined' && m.participant.displayName === 'ChannelAdminUser',
      'voice:participant-joined for ChannelAdminUser',
    );
    await sendRequest(
      adminRaw.ws,
      {
        type: 'client:authorization-grant-group',
        id: freshId('grant-channel-admin'),
        targetParticipantId: channelAdminJoined.participant.participantId,
        groupId: channelAdminGroupId,
      },
      ['server:authorization-ack'],
    );
    await hiddenProfileDemo.waitFor('E2E_SCREENSHOT_SAVED:09-server-settings-hidden-profile.png');
    await hiddenProfileDemo.stop();
    console.info('Saved 09-server-settings-hidden-profile.png');

    console.info(
      '=== AdminUser: Profile Editor, presence change, Server Profile admin section ===',
    );
    adminUser = spawnElectronE2E('admin', {
      DISCO_VOADOR_REALTIME_URL: url,
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'AdminUser',
      DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
      DISCO_VOADOR_E2E_PROFILE_AVATAR_FILE_PATH: validAvatarPath,
      DISCO_VOADOR_E2E_PROFILE_SCREENSHOT_DIR: captureDir,
      DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify([
        { action: 'resize', width: 1920, height: 1080 },
        { action: 'wait-group', groupId: ownerGroupId, timeoutMs: 20_000 },
        { action: 'open-profile-editor' },
        { action: 'upload-self-avatar' },
        { action: 'set-status', text: 'Building OvniChat' },
        // Deliberately delayed (not the earlier 300ms) — see this task's own T13.3 QA follow-up:
        // an earlier capture briefly looked like a broken avatar image here; root-caused to an
        // invalid test-fixture PNG (fixed in `lib/avatar-fixtures.mjs`), not a timing race, but this
        // longer, deliberate wait remains as real evidence against a timing explanation recurring.
        { action: 'wait', ms: 1500 },
        { action: 'screenshot', name: '01-profile-editor.png' },
        { action: 'set-presence', value: 'away' },
        { action: 'wait', ms: 1500 },
        { action: 'screenshot', name: '02-presence-selector.png' },
        { action: 'close-profile-editor' },
        { action: 'wait', ms: 300 },
        { action: 'open-server-settings' },
        { action: 'click', selector: '[data-testid="server-settings-nav-profile"]' },
        { action: 'wait', ms: 400 },
        { action: 'screenshot', name: '07-server-profile-admin.png' },
        { action: 'close-server-settings' },
      ]),
    });
    const adminJoined = await waitForMessage(
      adminRaw.ws,
      (m) => m.type === 'voice:participant-joined' && m.participant.displayName === 'AdminUser',
      'voice:participant-joined for AdminUser',
    );
    await sendRequest(
      adminRaw.ws,
      {
        type: 'client:authorization-grant-group',
        id: freshId('grant-owner'),
        targetParticipantId: adminJoined.participant.participantId,
        groupId: ownerGroupId,
      },
      ['server:authorization-ack'],
    );
    await adminUser.waitFor('E2E_SCREENSHOT_SAVED:07-server-profile-admin.png');
    console.info(
      'Saved 01-profile-editor.png, 02-presence-selector.png, 07-server-profile-admin.png',
    );

    console.info(
      '=== ModUser: sets up, then waits for PlainUser to capture the moderator popover ===',
    );
    modUser = spawnElectronE2E('mod', {
      DISCO_VOADOR_REALTIME_URL: url,
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'ModUser',
      DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
      DISCO_VOADOR_E2E_PROFILE_AVATAR_FILE_PATH: validAvatarPath,
      DISCO_VOADOR_E2E_PROFILE_SCREENSHOT_DIR: captureDir,
      DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify([
        { action: 'resize', width: 1920, height: 1080 },
        { action: 'wait-group', groupId: moderatorGroupId, timeoutMs: 20_000 },
        { action: 'open-profile-editor' },
        { action: 'upload-self-avatar' },
        { action: 'set-status', text: 'On call duty' },
        { action: 'close-profile-editor' },
        {
          action: 'wait-condition',
          expression: rowContainsExpression('PlainUser', 'PlainUser'),
          timeoutMs: 60_000,
        },
        { action: 'open-member-popover', name: 'PlainUser' },
        { action: 'wait', ms: 1500 },
        { action: 'screenshot', name: '06-member-popover-moderator.png' },
        { action: 'close-member-popover' },
      ]),
    });
    const modJoined = await waitForMessage(
      adminRaw.ws,
      (m) => m.type === 'voice:participant-joined' && m.participant.displayName === 'ModUser',
      'voice:participant-joined for ModUser',
    );
    await sendRequest(
      adminRaw.ws,
      {
        type: 'client:authorization-grant-group',
        id: freshId('grant-moderator'),
        targetParticipantId: modJoined.participant.participantId,
        groupId: moderatorGroupId,
      },
      ['server:authorization-ack'],
    );

    console.info(
      '=== PlainUser (genuinely no group at all): Member Panel, normal popover, bottom bar ===',
    );
    // Deliberately holds NO group whatsoever — unlike `hiddenProfileDemo` above, this identity must
    // render as a real, unbadged "Member" in the Member Panel (screenshot 04), which holding
    // `channels.manage` would immediately contradict (`role-bucket.ts`'s own "Admin" bucket rule).
    plainUser = spawnElectronE2E('plain', {
      DISCO_VOADOR_REALTIME_URL: url,
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'PlainUser',
      DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
      DISCO_VOADOR_E2E_PROFILE_AVATAR_FILE_PATH: validAvatarPath,
      DISCO_VOADOR_E2E_PROFILE_EXIT_AFTER_STEPS: '1',
      DISCO_VOADOR_E2E_PROFILE_SCREENSHOT_DIR: captureDir,
      DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify([
        { action: 'resize', width: 1920, height: 1080 },
        { action: 'open-profile-editor' },
        { action: 'upload-self-avatar' },
        { action: 'set-status', text: 'Just here for the vibes' },
        { action: 'close-profile-editor' },
        { action: 'wait', ms: 800 },
        { action: 'screenshot', name: '04-member-panel.png' },
        { action: 'open-member-popover', name: 'AdminUser' },
        { action: 'wait', ms: 1500 },
        { action: 'screenshot', name: '05-member-popover-normal.png' },
        { action: 'close-member-popover' },
        { action: 'wait', ms: 300 },
        { action: 'screenshot', name: '08-user-control-bar.png' },
      ]),
    });
    await plainUser.waitFor('E2E_SCREENSHOT_SAVED:08-user-control-bar.png');
    console.info(
      'Saved 04-member-panel.png, 05-member-popover-normal.png, 08-user-control-bar.png',
    );

    await modUser.waitFor('E2E_SCREENSHOT_SAVED:06-member-popover-moderator.png');
    console.info('Saved 06-member-popover-moderator.png');

    console.info(`All T13.3 screenshots captured under: ${captureDir}`);
  } finally {
    adminRaw.ws.close();
    await avatarRejectDemo?.stop();
    await hiddenProfileDemo?.stop();
    await adminUser?.stop();
    await modUser?.stop();
    await plainUser?.stop();
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
      `E2E screenshot-capture-t13-3 failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
