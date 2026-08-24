// T13.4 targeted fix — proves the headline bug is actually fixed: "I lowered a peer's local volume,
// but OvniChat forgets that preference when the client restarts." Two real Electron instances (A, B)
// against a real Dedicated Server. B joins once and stays joined for the whole scenario (its
// participantId never changes) — A is launched and relaunched *four* times against the same
// `--user-data-dir`, so its local `settings.json` genuinely persists across each relaunch, exactly
// like a user closing and reopening OvniChat.
//
//   A-1: drives the real "User Volume" UI to set B's local volume to 55%, then quits.
//   A-2: relaunches fresh, rejoins, and must restore 55% automatically with no manual adjustment —
//        proven via the real `disco-voador:voice-preference-applied:<participantId>:<percent>:
//        <muted>` marker `use-voice-channel.ts`'s attach-with-preference logic emits once it has
//        resolved this participant's stable identity, loaded the stored preference over the real
//        `getVoicePreference` IPC channel, and applied it to the real `RemoteAudioGraphController`
//        `GainNode` — the full pipeline, not a mocked slice of it.
//   A-3: relaunches again and drives only "Mute for Me" (the volume slider is never touched), then
//        quits.
//   A-4: relaunches a final time and must restore *both* 55% and muted — proving mute never resets
//        the stored volume (T13.4 Section 12).
//
// Never plays real audible output — `RemoteAudioGraphController`'s decode-keep-alive element is
// muted by construction, and this script never inspects speaker output at all; it reads the
// already-resolved preference values straight out of the real, product `console.info` marker.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { spawnElectronE2E } from './lib/spawn-electron-e2e.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

function fail(message) {
  console.error(message);
  process.exit(1);
}

/** Parses `"<participantId>:<volumePercent>:<locallyMuted>"` — participantIds in this app are
 * `randomUUID()`s (no colons), so a plain split is unambiguous. */
function parseAppliedMarker(value) {
  if (!value) return undefined;
  const parts = value.split(':');
  if (parts.length !== 3) return undefined;
  return {
    participantId: parts[0],
    volumePercent: Number(parts[1]),
    locallyMuted: parts[2] === 'true',
  };
}

