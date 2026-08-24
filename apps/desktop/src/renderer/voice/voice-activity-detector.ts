/**
 * T13.4 — the one speaking/voice-activity detection technique this feature uses everywhere: a small
 * FFT (`fftSize: 256`), RMS/average-magnitude energy read off an `AnalyserNode`-shaped source, and a
 * two-threshold Schmitt trigger with a hangover delay before flipping back to "not speaking". Used
 * identically for the local microphone (feeding `@disco-voador/media-core`'s `TransmitGate.
 * setVoiceActivityDetected`) and for every remote participant's speaking indicator
 * (`remote-audio-graph.ts`) — one algorithm, two call sites, per this task's own "don't invent two
 * different detection algorithms" requirement.
 *
 * Deliberately split into two layers so the load-bearing logic is testable with zero real audio
 * hardware or `AudioContext`/`AnalyserNode` support (neither exists under Vitest/jsdom):
 *
 * - {@link SchmittHangoverDetector} and {@link computeRmsFromByteTimeDomain} are pure, synchronous,
 *   environment-neutral — fed synthetic energy/byte-array samples directly in tests.
 * - {@link AnalyserActivitySampler} is the thin, largely-untested production wiring that actually
 *   polls a real `AnalyserNode` on a timer; its own tests inject a fake `AnalyserLike` and fake
 *   timers rather than a real Web Audio graph.
 */

/** The narrow slice of a real `AnalyserNode` this module actually reads — declared locally (not
 * imported from `lib.dom.d.ts` directly as a hard dependency) so a caller can inject a fully fake
 * implementation in tests without needing `jsdom`/a real browser to construct one. */
export interface AnalyserLike {
  readonly fftSize: number;
  getByteTimeDomainData(array: Uint8Array): void;
}

/**
 * Converts one frame of `getByteTimeDomainData`'s own byte-centered-at-128 samples into a normalized
 * 0-1 RMS energy value. `data` values are `Uint8Array` in `[0, 255]`, spec-centered at silence = 128;
 * each sample is rescaled to `[-1, 1]` before squaring, matching the Web Audio API's own documented
 * time-domain sample semantics.
 */
export function computeRmsFromByteTimeDomain(data: Uint8Array): number {
  if (data.length === 0) return 0;
  let sumSquares = 0;
  for (const byte of data) {
    const normalized = (byte - 128) / 128;
    sumSquares += normalized * normalized;
  }
  return Math.sqrt(sumSquares / data.length);
}

/**
 * Maps a product-facing `sensitivity` (0 = least sensitive/most silence-tolerant, 1 = most
 * sensitive) to a concrete on/off RMS-energy threshold pair. Higher sensitivity means a *lower*
 * energy threshold is enough to count as "speaking". The off-threshold is always a fixed fraction of
 * the on-threshold (a real Schmitt trigger gap — see `SchmittHangoverDetector`'s own doc comment for
 * why the up and down thresholds must differ), so this never collapses to a single-threshold
 * comparator that would chatter on borderline energy.
 */
export function deriveActivityThresholds(sensitivity: number): {
  readonly onThreshold: number;
  readonly offThreshold: number;
} {
  const clamped = Math.max(0, Math.min(1, sensitivity));
  // At sensitivity 0: onThreshold 0.20 (quiet background noise never triggers). At sensitivity 1:
  // onThreshold 0.02 (a very soft voice still triggers). Default (0.5): 0.11.
  //
  // **Lowered from an earlier default (0.1475) after a real QA finding, but deliberately not chased
  // all the way down to that finding's own measured number.** A QA pass measured Chromium's plain
  // fake-microphone-device signal, after this app's real default `noiseSuppression`/`autoGainControl`
  // processing (`microphone.ts`), at RMS ~0.016 — the *same* signal measured ~0.33 with processing
  // disabled, a ~20x reduction specific to that synthetic waveform. This is the same class of finding
  // already independently confirmed elsewhere in this exact task (`ptt-hotkey-listener`'s own E2E:
  // Chromium's real-time audio pipeline measurably mistreats a synthetic/file-backed fake-audio signal
  // in ways a real human voice's very different spectral/temporal characteristics should not trigger —
  // `noiseSuppression`'s whole purpose is to preserve real speech while suppressing real noise, not the
  // reverse. Recalibrating the *default* down to a fake-device artifact's own measured floor would risk
  // making Voice Activity mode fire on ordinary room background noise for real users, defeating its own
  // purpose. This value is a genuine, reasoned safety-margin reduction (roughly 25% lower than the
  // original default) in response to a real, if unresolved, finding — not a recalibration against the
  // fake-device number itself, and still **not independently verified against real microphone
  // hardware** (no human-in-the-loop was available to speak into a real mic during this task's
  // automated verification — see the task doc's "Known limitations"). A real-hardware calibration pass
  // remains a legitimate follow-up.
  const onThreshold = 0.2 - clamped * 0.18;
  const offThreshold = onThreshold * 0.6;
  return { onThreshold, offThreshold };
}

export interface SchmittHangoverConfig {
  /** Energy at/above which a currently-silent detector becomes "active". */
  readonly onThreshold: number;
  /** Energy at/above which an already-active detector remains active (postpones the hangover
   * clock). Always lower than `onThreshold` — the hysteresis gap that prevents chatter right at the
   * boundary. */
  readonly offThreshold: number;
  /** Minimum time, in milliseconds, energy must stay below `offThreshold` before an active detector
   * flips back to inactive — smooths over natural micro-pauses in speech (product spec: 300-500ms). */
  readonly hangoverMs: number;
}

