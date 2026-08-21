/**
 * T12 — automated-verification-only frequency-domain proof that a remote `MediaStream` carries one
 * specific, known tone and demonstrably not a second, different known tone — closing the gap
 * `e2e-audio-probe.ts`'s RMS-only proof left open for T6 (RMS proves *some* non-silent audio arrived,
 * never *which* audio). This is the mandatory acceptance evidence for T12's process-loopback
 * isolation E2E (`e2e-process-audio-smoke.mjs`): the remote side must show the selected process's
 * tone strongly present and the *other*, non-selected but simultaneously-running process's tone
 * excluded by a wide, defensible margin — not merely "audio present."
 *
 * Deliberately samples multiple consecutive analysis windows and requires a *sustained* margin
 * across them, not a single favorable sample — a single lucky/unlucky FFT window is not trustworthy
 * evidence on its own (Opus's ~20ms frame size and this codebase's own experience with WebRTC/screen-
 * share E2E timing jitter, see `e2e-audio-probe.ts`'s own doc comment, both argue for the same
 * "sample many windows, require sustained results" discipline used there). This also directly guards
 * against the specific failure mode this proof exists to catch: if process-loopback ever silently
 * fell back to system-wide capture (the one thing T12's own architecture constraints forbid), BOTH
 * tones would be simultaneously audible on the system and this probe's margin would collapse toward
 * 0 dB instead of staying wide — a real silent-fallback bug fails this proof loudly, not quietly.
 */

const SAMPLE_INTERVAL_MS = 100;
/** ~30s ceiling before giving up if the expected tone never even crosses the presence threshold —
 * matches `e2e-audio-probe.ts`'s own generously-measured real-world contention budget. */
const MAX_SAMPLES = 300;
/** Once the expected tone first crosses {@link PRESENCE_THRESHOLD_DB}, this many *additional*
 * consecutive windows (so `SUSTAINED_WINDOW_COUNT + 1` total, ~1.1s) are averaged before the pass/
 * fail decision — smooths over a single-window fluke in either direction. */
const SUSTAINED_WINDOW_COUNT = 10;

/** Frequency resolution at 48kHz: 48000/8192 ≈ 5.86 Hz/bin — fine enough to cleanly separate two
 * test tones a few hundred Hz apart (see `e2e-process-audio-smoke.mjs`'s tone-frequency choice)
 * while keeping each analysis window short (~170ms of audio). Not tied to an assumed sample rate —
 * this probe always reads the real `AudioContext.sampleRate` it actually got and reports it. */
const FFT_SIZE = 8192;
/** Neighborhood (in bins, each side) searched around a target frequency's nominal bin — absorbs
 * exact bin-alignment rounding and minor resampling/Opus-related frequency drift without being wide
 * enough to bleed into a genuinely different, non-adjacent test tone's own bin range. */
const BIN_SEARCH_RADIUS = 3;

/** A tone must reach at least this loud (in the dBFS-like units `AnalyserNode.getFloatFrequencyData`
 * returns) before it counts as "present" at all — well above a typical encode/decode/output-hardware
 * noise floor, comfortably below a real, audible test tone's expected level. */
const PRESENCE_THRESHOLD_DB = -50;
/** The sustained margin (expected tone's average magnitude minus the rejected tone's, in dB) that
 * must hold once the expected tone is present. 20 dB is a 10x amplitude ratio — wide enough to
 * absorb real Opus/WebRTC encode-decode artifacts and normal spectral leakage, but nowhere near what
 * a genuine failure mode (the wrong process selected, or a silent fallback to system-wide capture
 * exposing both tones at comparable levels) could plausibly produce by accident. */
const MIN_MARGIN_DB = 20;

export interface FrequencyProbeEvidence {
  readonly participantId: string;
  readonly expectedHz: number;
  readonly rejectedHz: number;
  readonly fftSize: number;
  readonly sampleRateHz: number;
  readonly binWidthHz: number;
  readonly binSearchRadius: number;
  readonly presenceThresholdDb: number;
  readonly minMarginDb: number;
  readonly windowsAnalyzed: number;
  readonly expectedMagnitudeDb: number;
  readonly rejectedMagnitudeDb: number;
  readonly marginDb: number;
  readonly passed: boolean;
}