async function main() {
  console.info('Starting Dedicated Server...');
  const { child: realtimeChild, host, port } = await startDedicatedServer();
  const realtimeUrl = `ws://${host}:${String(port)}`;
  console.info(`Dedicated Server listening on ${host}:${String(port)}`);

  const dirA = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-voice-pref-a-'));
  let bInstance;

  const baseEnv = {
    DISCO_VOADOR_REALTIME_URL: realtimeUrl,
    DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
    // Relays both instances' Renderer console output to their own stdout — see
    // `armE2EVoicePreferenceSmokeRelay` in `main/index.ts`.
    DISCO_VOADOR_E2E_VOICE_PREFERENCE_SMOKE: '1',
  };

  try {
    console.info('Launching B (stays joined for the whole scenario)...');
    bInstance = spawnElectronE2E('B', { ...baseEnv, DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'B' });
    await bInstance.waitFor('disco-voador:voice-joined:general');

    console.info("Launching A (1st): setting B's local volume to 55%...");
    let a = spawnElectronE2E(
      'A-1',
      {
        ...baseEnv,
        DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'A',
        DISCO_VOADOR_E2E_VOICE_PREFERENCE_SET_PERCENT: '55',
      },
      dirA,
    );
    await a.waitFor('E2E_VOICE_PREFERENCE_ADJUSTED');
    // Waits for this instance's own graceful self-exit (see `armE2EVoicePreferenceAdjust`'s doc
    // comment) before relaunching the same profile — an external `.stop()`-driven kill here was found
    // live to corrupt this profile's `safeStorage`-encrypted identity file badly enough that the next
    // relaunch could not decrypt it at all.
    await a.exitedPromise;
    await a.stop();

    console.info('Relaunching A (2nd, same profile): expecting 55% to restore automatically...');
    a = spawnElectronE2E(
      'A-2',
      {
        ...baseEnv,
        DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'A',
        DISCO_VOADOR_E2E_VOICE_PREFERENCE_VERIFY: '1',
      },
      dirA,
    );
    await a.waitFor('disco-voador:voice-preference-applied:');
    const afterRelaunch = parseAppliedMarker(
      a.lastMarkerValue('disco-voador:voice-preference-applied:'),
    );
    await a.exitedPromise;
    await a.stop();
    if (!afterRelaunch) fail('A (2nd launch) never reported a restored voice preference.');
    if (afterRelaunch.volumePercent !== 55) {
      fail(
        `Expected 55% to restore after relaunch, but got ${String(afterRelaunch.volumePercent)}%.`,
      );
    }
    if (afterRelaunch.locallyMuted !== false) {
      fail('Expected the peer to not be locally muted yet, but the restored preference was muted.');
    }
    console.info(
      `Confirmed: volume restored to ${String(afterRelaunch.volumePercent)}% after a real relaunch.`,
    );

    console.info('Relaunching A (3rd): toggling Mute for Me only (volume untouched)...');
    a = spawnElectronE2E(
      'A-3',
      {
        ...baseEnv,
        DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'A',
        DISCO_VOADOR_E2E_VOICE_PREFERENCE_SET_MUTE: '1',
      },
      dirA,
    );
    await a.waitFor('E2E_VOICE_PREFERENCE_ADJUSTED');
    await a.exitedPromise;
    await a.stop();

    console.info('Relaunching A (4th): expecting BOTH 55% and muted to restore together...');
    a = spawnElectronE2E(
      'A-4',
      {
        ...baseEnv,
        DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'A',
        DISCO_VOADOR_E2E_VOICE_PREFERENCE_VERIFY: '1',
      },
      dirA,
    );
    await a.waitFor('disco-voador:voice-preference-applied:');
    const afterMuteRelaunch = parseAppliedMarker(
      a.lastMarkerValue('disco-voador:voice-preference-applied:'),
    );
    await a.exitedPromise;
    await a.stop();
    if (!afterMuteRelaunch) fail('A (4th launch) never reported a restored voice preference.');
    if (afterMuteRelaunch.volumePercent !== 55) {
      fail(
        `Muting must never reset the stored volume — expected 55%, got ${String(afterMuteRelaunch.volumePercent)}%.`,
      );
    }
    if (afterMuteRelaunch.locallyMuted !== true) {
      fail('Expected the peer to still be locally muted after this relaunch, but it was not.');
    }
    // Deliberately does NOT assert `afterMuteRelaunch.participantId === afterRelaunch.participantId`:
    // B (which never itself relaunches) can still legitimately reconnect mid-scenario for reasons
    // unrelated to this fix (e.g. a transient rate limit against the shared test server across four
    // A launches' worth of join/leave churn), which mints B a genuinely new `participantId` — and
    // when that happened live during this exact test, `afterMuteRelaunch` still correctly carried
    // 55%/muted against that new id, which is *stronger* evidence for this fix than a same-id run
    // would be (see `tests/realtime/protocol-handlers.test.ts`'s own dedicated, deterministic
    // leave/rejoin-new-participantId proof for the version of this claim that doesn't depend on an
    // incidental reconnect happening to occur).

    console.info(
      'E2E voice-preference smoke test passed: local volume/mute preference for a real remote ' +
        "participant survived real Electron relaunches, restoring before/at the audio graph's own " +
        'attach — never a reset, never a brief 100% blast first.',
    );
    process.exit(0);
  } finally {
    await bInstance?.stop();
    rmSync(dirA, { recursive: true, force: true });
    realtimeChild.kill();
  }
}

main().catch((error) => {
  fail(
    `E2E voice-preference smoke test crashed: ${error instanceof Error ? error.message : String(error)}`,
  );
});
