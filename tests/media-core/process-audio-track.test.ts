import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProcessAudioTrackError } from '../../packages/media-core/src/process-audio-errors.js';
import {
  createProcessAudioTrack,
  type ProcessAudioFormat,
  type ProcessAudioPortMessage,
} from '../../packages/media-core/src/process-audio-track.js';

/**
 * `MediaStreamTrackGenerator`, `AudioContext`/`AudioWorkletNode`, `AudioData`, `MediaStream`, and
 * `MessagePort` are all platform (Chromium/Electron Renderer) capabilities with no real
 * implementation under Node — mirroring `acquire-screen.test.ts`'s own documented boundary, these
 * tests hand-stub every one of them via `vi.stubGlobal` to exercise this module's own orchestration
 * (runtime feature detection and fallback, PCM/format decoding, the bounded drop-oldest queue, the
 * ack-back protocol, format-change/error/ended handling, and the full-stop-releases-everything
 * lifecycle) deterministically. They do not, and cannot, prove real audio is synthesized by a real
 * browser engine, or that a real `AudioWorkletProcessor` module actually runs — that real-runtime
 * proof only happens once this is wired into the actual Electron app (see the T12 handoff report).
 */

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

interface FakePort {
  readonly port: MessagePort;
  send(data: ProcessAudioPortMessage): void;
  readonly postMessage: ReturnType<typeof vi.fn>;
  readonly close: ReturnType<typeof vi.fn>;
}

function fakeMessagePort(): FakePort {
  const postMessage = vi.fn();
  const close = vi.fn();
  const portLike: { onmessage: ((event: MessageEvent) => void) | null } & Record<string, unknown> =
    {
      onmessage: null,
      postMessage,
      close,
    };
  return {
    port: portLike as unknown as MessagePort,
    postMessage,
    close,
    send: (data) => {
      portLike.onmessage?.({ data } as MessageEvent);
    },
  };
}

const DEFAULT_FORMAT: ProcessAudioFormat = {
  sampleRateHz: 48000,
  channelCount: 1,
  bitsPerSample: 16,
  isFloat: false,
};

function pcm16(...int16Samples: number[]): Uint8Array<ArrayBuffer> {
  const buffer = new ArrayBuffer(int16Samples.length * 2);
  const view = new DataView(buffer);
  int16Samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return new Uint8Array(buffer);
}

interface RecordedAudioData {
  readonly format: string;
  readonly sampleRate: number;
  readonly numberOfChannels: number;
  readonly numberOfFrames: number;
  readonly timestamp: number;
  readonly data: Uint8Array;
}

function stubGenerator(
  writeCalls: RecordedAudioData[],
  writeImpl?: (call: RecordedAudioData) => Promise<void>,
) {
  class FakeAudioData {
    format: string;
    sampleRate: number;
    numberOfChannels: number;
    numberOfFrames: number;
    timestamp: number;
    data: Uint8Array;
    constructor(init: {
      format: string;
      sampleRate: number;
      numberOfChannels: number;
      numberOfFrames: number;
      timestamp: number;
      data: Uint8Array;
    }) {
      this.format = init.format;
      this.sampleRate = init.sampleRate;
      this.numberOfChannels = init.numberOfChannels;
      this.numberOfFrames = init.numberOfFrames;
      this.timestamp = init.timestamp;
      this.data = init.data;
    }
    close(): void {
      // no-op fake
    }
  }

  const writer = {
    write: vi.fn((data: RecordedAudioData) => {
      writeCalls.push(data);
      return writeImpl ? writeImpl(data) : Promise.resolve();
    }),
    close: vi.fn(async () => {}),
  };

  class FakeMediaStreamTrackGenerator {
    kind: string;
    readyState: MediaStreamTrackState = 'live';
    id = 'generator-track';
    writable = { getWriter: () => writer };
    stop = vi.fn(function (this: FakeMediaStreamTrackGenerator) {
      this.readyState = 'ended';
    });
    constructor(init: { kind: string }) {
      this.kind = init.kind;
    }
  }

  vi.stubGlobal('AudioData', FakeAudioData);
  vi.stubGlobal('MediaStreamTrackGenerator', FakeMediaStreamTrackGenerator);
  vi.stubGlobal(
    'MediaStream',
    class {
      private readonly tracks: MediaStreamTrack[];
      constructor(tracks: MediaStreamTrack[]) {
        this.tracks = tracks;
      }
      getAudioTracks(): MediaStreamTrack[] {
        return this.tracks.filter((t) => t.kind === 'audio');
      }
      getTracks(): MediaStreamTrack[] {
        return this.tracks;
      }
    },
  );

  return { writer };
}

