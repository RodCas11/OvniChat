import { app, MessageChannelMain } from 'electron';
import type { WebContents } from 'electron';
import path from 'node:path';

import {
  ProcessLoopbackSupervisor,
  detectProcessAudioCapability,
  type AudioFramePayload,
  type ErrorPayload,
  type FormatPayload,
  type ProcessCandidate,
} from '@disco-voador/windows-media';

import {
  IPC_CHANNELS,
  type DesktopProcessAudioCandidate,
  type DesktopProcessAudioCandidatesResult,
  type DesktopProcessAudioCapabilityResult,
  type DesktopProcessAudioEndedInfo,
  type DesktopProcessAudioStartResult,
} from '../shared/ipc-contract.js';

/**
 * T12 — Main-process lifecycle/IPC owner for Windows per-process/game audio capture: owns exactly
 * one {@link ProcessLoopbackSupervisor} at a time (enumeration-only, or upgraded into an active
 * capture — never two concurrent helper processes), resolves the native helper's executable path
 * (dev tree and packaged layout alike, never anything Renderer-supplied — see
 * `resolveHelperExecutablePath`), and bridges captured PCM to the Renderer over a
 * `MessageChannelMain` port pair, translating `ProcessLoopbackSupervisor`'s events into the small
 * `ProcessAudioPortMessage` wire contract `@disco-voador/media-core`'s `createProcessAudioTrack`
 * expects (see that module's own doc comment for the exact message shapes).
 *
 * This module owns no IPC registration itself (`main/ipc.ts` does, mirroring every other Main-process
 * feature module in this codebase — see `screen-share.ts`) and never touches Electron's
 * `desktopCapturer`/`session`/permission surfaces; its only Electron dependencies are
 * `MessageChannelMain` and the `WebContents` handed to it by `ipc.ts`.
 */

// --- Helper executable path resolution -----------------------------------------------------------

/**
 * Locates `@disco-voador/windows-media`'s own package directory on disk via real Node module
 * resolution (`require.resolve`) — used only in the dev tree (see `resolveHelperExecutablePath`),
 * never anything relative to this file's own (Vite-bundled) output location. `require.resolve`
 * performs genuine filesystem-based Node resolution against the actual installed/hoisted
 * `node_modules` layout (a pnpm workspace symlink in dev) at the moment this function runs.
 * `@disco-voador/windows-media`'s `package.json` declares no `exports` map, so resolving an
 * arbitrary subpath (`package.json` itself) is permitted by Node's legacy resolution algorithm.
 */
function resolveWindowsMediaPackageDir(): string {
  const packageJsonPath = require.resolve('@disco-voador/windows-media/package.json');
  return path.dirname(packageJsonPath);
}

/**
 * Resolves the native helper's real, spawnable executable path — dev tree and packaged layout
 * alike, never anything Renderer-supplied or hardcoded to a `node_modules` assumption that a
 * packaged build cannot satisfy.
 *
 * **Packaged (`app.isPackaged`):** reads it from `process.resourcesPath` — `forge.config.ts`'s
 * `packagerConfig.extraResource` copies the compiled helper directly into the packaged app's
 * `resources` directory at package time (outside the asar entirely, so no `asar.unpack`/
 * `app.asar.unpacked` rewrite is needed at all). This was a real, corrected finding from this
 * task's own `electron-forge package` run: an earlier version of this function assumed
 * `@disco-voador/windows-media`'s files would end up *somewhere* inside the packaged
 * `node_modules` tree (with an `asar.unpack` glob and an `app.asar` -> `app.asar.unpacked` path
 * rewrite to make a `require.resolve`-based lookup spawnable) — a real package build proved that
 * assumption wrong: `@electron-forge/plugin-vite`'s Rollup build inlines every workspace package's
 * JS directly into `main.cjs`/`preload.cjs`, so the packaged `app.asar` has **no**
 * `node_modules/@disco-voador/*` tree at all for `require.resolve` to find. `extraResource` sidesteps
 * this category of problem entirely by not depending on the packaged `node_modules` layout.
 *
 * **Dev tree (`!app.isPackaged`):** resolves relative to `@disco-voador/windows-media`'s own real
 * module location via {@link resolveWindowsMediaPackageDir} — a real pnpm workspace symlink, no
 * `extraResource` copy involved (there is nothing to package in dev).
 */
function resolveHelperExecutablePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'process-loopback-helper.exe');
  }
  return path.join(
    resolveWindowsMediaPackageDir(),
    'native',
    'process-loopback-helper',
    'build',
    'process-loopback-helper.exe',
  );
}

// --- Session state (module-local — this app only ever has one trusted window; see `ipc.ts`'s own
// `currentMainWebContents` for the identical single-window simplification) -----------------------

type SupervisorMode = 'enumeration' | 'capturing';

interface ActiveCaptureSession {
  readonly sessionId: number;
  readonly pid: number;
  readonly port1: Electron.MessagePortMain;
  readonly detach: () => void;
}

let currentSupervisor: ProcessLoopbackSupervisor | undefined;
let currentSupervisorMode: SupervisorMode | undefined;

/**
 * A plain accessor, deliberately not a direct read of `currentSupervisorMode` — TypeScript's
 * control-flow narrowing otherwise "remembers" an earlier `if (currentSupervisorMode === X) return`
 * guard as still holding true for every later read in the same function, including across an
 * `await` — but this module-level `let` genuinely can be reassigned by a *different* exported
 * function call (e.g. a concurrent `startProcessAudioCapture`) while an `await` in the current one
 * is pending, which TS's purely-syntactic analysis has no way to know about. Routing every
 * post-`await` read through this function call resets that (correct, not a workaround for a type
 * error) narrowing instead of silencing a real check with a type assertion.
 */
function getSupervisorMode(): SupervisorMode | undefined {
  return currentSupervisorMode;
}
let lastEnumeratedCandidates: readonly ProcessCandidate[] = [];
let activeSession: ActiveCaptureSession | undefined;
let nextSessionId = 1;

function toDesktopCandidate(candidate: ProcessCandidate): DesktopProcessAudioCandidate {
  return { pid: candidate.pid, exeName: candidate.exeName, displayTitle: candidate.displayTitle };
}

/** Forcibly tears down whichever supervisor (enumeration-only or actively capturing) is currently
 * alive, without notifying the Renderer — for module-internal error paths and app-quit teardown
 * (`disposeProcessAudioSession`), never a substitute for the graceful `stopProcessAudioCapture`. */
function forceDisposeSupervisor(): void {
  activeSession?.detach();
  activeSession?.port1.close();
  activeSession = undefined;
  currentSupervisor?.dispose();
  currentSupervisor = undefined;
  currentSupervisorMode = undefined;
}

// --- Capability -------------------------------------------------------------------------------

export function getProcessAudioCapability(): DesktopProcessAudioCapabilityResult {
  const result = detectProcessAudioCapability();
  return result.supported ? { supported: true } : { supported: false, reason: result.reason };
}

// --- Enumeration --------------------------------------------------------------------------------

const ENUMERATE_TIMEOUT_MS = 8000;

function requestEnumerateAndWait(
  supervisor: ProcessLoopbackSupervisor,
): Promise<readonly ProcessCandidate[]> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      clearTimeout(timeout);
      supervisor.off('enumerateResponse', onResponse);
      supervisor.off('error', onError);
      supervisor.off('helperExit', onExit);
    };
    const onResponse = (candidates: readonly ProcessCandidate[]): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(candidates);
    };
    const onError = (error: ErrorPayload): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error(`Process-loopback helper reported an error during enumeration: ${error.message}`),
      );
    };
    const onExit = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new Error('Process-loopback helper exited before enumeration completed'));
    };
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(
        new Error('Timed out waiting for the process-loopback helper to enumerate candidates'),
      );
    }, ENUMERATE_TIMEOUT_MS);

    supervisor.on('enumerateResponse', onResponse);
    supervisor.on('error', onError);
    supervisor.on('helperExit', onExit);
    supervisor.requestEnumerate();
  });
}

/** Reuses the current supervisor only while it is enumeration-only (never mid-capture, since this
 * repository has no confirmed native-side guarantee that `EnumerateRequest` is safe to interleave
 * with an active capture stream on the same connection) and only ever spawns a fresh one when none
 * is currently running — see this module's own doc comment. */
async function ensureEnumerationSupervisor(): Promise<ProcessLoopbackSupervisor> {
  if (currentSupervisor && currentSupervisorMode === 'enumeration') {
    return currentSupervisor;
  }

  const supervisor = new ProcessLoopbackSupervisor({ helperPath: resolveHelperExecutablePath() });
  currentSupervisor = supervisor;
  currentSupervisorMode = 'enumeration';
  await supervisor.start();
  return supervisor;
}

