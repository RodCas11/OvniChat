import { describe, expect, it, vi } from 'vitest';

import {
  RemoteAudioGraphController,
  type AudioContextLike,
  type AudioElementLike,
  type AudioNodeLike,
} from '../../apps/desktop/src/renderer/voice/remote-audio-graph.js';

/**
 * T13.4 — `RemoteAudioGraphController`'s attach/detach/volume/mute/output-device/dispose logic,
 * exercised against a fully fake `AudioContext`/node graph (mocking Web Audio is standard practice
 * under Vitest/jsdom, which has no real implementation at all — see this module's own doc comment).
 * The central assertion this suite cares most about: exactly one audible path per participant
 * (`source -> gain -> destination`), with the analyser tapped off `source` but never connected
 * onward to anything.
 */

/** This suite's tests always know an indexed fake node exists (it was just created by the very
 * `attachParticipant` call above each assertion) — this small helper documents that assumption
 * explicitly and fails loudly if it is ever wrong, rather than reaching for a forbidden `!`
 * non-null assertion at each of this file's many call sites. */
function at<T>(array: readonly T[], index: number): T {
  const value = array[index];
  if (value === undefined) throw new Error(`Expected array[${String(index)}] to be defined`);
  return value;
}

function fakeNode(): AudioNodeLike & { connectedTo: unknown[] } {
  const connectedTo: unknown[] = [];
  return {
    connectedTo,
    connect: vi.fn((destination: unknown) => {
      connectedTo.push(destination);
    }),
    disconnect: vi.fn(),
  };
}

function fakeAudioContext(): AudioContextLike & {
  readonly sources: ReturnType<typeof fakeNode>[];
  readonly gains: (ReturnType<typeof fakeNode> & { gain: { value: number } })[];
  readonly analysers: (ReturnType<typeof fakeNode> & {
    fftSize: number;
    getByteTimeDomainData: (a: Uint8Array) => void;
  })[];
  readonly destination: unknown;
  setSinkId: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  const destination = { marker: 'destination' };
  const sources: ReturnType<typeof fakeNode>[] = [];
  const gains: (ReturnType<typeof fakeNode> & { gain: { value: number } })[] = [];
  const analysers: (ReturnType<typeof fakeNode> & {
    fftSize: number;
    getByteTimeDomainData: (a: Uint8Array) => void;
  })[] = [];

  return {
    destination,
    sources,
    gains,
    analysers,
    createMediaStreamSource: vi.fn(() => {
      const node = fakeNode();
      sources.push(node);
      return node;
    }),
    createGain: vi.fn(() => {
      const node = { ...fakeNode(), gain: { value: 1 } };
      gains.push(node);
      return node;
    }),
    createAnalyser: vi.fn(() => {
      const node = {
        ...fakeNode(),
        fftSize: 2048,
        getByteTimeDomainData: vi.fn((array: Uint8Array) => array.fill(128)),
      };
      analysers.push(node);
      return node;
    }),
    setSinkId: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  };
}

function fakeStream(): MediaStream {
  return {} as MediaStream;
}

/** T13.4 — the decode-keep-alive `HTMLMediaElement` stand-in (see `remote-audio-graph.ts`'s own top
 * doc comment for why this element exists at all: a real, live-verified Chromium requirement, not
 * speculative). `play()` resolves by default; a test overrides it to reject to exercise the
 * defense-in-depth catch path. */
function fakeAudioElement(): AudioElementLike & { playCalls: number; pauseCalls: number } {
  let playCalls = 0;
  let pauseCalls = 0;
  return {
    srcObject: null,
    muted: false,
    get playCalls() {
      return playCalls;
    },
    get pauseCalls() {
      return pauseCalls;
    },
    play: vi.fn(async () => {
      playCalls += 1;
    }),
    pause: vi.fn(() => {
      pauseCalls += 1;
    }),
  };
}

