import { ProcessAudioTrackError } from './process-audio-errors.js';

/**
 * T12 — turns a stream of raw PCM audio frames arriving over a `MessagePort` into a real, live
 * `MediaStreamTrack` (`kind: 'audio'`), so Windows per-process/game audio (captured natively in
 * `packages/windows-media`, forwarded to this Renderer over a `MessageChannelMain`-transferred port
 * by `apps/desktop`'s Main process — see `docs/tasks/T12_WINDOWS_PROCESS_AUDIO.md` and
 * `docs/adr/0017-windows-process-loopback-native-boundary.md`) can be published through the exact
 * same `screen-audio` semantic WebRTC source T6 already established, exactly like this package's
 * other media sources.
 *
 * This module is entirely environment-neutral within the boundary the Media Capture and Streams /
 * WebCodecs / Web Audio specifications define — it never touches Electron, React, or
 * `packages/windows-media`'s wire protocol directly; it only assumes the caller hands it an
 * already-connected, already-listening standard Web `MessagePort` speaking the small message
 * contract documented below.
 *
 * ## Wire contract over the `MessagePort` (this module's own design, not `windows-media/protocol.ts`)
 *
 * This module deliberately does not import `packages/windows-media/src/protocol.ts` — that would
 * violate this package's independence from a Windows-specific/native-adjacent package (see
 * `docs/ARCHITECTURE.md`) — but it mirrors that protocol's `FormatPayload`/`AudioFramePayload` field
 * shapes closely on purpose, since the same decoded values are what actually flows across the
 * `MessagePort` after Main-process code (built separately) re-frames them. The Main-process side
 * must send:
 *
 * - `{ type: 'format', format: ProcessAudioFormat }` — the actual PCM format, once, before the first
 *   `audioFrame` (matches `protocol.ts`'s own `Format` message ordering guarantee). A *second*
 *   `format` message mid-stream is a legal, explicit format-change notification (see below).
 * - `{ type: 'audioFrame', frame: ProcessAudioFrame }` — one buffer of PCM, tagged with a monotonic
 *   `sequence` a consumer can use to notice a drop/reorder without inspecting audio content.
 * - `{ type: 'ended' }` — the source ended cleanly (e.g. the target process exited) — not an error.
 * - `{ type: 'error', message: string }` — the source failed; `message` is a short, human-readable,
 *   local-only diagnostic (never PCM content).
 *
 * This module sends exactly one message type back: `{ type: 'ack', sequence }`, once per PCM frame
 * it has finished handing off to the synthesis path (see "Backpressure" below) — the Main-process
 * side may wire this to `ProcessLoopbackSupervisor.acknowledgeAudioFrame()` (see
 * `packages/windows-media/src/process-loopback-supervisor.ts`) to drive its own high/low-watermark
 * pause-resume, though this module has no dependency on that class and makes no assumption about
 * what (if anything) the other side does with each `ack`.
 *
 * ## Synthesis mechanism: `MediaStreamTrackGenerator` (primary) vs. `AudioWorkletNode` (fallback)
 *
 * Two real mechanisms can turn raw PCM into a live `MediaStreamTrack`:
 *
 * 1. **`MediaStreamTrackGenerator({ kind: 'audio' })`** ("Insertable Streams for `MediaStreamTrack`"
 *    / "Breakout Box") — construct one, get a writer on `.writable`, and `write()` `AudioData`
 *    chunks built directly from the PCM bytes in their *original* format (no float conversion, no
 *    resampling) — the most direct path, and the one this module prefers.
 * 2. **`AudioContext` + a custom `AudioWorkletProcessor` (loaded from an inline `Blob` URL, so no new
 *    build-tool/Vite wiring is needed — this package has no bundler step of its own, only `tsc`) +
 *    `MediaStreamAudioDestinationNode`** — PCM is decoded to interleaved `Float32Array` samples (Web
 *    Audio's internal representation is always 32-bit float) and fed to the worklet over its own
 *    `port`; the worklet fills each 128-frame render quantum from a small internal queue, and the
 *    resulting graph's destination node exposes a `MediaStreamTrack`.
 *
 * **Chromium 150 research (2026-08-20, this task):** per MDN's browser-compat-data for
 * `MediaStreamTrackGenerator` and the "Intent to Ship: MediaStreamTrack Insertable Streams (a.k.a.
 * Breakout Box)" blink-dev thread, this API — including the `kind: 'audio'` variant, which accepts
 * `AudioData` chunks — shipped in Chromium **unflagged since Chrome 94** (2021), well before
 * Chromium 150 (this repo's pinned Electron 43.4.0 target, per `docs/references/WINDOWS_MEDIA.md`).
 * MDN separately flags the whole API as "experimental"/non-standard (the spec itself,
 * `mediacapture-transform`, has open WG-consensus disagreement from Apple/Mozilla specifically about
 * *audio* support) — but "non-standard/no cross-browser consensus" is a spec-process status, not a
 * Chromium runtime-availability fact, and this product's target is a pinned, known, Windows-only
 * Chromium build, not general web portability. This module therefore uses it as the **primary** path
 * (simpler, no audio graph, preserves the original PCM format/bit depth exactly), with the
 * `AudioWorkletNode` mechanism as an explicit **runtime-feature-detected fallback**
 * (`typeof MediaStreamTrackGenerator !== 'undefined'`), matching this repository's own established
 * discipline of feature-testing rather than trusting a single API's assumed availability (see
 * `packages/windows-media/src/capability.ts`'s numeric-build feature test for the same philosophy
 * applied to the native side of this same task).
 *
 * **TypeScript typing note:** as of this repository's pinned TypeScript version, the bundled
 * `lib.dom.d.ts` does not declare `MediaStreamTrackGenerator`/`MediaStreamTrackGeneratorInit` at all
 * (confirmed by inspecting the shipped lib file for this task) even though it already declares the
 * `AudioData`/`AudioDataInit` WebCodecs types this module also needs. This module adds a minimal,
 * intentionally narrow ambient `declare global` augmentation below covering only the members this
 * module actually calls — not a full spec-accurate re-declaration — since it is purely an
 * implementation-internal detail that never appears on this module's exported public types.
 *
 * ## Backpressure: a bounded, drop-oldest queue plus a per-frame `ack`
 *
 * PCM frames may arrive over the port faster than the synthesis path can consume them (a momentarily
 * stalled audio graph, a slow browser tick). This module keeps an internal queue of decoded-but-not-
 * yet-synthesized frames capped at {@link MAX_QUEUED_FRAMES}; once full, the **oldest** queued frame
 * is dropped to make room for the newest arrival — chosen over drop-newest because this is live
 * audio: once a graph has fallen behind, catching up on stale audio is worth less than staying close
 * to real time, and drop-oldest is the standard real-time-media backpressure choice for exactly that
 * reason. A frame is only `ack`ed back over the port once it has actually been hand off to the
 * synthesis path (written to the `MediaStreamTrackGenerator`'s writer — which itself carries the
 * WHATWG `WritableStream` backpressure signal this module `await`s before pulling the next queued
 * frame — or posted into the `AudioWorkletNode`'s port for the fallback path, which has no equivalent
 * built-in backpressure signal and therefore relies on the bounded queue alone).
 *
 * ## Format-change and error/end handling
 *
 * - A second `format` message mid-stream is a legal format-change notification. The primary
 *   (`MediaStreamTrackGenerator`) path handles it seamlessly — every `AudioData` chunk already
 *   carries its own `sampleRate`/format, so nothing needs to be rebuilt. The fallback
 *   (`AudioWorkletNode`) path **cannot**: `AudioContext`'s sample rate is fixed at construction time
 *   by the Web Audio specification, so a format change under the fallback path ends the track
 *   cleanly (`stop()`, `lastError` describes why) rather than silently producing corrupted/garbled
 *   audio — this asymmetry is a deliberate, documented limitation of the fallback path, not an
 *   oversight.
 * - `{ type: 'ended' }` and `{ type: 'error', message }` both end the track (`stop()`); `error` also
 *   sets `lastError` to the given message so a caller can distinguish a clean end from a failure
 *   after the fact, mirroring how `Screen`/`Camera` let the native `MediaStreamTrack` lifecycle
 *   (`readyState`) speak for itself rather than introducing a second bespoke event-emitter surface.
 * - An `error`/`ended` message that arrives *before* any `format` message ever arrived rejects
 *   `createProcessAudioTrack`'s promise instead (nothing was ever built to `stop()`).
 *
 * ## No microphone-style processing
 *
 * This module never calls `getUserMedia`, never sets `echoCancellation`/`noiseSuppression`/
 * `autoGainControl` anywhere, and the `AudioWorkletNode` fallback path's `MediaStreamAudioDestinationNode`
 * output is not a captured input device, so none of that voice-oriented processing is applied to it
 * either way, by construction — this is captured game/application audio, not voice, and applying
 * those algorithms would degrade it (T12's own mandatory constraint).
 */

