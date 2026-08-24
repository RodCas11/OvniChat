const SAMPLE_INTERVAL_MS = 100;
// ~25s, matching `e2e-screen-probe.ts`'s budget — this probe starts sampling the instant a remote
// audio stream first appears, concurrently with camera/screen probes that (see that file) were
// found to need up to ~25s under T5's screen-share smoke test's worst-case load (two Electron
// instances each simultaneously encoding mic + camera + a real screen capture). Was 1s, then 3s;
// both were empirically too tight — live-verified this sustained load window, not a single brief
// startup spike, can keep RMS pinned near zero for well over 3s even though voice itself never
// actually broke (the underlying peer connection stayed healthy and audio was audible once
// contention eased). Taking the max RMS over a longer window makes this a stronger, not weaker,
// proof — it just stops requiring the non-silent sample to land early specifically.
const SAMPLE_COUNT = 250;
const SILENCE_RMS_THRESHOLD = 0.001;

/**
 * Automated-verification-only: proves a remote `MediaStream` is carrying real, non-silent audio —
 * not just that a track object exists — by sampling RMS energy from a Web Audio `AnalyserNode`
 * over up to ~25 seconds and logging `<markerPrefix>_OK:<id>` (or `<markerPrefix>_SILENT:<id>`
 * if every sample stayed near zero). `apps/desktop/scripts/e2e-voice-smoke.mjs` and
 * `main/index.ts`'s `armE2EVoiceSmokeExit` watch the Electron console for this line (using the
 * default `markerPrefix`). Chromium's `--use-fake-device-for-media-stream` produces a synthetic
 * non-silent waveform, so a real end-to-end connection is expected to pass this. Only ever invoked
 * when the E2E auto-join config is present (see `VoiceChannelView.tsx`), which is itself gated to
 * non-packaged builds — this never runs for a real user.
 *
 * `markerPrefix` defaults to `'E2E_AUDIO_LEVEL'` — T5 stabilization reuses this same function for a
 * *second*, distinctly-prefixed continuity re-check after a remote screen share ends
 * (`'E2E_AUDIO_LEVEL_POST_SCREEN'`, see `VoiceChannelView.tsx`), so the two proofs never get
 * confused with each other in the console log.
 */
export function probeRemoteAudioLevel(
  stream: MediaStream,
  participantId: string,
  markerPrefix = 'E2E_AUDIO_LEVEL',
  // T13.4 — `apps/desktop/scripts/e2e-ptt-smoke.mjs` needs several short, back-to-back,
  // independently-timed probes (pre-hold/during-hold/post-release) rather than one long one; a
  // caller-supplied bound keeps that scenario fast without changing this constant's own default (and
  // therefore every existing caller's behavior) at all.
  sampleCount = SAMPLE_COUNT,
): void {
  try {
    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audioContext = new AudioContextCtor();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2048;
    source.connect(analyser);

    const buffer = new Float32Array(analyser.fftSize);
    let maxRms = 0;
    let samplesTaken = 0;

    // Resolves as soon as a decisively non-silent sample appears — matching the video/screen
    // probes' early-exit-on-success behavior — rather than always waiting the full window; the
    // extended `SAMPLE_COUNT` above is a ceiling for a genuinely slow/contended case, not a
    // mandatory wait, so a healthy connection (the common case) still reports success quickly.
    const intervalId = setInterval(() => {
      analyser.getFloatTimeDomainData(buffer);
      let sumSquares = 0;
      for (const sample of buffer) sumSquares += sample * sample;
      const rms = Math.sqrt(sumSquares / buffer.length);
      maxRms = Math.max(maxRms, rms);
      samplesTaken += 1;

      if (rms > SILENCE_RMS_THRESHOLD) {
        clearInterval(intervalId);
        void audioContext.close();
        console.info(`${markerPrefix}_OK:${participantId}:${rms.toFixed(4)}`);
        return;
      }

      if (samplesTaken >= sampleCount) {
        clearInterval(intervalId);
        void audioContext.close();
        console.info(`${markerPrefix}_SILENT:${participantId}:${maxRms.toFixed(4)}`);
      }
    }, SAMPLE_INTERVAL_MS);
  } catch (error) {
    console.error('E2E audio probe failed', error);
  }
}
