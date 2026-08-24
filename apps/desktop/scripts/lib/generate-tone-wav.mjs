// T13.4 — generates a small, deterministic 16-bit PCM WAV file containing a continuous sine tone (or
// silence), for Chromium's `--use-file-for-fake-audio-capture=<file>` switch. This is the only way
// found (and directly verified — see `apps/desktop/scripts/e2e-ptt-smoke.mjs`'s own doc comment) to
// get real, controllable, non-silent fake microphone content in at least one real sandboxed
// environment this task was verified against: the plain `--use-fake-device-for-media-stream`
// generator alone produced literal 0.0000 RMS energy there for the full length of every sample
// window tried, even with the local microphone track's `enabled` forced `true` from the very start
// (bypassing every T13.4 gating mechanism entirely) — a pre-existing environment characteristic,
// confirmed unrelated to anything this task changed.
import { writeFileSync } from 'node:fs';

/**
 * @param {object} options
 * @param {number} options.freqHz
 * @param {number} options.durationMs
 * @param {number} [options.sampleRate]
 * @param {number} [options.amplitude] 0-1, peak amplitude before 16-bit quantization.
 * @returns {Buffer}
 */
export function generateToneWavBuffer({ freqHz, durationMs, sampleRate = 48000, amplitude = 0.9 }) {
  const numSamples = Math.floor((sampleRate * durationMs) / 1000);
  const data = Buffer.alloc(numSamples * 2); // 16-bit mono
  for (let i = 0; i < numSamples; i += 1) {
    const sample = Math.sin(2 * Math.PI * freqHz * (i / sampleRate)) * amplitude;
    data.writeInt16LE(Math.round(sample * 32767), i * 2);
  }

  const byteRate = sampleRate * 2;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(1, 22); // mono
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(2, 32); // block align
  header.writeUInt16LE(16, 34); // bits per sample
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

/** Writes a continuous tone file to `filePath` and returns `filePath` — default duration (3 minutes)
 * is comfortably longer than any current E2E scenario's own run time; Chromium's fake-audio-file
 * switch loops by default (no `%noloop` suffix used here), but a generously long file is still the
 * more robust choice regardless of loop behavior. */
export function writeToneWavFile(filePath, freqHz = 440, durationMs = 180_000) {
  writeFileSync(filePath, generateToneWavBuffer({ freqHz, durationMs }));
  return filePath;
}