// --- Minimal ambient DOM augmentation for the Insertable-Streams-for-MediaStreamTrack surface this
// module needs — see the "TypeScript typing note" above for why this exists at all. Deliberately
// scoped to only the members this file calls, not a full spec re-declaration.
declare global {
  interface MediaStreamTrackGeneratorInit {
    readonly kind: 'audio' | 'video';
  }

  interface MediaStreamTrackGenerator extends MediaStreamTrack {
    readonly writable: WritableStream<AudioData>;
  }

  // Ambient global constructor declarations conventionally use `var` (matches lib.dom.d.ts's own
  // `declare var Worklet: {...}`-style constructor declarations).
  var MediaStreamTrackGenerator: {
    readonly prototype: MediaStreamTrackGenerator;
    new (init: MediaStreamTrackGeneratorInit): MediaStreamTrackGenerator;
  };
}

/** Mirrors `packages/windows-media/src/protocol.ts`'s `FormatPayload` field-for-field (see this
 * module's own doc comment for why this is a deliberately independent, not imported, declaration). */
export interface ProcessAudioFormat {
  readonly sampleRateHz: number;
  readonly channelCount: number;
  readonly bitsPerSample: number;
  readonly isFloat: boolean;
}

/** Mirrors `packages/windows-media/src/protocol.ts`'s `AudioFramePayload` field-for-field. Typed as
 * `Uint8Array<ArrayBuffer>` (never `SharedArrayBuffer`-backed) rather than the wider
 * `Uint8Array<ArrayBufferLike>` `protocol.ts` itself uses for its own zero-copy framing views — this
 * module needs an actual `ArrayBuffer` to satisfy `AudioData`'s `BufferSource`/`DataView`
 * constructors, and PCM arriving over a `MessagePort` is always a plain transferred/cloned
 * `ArrayBuffer`, never a shared one. */
