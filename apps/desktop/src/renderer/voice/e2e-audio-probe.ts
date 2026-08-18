const SAMPLE_INTERVAL_MS = 100;
const SAMPLE_COUNT = 10;
const SILENCE_RMS_THRESHOLD = 0.001;

/**
 * Automated-verification-only: proves a remote `MediaStream` is carrying real, non-silent audio —
 * not just that a track object exists — by sampling RMS energy from a Web Audio `AnalyserNode`
 * over roughly one second and logging `E2E_AUDIO_LEVEL_OK:<id>` (or `E2E_AUDIO_LEVEL_SILENT:<id>`
 * if every sample stayed near zero). `apps/desktop/scripts/e2e-voice-smoke.mjs` and
 * `main/index.ts`'s `armE2EVoiceSmokeExit` watch the Electron console for this line. Chromium's
 * `--use-fake-device-for-media-stream` produces a synthetic non-silent waveform, so a real
 * end-to-end connection is expected to pass this. Only ever invoked when the E2E auto-join config
 * is present (see `VoiceChannelView.tsx`), which is itself gated to non-packaged builds — this
 * never runs for a real user.
 */
export function probeRemoteAudioLevel(stream: MediaStream, participantId: string): void {
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

    const intervalId = setInterval(() => {
      analyser.getFloatTimeDomainData(buffer);
      let sumSquares = 0;
      for (const sample of buffer) sumSquares += sample * sample;
      maxRms = Math.max(maxRms, Math.sqrt(sumSquares / buffer.length));
      samplesTaken += 1;

      if (samplesTaken >= SAMPLE_COUNT) {
        clearInterval(intervalId);
        void audioContext.close();
        const marker =
          maxRms > SILENCE_RMS_THRESHOLD ? 'E2E_AUDIO_LEVEL_OK' : 'E2E_AUDIO_LEVEL_SILENT';
        console.info(`${marker}:${participantId}:${maxRms.toFixed(4)}`);
      }
    }, SAMPLE_INTERVAL_MS);
  } catch (error) {
    console.error('E2E audio probe failed', error);
  }
}