interface FakeAudioWorkletNodeInstance {
  readonly port: { postMessage: ReturnType<typeof vi.fn> };
  readonly connect: ReturnType<typeof vi.fn>;
  readonly disconnect: ReturnType<typeof vi.fn>;
}

function stubWorkletFallback(): {
  addModule: ReturnType<typeof vi.fn>;
  contextClose: ReturnType<typeof vi.fn>;
  createdContexts: { sampleRate: number }[];
  createdNodes: FakeAudioWorkletNodeInstance[];
  destinationTrack: MediaStreamTrack;
} {
  const createdContexts: { sampleRate: number }[] = [];
  const createdNodes: FakeAudioWorkletNodeInstance[] = [];
  const addModule = vi.fn(async () => {});
  const contextClose = vi.fn(async () => {});

  const destinationTrack = {
    id: 'destination-track',
    kind: 'audio',
    readyState: 'live' as MediaStreamTrackState,
    stop: vi.fn(function (this: { readyState: MediaStreamTrackState }) {
      this.readyState = 'ended';
    }),
  } as unknown as MediaStreamTrack;
  const destinationStream = {
    getAudioTracks: () => [destinationTrack],
    getTracks: () => [destinationTrack],
  } as unknown as MediaStream;

  class FakeAudioContext {
    sampleRate: number;
    state = 'running';
    audioWorklet = { addModule };
    close = contextClose;
    constructor(options: { sampleRate: number }) {
      this.sampleRate = options.sampleRate;
      createdContexts.push({ sampleRate: options.sampleRate });
    }
    createMediaStreamDestination(): { stream: MediaStream; connect: ReturnType<typeof vi.fn> } {
      return { stream: destinationStream, connect: vi.fn() };
    }
  }

  class FakeAudioWorkletNode implements FakeAudioWorkletNodeInstance {
    port = { postMessage: vi.fn() };
    connect = vi.fn();
    disconnect = vi.fn();
    constructor(
      public readonly context: unknown,
      public readonly name: string,
      public readonly options: unknown,
    ) {
      createdNodes.push(this);
    }
  }

  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeAudioWorkletNode);
  vi.stubGlobal(
    'Blob',
    class {
      constructor(
        public readonly parts: unknown[],
        public readonly options: unknown,
      ) {}
    },
  );
  vi.stubGlobal('URL', {
    createObjectURL: vi.fn(() => 'blob:fake-worklet-url'),
    revokeObjectURL: vi.fn(),
  });

  return { addModule, contextClose, createdContexts, createdNodes, destinationTrack };
}

