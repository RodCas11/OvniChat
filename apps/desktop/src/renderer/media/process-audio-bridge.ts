import { createProcessAudioTrack, type ProcessAudioTrack } from '@disco-voador/media-core';

import { PROCESS_AUDIO_PORT_WINDOW_MESSAGE_TYPE } from '../../shared/ipc-contract.js';

/**
 * T12 — Renderer-side orchestration for Windows per-process/game audio capture: pairs a
 * `startProcessAudioCapture` IPC call with the `MessagePort` Main transfers separately (via
 * `preload/index.ts`'s `window.postMessage` relay — see that file's own doc comment for why a
 * `MessagePort` cannot travel through `contextBridge` directly), then hands the connected port to
 * `@disco-voador/media-core`'s `createProcessAudioTrack` to synthesize a real `MediaStreamTrack`.
 * This module is the *only* place in this app's Renderer that listens for
 * {@link PROCESS_AUDIO_PORT_WINDOW_MESSAGE_TYPE} `window` messages — `use-voice-channel.ts` and
 * `ScreenSourcePicker.tsx` never touch `window.postMessage`/`MessagePort` directly, only this
 * module's exported functions.
 */

interface PendingPortWaiter {
  readonly resolve: (port: MessagePort) => void;
}

let nextWaiterId = 1;
const pendingPortWaiters = new Map<number, PendingPortWaiter>();
let listenerRegistered = false;

/**
 * Registered lazily, on first actual use (not at module load) — this module is imported
 * transitively by `App.tsx` (via `use-voice-channel.ts`), which this app's own
 * `tests/desktop/renderer-shell.test.ts` server-side-renders under plain Node (`environment: 'node'`
 * in `vitest.config.ts`, no `window` global at all) to prove the shell degrades to a loading
 * placeholder without a preload bridge — a module-load-time `window.addEventListener` call would
 * throw in that environment before any component ever rendered. Deferring registration to the first
 * `acquireProcessAudioTrack` call is also correct, not merely SSR-safe: nothing can produce a
 * transferred port before then, since Main only ever sends one in direct response to
 * `startProcessAudioCapture`, which this same function is what calls.
 *
 * The listener itself is the officially documented Electron pattern for receiving a `MessagePort`
 * relayed from preload into the main world. Only ever consumes messages carrying this module's own
 * `PROCESS_AUDIO_PORT_WINDOW_MESSAGE_TYPE` discriminator and originating from `window` itself
 * (`event.source === window`, matching Electron's own documented example for this pattern) — any
 * other `message` event on `window` (there is no other producer of one in this app, but this is a
 * shared global bus) is ignored.
 */
function ensureListenerRegistered(): void {
  if (listenerRegistered) return;
  listenerRegistered = true;

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window) return;
    const data = event.data as { readonly channel?: unknown } | undefined;
    if (!data || data.channel !== PROCESS_AUDIO_PORT_WINDOW_MESSAGE_TYPE) return;

    const port = event.ports[0];
    if (!port) return;

    // FIFO: only one process-audio capture session is ever active at a time (see
    // `main/process-audio.ts`'s own single-supervisor design), so a simple oldest-first drain
    // always pairs the right port with the right `acquireProcessAudioTrack` call, even under the
    // (currently impossible) case of two overlapping calls.
    const oldestEntry = pendingPortWaiters.entries().next();
    if (oldestEntry.done) return;
    const [waiterId, waiter] = oldestEntry.value;
    pendingPortWaiters.delete(waiterId);
    waiter.resolve(port);
  });
}

function waitForNextProcessAudioPort(): {
  readonly promise: Promise<MessagePort>;
  readonly cancel: () => void;
} {
  ensureListenerRegistered();
  let waiterId = 0;
  const promise = new Promise<MessagePort>((resolve) => {
    waiterId = nextWaiterId;
    nextWaiterId += 1;
    pendingPortWaiters.set(waiterId, { resolve });
  });
  return {
    promise,
    cancel: () => {
      pendingPortWaiters.delete(waiterId);
    },
  };
}

const PORT_WAIT_TIMEOUT_MS = 10_000;

export interface ProcessAudioCaptureHandle {
  readonly processAudioTrack: ProcessAudioTrack;
  readonly sessionId: number;
}

/**
 * Starts a real native process-loopback capture for `pid` (which must have come from this same
 * window's most recent `listProcessAudioCandidates()` call — see `main/process-audio.ts`'s own
 * validation) and resolves once a live `MediaStreamTrack` has actually been synthesized from the
 * first PCM format the native helper reported. Rejects if the IPC call itself is refused (stale/
 * unknown `pid`, capability unsupported, a capture already active), if no port arrives within a
 * bounded timeout, or if `createProcessAudioTrack` itself fails (unsupported Renderer runtime, a
 * synthesis failure, or an `error`/`ended` port message arriving before any format did).
 */
export async function acquireProcessAudioTrack(pid: number): Promise<ProcessAudioCaptureHandle> {
  const waiter = waitForNextProcessAudioPort();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      waiter.cancel();
      reject(new Error('Timed out waiting for the process-audio port from the Main process'));
    }, PORT_WAIT_TIMEOUT_MS);
  });

  try {
    const startResult = await window.desktopApp
      .startProcessAudioCapture(pid)
      .catch((error: unknown) => {
        throw error instanceof Error ? error : new Error(String(error));
      });
    if (!startResult.accepted) {
      throw new Error('Could not start application-audio capture (source no longer available).');
    }

    const port = await Promise.race([waiter.promise, timeoutPromise]);
    const processAudioTrack = await createProcessAudioTrack(port);
    return { processAudioTrack, sessionId: startResult.sessionId };
  } finally {
    waiter.cancel();
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}
