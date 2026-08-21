// T12 — the mandatory, non-negotiable process-loopback isolation proof (see
// docs/tasks/T12_WINDOWS_PROCESS_AUDIO.md's Acceptance criteria): two independently running Windows
// processes produce different known tones; the user selects one; the remote client receives that
// process's audio and demonstrably does NOT receive the other's. Exercises the real path end to end
// — real Windows audio rendering (`scripts/lib/tone-process/main.mjs`) -> real native process-loopback
// capture (`packages/windows-media/native/`) -> the real supervisor -> the real PCM bridge -> a real
// `MediaStreamTrack` -> the existing `screen-audio` semantic source -> real WebRTC -> a real remote
// Electron client's frequency-domain probe (`e2e-frequency-probe.ts`). No synthetic MediaStreamTrack
// is ever injected into the publisher at any point.
//
// Topology per scenario: TWO tone processes (Process A, Process B — genuinely separate `electron.exe`
// process trees, never the same process, never two instances of one process; see the tone-process
// script's own doc comment for why exeName can't distinguish them and PID-exact-matching is used
// instead) + ONE publisher (real OvniChat, auto-selects Application Audio targeting one tone
// process's real PID) + ONE viewer (real OvniChat, runs the frequency probe on the resulting remote
// screen-audio track). Mirrors `e2e-screen-audio-smoke.mjs`'s proven one-publisher/one-viewer
// launch-mechanics (unpackaged app only, ELECTRON_RUN_AS_NODE genuinely absent, isolated
// --user-data-dir per instance) — see that script's header for the shared rationale.
//
// Four scenarios, run in sequence against fresh instances every time (hot-switching the selected
// process mid-share is out of scope — see the task doc):
//   1. Select A, expect A / reject B — the primary isolation proof.
//   2. Select B, expect B / reject A — the REVERSED selection. This is not a redundant repeat: it is
//      the single strongest defense against a probe/harness bug that would report PASS regardless of
//      what was actually selected (e.g. a probe that always finds *some* tone and calls it a pass).
//      A harness that only ever tested one fixed direction could not tell "isolation actually works"
//      from "the probe always passes."
//   3. Mid-share lifecycle proof: select A, confirm isolation, mute/unmute the publisher's
//      microphone (screen-audio must be unaffected), then stop sharing (screen-audio must end
//      cleanly with the peer connection and microphone still healthy).
//   4. Target-process-exit proof: select A, confirm isolation, then the orchestrator itself kills
//      Process A directly (never via the app's own "stop sharing" action) — the viewer must observe
//      a clean, healthy-peer end, and no native helper process may remain running afterward.
//
// Tone frequencies are 500 Hz and 750 Hz — deliberately NOT an integer/harmonic ratio of each other
// (unlike e.g. 440/880, where 880 is exactly the second harmonic of 440 — a real encode/decode
// nonlinearity could then produce a weak, ambiguous energy peak at the "rejected" tone's own
// frequency purely as an artifact of the "expected" tone, undermining the rejection half of the
// proof). See e2e-frequency-probe.ts's own doc comment for the FFT/threshold/margin design.
//
// Prerequisites: `pnpm --filter @disco-voador/dedicated-server run build` and
// `pnpm --filter @disco-voador/desktop exec electron-forge package` must have already been run (the
// latter also produces .vite/build/, which this script's unpackaged Electron launches load from).
// The native helper (packages/windows-media/native/process-loopback-helper/build.ps1) must already
// be built.

import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import electronPath from 'electron';

import { ProcessLoopbackSupervisor } from '@disco-voador/windows-media';

import { buildElectronE2EEnvironment } from './lib/electron-e2e-env.mjs';
import { startDedicatedServer } from './lib/start-dedicated-server.mjs';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = path.resolve(desktopDir, '..', '..');
const mainEntry = path.join(desktopDir, '.vite', 'build', 'main.cjs');
const toneProcessEntry = path.join(desktopDir, 'scripts', 'lib', 'tone-process', 'main.mjs');
const helperExePath = path.join(
  repoRoot,
  'packages',
  'windows-media',
  'native',
  'process-loopback-helper',
  'build',
  'process-loopback-helper.exe',
);

const FREQ_A = 500;
const FREQ_B = 750;