export interface ProcessAudioFrame {
  readonly sequence: number;
  readonly pcm: Uint8Array<ArrayBuffer>;
}

/** The full set of messages this module expects to receive over the `MessagePort` — see this
 * module's own doc comment for the ordering contract (`format` before the first `audioFrame`). */
export type ProcessAudioPortMessage =
  | { readonly type: 'format'; readonly format: ProcessAudioFormat }
  | { readonly type: 'audioFrame'; readonly frame: ProcessAudioFrame }
  | { readonly type: 'ended' }
  | { readonly type: 'error'; readonly message: string };

/** The one message type this module ever sends back over the port — see this module's own doc
 * comment's "Backpressure" section. */
export interface ProcessAudioAckMessage {
  readonly type: 'ack';
  readonly sequence: number;
}

export interface ProcessAudioTrack {
  readonly track: MediaStreamTrack;
  readonly stream: MediaStream;
  /** True once `stop()` has run — the underlying track is stopped, the synthesis machinery
   * (`AudioContext`/`AudioWorkletNode`/`MediaStreamTrackGenerator` writer, whichever path was used)
   * is fully torn down, and the `MessagePort` is closed. Idempotent, same contract as `Screen`/
   * `Camera`. */
  readonly stopped: boolean;
  /** A short, human-readable description of why this session ended, set only when it ended via an
   * `error` port message or an unrecoverable synthesis/format-change failure — `undefined` for a
   * clean `ended` message or an explicit caller-initiated `stop()`. Never PCM content, never a
   * secret; see this module's own doc comment for why this is a plain string rather than a second
   * typed-error surface. */
  readonly lastError: string | undefined;
  /**
   * Stops the underlying track, tears down whichever synthesis machinery was built (never leaves an
   * `AudioContext` running), and closes the `MessagePort` so the Main-process side can detect the
   * Renderer is done and release its own resources. Idempotent.
   */
  stop(): void;
}

