import { describe, expect, it, vi } from 'vitest';

import {
  AnalyserActivitySampler,
  computeRmsFromByteTimeDomain,
  deriveActivityThresholds,
  SchmittHangoverDetector,
  type AnalyserLike,
} from '../../apps/desktop/src/renderer/voice/voice-activity-detector.js';

describe('computeRmsFromByteTimeDomain', () => {
  it('returns 0 for a perfectly silent (all-128) buffer', () => {
    expect(computeRmsFromByteTimeDomain(new Uint8Array(256).fill(128))).toBe(0);
  });

  it('returns 1 for a full-scale square wave', () => {
    const data = new Uint8Array(256);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 2 === 0 ? 255 : 1;
    expect(computeRmsFromByteTimeDomain(data)).toBeCloseTo(1, 1);
  });

  it('returns 0 for an empty buffer (never divides by zero / NaN)', () => {
    expect(computeRmsFromByteTimeDomain(new Uint8Array(0))).toBe(0);
  });

  it('a louder signal produces a higher RMS than a quieter one', () => {
    const quiet = new Uint8Array(256).fill(138); // small offset from silence (128)
    const loud = new Uint8Array(256).fill(200);
    expect(computeRmsFromByteTimeDomain(loud)).toBeGreaterThan(computeRmsFromByteTimeDomain(quiet));
  });
});

describe('deriveActivityThresholds', () => {
  it('a higher sensitivity produces a lower onThreshold (easier to trigger)', () => {
    const low = deriveActivityThresholds(0);
    const high = deriveActivityThresholds(1);
    expect(high.onThreshold).toBeLessThan(low.onThreshold);
  });

  it('offThreshold is always strictly lower than onThreshold (real hysteresis gap)', () => {
    for (const sensitivity of [0, 0.25, 0.5, 0.75, 1]) {
      const { onThreshold, offThreshold } = deriveActivityThresholds(sensitivity);
      expect(offThreshold).toBeLessThan(onThreshold);
    }
  });

  it('clamps an out-of-range sensitivity into [0, 1]', () => {
    expect(deriveActivityThresholds(-5)).toEqual(deriveActivityThresholds(0));
    expect(deriveActivityThresholds(5)).toEqual(deriveActivityThresholds(1));
  });
});

describe('SchmittHangoverDetector', () => {
  const config = { onThreshold: 0.2, offThreshold: 0.1, hangoverMs: 400 };

  it('starts inactive and stays inactive under the onThreshold', () => {
    const detector = new SchmittHangoverDetector(config);
    expect(detector.feed(0.05, 0)).toBe(false);
    expect(detector.isActive).toBe(false);
  });

  it('becomes active the instant energy reaches onThreshold', () => {
    const detector = new SchmittHangoverDetector(config);
    expect(detector.feed(0.2, 0)).toBe(true);
  });

  it('stays active while energy stays above offThreshold, even below onThreshold', () => {
    const detector = new SchmittHangoverDetector(config);
    detector.feed(0.25, 0);
    expect(detector.feed(0.15, 50)).toBe(true); // between offThreshold and onThreshold
  });

  it('does not flip inactive immediately when energy drops below offThreshold (hangover)', () => {
    const detector = new SchmittHangoverDetector(config);
    detector.feed(0.25, 0);
    expect(detector.feed(0.0, 100)).toBe(true); // only 100ms since last "above off", < 400ms hangover
  });

  it('flips inactive once the hangover window elapses with no energy above offThreshold', () => {
    const detector = new SchmittHangoverDetector(config);
    detector.feed(0.25, 0);
    detector.feed(0.0, 100);
    expect(detector.feed(0.0, 500)).toBe(false); // 500ms since last "above off" >= 400ms hangover
  });

  it('a brief dip that recovers above offThreshold resets the hangover clock', () => {
    const detector = new SchmittHangoverDetector(config);
    detector.feed(0.25, 0);
    detector.feed(0.0, 350); // still within hangover, stays active
    expect(detector.isActive).toBe(true);
    detector.feed(0.15, 360); // recovers above offThreshold — resets the hangover clock
    expect(detector.feed(0.0, 600)).toBe(true); // only 240ms since the reset at 360ms
    expect(detector.feed(0.0, 800)).toBe(false); // now 440ms since 360ms >= 400ms hangover
  });

  it('holding PTT while silent must not register as speaking (pure energy-only logic)', () => {
    // The detector has no concept of PTT/mute at all — this test documents that a caller (the
    // gate's own `voiceActivityDetected` input, or the UI's "effective speaking" derivation) is
    // responsible for combining this purely-energy-based signal with mute/PTT state, never this class.
    const detector = new SchmittHangoverDetector(config);
    expect(detector.feed(0.0, 0)).toBe(false);
  });
});

function fakeAnalyser(fftSize: number): AnalyserLike & { setNextBuffer: (fill: number) => void } {
  let nextFill = 128;
  return {
    fftSize,
    getByteTimeDomainData: (array: Uint8Array) => {
      array.fill(nextFill);
    },
    setNextBuffer: (fill: number) => {
      nextFill = fill;
    },
  };
}

describe('AnalyserActivitySampler', () => {
  it('calls onChange only on a real transition, never on every raw sample', () => {
    const analyser = fakeAnalyser(256);
    const onChange = vi.fn();
    const clock = 0;
    const sampler = new AnalyserActivitySampler(analyser, 1, onChange, {
      now: () => clock,
      hangoverMs: 200,
    });

    analyser.setNextBuffer(255); // loud
    sampler.sampleOnce();
    sampler.sampleOnce();
    sampler.sampleOnce();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('debounces a brief silence via the hangover before reporting speaking -> not-speaking', () => {
    const analyser = fakeAnalyser(256);
    const onChange = vi.fn();
    let clock = 0;
    const sampler = new AnalyserActivitySampler(analyser, 1, onChange, {
      now: () => clock,
      hangoverMs: 300,
    });

    analyser.setNextBuffer(255);
    sampler.sampleOnce(); // active at t=0
    expect(onChange).toHaveBeenLastCalledWith(true);

    analyser.setNextBuffer(128); // silence
    clock = 100;
    sampler.sampleOnce(); // still within hangover
    expect(onChange).toHaveBeenCalledTimes(1);

    clock = 400;
    sampler.sampleOnce(); // hangover elapsed
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(onChange).toHaveBeenLastCalledWith(false);
  });

  it('start()/stop() drive sampling via the injected timer functions, and stop() is idempotent', () => {
    const analyser = fakeAnalyser(256);
    const onChange = vi.fn();
    const setIntervalFn = vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>);
    const clearIntervalFn = vi.fn();
    const sampler = new AnalyserActivitySampler(analyser, 0.5, onChange, {
      setIntervalFn,
      clearIntervalFn,
    });

    sampler.start();
    sampler.start(); // idempotent — must not register a second interval
    expect(setIntervalFn).toHaveBeenCalledTimes(1);

    sampler.stop();
    sampler.stop(); // idempotent
    expect(clearIntervalFn).toHaveBeenCalledTimes(1);
  });

  it('isSpeaking mirrors the underlying detector state', () => {
    const analyser = fakeAnalyser(256);
    const sampler = new AnalyserActivitySampler(analyser, 1, vi.fn());
    expect(sampler.isSpeaking).toBe(false);
    analyser.setNextBuffer(255);
    sampler.sampleOnce();
    expect(sampler.isSpeaking).toBe(true);
  });
});