async function flushMicrotasks(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------------------------
// Runtime support detection
// ---------------------------------------------------------------------------------------------

describe('createProcessAudioTrack — runtime support', () => {
  it('rejects with unsupported-runtime and closes the port when neither mechanism is available', async () => {
    const { port, close } = fakeMessagePort();

    await expect(createProcessAudioTrack(port)).rejects.toMatchObject({
      reason: 'unsupported-runtime',
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('prefers MediaStreamTrackGenerator when both mechanisms are available', async () => {
    const writeCalls: RecordedAudioData[] = [];
    stubGenerator(writeCalls);
    stubWorkletFallback();
    const { port, send } = fakeMessagePort();

    const resultPromise = createProcessAudioTrack(port);
    send({ type: 'format', format: DEFAULT_FORMAT });
    const result = await resultPromise;

    expect(result.track.constructor.name).toBe('FakeMediaStreamTrackGenerator');
  });
});

// ---------------------------------------------------------------------------------------------
// Pre-format error/ended handling
// ---------------------------------------------------------------------------------------------

describe('createProcessAudioTrack — pre-format termination', () => {
  it('rejects with source-error when an error message arrives before any format message', async () => {
    stubGenerator([]);
    const { port, send, close } = fakeMessagePort();

    const resultPromise = createProcessAudioTrack(port);
    send({ type: 'error', message: 'helper crashed' });

    await expect(resultPromise).rejects.toMatchObject({
      reason: 'source-error',
      message: 'helper crashed',
    });
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects with source-error when an ended message arrives before any format message', async () => {
    stubGenerator([]);
    const { port, send, close } = fakeMessagePort();

    const resultPromise = createProcessAudioTrack(port);
    send({ type: 'ended' });

    await expect(resultPromise).rejects.toBeInstanceOf(ProcessAudioTrackError);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('drops an audioFrame that arrives before any format message, without crashing the bootstrap listener', async () => {
    const writeCalls: RecordedAudioData[] = [];
    stubGenerator(writeCalls);
    const { port, send } = fakeMessagePort();

    const resultPromise = createProcessAudioTrack(port);
    send({ type: 'audioFrame', frame: { sequence: 0, pcm: pcm16(1, 2) } });
    send({ type: 'format', format: DEFAULT_FORMAT });

    await expect(resultPromise).resolves.toBeDefined();
    expect(writeCalls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Primary path: MediaStreamTrackGenerator
// ---------------------------------------------------------------------------------------------

describe('createProcessAudioTrack — MediaStreamTrackGenerator path', () => {
  it('writes each PCM frame as an AudioData chunk with the reported format, and acks it', async () => {
    const writeCalls: RecordedAudioData[] = [];
    stubGenerator(writeCalls);
    const { port, send, postMessage } = fakeMessagePort();

    const resultPromise = createProcessAudioTrack(port);
    send({ type: 'format', format: DEFAULT_FORMAT });
    const session = await resultPromise;

    send({ type: 'audioFrame', frame: { sequence: 7, pcm: pcm16(100, -200) } });
    await flushMicrotasks();

    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0]).toMatchObject({
      format: 's16',
      sampleRate: 48000,
      numberOfChannels: 1,
      numberOfFrames: 2,
      timestamp: 0,
    });
    expect(postMessage).toHaveBeenCalledWith({ type: 'ack', sequence: 7 });
    expect(session.stopped).toBe(false);
  });

  it('advances the AudioData timestamp cumulatively across successive frames', async () => {
    const writeCalls: RecordedAudioData[] = [];
    stubGenerator(writeCalls);
    const { port, send } = fakeMessagePort();

    const resultPromise = createProcessAudioTrack(port);
    send({ type: 'format', format: DEFAULT_FORMAT });
    await resultPromise;

    send({ type: 'audioFrame', frame: { sequence: 0, pcm: pcm16(1, 2) } });
    await flushMicrotasks();
    send({ type: 'audioFrame', frame: { sequence: 1, pcm: pcm16(3, 4) } });
    await flushMicrotasks();

    expect(writeCalls[0]?.timestamp).toBe(0);
    // 2 frames at 48000 Hz = (2 / 48000) * 1_000_000 microseconds.
    expect(writeCalls[1]?.timestamp).toBeCloseTo((2 / 48000) * 1_000_000, 5);
  });

  it('handles a mid-stream format change seamlessly (no track termination)', async () => {
    const writeCalls: RecordedAudioData[] = [];
    stubGenerator(writeCalls);
    const { port, send } = fakeMessagePort();

    const resultPromise = createProcessAudioTrack(port);
    send({ type: 'format', format: DEFAULT_FORMAT });
    const session = await resultPromise;

    const stereoFormat: ProcessAudioFormat = { ...DEFAULT_FORMAT, channelCount: 2 };
    send({ type: 'format', format: stereoFormat });
    send({ type: 'audioFrame', frame: { sequence: 0, pcm: pcm16(1, 2, 3, 4) } });
    await flushMicrotasks();

    expect(session.stopped).toBe(false);
    expect(writeCalls[0]?.numberOfChannels).toBe(2);
  });

  it('ends the track cleanly (no lastError) when an ended message arrives after resolution', async () => {
    stubGenerator([]);
    const { port, send, close } = fakeMessagePort();

    const resultPromise = createProcessAudioTrack(port);
    send({ type: 'format', format: DEFAULT_FORMAT });
    const session = await resultPromise;

    send({ type: 'ended' });

    expect(session.stopped).toBe(true);
    expect(session.lastError).toBeUndefined();
    expect(session.track.readyState).toBe('ended');
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('ends the track and records lastError when an error message arrives after resolution', async () => {
    stubGenerator([]);
    const { port, send } = fakeMessagePort();

    const resultPromise = createProcessAudioTrack(port);
    send({ type: 'format', format: DEFAULT_FORMAT });
    const session = await resultPromise;

    send({ type: 'error', message: 'capture engine glitched' });

    expect(session.stopped).toBe(true);
    expect(session.lastError).toBe('capture engine glitched');
  });

  it('ends the track with a descriptive lastError when a frame uses an unsupported bit depth', async () => {
    const writeCalls: RecordedAudioData[] = [];
    stubGenerator(writeCalls);
    const { port, send, postMessage } = fakeMessagePort();

    const resultPromise = createProcessAudioTrack(port);
    send({ type: 'format', format: DEFAULT_FORMAT });
    const session = await resultPromise;

    const oddFormat: ProcessAudioFormat = { ...DEFAULT_FORMAT, bitsPerSample: 24 };
    send({ type: 'format', format: oddFormat });
    send({ type: 'audioFrame', frame: { sequence: 0, pcm: new Uint8Array([1, 2, 3]) } });
    await flushMicrotasks();

    expect(session.stopped).toBe(true);
    expect(session.lastError).toContain('24');
    expect(postMessage).not.toHaveBeenCalledWith({ type: 'ack', sequence: 0 });
  });

  it('stop() is idempotent and releases the writer, the track, and the port exactly once', async () => {
    const { writer } = stubGenerator([]);
    const { port, send, close } = fakeMessagePort();

    const resultPromise = createProcessAudioTrack(port);
    send({ type: 'format', format: DEFAULT_FORMAT });
    const session = await resultPromise;

    session.stop();
    session.stop();
    session.stop();

    expect(session.stopped).toBe(true);
    expect(session.track.readyState).toBe('ended');
    expect(
      (session.track as unknown as { stop: ReturnType<typeof vi.fn> }).stop,
    ).toHaveBeenCalledTimes(1);
    expect(writer.close).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('bounds the internal queue and drops the oldest frames when arrivals outrun the writer', async () => {
    const MAX_QUEUED_FRAMES = 64;
    const writeCalls: RecordedAudioData[] = [];
    let releaseFirstWrite: (() => void) | undefined;
    const { writer } = stubGenerator(writeCalls, (call) => {
      if (writeCalls[0] === call) {
        return new Promise<void>((resolve) => {
          releaseFirstWrite = resolve;
        });
      }
      return Promise.resolve();
    });
    const { port, send, postMessage } = fakeMessagePort();

    const resultPromise = createProcessAudioTrack(port);
    send({ type: 'format', format: DEFAULT_FORMAT });
    await resultPromise;

    // Frame 0 starts draining and stalls on the first (gated) writer.write() call.
    send({ type: 'audioFrame', frame: { sequence: 0, pcm: pcm16(1, 2) } });
    expect(writer.write).toHaveBeenCalledTimes(1);

    // Flood far more frames than MAX_QUEUED_FRAMES while frame 0's write is still pending — the
    // internal queue must cap at MAX_QUEUED_FRAMES and drop the oldest of these, keeping only the
    // most recently arrived ones (sequences 27..90 for 90 total floods with a 64 cap).
    const floodCount = 90;
    for (let sequence = 1; sequence <= floodCount; sequence += 1) {
      send({ type: 'audioFrame', frame: { sequence, pcm: pcm16(sequence, sequence) } });
    }
    expect(writer.write).toHaveBeenCalledTimes(1); // still stalled — nothing else drained yet

    releaseFirstWrite?.();
    await flushMicrotasks();

    const expectedSurvivingCount = MAX_QUEUED_FRAMES;
    expect(writeCalls).toHaveLength(1 + expectedSurvivingCount);

    const ackedSequences = postMessage.mock.calls
      .map((call) => call[0] as { type: string; sequence: number })
      .filter((message) => message.type === 'ack')
      .map((message) => message.sequence);
    const expectedOldestSurvivor = floodCount - MAX_QUEUED_FRAMES + 1; // 27
    expect(ackedSequences[0]).toBe(0);
    expect(ackedSequences[1]).toBe(expectedOldestSurvivor);
    expect(ackedSequences[ackedSequences.length - 1]).toBe(floodCount);
    expect(ackedSequences).toHaveLength(1 + expectedSurvivingCount);
  });
});

// ---------------------------------------------------------------------------------------------
// Fallback path: AudioWorkletNode + MediaStreamAudioDestinationNode
// ---------------------------------------------------------------------------------------------

describe('createProcessAudioTrack — AudioWorkletNode fallback path', () => {
  it('builds the AudioContext at the reported sample rate and returns the destination track/stream', async () => {
    const fallback = stubWorkletFallback();
    const { port, send } = fakeMessagePort();

    const resultPromise = createProcessAudioTrack(port);
    send({ type: 'format', format: DEFAULT_FORMAT });
    const session = await resultPromise;

    expect(fallback.createdContexts).toEqual([{ sampleRate: 48000 }]);
    expect(fallback.addModule).toHaveBeenCalledTimes(1);
    expect(session.track).toBe(fallback.destinationTrack);
  });

  it('decodes PCM to interleaved Float32 samples and posts them to the worklet, transferring the buffer', async () => {
    const fallback = stubWorkletFallback();
    const { port, send } = fakeMessagePort();

    const resultPromise = createProcessAudioTrack(port);
    send({ type: 'format', format: DEFAULT_FORMAT });
    await resultPromise;

    // int16 16384 -> 0.5, int16 -32768 -> -1 (see decodeInterleavedPcmToFloat32/readSample).
    send({ type: 'audioFrame', frame: { sequence: 0, pcm: pcm16(16384, -32768) } });
    await flushMicrotasks();

    const node = fallback.createdNodes[0];
    if (!node) throw new Error('expected an AudioWorkletNode to have been created');
    expect(node.port.postMessage).toHaveBeenCalledTimes(1);
    const [message, transfer] = node.port.postMessage.mock.calls[0] as [
      { type: string; channelCount: number; samples: Float32Array },
      ArrayBuffer[],
    ];
    expect(message.type).toBe('pcm');
    expect(message.channelCount).toBe(1);
    expect(message.samples[0]).toBeCloseTo(0.5, 5);
    expect(message.samples[1]).toBeCloseTo(-1, 5);
    expect(transfer).toEqual([message.samples.buffer]);
  });

  it('ends the track when a format change arrives mid-stream, since the AudioContext sample rate is fixed', async () => {
    stubWorkletFallback();
    const { port, send } = fakeMessagePort();

    const resultPromise = createProcessAudioTrack(port);
    send({ type: 'format', format: DEFAULT_FORMAT });
    const session = await resultPromise;

    send({ type: 'format', format: { ...DEFAULT_FORMAT, sampleRateHz: 44100 } });

    expect(session.stopped).toBe(true);
    expect(session.lastError).toContain('AudioWorkletNode');
  });

  it('stop() disconnects the worklet node, closes the AudioContext, and closes the port exactly once', async () => {
    const fallback = stubWorkletFallback();
    const { port, send, close } = fakeMessagePort();

    const resultPromise = createProcessAudioTrack(port);
    send({ type: 'format', format: DEFAULT_FORMAT });
    const session = await resultPromise;
    const node = fallback.createdNodes[0];

    session.stop();
    session.stop();

    expect(session.stopped).toBe(true);
    expect(node?.disconnect).toHaveBeenCalledTimes(1);
    expect(fallback.contextClose).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(
      (fallback.destinationTrack as unknown as { stop: ReturnType<typeof vi.fn> }).stop,
    ).toHaveBeenCalledTimes(1);
  });
});
