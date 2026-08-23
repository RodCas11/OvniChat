// Throwaway diagnostic (not wired into package.json) investigating the coordinator's report of a
// small, oddly-shaped glyph in the large (80x80) avatar slot in screenshots 01/02/05/06, versus
// clean rendering at small (28px) sizes in 04/08. Reads the REAL DOM `<img>` state
// (complete/naturalWidth/naturalHeight) via `armE2EProfileSmoke`'s new `read-avatar-image-state`
// step — the programmatic equivalent of inspecting DevTools' Elements/Network panel by hand.

import { writeValidAvatarFixture } from './lib/avatar-fixtures.mjs';
import { spawnElectronE2E } from './lib/spawn-electron-e2e.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const CHANNEL_ID = 'general';

function readMarker(stdout, prefix) {
  let found;
  for (const line of stdout.split('\n')) {
    const idx = line.indexOf(prefix);
    if (idx === -1) continue;
    found = line.slice(idx + prefix.length).trim();
  }
  return found;
}

async function main() {
  const server = await startDedicatedServer();
  const url = `ws://${server.host}:${String(server.port)}`;
  const validAvatarPath = writeValidAvatarFixture();
  console.info(`Using existing fixture (suspect): ${validAvatarPath}`);

  const instance = spawnElectronE2E('diag', {
    DISCO_VOADOR_REALTIME_URL: url,
    DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
    DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Diag',
    DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
    DISCO_VOADOR_E2E_PROFILE_AVATAR_FILE_PATH: validAvatarPath,
    DISCO_VOADOR_E2E_PROFILE_EXIT_AFTER_STEPS: '1',
    DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify([
      { action: 'wait', ms: 500 },
      { action: 'open-profile-editor' },
      { action: 'upload-self-avatar' },
      // Immediately after upload (cache already populated by this same upload's own reply).
      {
        action: 'read-avatar-image-state',
        name: 'profile-editor',
        marker: 'immediately-after-upload',
      },
      { action: 'close-profile-editor' },
      // Deliberately delayed re-open — tests the coordinator's "mid-fetch" timing hypothesis: if the
      // popover's own `onRequestAvatar` mount-time fetch just hadn't resolved yet, waiting and
      // re-opening fresh should show it resolved by now.
      { action: 'wait', ms: 3000 },
      { action: 'open-profile-editor' },
      { action: 'wait', ms: 2000 },
      { action: 'read-avatar-image-state', name: 'profile-editor', marker: 'delayed-reopen' },
      { action: 'close-profile-editor' },
    ]),
  });

  await instance.waitFor('E2E_PROFILE_SMOKE_STEPS_DONE');
  await instance.exitedPromise;
  const stdout = instance.getStdout();
  console.info(
    'immediately-after-upload:',
    readMarker(stdout, 'disco-voador:e2e-avatar-image-state:immediately-after-upload:'),
  );
  console.info(
    'delayed-reopen:          ',
    readMarker(stdout, 'disco-voador:e2e-avatar-image-state:delayed-reopen:'),
  );

  if (server.child.exitCode === null && server.child.signalCode === null) {
    server.child.kill('SIGTERM');
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error('diag failed:', error);
    process.exit(1);
  });
