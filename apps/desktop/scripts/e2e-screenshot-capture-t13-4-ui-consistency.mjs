// T13.4 UI-consistency follow-up — QA-pass screenshot-capture tooling only, producing this small
// sub-task's own evidence set (Section 51 of its brief). Never a permanent regression test; not part
// of `pnpm check`. Reuses `armE2EProfileSmoke`'s existing generic step vocabulary
// (`open-profile-editor`/`upload-self-avatar`/`wait-condition`/`screenshot`/`resize` — see
// `apps/desktop/src/main/index.ts`) exactly as `e2e-profile-avatar-smoke.mjs` does; no Main/Renderer
// product or scaffold code needed changing for this script to exist.
//
// Scenario: Bob (real Electron) joins "general" with no avatar, then — after a generous fixed delay
// comfortably past Alice's own fallback capture below — uploads a real avatar and keeps running.
// Bob's own transmission is forced deterministically via the same simulated-PTT technique
// `e2e-screenshot-capture-t13-4.mjs`/`armE2EPttSimulation` already establish (switch to push-to-talk
// via real DOM clicks, then a Main-driven simulated PTT `'down'` edge on the real `pttState` IPC
// channel), NOT left to the default Voice-Activity mode's own local threshold — a real, documented
// finding (`armE2EPttHoldOnJoin`'s own doc comment in `apps/desktop/src/main/index.ts`) is that the
// fake microphone's ambient signal only unreliably clears the local Voice-Activity gate on its own; PTT
// bypasses that local gate entirely and reliably puts real, decodable audio on the wire, which is what
// this script actually needs proof of (the *receiving* side's speaking-ring analysis, exercised the
// same way for both this script and the original T13.4 screenshot script). Alice (real Electron) joins
// the same channel and drives every capture, gated on real, condition-polled DOM reads scoped to "a
// participant/member row that also has a real avatar image" — never a fixed guessed timer racing Bob's
// own upload, and never ambiguous with Alice's own (avatar-less, so structurally excluded by the same
// selector) row even though Alice's own fake microphone may also be transmitting.
//
// Produces (docs/tasks/screenshots/t13-4-ui-consistency/):
//   05-voice-participant-fallback.png       — Bob's row before he has any avatar (initials fallback)
//   01-voice-participant-avatar.png         — Bob's row after his real avatar appears, live, no reconnect
//   02-voice-participant-speaking-avatar.png — Bob's row with both his real avatar AND the speaking ring
//   03-member-panel-speaking.png            — the server-wide Member Panel showing the same speaking ring
// `04-avatar-live-update.png` (optional per the brief) is deliberately not produced by this pass: proving
// a *second*, visually distinct live avatar change would need `armE2EProfileSmoke`'s single fixed
// `DISCO_VOADOR_E2E_PROFILE_AVATAR_FILE_PATH` to support swapping mid-run, a small scaffold change not
// worth making for one optional screenshot when 01/05 already prove the live (no-reconnect) avatar
// path and `e2e:profile-avatar-smoke` already separately proves live avatar propagation end to end.
//
// Prerequisites: `pnpm --filter @disco-voador/dedicated-server run build` and
// `pnpm --filter @disco-voador/desktop exec electron-forge package` must have already been run.

import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { writeValidAvatarFixture } from './lib/avatar-fixtures.mjs';
import { spawnElectronE2E } from './lib/spawn-electron-e2e.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopDir, '..', '..');
const captureDir = path.join(repoRoot, 'docs', 'tasks', 'screenshots', 't13-4-ui-consistency');

const CHANNEL_ID = 'general';

// Any participant row (self or remote) whose avatar wrap carries a real `<img>` — scoped this way,
// rather than by a specific participantId, because this script never learns Bob's participantId (no
// step here needs it); Alice's own row is structurally excluded since Alice never uploads an avatar.
const ANY_PARTICIPANT_HAS_AVATAR =
  `Array.from(document.querySelectorAll('[data-testid^="participant-row-avatar-wrap-"]'))` +
  `.some((el) => el.querySelector('img'))`;
const ANY_PARTICIPANT_ROW_COUNT_AT_LEAST_TWO = `document.querySelectorAll('[data-testid^="participant-row-avatar-wrap-"]').length >= 2`;
const SPEAKING_PARTICIPANT_HAS_AVATAR =
  `Array.from(document.querySelectorAll('[data-testid^="participant-row-avatar-wrap-"][data-speaking="true"]'))` +
  `.some((el) => el.querySelector('img'))`;
const SPEAKING_MEMBER_ROW_HAS_AVATAR =
  `Array.from(document.querySelectorAll('[data-testid^="member-row-"]'))` +
  `.some((el) => el.querySelector('[data-speaking="true"]') && el.querySelector('img'))`;

