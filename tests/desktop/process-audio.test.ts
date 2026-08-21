import type { WebContents } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * T12 QA gap fix — before this file existed, `apps/desktop/src/main/process-audio.ts` (the
 * Main-process lifecycle/IPC owner for Windows per-process/game audio capture) had **zero** direct
 * test coverage. `tests/desktop/ipc.test.ts` only proves `main/ipc.ts` calls into this module
 * correctly for a trusted sender and validates the `pid` argument shape — it mocks this entire
 * module away, so none of its own real logic (capability fail-narrow enforcement, single-supervisor
 * exclusivity, PID-to-exeName cross-check assembly for the TOCTOU fix, cleanup-on-error paths) was
 * ever exercised by anything. `packages/windows-media/tests/*` cover the pure protocol/capability/
 * supervisor units in isolation, but never this module's own integration of them. This file closes
 * that gap with a controllable fake `ProcessLoopbackSupervisor` (mirroring the real class's on/off/
 * start/requestEnumerate/startCapture/stop/dispose surface) and a controllable
 * `detectProcessAudioCapability` stand-in, exercising the real `process-audio.ts` source unmodified.
 */

/** Minimal stand-in for Electron's Main-side `MessagePortMain` — only the surface
 * `wireCaptureSession`/`stopProcessAudioCapture` in `process-audio.ts` actually calls. */
class FakePortMain {
  readonly messageListeners = new Set<(event: { data: unknown }) => void>();
  readonly posted: unknown[] = [];
  started = false;
  closed = false;

  postMessage(data: unknown): void {
    this.posted.push(data);
  }

  on(event: string, listener: (e: { data: unknown }) => void): void {
    if (event === 'message') this.messageListeners.add(listener);
  }

  off(event: string, listener: (e: { data: unknown }) => void): void {
    if (event === 'message') this.messageListeners.delete(listener);
  }

  start(): void {
    this.started = true;
  }

  close(): void {
    this.closed = true;
  }
}

class FakeMessageChannelMain {
  static instances: FakeMessageChannelMain[] = [];
  static reset(): void {
    FakeMessageChannelMain.instances = [];
  }

  readonly port1 = new FakePortMain();
  readonly port2 = new FakePortMain();

  constructor() {
    FakeMessageChannelMain.instances.push(this);
  }
}

vi.mock('electron', () => ({
  app: { isPackaged: false },
  MessageChannelMain: FakeMessageChannelMain,
}));

type Listener = (...args: never[]) => void;

class FakeSupervisor {
  static instances: FakeSupervisor[] = [];
  static reset(): void {
    FakeSupervisor.instances = [];
  }

  readonly helperPath: string;
  readonly listeners = new Map<string, Set<Listener>>();
  readonly startCaptureCalls: { pid: number; exeName: string }[] = [];
  requestEnumerateCalls = 0;
  stopCalls = 0;
  disposeCalls = 0;
  acknowledgeCalls = 0;
  /** Controls what `start()` does for this instance — set before construction via
   * `FakeSupervisor.nextStartBehavior`. */
  startBehavior: 'resolve' | Error = 'resolve';

  constructor(options: { helperPath: string }) {
    this.helperPath = options.helperPath;
    this.startBehavior = FakeSupervisor.nextStartBehavior;
    FakeSupervisor.nextStartBehavior = 'resolve';
    FakeSupervisor.instances.push(this);
  }

  static nextStartBehavior: 'resolve' | Error = 'resolve';

  on(event: string, listener: Listener): void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
  }

  off(event: string, listener: Listener): void {
    this.listeners.get(event)?.delete(listener);
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      (listener as (...emitArgs: unknown[]) => void)(...args);
    }
  }

  async start(): Promise<void> {
    if (this.startBehavior instanceof Error) throw this.startBehavior;
  }

  requestEnumerate(): void {
    this.requestEnumerateCalls += 1;
  }

  startCapture(pid: number, exeName: string): void {
    this.startCaptureCalls.push({ pid, exeName });
  }

  stop(): void {
    this.stopCalls += 1;
  }

  dispose(): void {
    this.disposeCalls += 1;
  }

  acknowledgeAudioFrame(): void {
    this.acknowledgeCalls += 1;
  }
}