describe('RemoteAudioGraphController', () => {
  it('wires exactly one audible path per participant: source -> gain -> destination', () => {
    const audioContext = fakeAudioContext();
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
    });

    controller.attachParticipant('p1', fakeStream());

    const source = at(audioContext.sources, 0);
    const gain = at(audioContext.gains, 0);
    expect(source.connect).toHaveBeenCalledWith(gain);
    expect(gain.connect).toHaveBeenCalledWith(audioContext.destination);
    // Exactly two `connect()` calls off the source: gain (audible) and analyser (analysis-only).
    expect(source.connect).toHaveBeenCalledTimes(2);
  });

  it('the analyser is tapped off source but never connected onward to anything', () => {
    const audioContext = fakeAudioContext();
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
    });

    controller.attachParticipant('p1', fakeStream());

    const analyser = at(audioContext.analysers, 0);
    expect(analyser.connect).not.toHaveBeenCalled();
    expect(analyser.fftSize).toBe(256);
  });

  it('defaults a newly-attached participant to 100% volume, not muted', () => {
    const audioContext = fakeAudioContext();
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
    });

    controller.attachParticipant('p1', fakeStream());

    expect(at(audioContext.gains, 0).gain.value).toBe(1);
    expect(controller.getParticipantVolume('p1')).toBe(100);
    expect(controller.isParticipantMuted('p1')).toBe(false);
  });

  it('honors an explicit initial volume', () => {
    const audioContext = fakeAudioContext();
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
    });

    controller.attachParticipant('p1', fakeStream(), 150);

    expect(at(audioContext.gains, 0).gain.value).toBe(1.5);
  });

  // T13.4 — proves the last link in the persisted-preference chain: `use-voice-channel.ts`'s
  // attach-with-preference logic resolves a stable `identityRef`, loads its stored
  // `{volumePercent, locallyMuted}` entry via IPC, and passes both straight into `attachParticipant` —
  // this is the point where that loaded state actually reaches the real `GainNode`, silent from the
  // very first frame when the stored preference says muted, never a moment of audible 100% first.
  it('honors an explicit initialMuted, applied from the very first attach — no audible moment before it', () => {
    const audioContext = fakeAudioContext();
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
    });

    controller.attachParticipant('p1', fakeStream(), 60, true);

    expect(controller.getParticipantVolume('p1')).toBe(60);
    expect(controller.isParticipantMuted('p1')).toBe(true);
    expect(at(audioContext.gains, 0).gain.value).toBe(0);

    controller.setParticipantMuted('p1', false);
    expect(at(audioContext.gains, 0).gain.value).toBe(0.6);
  });

  it('setParticipantVolume updates the real GainNode value and clamps to [0, 200]', () => {
    const audioContext = fakeAudioContext();
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
    });
    controller.attachParticipant('p1', fakeStream());

    controller.setParticipantVolume('p1', 50);
    expect(at(audioContext.gains, 0).gain.value).toBe(0.5);
    expect(controller.getParticipantVolume('p1')).toBe(50);

    controller.setParticipantVolume('p1', 999);
    expect(controller.getParticipantVolume('p1')).toBe(200);
    expect(at(audioContext.gains, 0).gain.value).toBe(2);

    controller.setParticipantVolume('p1', -50);
    expect(controller.getParticipantVolume('p1')).toBe(0);
  });

  it('setParticipantMuted silences the gain node without discarding the configured volume', () => {
    const audioContext = fakeAudioContext();
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
    });
    controller.attachParticipant('p1', fakeStream());
    controller.setParticipantVolume('p1', 150);

    controller.setParticipantMuted('p1', true);
    expect(at(audioContext.gains, 0).gain.value).toBe(0);
    expect(controller.getParticipantVolume('p1')).toBe(150); // preserved, not reset

    controller.setParticipantMuted('p1', false);
    // Unmuting restores exactly the previously-configured volume — never resets to 100%.
    expect(at(audioContext.gains, 0).gain.value).toBe(1.5);
  });

  it('setDeafened silences every attached participant without touching their own volume/mute state', () => {
    const audioContext = fakeAudioContext();
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
    });
    controller.attachParticipant('p1', fakeStream(), 150);
    controller.attachParticipant('p2', fakeStream(), 50);
    controller.setParticipantMuted('p2', true);

    controller.setDeafened(true);

    expect(at(audioContext.gains, 0).gain.value).toBe(0);
    expect(at(audioContext.gains, 1).gain.value).toBe(0);
    expect(controller.isDeafened()).toBe(true);
    // Neither participant's own configuration was mutated by deafening.
    expect(controller.getParticipantVolume('p1')).toBe(150);
    expect(controller.getParticipantVolume('p2')).toBe(50);
    expect(controller.isParticipantMuted('p2')).toBe(true);

    controller.setDeafened(false);

    // Un-deafening restores exactly what was there before: p1's own 150% volume, and p2 stays
    // silent only because *it* is still individually muted, not because of deafen.
    expect(at(audioContext.gains, 0).gain.value).toBe(1.5);
    expect(at(audioContext.gains, 1).gain.value).toBe(0);
    expect(controller.isParticipantMuted('p2')).toBe(true);
  });

  it('a participant attached while already deafened starts silent', () => {
    const audioContext = fakeAudioContext();
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
    });
    controller.setDeafened(true);

    controller.attachParticipant('p1', fakeStream(), 100);

    expect(at(audioContext.gains, 0).gain.value).toBe(0);
    // The participant's own volume is still recorded normally — only playback is silenced.
    expect(controller.getParticipantVolume('p1')).toBe(100);
  });

  it('honors initialDeafened at construction time', () => {
    const audioContext = fakeAudioContext();
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
      initialDeafened: true,
    });

    expect(controller.isDeafened()).toBe(true);
    controller.attachParticipant('p1', fakeStream());
    expect(at(audioContext.gains, 0).gain.value).toBe(0);
  });

  it('setDeafened(false) when already un-deafened leaves every participant gain unchanged', () => {
    const audioContext = fakeAudioContext();
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
    });
    controller.attachParticipant('p1', fakeStream(), 75);

    controller.setDeafened(false); // already false — a no-op

    expect(at(audioContext.gains, 0).gain.value).toBe(0.75);
    expect(controller.isDeafened()).toBe(false);
  });

  it('detachParticipant fully disconnects every node and is safe to call twice', () => {
    const audioContext = fakeAudioContext();
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
    });
    controller.attachParticipant('p1', fakeStream());

    controller.detachParticipant('p1');
    expect(at(audioContext.sources, 0).disconnect).toHaveBeenCalledTimes(1);
    expect(at(audioContext.gains, 0).disconnect).toHaveBeenCalledTimes(1);
    expect(at(audioContext.analysers, 0).disconnect).toHaveBeenCalledTimes(1);

    expect(() => controller.detachParticipant('p1')).not.toThrow();
    expect(at(audioContext.sources, 0).disconnect).toHaveBeenCalledTimes(1); // not called again
  });

  // T13.4 — real regression found and fixed via `e2e:voice-smoke`: see `remote-audio-graph.ts`'s own
  // top doc comment ("A real, live-verified Chromium decode-pipeline requirement") for the full
  // evidence. `attachParticipant` must also wire up a muted, playing decode-keep-alive element for
  // every participant, entirely separate from the audible `source -> gain -> destination` path.
  describe('decode keep-alive element (real Chromium decode-pipeline requirement)', () => {
    it('attachParticipant creates a muted, playing element sourced from the exact same stream', () => {
      const audioContext = fakeAudioContext();
      const elements: ReturnType<typeof fakeAudioElement>[] = [];
      const controller = new RemoteAudioGraphController({
        createAudioContext: () => audioContext,
        createAudioElement: () => {
          const element = fakeAudioElement();
          elements.push(element);
          return element;
        },
      });
      const stream = fakeStream();

      controller.attachParticipant('p1', stream);

      const element = at(elements, 0);
      expect(element.srcObject).toBe(stream);
      expect(element.muted).toBe(true);
      expect(element.playCalls).toBe(1);
    });

    it('the decode-keep-alive element is never connected into the audible/analysis graph', () => {
      // It is not an `AudioNodeLike` at all (no `connect`/`disconnect`), so this is structural, not
      // just behavioral: it cannot participate in `source.connect(...)` calls even by accident.
      const audioContext = fakeAudioContext();
      const controller = new RemoteAudioGraphController({
        createAudioContext: () => audioContext,
        createAudioElement: () => fakeAudioElement(),
      });

      controller.attachParticipant('p1', fakeStream());

      // Exactly two `connect()` calls off source (gain + analyser) — unchanged by this mechanism.
      expect(at(audioContext.sources, 0).connect).toHaveBeenCalledTimes(2);
    });

    it('a decode-keep-alive play() rejection is caught and logged, never thrown, and playback is unaffected', async () => {
      const audioContext = fakeAudioContext();
      const failingElement = fakeAudioElement();
      failingElement.play = vi.fn(async () => {
        throw new Error('autoplay blocked');
      });
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      const controller = new RemoteAudioGraphController({
        createAudioContext: () => audioContext,
        createAudioElement: () => failingElement,
      });

      expect(() => controller.attachParticipant('p1', fakeStream())).not.toThrow();
      // Let the rejected promise's `.catch()` handler run.
      await Promise.resolve();
      await Promise.resolve();

      expect(consoleError).toHaveBeenCalled();
      // The audible path is unaffected by a keep-alive failure.
      expect(at(audioContext.gains, 0).connect).toHaveBeenCalledWith(audioContext.destination);
      consoleError.mockRestore();
    });

    it('detachParticipant pauses the decode-keep-alive element and clears its srcObject', () => {
      const audioContext = fakeAudioContext();
      const element = fakeAudioElement();
      const controller = new RemoteAudioGraphController({
        createAudioContext: () => audioContext,
        createAudioElement: () => element,
      });
      controller.attachParticipant('p1', fakeStream());

      controller.detachParticipant('p1');

      expect(element.pauseCalls).toBe(1);
      expect(element.srcObject).toBeNull();
    });

    it('re-attaching the same participant id replaces the decode-keep-alive element (old one paused first)', () => {
      const audioContext = fakeAudioContext();
      const elements: ReturnType<typeof fakeAudioElement>[] = [];
      const controller = new RemoteAudioGraphController({
        createAudioContext: () => audioContext,
        createAudioElement: () => {
          const element = fakeAudioElement();
          elements.push(element);
          return element;
        },
      });
      controller.attachParticipant('p1', fakeStream());
      const first = at(elements, 0);

      controller.attachParticipant('p1', fakeStream());

      expect(first.pauseCalls).toBe(1);
      expect(elements).toHaveLength(2);
      expect(at(elements, 1).playCalls).toBe(1);
    });

    it('disposeAll pauses and clears every remaining participant decode-keep-alive element', () => {
      const audioContext = fakeAudioContext();
      const elements: ReturnType<typeof fakeAudioElement>[] = [];
      const controller = new RemoteAudioGraphController({
        createAudioContext: () => audioContext,
        createAudioElement: () => {
          const element = fakeAudioElement();
          elements.push(element);
          return element;
        },
      });
      controller.attachParticipant('p1', fakeStream());
      controller.attachParticipant('p2', fakeStream());

      controller.disposeAll();

      expect(at(elements, 0).pauseCalls).toBe(1);
      expect(at(elements, 1).pauseCalls).toBe(1);
    });
  });

  it('detachParticipant is a no-op for an id that was never attached', () => {
    const audioContext = fakeAudioContext();
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
    });
    expect(() => controller.detachParticipant('never-attached')).not.toThrow();
  });

  it('re-attaching the same participant id detaches the old nodes first (no leak, no double-audio)', () => {
    const audioContext = fakeAudioContext();
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
    });
    controller.attachParticipant('p1', fakeStream());
    const firstSource = at(audioContext.sources, 0);

    controller.attachParticipant('p1', fakeStream());

    expect(firstSource.disconnect).toHaveBeenCalledTimes(1);
    expect(audioContext.sources).toHaveLength(2);
  });

  it('setOutputDevice calls the real AudioContext.setSinkId once, at the context level', async () => {
    const audioContext = fakeAudioContext();
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
    });

    await controller.setOutputDevice('speaker-123');
    expect(audioContext.setSinkId).toHaveBeenCalledWith('speaker-123');

    await controller.setOutputDevice(null);
    expect(audioContext.setSinkId).toHaveBeenCalledWith('');
  });

  it('setOutputDevice never throws when setSinkId is unsupported', async () => {
    const audioContext = fakeAudioContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (audioContext as any).setSinkId = undefined;
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
    });

    await expect(controller.setOutputDevice('speaker-123')).resolves.toBeUndefined();
  });

  it('disposeAll detaches every remaining participant and closes the shared AudioContext', () => {
    const audioContext = fakeAudioContext();
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
    });
    controller.attachParticipant('p1', fakeStream());
    controller.attachParticipant('p2', fakeStream());

    controller.disposeAll();

    expect(at(audioContext.sources, 0).disconnect).toHaveBeenCalledTimes(1);
    expect(at(audioContext.sources, 1).disconnect).toHaveBeenCalledTimes(1);
    expect(audioContext.close).toHaveBeenCalledTimes(1);
  });

  it('disposeAll is idempotent (never closes the AudioContext twice)', () => {
    const audioContext = fakeAudioContext();
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
    });
    controller.attachParticipant('p1', fakeStream());

    controller.disposeAll();
    controller.disposeAll();

    expect(audioContext.close).toHaveBeenCalledTimes(1);
  });

  it('attachParticipant after disposeAll is a silent no-op (no new AudioContext resurrected)', () => {
    const audioContext = fakeAudioContext();
    const controller = new RemoteAudioGraphController({
      createAudioContext: () => audioContext,
      createAudioElement: () => fakeAudioElement(),
    });
    controller.disposeAll();

    controller.attachParticipant('p1', fakeStream());

    expect(audioContext.createMediaStreamSource).not.toHaveBeenCalled();
  });

  it('reports a real speaking transition through onSpeakingChange, keyed by the right participantId', () => {
    vi.useFakeTimers();
    try {
      const audioContext = fakeAudioContext();
      const onSpeakingChange = vi.fn();
      const controller = new RemoteAudioGraphController({
        createAudioContext: () => audioContext,
        createAudioElement: () => fakeAudioElement(),
        sensitivity: 1,
        onSpeakingChange,
      });
      controller.attachParticipant('p1', fakeStream());
      controller.attachParticipant('p2', fakeStream());

      // p1's analyser reports loud audio; p2's stays silent (the default fill(128) from
      // `fakeAudioContext`) — only p1 should ever report a speaking transition.
      at(audioContext.analysers, 0).getByteTimeDomainData = vi.fn((array: Uint8Array) =>
        array.fill(255),
      );

      vi.advanceTimersByTime(100); // one internal sample tick (default ~75ms interval)

      expect(onSpeakingChange).toHaveBeenCalledWith('p1', true);
      expect(onSpeakingChange).not.toHaveBeenCalledWith('p2', expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });
});