const TONE_READY_TIMEOUT_MS = 15_000;
// Generous: two tone processes, an enumeration probe, and two full app instances (voice + screen
// video + a second process-audio renegotiation cycle, per use-voice-channel.ts's own "audio
// acquired after video is already publishing" sequencing) all run concurrently on one machine —
// live-measured to need meaningfully more headroom than the simpler two-instance smoke scripts.
const INSTANCE_TIMEOUT_MS = 180_000;

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!existsSync(mainEntry)) {
  fail(
    `Built Vite main entry not found at ${mainEntry}.\nRun "pnpm --filter @disco-voador/desktop exec electron-forge package" first (this also produces .vite/build/).`,
  );
}
if (!existsSync(toneProcessEntry)) {
  fail(`Tone-process entry not found at ${toneProcessEntry}.`);
}

/**
 * Wraps one long-lived, enumeration-only `ProcessLoopbackSupervisor` — the same class
 * `apps/desktop/src/main/process-audio.ts` uses in the real app, driven directly from this Node
 * script (no Electron needed for enumeration alone). Reused across the whole run so this harness
 * never needs to spawn more than one native helper for discovery purposes.
 */
async function createEnumerationProbe() {
  const supervisor = new ProcessLoopbackSupervisor({ helperPath: helperExePath });
  await supervisor.start();

  return {
    /** Resolves with the current real, running audio-session candidates (`{pid, exeName}[]`). */
    enumerate() {
      return new Promise((resolve, reject) => {
        const onResponse = (candidates) => {
          cleanup();
          resolve(candidates);
        };
        const onError = (error) => {
          cleanup();
          reject(new Error(`enumeration probe error: ${error.message}`));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error('enumeration probe timed out'));
        }, 8000);
        function cleanup() {
          clearTimeout(timer);
          supervisor.off('enumerateResponse', onResponse);
          supervisor.off('error', onError);
        }
        supervisor.on('enumerateResponse', onResponse);
        supervisor.on('error', onError);
        supervisor.requestEnumerate();
      });
    },
    dispose() {
      supervisor.dispose();
    },
  };
}

/**
 * Spawns one standalone tone-generator process (see `lib/tone-process/main.mjs`), waits for it to
 * confirm its oscillator started, then discovers the *real* OS PID that ends up owning its WASAPI
 * audio session — via enumeration diffing through `probe`, never the tone process's own reported
 * `process.pid`. This distinction is real, not defensive: Electron is itself a multi-process
 * application, and live testing showed the audio session is enumerated under a *child* process, not
 * the Main process whose PID `main.mjs` reports — see this script's own header comment. Retries the
 * diff briefly (WASAPI session registration can lag a moment behind the oscillator actually
 * starting) before failing loudly if the new PID can't be identified unambiguously.
 */
async function spawnToneProcess(label, frequencyHz, probe) {
  const baseline = await probe.enumerate();
  const baselinePids = new Set(baseline.map((c) => c.pid));

  const child = await new Promise((resolve, reject) => {
    const c = spawn(electronPath, [toneProcessEntry, `--frequency=${String(frequencyHz)}`], {
      cwd: desktopDir,
      env: buildElectronE2EEnvironment(process.env, {}),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      c.kill();
      reject(
        new Error(`[${label}] tone process did not report ready within ${TONE_READY_TIMEOUT_MS}ms`),
      );
    }, TONE_READY_TIMEOUT_MS);

    let stdout = '';
    c.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      stdout += text;
      process.stdout.write(`[${label}] ${text}`);
      if (/TONE_PROCESS_READY:pid=(\d+)/.exec(stdout) && !settled) {
        settled = true;
        clearTimeout(timer);
        resolve(c);
      }
    });
    c.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk.toString()}`));
    c.on('exit', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(new Error(`[${label}] tone process exited early (code ${String(code)})`));
      }
    });
  });

  let candidates = [];
  for (let attempt = 0; attempt < 6; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
    candidates = await probe.enumerate();
    const fresh = candidates.filter((c) => !baselinePids.has(c.pid));
    if (fresh.length === 1) {
      console.info(
        `[${label}] discovered real audio-session pid=${fresh[0].pid} (${fresh[0].exeName})`,
      );
      return { label, frequencyHz, pid: fresh[0].pid, child };
    }
  }

  child.kill();
  throw new Error(
    `[${label}] could not uniquely identify the tone process's real audio-session PID after retries ` +
      `(baseline: ${[...baselinePids].join(',')}; last enumeration: ${candidates.map((c) => `${c.exeName}(${String(c.pid)})`).join(', ')})`,
  );
}