/** Bounds how many decoded-but-not-yet-synthesized PCM frames this module holds internally before
 * dropping the oldest one — see this module's own doc comment's "Backpressure" section for the
 * drop-oldest rationale. Not tied to any particular frame duration; chosen as a generous few-hundred-
 * millisecond-to-low-seconds cushion (exact size depends on the source's own frame duration) that
 * absorbs a brief synthesis stall without letting memory grow unbounded under a sustained one. */
const MAX_QUEUED_FRAMES = 64;

const PROCESS_AUDIO_WORKLET_NAME = 'ovnichat-process-audio-worklet';

/**
 * Original `AudioWorkletProcessor` source for the fallback synthesis path, loaded via an inline
 * `Blob` URL (see this module's own doc comment). Independently written for this task — not adapted
 * from any third-party reference (see `docs/references/VDO_NINJA.md`'s provenance workflow; this
 * task never consulted VDO.Ninja, since this is a standard, generic Web Audio pattern with no
 * VDO.Ninja-specific behavior to corroborate). Receives interleaved `Float32Array` PCM batches over
 * `AudioWorkletNode.port`, queues them, and drains one output sample per channel per rendered frame,
 * emitting silence when starved rather than throwing or stalling the audio thread.
 */
const PROCESS_AUDIO_WORKLET_SOURCE = `
class OvniChatProcessAudioWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._queue = [];
    this._readOffsetFrames = 0;
    this.port.onmessage = (event) => {
      const message = event.data;
      if (message && message.type === 'pcm') {
        this._queue.push({ channelCount: message.channelCount, samples: message.samples });
      }
    };
  }

  _nextFrame(outputChannelCount) {
    while (this._queue.length > 0) {
      const batch = this._queue[0];
      const totalFrames = batch.channelCount > 0 ? batch.samples.length / batch.channelCount : 0;
      if (this._readOffsetFrames >= totalFrames) {
        this._queue.shift();
        this._readOffsetFrames = 0;
        continue;
      }
      const base = this._readOffsetFrames * batch.channelCount;
      const frame = new Array(outputChannelCount);
      for (let channel = 0; channel < outputChannelCount; channel += 1) {
        const sourceChannel = Math.min(channel, batch.channelCount - 1);
        frame[channel] = batch.samples[base + sourceChannel];
      }
      this._readOffsetFrames += 1;
      return frame;
    }
    return null;
  }

  process(_inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const renderQuantumFrames = output[0].length;
    for (let i = 0; i < renderQuantumFrames; i += 1) {
      const frame = this._nextFrame(output.length);
      for (let channel = 0; channel < output.length; channel += 1) {
        output[channel][i] = frame ? frame[channel] : 0;
      }
    }
    return true;
  }
}

registerProcessor('${PROCESS_AUDIO_WORKLET_NAME}', OvniChatProcessAudioWorkletProcessor);
`;

function formatsEqual(a: ProcessAudioFormat, b: ProcessAudioFormat): boolean {
  return (
    a.sampleRateHz === b.sampleRateHz &&
    a.channelCount === b.channelCount &&
    a.bitsPerSample === b.bitsPerSample &&
    a.isFloat === b.isFloat
  );
}