/**
 * A pure, synchronous, time-injected two-threshold Schmitt trigger with a hangover delay — no
 * timers, no audio APIs, no side effects of its own. One instance tracks exactly one stream's
 * (local microphone, or one remote participant's) current speaking state.
 */
export class SchmittHangoverDetector {
  private active = false;
  private lastAboveOffAtMs: number | undefined;

  constructor(private readonly config: SchmittHangoverConfig) {}

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Feeds one energy sample observed at `atMs` (any monotonically-nondecreasing clock — a real
   * `Date.now()`/`performance.now()` in production, an arbitrary counter in tests). Returns the
   * detector's active state *after* processing this sample.
   */
  feed(energy: number, atMs: number): boolean {
    if (!this.active) {
      if (energy >= this.config.onThreshold) {
        this.active = true;
        this.lastAboveOffAtMs = atMs;
      }
      return this.active;
    }

    if (energy >= this.config.offThreshold) {
      this.lastAboveOffAtMs = atMs;
      return this.active;
    }

    if (
      this.lastAboveOffAtMs !== undefined &&
      atMs - this.lastAboveOffAtMs >= this.config.hangoverMs
    ) {
      this.active = false;
    }
    return this.active;
  }
}

export interface AnalyserActivitySamplerOptions {
  /** Target internal detection rate — the product spec's own "~10-15Hz internal detection" (a
   * *transition*, debounced/hangover-smoothed, is what ever reaches a caller — see this class's own
   * `onChange` contract). Defaults to ~13Hz. */
  readonly sampleIntervalMs?: number;
  readonly hangoverMs?: number;
  /** Injectable clock, for deterministic tests — defaults to `Date.now`. */
  readonly now?: () => number;
  /** Injectable timer functions, for deterministic tests (mirrors this codebase's existing
   * `setTimeout`-injection precedent elsewhere) — defaults to the real globals. */
  readonly setIntervalFn?: (handler: () => void, ms: number) => ReturnType<typeof setInterval>;
  readonly clearIntervalFn?: (handle: ReturnType<typeof setInterval>) => void;
}

/**
 * Polls a real (or fake, in tests) `AnalyserLike` on a fixed interval and calls `onChange` only on
 * an actual true/false *transition* — never on every raw sample — per this task's own "no per-sample
 * React state updates" requirement. This is the one piece of this module that touches a timer/analyser
 * at all; everything else it delegates to is pure and independently tested.
 */
export class AnalyserActivitySampler {
  private readonly buffer: Uint8Array;
  private readonly detector: SchmittHangoverDetector;
  private readonly now: () => number;
  private readonly setIntervalFn: NonNullable<AnalyserActivitySamplerOptions['setIntervalFn']>;
  private readonly clearIntervalFn: NonNullable<AnalyserActivitySamplerOptions['clearIntervalFn']>;
  private readonly sampleIntervalMs: number;
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly analyser: AnalyserLike,
    sensitivity: number,
    private readonly onChange: (speaking: boolean) => void,
    options: AnalyserActivitySamplerOptions = {},
  ) {
    this.buffer = new Uint8Array(analyser.fftSize);
    const { onThreshold, offThreshold } = deriveActivityThresholds(sensitivity);
    this.detector = new SchmittHangoverDetector({
      onThreshold,
      offThreshold,
      hangoverMs: options.hangoverMs ?? 400,
    });
    this.now = options.now ?? Date.now;
    this.sampleIntervalMs = options.sampleIntervalMs ?? 75;
    // **Real bug found and fixed via `e2e:voice-smoke`, not merely reasoned about**: storing the
    // bare global `setInterval`/`clearInterval` function references as instance properties, then
    // invoking them as `this.setIntervalFn(...)` (a *method* call), throws a genuine Chromium
    // `TypeError: Illegal invocation` — `Window.prototype.setInterval`/`clearInterval` are
    // WebIDL-hosted methods that require their receiver (`this`) to actually be the real `Window`
    // object; a method-style call rebinds `this` to whatever object the method lives on (this
    // sampler instance), which Chromium rejects. `Date.now` above is safe to extract this way (it is
    // a plain ECMAScript static method with no `this` requirement at all), but `setInterval`/
    // `clearInterval` are not — wrapped in plain arrow functions here so the real call inside each
    // one is a *bare* `setInterval(...)`/`clearInterval(...)` reference expression (not a method
    // call on any object), the same safe pattern this codebase's own `setTimeout(...)` call sites
    // already use everywhere else. This class's own unit tests never caught this because they always
    // inject a `vi.fn()` mock for `setIntervalFn`, which has no such Web-API-hosted `this`
    // requirement — only a real browser `AudioContext.setSinkId`-adjacent path resurfaces it, which
    // is exactly why the coordinator's insistence on real Electron E2E verification (rather than
    // stopping at mocked unit tests) mattered here.
    this.setIntervalFn = options.setIntervalFn ?? ((handler, ms) => setInterval(handler, ms));
    this.clearIntervalFn =
      options.clearIntervalFn ??
      ((handle) => {
        clearInterval(handle);
      });
  }

  get isSpeaking(): boolean {
    return this.detector.isActive;
  }

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = this.setIntervalFn(() => {
      this.sampleOnce();
    }, this.sampleIntervalMs);
  }

  /** Exposed directly for tests that want to drive one sample deterministically without a real timer. */
  sampleOnce(): void {
    this.analyser.getByteTimeDomainData(this.buffer);
    const energy = computeRmsFromByteTimeDomain(this.buffer);
    const wasActive = this.detector.isActive;
    const isActive = this.detector.feed(energy, this.now());
    if (isActive !== wasActive) this.onChange(isActive);
  }

  stop(): void {
    if (this.timer === undefined) return;
    this.clearIntervalFn(this.timer);
    this.timer = undefined;
  }
}