async function main() {
  rmSync(captureDir, { recursive: true, force: true });
  mkdirSync(captureDir, { recursive: true });

  console.info('Starting Dedicated Server (real, open access, ephemeral)...');
  const server = await startDedicatedServer();
  const url = `ws://${server.host}:${String(server.port)}`;
  console.info(`Dedicated Server listening on ${server.host}:${String(server.port)}`);

  const validAvatarPath = writeValidAvatarFixture();
  let bob;
  let alice;

  try {
    console.info(
      'Launching Bob (real Electron) — joins with no avatar, uploads one shortly after...',
    );
    bob = spawnElectronE2E('bob', {
      DISCO_VOADOR_REALTIME_URL: url,
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Bob',
      DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
      DISCO_VOADOR_E2E_PROFILE_AVATAR_FILE_PATH: validAvatarPath,
      // Fixed-delay-since-launch simulated PTT edge (`armE2EPttSimulation`) — held from 8s to 50s,
      // comfortably spanning every wait-condition Alice's own steps below can take.
      DISCO_VOADOR_E2E_PTT_DOWN_AFTER_MS: '8000',
      DISCO_VOADOR_E2E_PTT_UP_AFTER_MS: '50000',
      DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify([
        // Switch to push-to-talk immediately, well before the 8s simulated-down edge above — the
        // simulated edge only affects `TransmitGate` while `voiceInputMode === 'push-to-talk'`.
        { action: 'wait', ms: 500 },
        { action: 'click', selector: '[data-testid="user-control-settings"]' },
        { action: 'wait', ms: 400 },
        { action: 'click', selector: '[data-testid="settings-nav-voice"]' },
        { action: 'wait', ms: 300 },
        { action: 'click', selector: '[data-testid="voice-input-mode-push-to-talk"]' },
        { action: 'wait', ms: 300 },
        { action: 'click', selector: '[aria-label="Close"]' },
        // Generous, fixed delay — comfortably past Alice's own join + fallback-capture time below,
        // matching this codebase's established "generous fixed wait over a fragile race" convention
        // (see e.g. the existing T13.4 screenshot script's own 1500ms/19000ms waits).
        { action: 'wait', ms: 4500 },
        { action: 'open-profile-editor' },
        { action: 'upload-self-avatar' },
        { action: 'close-profile-editor' },
      ]),
    });
    await bob.waitFor(`disco-voador:voice-joined:${CHANNEL_ID}`);
    console.info('Bob joined "general" with no avatar yet.');

    console.info('Launching Alice (real Electron) — drives every capture...');
    alice = spawnElectronE2E('alice', {
      DISCO_VOADOR_REALTIME_URL: url,
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: CHANNEL_ID,
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Alice',
      DISCO_VOADOR_E2E_PROFILE_SMOKE: '1',
      DISCO_VOADOR_E2E_PROFILE_SCREENSHOT_DIR: captureDir,
      DISCO_VOADOR_E2E_PROFILE_EXIT_AFTER_STEPS: '1',
      DISCO_VOADOR_E2E_PROFILE_STEPS: JSON.stringify([
        { action: 'resize', width: 1920, height: 1080 },
        {
          action: 'wait-condition',
          expression: ANY_PARTICIPANT_ROW_COUNT_AT_LEAST_TWO,
          timeoutMs: 20000,
        },
        { action: 'wait', ms: 1000 },
        { action: 'screenshot', name: '05-voice-participant-fallback.png' },

        { action: 'wait-condition', expression: ANY_PARTICIPANT_HAS_AVATAR, timeoutMs: 20000 },
        { action: 'wait', ms: 500 },
        { action: 'screenshot', name: '01-voice-participant-avatar.png' },

        { action: 'wait-condition', expression: SPEAKING_PARTICIPANT_HAS_AVATAR, timeoutMs: 60000 },
        { action: 'wait', ms: 300 },
        { action: 'screenshot', name: '02-voice-participant-speaking-avatar.png' },

        { action: 'wait-condition', expression: SPEAKING_MEMBER_ROW_HAS_AVATAR, timeoutMs: 60000 },
        { action: 'wait', ms: 300 },
        { action: 'screenshot', name: '03-member-panel-speaking.png' },
      ]),
    });
    await alice.waitFor('E2E_PROFILE_SMOKE_STEPS_DONE', 150000);
    await alice.exitedPromise;

    const stdout = alice.getStdout();
    const expected = [
      '05-voice-participant-fallback.png',
      '01-voice-participant-avatar.png',
      '02-voice-participant-speaking-avatar.png',
      '03-member-panel-speaking.png',
    ];
    const missing = expected.filter((name) => !stdout.includes(`E2E_SCREENSHOT_SAVED:${name}`));
    if (missing.length > 0) {
      throw new Error(`Missing expected screenshot save marker(s): ${missing.join(', ')}`);
    }

    console.info(
      `T13.4 UI-consistency screenshot capture complete. Saved ${String(expected.length)} files to: ${captureDir}`,
    );
  } finally {
    await alice?.stop();
    await bob?.stop();
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
      `T13.4 UI-consistency screenshot capture failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