/** Drains pending microtasks (several ticks of headroom, deliberately more than the exact number
 * `ensureEnumerationSupervisor`/`requestEnumerateAndWait`'s own `await` chain needs) so a fake
 * supervisor's synchronous side effects (construction, `requestEnumerate()`) are observable before
 * the test drives it further — avoids this file being brittle to an exact microtask-count change in
 * `process-audio.ts`'s own implementation. */
async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve();
  }
}

let capabilityResult: unknown = { supported: true, detectedBuild: 26200 };
const detectProcessAudioCapabilityMock = vi.fn(() => capabilityResult);

vi.mock('@disco-voador/windows-media', () => ({
  ProcessLoopbackSupervisor: FakeSupervisor,
  detectProcessAudioCapability: () => detectProcessAudioCapabilityMock(),
}));

const {
  getProcessAudioCapability,
  listProcessAudioCandidates,
  cancelProcessAudioEnumeration,
  startProcessAudioCapture,
  stopProcessAudioCapture,
  disposeProcessAudioSession,
} = await import('../../apps/desktop/src/main/process-audio.js');

function fakeWebContents(): WebContents & {
  postMessageCalls: { channel: string; data: unknown; transfer: unknown[] }[];
  sendCalls: { channel: string; args: unknown[] }[];
} {
  const postMessageCalls: { channel: string; data: unknown; transfer: unknown[] }[] = [];
  const sendCalls: { channel: string; args: unknown[] }[] = [];
  return {
    postMessageCalls,
    sendCalls,
    isDestroyed: () => false,
    postMessage: (channel: string, data: unknown, transfer: unknown[] = []) => {
      postMessageCalls.push({ channel, data, transfer });
    },
    send: (channel: string, ...args: unknown[]) => {
      sendCalls.push({ channel, args });
    },
  } as unknown as WebContents & {
    postMessageCalls: { channel: string; data: unknown; transfer: unknown[] }[];
    sendCalls: { channel: string; args: unknown[] }[];
  };
}

beforeEach(() => {
  FakeSupervisor.reset();
  FakeSupervisor.nextStartBehavior = 'resolve';
  FakeMessageChannelMain.reset();
  capabilityResult = { supported: true, detectedBuild: 26200 };
  detectProcessAudioCapabilityMock.mockClear();
  // Every exported function here shares module-level singleton state (`currentSupervisor`,
  // `lastEnumeratedCandidates`, `activeSession`, ...) exactly like the real production module does
  // (there is only ever one trusted window) — force it back to a clean slate before each test via
  // the same forced-teardown path `main/index.ts`'s own `before-quit` handler uses, rather than
  // re-importing the module (which would lose the shared mock wiring above).
  disposeProcessAudioSession();
});

describe('getProcessAudioCapability', () => {
  it('reports supported without exposing the raw detectedBuild', () => {
    capabilityResult = { supported: true, detectedBuild: 26200 };
    expect(getProcessAudioCapability()).toEqual({ supported: true });
  });

  it('fails narrow (never assumed-supported) when the platform capability check reports unsupported', () => {
    capabilityResult = { supported: false, reason: 'not-windows', detectedBuild: undefined };
    expect(getProcessAudioCapability()).toEqual({ supported: false, reason: 'not-windows' });
  });

  it('propagates the build-too-old reason distinctly from not-windows', () => {
    capabilityResult = { supported: false, reason: 'build-too-old', detectedBuild: 19045 };
    expect(getProcessAudioCapability()).toEqual({ supported: false, reason: 'build-too-old' });
  });
});