/** Maps this module's PCM format to the WebCodecs `AudioSampleFormat` the primary
 * (`MediaStreamTrackGenerator`) path passes straight through to `AudioData`, with no conversion —
 * see this module's own doc comment for why preserving the original bit depth matters here. */
function toAudioSampleFormat(format: ProcessAudioFormat): AudioSampleFormat {
  if (format.isFloat) {
    if (format.bitsPerSample === 32) return 'f32';
    throw new ProcessAudioTrackError(
      'unsupported-format',
      `Unsupported floating-point PCM bit depth: ${String(format.bitsPerSample)}`,
    );
  }
  switch (format.bitsPerSample) {
    case 8:
      return 'u8';
    case 16:
      return 's16';
    case 32:
      return 's32';
    default:
      throw new ProcessAudioTrackError(
        'unsupported-format',
        `Unsupported integer PCM bit depth: ${String(format.bitsPerSample)}`,
      );
  }
}

/** Decodes interleaved PCM bytes into interleaved `Float32Array` samples (Web Audio's only internal
 * representation) — used only by the `AudioWorkletNode` fallback path; the primary
 * (`MediaStreamTrackGenerator`) path never needs this, since `AudioData` accepts the original PCM
 * format directly (see {@link toAudioSampleFormat}). */
function decodeInterleavedPcmToFloat32(pcm: Uint8Array, format: ProcessAudioFormat): Float32Array {
  const bytesPerSample = format.bitsPerSample / 8;
  const frameSizeBytes = bytesPerSample * format.channelCount;
  if (frameSizeBytes <= 0) return new Float32Array(0);

  const numberOfFrames = Math.floor(pcm.byteLength / frameSizeBytes);
  const sampleCount = numberOfFrames * format.channelCount;
  const out = new Float32Array(sampleCount);
  const view = new DataView(pcm.buffer, pcm.byteOffset, numberOfFrames * frameSizeBytes);

  for (let i = 0; i < sampleCount; i += 1) {
    out[i] = readSample(view, i * bytesPerSample, format);
  }
  return out;
}

function readSample(view: DataView, byteOffset: number, format: ProcessAudioFormat): number {
  if (format.isFloat) {
    if (format.bitsPerSample === 32) return view.getFloat32(byteOffset, true);
    throw new ProcessAudioTrackError(
      'unsupported-format',
      `Unsupported floating-point PCM bit depth: ${String(format.bitsPerSample)}`,
    );
  }
  switch (format.bitsPerSample) {
    case 8:
      return (view.getUint8(byteOffset) - 128) / 128;
    case 16:
      return view.getInt16(byteOffset, true) / 32768;
    case 32:
      return view.getInt32(byteOffset, true) / 2147483648;
    default:
      throw new ProcessAudioTrackError(
        'unsupported-format',
        `Unsupported integer PCM bit depth: ${String(format.bitsPerSample)}`,
      );
  }
}

/** True when the primary path's runtime dependency is present. */
function generatorSupported(): boolean {
  return typeof MediaStreamTrackGenerator !== 'undefined';
}

/** True when the fallback path's runtime dependencies are present. */
function workletFallbackSupported(): boolean {
  return typeof AudioContext !== 'undefined' && typeof AudioWorkletNode !== 'undefined';
}

interface SynthesisSession {
  readonly track: MediaStreamTrack;
  readonly stream: MediaStream;
  readonly mode: 'generator' | 'worklet';
  readonly writer: WritableStreamDefaultWriter<AudioData> | undefined;
  readonly audioContext: AudioContext | undefined;
  readonly workletNode: AudioWorkletNode | undefined;
}