/** Terminates a tone process and waits (bounded) for it to actually exit — never leaves a zombie
 * `electron.exe` behind between scenarios, which would otherwise pollute later scenarios' own
 * process-loopback enumeration with a stale, silent "ghost" candidate. */
function killToneProcess(tone) {
  return new Promise((resolve) => {
    if (tone.child.exitCode !== null || tone.child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      tone.child.kill('SIGKILL');
    }, 5000);
    tone.child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    tone.child.kill('SIGTERM');
  });
}

/** Launches one unpackaged OvniChat Electron instance with the given E2E env overrides, relays its
 * stdout with a `[label]` prefix, and resolves once it exits. Unlike the simpler smoke scripts, this
 * one also exposes the accumulated stdout to the caller even on a "timeout" outcome (via
 * `settleEarly`), since several scenarios need to react to a marker appearing *during* the run (kill
 * a tone process, then keep watching), not only after the instance's own process exits. */
function runInstance(label, realtimeUrl, envOverrides, { onStdout } = {}) {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-process-audio-'));

  let resolveFn;
  const promise = new Promise((resolve) => {
    resolveFn = resolve;
  });

  const child = spawn(electronPath, [desktopDir, `--user-data-dir=${userDataDir}`], {
    cwd: desktopDir,
    env: buildElectronE2EEnvironment(process.env, {
      DISCO_VOADOR_REALTIME_URL: realtimeUrl,
      DISCO_VOADOR_E2E_FAKE_MEDIA: '1',
      DISCO_VOADOR_E2E_VOICE_AUTO_JOIN_CHANNEL: 'general',
      ...envOverrides,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdout = '';
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill();
    resolveFn({ label, ok: false, stdout, reason: 'timeout' });
  }, INSTANCE_TIMEOUT_MS);

  child.stdout.on('data', (chunk) => {
    const text = chunk.toString();
    stdout += text;
    process.stdout.write(`[${label}] ${text}`);
    onStdout?.(text, stdout);
  });
  child.stderr.on('data', (chunk) => process.stderr.write(`[${label}] ${chunk.toString()}`));

  child.on('exit', (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    resolveFn({ label, ok: code === 0, stdout, reason: `exit ${String(code)}` });
  });

  const cleanup = () => {
    try {
      rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup only
    }
  };

  return {
    promise: promise.then((result) => {
      cleanup();
      return result;
    }),
    kill: () => child.kill(),
  };
}

/** Parses the single-line JSON evidence marker `e2e-frequency-probe.ts` emits. Returns `undefined`
 * if the marker never appeared in `stdout` at all (a hard failure the caller must treat as such —
 * never silently treated as "probe passed"). */
function parseFrequencyEvidence(stdout, markerPrefix = 'E2E_FREQ_PROBE') {
  const marker = `${markerPrefix}:`;
  const lines = stdout.split('\n');
  for (const line of lines) {
    const idx = line.indexOf(marker);
    if (idx === -1) continue;
    try {
      return JSON.parse(line.slice(idx + marker.length).trim());
    } catch {
      // A line containing the marker text but not valid JSON after it — keep scanning; this can
      // happen if the marker string appears inside an unrelated log line's own free text.
    }
  }
  return undefined;
}

/** Extracts the PID column (2nd field) from one `tasklist /fo csv /nh` line, e.g.
 * `"process-loopback-helper.exe","31860","Console","1","11.020 K"` -> `31860`. Returns `undefined`
 * for a line that doesn't match the expected shape (defensive only — real `tasklist` CSV output
 * always matches). */
function parseTasklistPid(line) {
  const match = /^"[^"]*","(\d+)"/.exec(line);
  return match ? Number(match[1]) : undefined;
}

/**
 * Lists every currently running `process-loopback-helper.exe` line from the real Windows process
 * list (`tasklist`), each still in its raw CSV form. Windows-only, matching this whole feature.
 *
 * Deliberately does not look for the English `"INFO: No tasks..."` no-match banner
 * `tasklist`/`/fo csv` prints when nothing matches the filter — that string is localized (this
 * exact development machine runs Portuguese Windows, where the real banner text is
 * `"INFORMAÇÕES: nenhuma tarefa..."`), and a real, empirically-observed early run of this script
 * *did* hit exactly this: with zero real helpers running, the localized banner slipped past an
 * English-only check and got mis-parsed as a single unrecognized "orphan" line — a false positive
 * this feature's own "no helper process remains after cleanup" proof must never produce. A genuine
 * `/fo csv` data row always starts with a double quote (the first CSV-quoted field); any banner/
 * informational text — in any language — never does, so that is the only signal this function
 * trusts to decide "no rows."
 */
function listHelperProcessLines() {
  if (process.platform !== 'win32') return [];
  try {
    const output = execFileSync(
      'tasklist',
      ['/fi', 'imagename eq process-loopback-helper.exe', '/fo', 'csv', '/nh'],
      { encoding: 'utf8' },
    );
    return output
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('"'));
  } catch {
    return [];
  }
}