describe('listProcessAudioCandidates — capability fail-narrow at the Main-process layer', () => {
  it('returns supported:false honestly, with no candidates, and never spawns a helper at all', async () => {
    capabilityResult = { supported: false, reason: 'not-windows', detectedBuild: undefined };

    const result = await listProcessAudioCandidates();

    expect(result).toEqual({ supported: false, reason: 'not-windows' });
    // The load-bearing assertion: an unsupported system must never spawn the native helper at all
    // (not even to try and fail) — "fail narrow" means never attempting the broader operation, not
    // merely reporting a caught failure afterward.
    expect(FakeSupervisor.instances).toHaveLength(0);
  });

  it('returns supported:false for build-too-old just as honestly as not-windows', async () => {
    capabilityResult = { supported: false, reason: 'build-too-old', detectedBuild: 19045 };

    const result = await listProcessAudioCandidates();

    expect(result).toEqual({ supported: false, reason: 'build-too-old' });
    expect(FakeSupervisor.instances).toHaveLength(0);
  });
});

describe('listProcessAudioCandidates — supported platform', () => {
  it('spawns exactly one helper, requests enumeration, and returns the resulting candidates', async () => {
    const promise = listProcessAudioCandidates();
    // Allow `ensureEnumerationSupervisor`'s `await supervisor.start()` to settle before the
    // supervisor exists to emit on.
    await flush();
    const supervisor = FakeSupervisor.instances[0];
    expect(supervisor).toBeDefined();
    expect(supervisor?.requestEnumerateCalls).toBe(1);

    const candidates = [{ pid: 111, exeName: 'game.exe', displayTitle: 'A Game' }];
    supervisor?.emit('enumerateResponse', candidates);

    await expect(promise).resolves.toEqual({ supported: true, candidates });
  });

  it('reuses the same enumeration-only supervisor across two consecutive calls', async () => {
    const first = listProcessAudioCandidates();
    await flush();
    FakeSupervisor.instances[0]?.emit('enumerateResponse', []);
    await first;

    const second = listProcessAudioCandidates();
    await flush();
    expect(FakeSupervisor.instances).toHaveLength(1);
    FakeSupervisor.instances[0]?.emit('enumerateResponse', []);
    await second;

    expect(FakeSupervisor.instances).toHaveLength(1);
  });

  it('surfaces an enumeration helper error as supported:true with an empty candidate list rather than throwing', async () => {
    // Documents *actual current behavior*, not necessarily ideal behavior — flagged separately: a
    // genuine helper failure (spawn error, crash, protocol violation) during enumeration is
    // currently indistinguishable, from the Renderer's perspective, from "the platform supports
    // process audio but no audio-producing process happens to be running right now." This pins the
    // current contract so a future change to it is a deliberate, reviewed decision, not an
    // accidental regression either direction.
    const promise = listProcessAudioCandidates();
    await flush();
    const supervisor = FakeSupervisor.instances[0];
    supervisor?.emit('error', { code: 99, hresult: 0, message: 'helper exploded' });

    await expect(promise).resolves.toEqual({ supported: true, candidates: [] });
  });

  it('surfaces the helper exiting before responding the same way as an explicit error', async () => {
    const promise = listProcessAudioCandidates();
    await flush();
    const supervisor = FakeSupervisor.instances[0];
    supervisor?.emit('helperExit', { code: 1, expected: false });

    await expect(promise).resolves.toEqual({ supported: true, candidates: [] });
  });

  it('surfaces a start() rejection (helper failed to spawn) as supported:true with no candidates', async () => {
    FakeSupervisor.nextStartBehavior = new Error('spawn ENOENT');

    const result = await listProcessAudioCandidates();

    expect(result).toEqual({ supported: true, candidates: [] });
  });
});

describe('cancelProcessAudioEnumeration', () => {
  it('is a no-op when no supervisor is running', () => {
    expect(() => cancelProcessAudioEnumeration()).not.toThrow();
  });

  it('tears down an enumeration-only supervisor', async () => {
    const promise = listProcessAudioCandidates();
    await flush();
    const supervisor = FakeSupervisor.instances[0];
    supervisor?.emit('enumerateResponse', []);
    await promise;

    cancelProcessAudioEnumeration();
    expect(supervisor?.disposeCalls).toBe(1);

    // A subsequent enumeration spawns a genuinely new helper, not the disposed one.
    const second = listProcessAudioCandidates();
    await flush();
    expect(FakeSupervisor.instances).toHaveLength(2);
    FakeSupervisor.instances[1]?.emit('enumerateResponse', []);
    await second;
  });
});