async function buildSynthesisSession(initialFormat: ProcessAudioFormat): Promise<SynthesisSession> {
  if (generatorSupported()) {
    try {
      const track = new MediaStreamTrackGenerator({ kind: 'audio' });
      const writer = track.writable.getWriter();
      const stream = new MediaStream([track]);
      return {
        track,
        stream,
        mode: 'generator',
        writer,
        audioContext: undefined,
        workletNode: undefined,
      };
    } catch (err) {
      throw new ProcessAudioTrackError(
        'synthesis-failed',
        'Failed to construct the MediaStreamTrackGenerator(audio) synthesis path.',
        err,
      );
    }
  }

  if (!workletFallbackSupported()) {
    throw new ProcessAudioTrackError(
      'unsupported-runtime',
      'Neither MediaStreamTrackGenerator(audio) nor AudioContext/AudioWorkletNode is available in this runtime.',
    );
  }

  try {
    const audioContext = new AudioContext({ sampleRate: initialFormat.sampleRateHz });
    const moduleUrl = URL.createObjectURL(
      new Blob([PROCESS_AUDIO_WORKLET_SOURCE], { type: 'application/javascript' }),
    );
    try {
      await audioContext.audioWorklet.addModule(moduleUrl);
    } finally {
      URL.revokeObjectURL(moduleUrl);
    }

    const workletNode = new AudioWorkletNode(audioContext, PROCESS_AUDIO_WORKLET_NAME, {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [initialFormat.channelCount],
    });
    const destination = audioContext.createMediaStreamDestination();
    workletNode.connect(destination);

    const track = destination.stream.getAudioTracks()[0];
    if (!track) {
      throw new ProcessAudioTrackError(
        'synthesis-failed',
        'MediaStreamAudioDestinationNode produced no audio track.',
      );
    }

    return {
      track,
      stream: destination.stream,
      mode: 'worklet',
      writer: undefined,
      audioContext,
      workletNode,
    };
  } catch (err) {
    if (err instanceof ProcessAudioTrackError) throw err;
    throw new ProcessAudioTrackError(
      'synthesis-failed',
      'Failed to build the AudioWorkletNode fallback synthesis path.',
      err,
    );
  }
}

class ProcessAudioTrackImpl implements ProcessAudioTrack {
  readonly track: MediaStreamTrack;
  readonly stream: MediaStream;

  private readonly port: MessagePort;
  private readonly mode: 'generator' | 'worklet';
  private readonly writer: WritableStreamDefaultWriter<AudioData> | undefined;
  private readonly audioContext: AudioContext | undefined;
  private readonly workletNode: AudioWorkletNode | undefined;

  private currentFormat: ProcessAudioFormat;
  private nextTimestampUs = 0;
  private readonly pending: { frame: ProcessAudioFrame; format: ProcessAudioFormat }[] = [];
  private draining = false;

  private _stopped = false;
  private _lastError: string | undefined;

  constructor(port: MessagePort, session: SynthesisSession, initialFormat: ProcessAudioFormat) {
    this.port = port;
    this.track = session.track;
    this.stream = session.stream;
    this.mode = session.mode;
    this.writer = session.writer;
    this.audioContext = session.audioContext;
    this.workletNode = session.workletNode;
    this.currentFormat = initialFormat;
  }

  get stopped(): boolean {
    return this._stopped;
  }

  get lastError(): string | undefined {
    return this._lastError;
  }

  /** Routes one already-decoded port message to this session — called by `createProcessAudioTrack`
   * once it has resolved; not part of the public `ProcessAudioTrack` interface. */
  handleMessage(message: ProcessAudioPortMessage): void {
    if (this._stopped) return;
    switch (message.type) {
      case 'format':
        this.handleFormatChange(message.format);
        return;
      case 'audioFrame':
        this.enqueueFrame(message.frame);
        return;
      case 'ended':
        this.endTrack(undefined);
        return;
      case 'error':
        this.endTrack(message.message);
        return;
    }
  }