export async function listProcessAudioCandidates(): Promise<DesktopProcessAudioCandidatesResult> {
  const capability = detectProcessAudioCapability();
  if (!capability.supported) {
    if (currentSupervisorMode !== 'capturing') forceDisposeSupervisor();
    return { supported: false, reason: capability.reason };
  }

  // A live capture already owns the current supervisor exclusively — return the set that capture's
  // own selection was validated against rather than disturbing an active session.
  if (currentSupervisorMode === 'capturing') {
    return { supported: true, candidates: lastEnumeratedCandidates.map(toDesktopCandidate) };
  }

  try {
    const supervisor = await ensureEnumerationSupervisor();
    const candidates = await requestEnumerateAndWait(supervisor);
    lastEnumeratedCandidates = candidates;
    return { supported: true, candidates: candidates.map(toDesktopCandidate) };
  } catch (error) {
    console.error('[disco-voador] process-audio enumeration failed', error);
    if (getSupervisorMode() !== 'capturing') forceDisposeSupervisor();
    lastEnumeratedCandidates = [];
    return { supported: true, candidates: [] };
  }
}

export function cancelProcessAudioEnumeration(): void {
  if (currentSupervisorMode !== 'enumeration') return;
  forceDisposeSupervisor();
}

// --- Start/stop capture --------------------------------------------------------------------------

/**
 * Copies a decoded PCM frame view into its own freshly-allocated `ArrayBuffer` before it is handed
 * to `port1.postMessage`. This is load-bearing, not defensive styling: `@disco-voador/windows-media`'s
 * `FrameDecoder` returns zero-copy `subarray()` views directly into its own internal reassembly
 * buffer (see that package's `protocol.ts`), reused/resliced on every subsequent `push()` call — an
 * un-copied view handed off here could be mutated out from under whatever later reads it.
 *
 * **Not a zero-copy transfer**, despite the name: Electron's Main-process-side `MessagePortMain`
 * (distinct from the DOM `MessagePort` the Renderer side uses) only accepts *other*
 * `MessagePortMain` objects in its `postMessage` transfer list — confirmed against
 * `electron.d.ts`'s own `postMessage(message: any, transfer?: MessagePortMain[])` signature and a
 * real, reproduced upstream report (electron/electron#34905) that transferring an `ArrayBuffer` out
 * of a Main-side port is not supported. `frame.pcm`'s bytes are therefore always structured-cloned
 * (copied again) across this specific hop regardless of what this function does — this copy exists
 * only to protect against the decoder's own buffer reuse, not to enable a transfer that Electron's
 * Main-side port does not offer.
 */
function toOwnedPcmBytes(view: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(view.byteLength);
  copy.set(view);
  return copy;
}

