import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { ProcessLoopbackSupervisor } from '../../packages/windows-media/src/process-loopback-supervisor.js';

const stubHelperPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/stub-helper.mjs',
);

function makeSupervisor(mode: string, overrides: { handshakeTimeoutMs?: number } = {}) {
  return new ProcessLoopbackSupervisor({
    helperPath: process.execPath,
    helperArgs: [stubHelperPath],
    env: { STUB_MODE: mode },
    handshakeTimeoutMs: overrides.handshakeTimeoutMs ?? 2000,
    connectRetryDelayMs: 20,
  });
}

const activeSupervisors: ProcessLoopbackSupervisor[] = [];
function track(supervisor: ProcessLoopbackSupervisor): ProcessLoopbackSupervisor {
  activeSupervisors.push(supervisor);
  return supervisor;
}

afterEach(() => {
  for (const supervisor of activeSupervisors.splice(0)) supervisor.dispose();
});

describe('ProcessLoopbackSupervisor', () => {
  it('completes the handshake and fires ready', async () => {
    const supervisor = track(makeSupervisor('normal'));
    await expect(supervisor.start()).resolves.toBeUndefined();
  });

  it('receives enumerate candidates from the helper', async () => {
    const supervisor = track(makeSupervisor('normal'));
    await supervisor.start();

    const candidates = await new Promise((resolve) => {
      supervisor.on('enumerateResponse', resolve);
      supervisor.requestEnumerate();
    });

    expect(candidates).toEqual([
      { pid: 111, exeName: 'game.exe', displayTitle: 'Test Game' },
      { pid: 222, exeName: 'other.exe', displayTitle: '' },
    ]);
  });

  it('receives Format then AudioFrame messages after starting capture', async () => {
    const supervisor = track(makeSupervisor('normal'));
    await supervisor.start();

    const format = new Promise((resolve) => supervisor.on('format', resolve));
    const frames: number[] = [];
    const gotAllFrames = new Promise<void>((resolve) => {
      supervisor.on('audioFrame', (frame) => {
        frames.push(frame.sequence);
        supervisor.acknowledgeAudioFrame();
        if (frames.length === 3) resolve();
      });
    });

    supervisor.startCapture(111);

    await expect(format).resolves.toEqual({
      sampleRateHz: 48000,
      channelCount: 2,
      bitsPerSample: 16,
      isFloat: false,
    });
    await gotAllFrames;
    expect(frames).toEqual([0, 1, 2]);
  });

  it('fires stopped and helperExit(expected: true) on a clean stop()', async () => {
    const supervisor = track(makeSupervisor('normal'));
    await supervisor.start();

    const stopped = new Promise<void>((resolve) => supervisor.on('stopped', resolve));
    const exited = new Promise<{ code: number | null; expected: boolean }>((resolve) =>
      supervisor.on('helperExit', resolve),
    );

    supervisor.stop();

    await stopped;
    await expect(exited).resolves.toEqual({ code: 0, expected: true });
  });

  it('fires helperExit(expected: false) when the helper exits on its own after ready', async () => {
    const supervisor = track(makeSupervisor('exit-after-ready'));
    await supervisor.start();

    const exited = await new Promise<{ code: number | null; expected: boolean }>((resolve) =>
      supervisor.on('helperExit', resolve),
    );

    expect(exited).toEqual({ code: 7, expected: false });
  });

  it('rejects start() if the helper closes the connection before completing the handshake', async () => {
    const supervisor = track(makeSupervisor('close-before-ready'));
    await expect(supervisor.start()).rejects.toBeInstanceOf(Error);
  });

  it('rejects start() if the helper never responds within the handshake timeout', async () => {
    const supervisor = track(makeSupervisor('silent', { handshakeTimeoutMs: 150 }));
    await expect(supervisor.start()).rejects.toThrow(/timed out/i);
  });

  it('throws when a command is sent before start() has completed', () => {
    const supervisor = track(makeSupervisor('normal'));
    expect(() => supervisor.startCapture(1)).toThrow();
  });
});