  private handleFormatChange(format: ProcessAudioFormat): void {
    if (formatsEqual(format, this.currentFormat)) return;

    if (this.mode === 'worklet') {
      // See this module's own doc comment: the fallback path's AudioContext sample rate is fixed at
      // construction time, so a real format change cannot be applied without rebuilding the whole
      // graph — end cleanly rather than silently produce corrupted audio.
      this.endTrack(
        'Process audio format changed mid-stream, which the AudioWorkletNode fallback synthesis ' +
          'path cannot apply without restarting the whole audio graph.',
      );
      return;
    }

    this.currentFormat = format;
  }

  private enqueueFrame(frame: ProcessAudioFrame): void {
    if (this._stopped) return;
    this.pending.push({ frame, format: this.currentFormat });
    // Bounded, drop-oldest — see MAX_QUEUED_FRAMES's doc comment.
    while (this.pending.length > MAX_QUEUED_FRAMES) this.pending.shift();
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      for (;;) {
        const entry = this.pending.shift();
        if (!entry) break;
        try {
          await this.writeFrame(entry);
        } catch (err) {
          this.endTrack(err instanceof Error ? err.message : String(err));
          return;
        }
        this.sendAck(entry.frame.sequence);
      }
    } finally {
      this.draining = false;
    }
  }

  private async writeFrame(entry: {
    frame: ProcessAudioFrame;
    format: ProcessAudioFormat;
  }): Promise<void> {
    if (this.mode === 'generator') {
      await this.writeGeneratorFrame(entry);
      return;
    }
    this.writeWorkletFrame(entry);
  }

  private async writeGeneratorFrame(entry: {
    frame: ProcessAudioFrame;
    format: ProcessAudioFormat;
  }): Promise<void> {
    const { frame, format } = entry;
    const bytesPerSample = format.bitsPerSample / 8;
    const frameSizeBytes = bytesPerSample * format.channelCount;
    if (frameSizeBytes <= 0) return;

    const numberOfFrames = Math.floor(frame.pcm.byteLength / frameSizeBytes);
    if (numberOfFrames <= 0) return;

    const audioData = new AudioData({
      format: toAudioSampleFormat(format),
      sampleRate: format.sampleRateHz,
      numberOfChannels: format.channelCount,
      numberOfFrames,
      timestamp: this.nextTimestampUs,
      data: frame.pcm,
    });
    this.nextTimestampUs += (numberOfFrames / format.sampleRateHz) * 1_000_000;

    const writer = this.writer;
    if (!writer) {
      audioData.close();
      return;
    }
    try {
      // `write()`'s returned promise is this path's real backpressure signal (WHATWG
      // `WritableStream` semantics) — awaiting it before the queue pulls its next entry is what
      // keeps this path from ever needing to buffer more than one in-flight `AudioData` chunk
      // beyond {@link MAX_QUEUED_FRAMES}.
      await writer.write(audioData);
    } finally {
      // Writing an AudioData into a MediaStreamTrackGenerator's writable does not itself close it
      // (per the Insertable Streams for MediaStreamTrack / WebCodecs spec) — relying on GC to
      // reclaim it would risk resource-pressure warnings under a sustained real-time audio stream,
      // so this module closes every frame explicitly once handed off, matching the pattern used in
      // Chromium's own sample code for this exact API.
      audioData.close();
    }
  }

  private writeWorkletFrame(entry: { frame: ProcessAudioFrame; format: ProcessAudioFormat }): void {
    const { frame, format } = entry;
    const node = this.workletNode;
    if (!node) return;
    const samples = decodeInterleavedPcmToFloat32(frame.pcm, format);
    // `postMessage` carries no backpressure signal of its own (unlike the generator path's
    // `WritableStream`) — see this module's own doc comment: the bounded queue is this path's only
    // backpressure mechanism.
    node.port.postMessage({ type: 'pcm', channelCount: format.channelCount, samples }, [
      samples.buffer,
    ]);
  }

  private sendAck(sequence: number): void {
    if (this._stopped) return;
    const ack: ProcessAudioAckMessage = { type: 'ack', sequence };
    try {
      this.port.postMessage(ack);
    } catch {
      // Never let a failed ack postMessage (e.g. a race with the port closing) disrupt frame
      // delivery — the queue and the writer/worklet backpressure remain correct either way.
    }
  }

  private endTrack(errorMessage: string | undefined): void {
    if (this._stopped) return;
    if (errorMessage !== undefined) this._lastError = errorMessage;
    this.stop();
  }

  stop(): void {
    if (this._stopped) return;
    this._stopped = true;
    this.pending.length = 0;
    this.port.onmessage = null;
    this.port.close();

    if (this.mode === 'generator') {
      void this.writer?.close().catch(() => {
        // The writable side may already be closed/errored (e.g. this stop() followed a synthesis
        // failure) — best-effort teardown, never let this reject unobserved.
      });
      this.track.stop();
      return;
    }

    this.workletNode?.disconnect();
    this.track.stop();
    const context = this.audioContext;
    if (context && context.state !== 'closed') {
      void context.close().catch(() => {
        // Best-effort teardown — never let this reject unobserved.
      });
    }
  }
}