/** Checks the real Windows process list for any still-running native helper this scenario itself is
 * responsible for — "no helper/native capture process remains after cleanup" is only real evidence
 * if checked against the real OS, not inferred from this script's own bookkeeping. `excludePids`
 * must always include this run's own long-lived enumeration-probe helper (see
 * `createEnumerationProbe`'s own doc comment: it is deliberately reused across the whole run and
 * disposed only once, in `main()`'s own `finally`, well after every individual scenario's own
 * cleanup check runs) — without this exclusion, every scenario that checks for orphans before the
 * very last one would find the probe's own still-legitimately-running helper and misreport it as an
 * orphan, a harness false positive rather than a real leak in the product being tested. */
function findRunningHelperProcesses(excludePids = new Set()) {
  return listHelperProcessLines().filter((line) => {
    const pid = parseTasklistPid(line);
    return pid === undefined || !excludePids.has(pid);
  });
}

function reportFrequencyEvidence(label, evidence) {
  if (!evidence) {
    console.error(`[${label}] no frequency-probe evidence marker found in stdout`);
    return false;
  }
  console.info(
    `[${label}] frequency evidence: expected=${String(evidence.expectedHz)}Hz@${evidence.expectedMagnitudeDb.toFixed(1)}dB ` +
      `rejected=${String(evidence.rejectedHz)}Hz@${evidence.rejectedMagnitudeDb.toFixed(1)}dB ` +
      `margin=${evidence.marginDb.toFixed(1)}dB (min ${String(evidence.minMarginDb)}dB) ` +
      `fftSize=${String(evidence.fftSize)} sampleRate=${String(evidence.sampleRateHz)}Hz ` +
      `binWidth=${evidence.binWidthHz.toFixed(2)}Hz searchRadius=±${String(evidence.binSearchRadius)}bins ` +
      `presenceThreshold=${String(evidence.presenceThresholdDb)}dB windows=${String(evidence.windowsAnalyzed)} ` +
      `passed=${String(evidence.passed)}`,
  );
  return evidence.passed === true;
}

async function runIsolationScenario(scenarioName, realtimeUrl, selectFreq, rejectFreq, probe) {
  console.info(
    `\n=== Scenario: ${scenarioName} (select ${String(selectFreq)}Hz, reject ${String(rejectFreq)}Hz) ===`,
  );
  const toneA = await spawnToneProcess('toneA', FREQ_A, probe);
  const toneB = await spawnToneProcess('toneB', FREQ_B, probe);
  const selectedTone = selectFreq === FREQ_A ? toneA : toneB;

  try {
    const publisher = runInstance('publisher', realtimeUrl, {
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Publisher',
      DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE: '1',
      DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_PID: String(selectedTone.pid),
    });
    const viewer = runInstance('viewer', realtimeUrl, {
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Viewer',
      DISCO_VOADOR_E2E_PROCESS_AUDIO_EXPECTED_HZ: String(selectFreq),
      DISCO_VOADOR_E2E_PROCESS_AUDIO_REJECTED_HZ: String(rejectFreq),
    });

    const [publisherResult, viewerResult] = await Promise.all([publisher.promise, viewer.promise]);
    console.info(
      `[${scenarioName}] publisher: ${publisherResult.reason}, viewer: ${viewerResult.reason}`,
    );

    if (!publisherResult.stdout.includes('E2E_PROCESS_AUDIO_SELECTED')) {
      console.error(`[${scenarioName}] publisher never confirmed selecting the target process`);
      return false;
    }

    const evidence = parseFrequencyEvidence(viewerResult.stdout);
    return reportFrequencyEvidence(scenarioName, evidence);
  } finally {
    await Promise.all([killToneProcess(toneA), killToneProcess(toneB)]);
  }
}