async function enumerateOneCandidate(
  candidate: { pid: number; exeName: string; displayTitle: string } = {
    pid: 4242,
    exeName: 'Game.exe',
    displayTitle: 'A Game',
  },
): Promise<FakeSupervisor> {
  const promise = listProcessAudioCandidates();
  await flush();
  const supervisor = FakeSupervisor.instances[FakeSupervisor.instances.length - 1];
  supervisor?.emit('enumerateResponse', [candidate]);
  await promise;
  if (!supervisor) throw new Error('expected a supervisor to have been created');
  return supervisor;
}

describe('startProcessAudioCapture', () => {
  it('rejects (accepted:false) without touching the supervisor when the platform is unsupported', async () => {
    await enumerateOneCandidate();
    capabilityResult = { supported: false, reason: 'not-windows', detectedBuild: undefined };

    const webContents = fakeWebContents();
    const result = await startProcessAudioCapture(4242, webContents);

    expect(result).toEqual({ accepted: false });
    expect(webContents.postMessageCalls).toHaveLength(0);
  });

  it('rejects a pid that was never returned by the most recent enumeration', async () => {
    await enumerateOneCandidate({ pid: 4242, exeName: 'Game.exe', displayTitle: 'A Game' });

    const webContents = fakeWebContents();
    const result = await startProcessAudioCapture(9999, webContents);

    expect(result).toEqual({ accepted: false });
    expect(webContents.postMessageCalls).toHaveLength(0);
  });

  it('rejects a pid from a now-superseded enumeration', async () => {
    await enumerateOneCandidate({ pid: 4242, exeName: 'Game.exe', displayTitle: 'A Game' });
    // A second, distinct enumeration supersedes the first.
    cancelProcessAudioEnumeration();
    await enumerateOneCandidate({ pid: 5555, exeName: 'Other.exe', displayTitle: 'Other' });

    const webContents = fakeWebContents();
    const result = await startProcessAudioCapture(4242, webContents);

    expect(result).toEqual({ accepted: false });
  });

  it('accepts a validly enumerated pid, upgrades the supervisor, and starts capture with the enumerated exeName', async () => {
    const supervisor = await enumerateOneCandidate({
      pid: 4242,
      exeName: 'Game.exe',
      displayTitle: 'A Game',
    });

    const webContents = fakeWebContents();
    const result = await startProcessAudioCapture(4242, webContents);

    expect(result).toEqual({ accepted: true, sessionId: expect.any(Number) as number });
    // The load-bearing TOCTOU-fix assertion: the exeName handed to the helper's Start command is
    // always the one this Main process itself enumerated, never anything else (e.g. never empty,
    // never Renderer-suppliable) — closing the PID-reuse gap the security review found.
    expect(supervisor.startCaptureCalls).toEqual([{ pid: 4242, exeName: 'Game.exe' }]);
    // A MessagePortMain (specifically `port2` of a fresh `MessageChannelMain` — `port1` stays in
    // Main to be wired to the supervisor's own events, see the "propagates a real captured
    // format/audioFrame pair" test below) is transferred to the Renderer for this session.
    expect(webContents.postMessageCalls).toHaveLength(1);
    expect(webContents.postMessageCalls[0]?.transfer).toEqual([
      FakeMessageChannelMain.instances[0]?.port2,
    ]);
  });

  it('rejects a second concurrent start while one capture is already active, without spawning a second helper', async () => {
    await enumerateOneCandidate({ pid: 4242, exeName: 'Game.exe', displayTitle: 'A Game' });
    const webContents = fakeWebContents();
    const first = await startProcessAudioCapture(4242, webContents);
    expect(first.accepted).toBe(true);

    const second = await startProcessAudioCapture(4242, webContents);
    expect(second).toEqual({ accepted: false });
    expect(FakeSupervisor.instances).toHaveLength(1);
  });

  it('propagates a real captured format/audioFrame pair to the transferred port and acks each frame', async () => {
    const supervisor = await enumerateOneCandidate();
    const webContents = fakeWebContents();
    await startProcessAudioCapture(4242, webContents);

    // `port1` (kept in Main, wired to the supervisor's events) is the one that actually receives
    // these — `port2` above is only ever handed to the Renderer, never written to directly by Main.
    const port1 = FakeMessageChannelMain.instances[0]?.port1;
    if (!port1) throw new Error('expected a MessageChannelMain to have been constructed');

    const format = { sampleRateHz: 48000, channelCount: 2, bitsPerSample: 16, isFloat: false };
    supervisor.emit('format', format);
    supervisor.emit('audioFrame', { sequence: 0, pcm: new Uint8Array([1, 2, 3]) });

    expect(port1.posted).toEqual([
      { type: 'format', format },
      { type: 'audioFrame', frame: { sequence: 0, pcm: new Uint8Array([1, 2, 3]) } },
    ]);
    expect(supervisor.acknowledgeCalls).toBe(1);
  });

  it('ends the session and notifies the Renderer via processAudioEnded on targetEnded, and stops the supervisor', async () => {
    const supervisor = await enumerateOneCandidate();
    const webContents = fakeWebContents();
    await startProcessAudioCapture(4242, webContents);

    supervisor.emit('targetEnded');

    expect(webContents.sendCalls).toHaveLength(1);
    expect(webContents.sendCalls[0]?.args[0]).toMatchObject({ reason: 'target-ended' });
    expect(supervisor.stopCalls).toBe(1);

    // The session is fully torn down — a subsequent start is possible again (proves cleanup, not
    // just the notification).
    await enumerateOneCandidate({ pid: 7777, exeName: 'Next.exe', displayTitle: '' });
    const secondResult = await startProcessAudioCapture(7777, webContents);
    expect(secondResult.accepted).toBe(true);
  });

  it('ends the session and notifies the Renderer on an unexpected helper exit, but not on a caller-initiated stop', async () => {
    const supervisor = await enumerateOneCandidate();
    const webContents = fakeWebContents();
    await startProcessAudioCapture(4242, webContents);

    supervisor.emit('helperExit', { code: 1, expected: false });

    expect(webContents.sendCalls).toHaveLength(1);
    expect(webContents.sendCalls[0]?.args[0]).toMatchObject({ reason: 'helper-exit' });
  });
});