/**
 * Builds a live `MediaStreamTrack` (`kind: 'audio'`) from PCM frames arriving over `port`. Named
 * `createProcessAudioTrack` rather than `acquireProcessAudio` (this package's `acquireScreen`/
 * `acquireCamera`/`acquireMicrophone` convention) deliberately: those functions *acquire* a live
 * platform device via `getUserMedia`/`getDisplayMedia`; this function *synthesizes* a track from
 * data the caller already has flowing over an already-connected port — a categorically different
 * operation, so it gets a categorically different name.
 *
 * Resolves once the first `{ type: 'format' }` message arrives and the synthesis path (see this
 * module's own doc comment) is built; rejects with a {@link ProcessAudioTrackError} if this runtime
 * supports neither synthesis mechanism, if an `error`/`ended` message arrives before any `format`
 * ever did, or if building the chosen synthesis path itself fails. There is no artificial timeout —
 * same convention as `acquireScreen`/`acquireCamera` trusting the platform call they await; a caller
 * that wants one should race this promise externally.
 */
export function createProcessAudioTrack(port: MessagePort): Promise<ProcessAudioTrack> {
  if (!generatorSupported() && !workletFallbackSupported()) {
    port.close();
    return Promise.reject(
      new ProcessAudioTrackError(
        'unsupported-runtime',
        'Neither MediaStreamTrackGenerator(audio) nor AudioContext/AudioWorkletNode is available in this runtime.',
      ),
    );
  }

  return new Promise<ProcessAudioTrack>((resolve, reject) => {
    let settled = false;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      fn();
    };

    port.onmessage = (event: MessageEvent) => {
      const message = event.data as ProcessAudioPortMessage;

      if (message.type === 'audioFrame') {
        // Violates the documented ordering contract (format must precede the first audioFrame) —
        // nothing can be synthesized without a format, so this is dropped defensively rather than
        // treated as fatal.
        return;
      }

      if (message.type === 'error') {
        settle(() => {
          port.close();
          reject(new ProcessAudioTrackError('source-error', message.message));
        });
        return;
      }

      if (message.type === 'ended') {
        settle(() => {
          port.close();
          reject(
            new ProcessAudioTrackError(
              'source-error',
              'The process-audio source ended before any audio format was reported.',
            ),
          );
        });
        return;
      }

      const format = message.format;
      buildSynthesisSession(format).then(
        (session) => {
          settle(() => {
            const impl = new ProcessAudioTrackImpl(port, session, format);
            port.onmessage = (ev: MessageEvent) => {
              impl.handleMessage(ev.data as ProcessAudioPortMessage);
            };
            resolve(impl);
          });
        },
        (err: unknown) => {
          settle(() => {
            port.close();
            reject(
              err instanceof ProcessAudioTrackError
                ? err
                : new ProcessAudioTrackError(
                    'unknown',
                    'Failed to build the process-audio synthesis session.',
                    err,
                  ),
            );
          });
        },
      );
    };
  });
}