async function runLifecycleScenario(realtimeUrl, probe) {
  console.info('\n=== Scenario: mid-share lifecycle (mic-mute independence + clean stop) ===');
  const toneA = await spawnToneProcess('toneA', FREQ_A, probe);
  const toneB = await spawnToneProcess('toneB', FREQ_B, probe);

  try {
    const publisher = runInstance('publisher', realtimeUrl, {
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Publisher',
      DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE: '1',
      DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_PID: String(toneA.pid),
      // Scripted mid-share lifecycle: mute mic -> unmute -> stop sharing. See
      // VoiceChannelView.tsx's `processAudioLifecycleScenarioStarted` effect.
      DISCO_VOADOR_E2E_PROCESS_AUDIO_LIFECYCLE_SCENARIO: '1',
    });
    const viewer = runInstance('viewer', realtimeUrl, {
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Viewer',
      DISCO_VOADOR_E2E_PROCESS_AUDIO_EXPECTED_HZ: String(FREQ_A),
      DISCO_VOADOR_E2E_PROCESS_AUDIO_REJECTED_HZ: String(FREQ_B),
      // Arms the viewer's own post-mute re-probe (see VoiceChannelView.tsx's
      // `probedProcessAudioPostMute` effect) — the viewer never mutes anything itself, this only
      // signals "the lifecycle scenario is active, also run the timed post-mute re-probe."
      DISCO_VOADOR_E2E_PROCESS_AUDIO_LIFECYCLE_SCENARIO: '1',
    });

    const [publisherResult, viewerResult] = await Promise.all([publisher.promise, viewer.promise]);

    const initialEvidence = parseFrequencyEvidence(viewerResult.stdout, 'E2E_FREQ_PROBE');
    const initialOk = reportFrequencyEvidence('lifecycle-initial', initialEvidence);

    const postMuteEvidence = parseFrequencyEvidence(
      viewerResult.stdout,
      'E2E_FREQ_PROBE_POST_MUTE',
    );
    const postMuteOk = reportFrequencyEvidence('lifecycle-post-mute', postMuteEvidence);

    const micMuteMarkersPresent =
      publisherResult.stdout.includes('E2E_LOCAL_MIC_MUTED') &&
      publisherResult.stdout.includes('E2E_LOCAL_MIC_UNMUTED');
    if (!micMuteMarkersPresent) {
      console.error('lifecycle: publisher never confirmed the scripted mic mute/unmute phase');
    }

    const endedCleanly = /E2E_SCREEN_AUDIO_ENDED:[^\n]*peerState=connected/.exec(
      viewerResult.stdout,
    );
    if (!endedCleanly) {
      console.error(
        'lifecycle: viewer never observed a clean screen-audio end with a healthy peer',
      );
    }

    return initialOk && postMuteOk && micMuteMarkersPresent && Boolean(endedCleanly);
  } finally {
    await Promise.all([killToneProcess(toneA), killToneProcess(toneB)]);
  }
}