function magnitudeNear(freqData: Float32Array, targetHz: number, binWidthHz: number): number {
  const centerBin = Math.round(targetHz / binWidthHz);
  let max = -Infinity;
  for (let bin = centerBin - BIN_SEARCH_RADIUS; bin <= centerBin + BIN_SEARCH_RADIUS; bin += 1) {
    if (bin < 0 || bin >= freqData.length) continue;
    const value = freqData[bin];
    if (value !== undefined && value > max) max = value;
  }
  return max;
}

/**
 * Samples `stream` for up to ~30s, waiting for `expectedHz` to become clearly present, then averages
 * {@link SUSTAINED_WINDOW_COUNT} further consecutive windows and requires the sustained margin over
 * `rejectedHz` to reach {@link MIN_MARGIN_DB}. Logs one single-line, machine-parseable evidence
 * marker (`<markerPrefix>:<JSON>`) containing every field T12's own acceptance criteria require to be
 * recorded — see {@link FrequencyProbeEvidence}. Never throws; a setup failure (no `AudioContext`,
 * stream with no audio track, etc.) logs `<markerPrefix>_ERROR:<message>` instead.
 */
export function probeRemoteAudioFrequency(
  stream: MediaStream,
  participantId: string,
  expectedHz: number,
  rejectedHz: number,
  markerPrefix = 'E2E_FREQ_PROBE',
): void {
  try {
    const AudioContextCtor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    const audioContext = new AudioContextCtor();
    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = FFT_SIZE;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -10;
    analyser.smoothingTimeConstant = 0; // this module does its own multi-window averaging.
    source.connect(analyser);

    const binWidthHz = audioContext.sampleRate / FFT_SIZE;
    const freqData = new Float32Array(analyser.frequencyBinCount);

    let samplesTaken = 0;
    let sustainedCollected = 0;
    let sustainedExpectedSum = 0;
    let sustainedRejectedSum = 0;
    let collecting = false;

    const finish = (result: FrequencyProbeEvidence): void => {
      clearInterval(intervalId);
      void audioContext.close();
      console.info(`${markerPrefix}:${JSON.stringify(result)}`);
    };

    const intervalId = setInterval(() => {
      analyser.getFloatFrequencyData(freqData);
      const expectedDb = magnitudeNear(freqData, expectedHz, binWidthHz);
      const rejectedDb = magnitudeNear(freqData, rejectedHz, binWidthHz);
      samplesTaken += 1;

      if (!collecting) {
        if (expectedDb >= PRESENCE_THRESHOLD_DB) collecting = true;
      }

      if (collecting) {
        sustainedCollected += 1;
        sustainedExpectedSum += expectedDb;
        sustainedRejectedSum += rejectedDb;

        if (sustainedCollected > SUSTAINED_WINDOW_COUNT) {
          const avgExpected = sustainedExpectedSum / sustainedCollected;
          const avgRejected = sustainedRejectedSum / sustainedCollected;
          const margin = avgExpected - avgRejected;
          finish({
            participantId,
            expectedHz,
            rejectedHz,
            fftSize: FFT_SIZE,
            sampleRateHz: audioContext.sampleRate,
            binWidthHz,
            binSearchRadius: BIN_SEARCH_RADIUS,
            presenceThresholdDb: PRESENCE_THRESHOLD_DB,
            minMarginDb: MIN_MARGIN_DB,
            windowsAnalyzed: sustainedCollected,
            expectedMagnitudeDb: avgExpected,
            rejectedMagnitudeDb: avgRejected,
            marginDb: margin,
            passed: margin >= MIN_MARGIN_DB,
          });
          return;
        }
      }

      if (samplesTaken >= MAX_SAMPLES) {
        finish({
          participantId,
          expectedHz,
          rejectedHz,
          fftSize: FFT_SIZE,
          sampleRateHz: audioContext.sampleRate,
          binWidthHz,
          binSearchRadius: BIN_SEARCH_RADIUS,
          presenceThresholdDb: PRESENCE_THRESHOLD_DB,
          minMarginDb: MIN_MARGIN_DB,
          windowsAnalyzed: Math.max(sustainedCollected, 1),
          expectedMagnitudeDb: collecting ? sustainedExpectedSum / sustainedCollected : expectedDb,
          rejectedMagnitudeDb: collecting ? sustainedRejectedSum / sustainedCollected : rejectedDb,
          marginDb: 0,
          passed: false,
        });
      }
    }, SAMPLE_INTERVAL_MS);
  } catch (error) {
    console.error(`${markerPrefix}_ERROR`, error);
    console.info(`${markerPrefix}_ERROR:${error instanceof Error ? error.message : String(error)}`);
  }
}