function wireCaptureSession(
  supervisor: ProcessLoopbackSupervisor,
  port1: Electron.MessagePortMain,
  sessionId: number,
  mainWebContents: WebContents,
): () => void {
  const onFormat = (format: FormatPayload): void => {
    port1.postMessage({ type: 'format', format });
  };
  const onAudioFrame = (frame: AudioFramePayload): void => {
    const pcm = toOwnedPcmBytes(frame.pcm);
    // No transfer list: Electron's Main-side `MessagePortMain.postMessage` only transfers other
    // `MessagePortMain`s, not `ArrayBuffer`s — see `toOwnedPcmBytes`'s own doc comment.
    port1.postMessage({ type: 'audioFrame', frame: { sequence: frame.sequence, pcm } });
    supervisor.acknowledgeAudioFrame();
  };
  const onTargetEnded = (): void => {
    port1.postMessage({ type: 'ended' });
    endSession('target-ended');
    supervisor.stop();
  };
  const onError = (error: ErrorPayload): void => {
    port1.postMessage({ type: 'error', message: error.message });
    endSession('error');
    supervisor.dispose();
  };
  const onHelperExit = (info: {
    readonly code: number | null;
    readonly expected: boolean;
  }): void => {
    if (info.expected) return;
    port1.postMessage({
      type: 'error',
      message: 'The process-loopback helper exited unexpectedly.',
    });
    endSession('helper-exit');
  };
  const onPortMessage = (event: Electron.MessageEvent): void => {
    const data = event.data as { readonly type?: unknown; readonly sequence?: unknown } | undefined;
    // T12's mandatory backpressure loop: the Renderer's `createProcessAudioTrack` acks exactly once
    // per PCM frame it has actually handed off to synthesis (see that module's own doc comment) —
    // each ack maps 1:1 to one `ProcessLoopbackSupervisor.acknowledgeAudioFrame()` call, closing the
    // high/low-watermark pause-resume loop that module implements.
    if (data && data.type === 'ack' && typeof data.sequence === 'number') {
      supervisor.acknowledgeAudioFrame();
    }
  };

  function endSession(reason: DesktopProcessAudioEndedInfo['reason']): void {
    if (activeSession?.sessionId !== sessionId) return;
    activeSession = undefined;
    currentSupervisor = undefined;
    currentSupervisorMode = undefined;
    detach();
    port1.close();
    if (!mainWebContents.isDestroyed()) {
      const info: DesktopProcessAudioEndedInfo = { sessionId, reason };
      mainWebContents.send(IPC_CHANNELS.processAudioEnded, info);
    }
  }

  function detach(): void {
    supervisor.off('format', onFormat);
    supervisor.off('audioFrame', onAudioFrame);
    supervisor.off('targetEnded', onTargetEnded);
    supervisor.off('error', onError);
    supervisor.off('helperExit', onHelperExit);
    port1.off('message', onPortMessage);
  }

  supervisor.on('format', onFormat);
  supervisor.on('audioFrame', onAudioFrame);
  supervisor.on('targetEnded', onTargetEnded);
  supervisor.on('error', onError);
  supervisor.on('helperExit', onHelperExit);
  port1.on('message', onPortMessage);
  port1.start();

  return detach;
}

/**
 * Validates `pid` against the most recently enumerated set (never a bare Renderer-supplied PID with
 * no prior enumeration — mirrors `selectScreenShareSource`'s own validation contract exactly),
 * upgrades the current enumeration-only supervisor into an active capture, creates the
 * `MessageChannelMain` PCM bridge, and transfers `port2` to `mainWebContents`. Resolves once
 * `supervisor.startCapture(pid)` has been issued — the capture's actual success/failure (a real PCM
 * `format`, or a rejection) arrives asynchronously over the transferred port, exactly like
 * `ProcessLoopbackSupervisor.startCapture`'s own fire-and-forget contract.
 */
export async function startProcessAudioCapture(
  pid: number,
  mainWebContents: WebContents,
): Promise<DesktopProcessAudioStartResult> {
  const capability = detectProcessAudioCapability();
  if (!capability.supported) return { accepted: false };
  if (currentSupervisorMode === 'capturing') return { accepted: false };

  // Also carries the enumerated exeName through to `startCapture` — the native helper cross-checks
  // it against the resolved PID's *actual* exe basename at `Start`-time (a security-review finding:
  // trusting a bare PID alone leaves a TOCTOU window between enumeration and `Start` where the OS
  // could have recycled that PID to an unrelated process).
  const candidate = lastEnumeratedCandidates.find((c) => c.pid === pid);
  if (!candidate) return { accepted: false };

  const supervisor = currentSupervisor;
  if (!supervisor || currentSupervisorMode !== 'enumeration') return { accepted: false };

  const { port1, port2 } = new MessageChannelMain();
  const sessionId = nextSessionId;
  nextSessionId += 1;
  currentSupervisorMode = 'capturing';

  const detach = wireCaptureSession(supervisor, port1, sessionId, mainWebContents);
  activeSession = { sessionId, pid, port1, detach };

  mainWebContents.postMessage(IPC_CHANNELS.processAudioPort, { sessionId }, [port2]);
  supervisor.startCapture(pid, candidate.exeName);

  return { accepted: true, sessionId };
}

/** Caller-initiated stop (the Renderer already knows — it asked for this — so no
 * `processAudioEnded` push is sent). Idempotent; a no-op if no capture is currently active. */
export function stopProcessAudioCapture(): void {
  const session = activeSession;
  if (!session || currentSupervisorMode !== 'capturing') return;
  const supervisor = currentSupervisor;
  activeSession = undefined;
  currentSupervisor = undefined;
  currentSupervisorMode = undefined;
  session.detach();
  session.port1.close();
  supervisor?.stop();
}

/** Forced, no-notification teardown for app quit — see `main/index.ts`'s `before-quit` handler. */
export function disposeProcessAudioSession(): void {
  forceDisposeSupervisor();
}