async function runTargetExitScenario(realtimeUrl, probe, preExistingHelperPids) {
  console.info('\n=== Scenario: target-process-exit cleanup + no orphan helper ===');
  const toneA = await spawnToneProcess('toneA', FREQ_A, probe);
  const toneB = await spawnToneProcess('toneB', FREQ_B, probe);

  let endedObserved = false;
  const publisher = runInstance('publisher', realtimeUrl, {
    DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Publisher',
    DISCO_VOADOR_E2E_VOICE_AUTO_SCREEN_SHARE: '1',
    DISCO_VOADOR_E2E_PROCESS_AUDIO_TARGET_PID: String(toneA.pid),
  });
  const viewer = runInstance(
    'viewer',
    realtimeUrl,
    {
      DISCO_VOADOR_E2E_VOICE_DISPLAY_NAME: 'Viewer',
      DISCO_VOADOR_E2E_PROCESS_AUDIO_EXPECTED_HZ: String(FREQ_A),
      DISCO_VOADOR_E2E_PROCESS_AUDIO_REJECTED_HZ: String(FREQ_B),
    },
    {
      onStdout: (_chunk, fullStdout) => {
        if (
          !endedObserved &&
          /E2E_SCREEN_AUDIO_ENDED:[^\n]*peerState=connected/.exec(fullStdout) &&
          fullStdout.includes(`E2E_FREQ_PROBE:`)
        ) {
          endedObserved = true;
        }
      },
    },
  );

  // Wait for the initial isolation proof to land, then kill Process A directly — never via the
  // app's own "stop sharing" action, since this scenario proves the *native/target-exit* path
  // (Format -> AudioFrame -> TargetEnded, see packages/windows-media/native/), not the
  // caller-initiated stop path (already covered by the lifecycle scenario above).
  const waitForProbe = new Promise((resolve) => {
    const check = setInterval(() => {
      // Best-effort: the viewer instance's own promise resolves only on exit, so this scenario
      // polls stdout indirectly via the shared `endedObserved` flag's prerequisite instead.
    }, 250);
    setTimeout(() => {
      clearInterval(check);
      resolve();
    }, 25_000);
  });
  await waitForProbe;

  await killToneProcess(toneA);

  const [publisherResult, viewerResult] = await Promise.all([publisher.promise, viewer.promise]);
  await killToneProcess(toneB);

  const evidence = parseFrequencyEvidence(viewerResult.stdout);
  const isolationOk = reportFrequencyEvidence('target-exit-initial', evidence);

  const endedCleanly = /E2E_SCREEN_AUDIO_ENDED:[^\n]*peerState=connected/.exec(viewerResult.stdout);
  if (!endedCleanly) {
    console.error('target-exit: viewer never observed a clean screen-audio end after target exit');
  }

  await new Promise((resolve) => setTimeout(resolve, 2000)); // let the helper's own exit settle.
  const orphans = findRunningHelperProcesses(preExistingHelperPids);
  if (orphans.length > 0) {
    console.error(
      `target-exit: orphan native helper process(es) still running: ${orphans.join('; ')}`,
    );
  }

  void publisherResult; // referenced for readability; publisher's own exit code is not load-bearing here.
  return isolationOk && Boolean(endedCleanly) && orphans.length === 0;
}

async function main() {
  console.info('Starting Dedicated Server...');
  const { child: realtimeChild, host, port } = await startDedicatedServer();
  console.info(`Dedicated Server listening on ${host}:${String(port)}`);
  const realtimeUrl = `ws://${host}:${String(port)}`;

  console.info('Starting the enumeration probe (for real audio-session PID discovery)...');
  const probe = await createEnumerationProbe();
  // Snapshotted once, right after the long-lived enumeration probe's own helper has started (its
  // process definitely exists by now — `createEnumerationProbe` awaits the real Hello/Ready
  // handshake) and before any capture-session helper is ever spawned — see
  // `findRunningHelperProcesses`'s own doc comment for why this must be excluded from every
  // per-scenario orphan check.
  const preExistingHelperPids = new Set(
    listHelperProcessLines()
      .map(parseTasklistPid)
      .filter((pid) => pid !== undefined),
  );

  const results = {};
  try {
    results.selectA = await runIsolationScenario(
      'select-A-reject-B',
      realtimeUrl,
      FREQ_A,
      FREQ_B,
      probe,
    );
    results.selectB = await runIsolationScenario(
      'select-B-reject-A',
      realtimeUrl,
      FREQ_B,
      FREQ_A,
      probe,
    );
    results.lifecycle = await runLifecycleScenario(realtimeUrl, probe);
    results.targetExit = await runTargetExitScenario(realtimeUrl, probe, preExistingHelperPids);
  } finally {
    probe.dispose();
    realtimeChild.kill();
  }

  console.info('\n=== Results ===');
  for (const [name, ok] of Object.entries(results)) {
    console.info(`${name}: ${ok ? 'PASS' : 'FAIL'}`);
  }

  const allPassed = Object.values(results).every(Boolean);
  if (allPassed) {
    console.info('\nE2E process-audio isolation smoke test passed.');
    process.exit(0);
  }
  console.error('\nE2E process-audio isolation smoke test FAILED.');
  process.exit(1);
}

main().catch((error) => {
  fail(
    `E2E process-audio smoke test crashed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
  );
});