describe('stopProcessAudioCapture', () => {
  it('is idempotent — a no-op when nothing is currently capturing', () => {
    expect(() => stopProcessAudioCapture()).not.toThrow();
  });

  it('stops an active capture without sending a processAudioEnded push (the caller already knows)', async () => {
    const supervisor = await enumerateOneCandidate();
    const webContents = fakeWebContents();
    await startProcessAudioCapture(4242, webContents);

    stopProcessAudioCapture();

    expect(supervisor.stopCalls).toBe(1);
    expect(webContents.sendCalls).toHaveLength(0);

    // A late event from the now-detached supervisor must not resurrect a `processAudioEnded` push
    // for a session the Main process itself already considers over.
    supervisor.emit('targetEnded');
    expect(webContents.sendCalls).toHaveLength(0);
  });

  it('calling stop twice in a row is safe', async () => {
    await enumerateOneCandidate();
    const webContents = fakeWebContents();
    await startProcessAudioCapture(4242, webContents);

    stopProcessAudioCapture();
    expect(() => stopProcessAudioCapture()).not.toThrow();
  });
});

describe('disposeProcessAudioSession (forced app-quit teardown)', () => {
  it('is idempotent when nothing is running', () => {
    expect(() => disposeProcessAudioSession()).not.toThrow();
  });

  it('forcibly tears down an active capture without notifying the Renderer', async () => {
    const supervisor = await enumerateOneCandidate();
    const webContents = fakeWebContents();
    await startProcessAudioCapture(4242, webContents);

    disposeProcessAudioSession();

    expect(supervisor.disposeCalls).toBe(1);
    expect(webContents.sendCalls).toHaveLength(0);
  });

  it('forcibly tears down an enumeration-only supervisor', async () => {
    const supervisor = await enumerateOneCandidate();

    disposeProcessAudioSession();

    expect(supervisor.disposeCalls).toBe(1);
  });
});
