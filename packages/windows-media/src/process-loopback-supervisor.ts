import { type ChildProcess, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import net, { type Socket } from 'node:net';

import {
  type AudioFramePayload,
  type DecodedMessage,
  type ErrorPayload,
  type FormatPayload,
  FrameDecoder,
  MessageType,
  type ProcessCandidate,
  ProcessAudioErrorCode,
  ProtocolError,
  TOKEN_LENGTH_BYTES,
  encodeEnumerateRequest,
  encodeHello,
  encodeStart,
  encodeStop,
} from './protocol.js';

/**
 * T12 — the Node/Electron-Main-side owner of one native process-loopback helper's lifecycle: spawns
 * it, authenticates the connection, speaks `protocol.ts`'s framed wire format over a Windows named
 * pipe, and re-exposes the result as a small typed event surface (see
 * `docs/adr/0017-windows-process-loopback-native-boundary.md` for why this is a separate helper
 * process rather than an in-process native addon). This class never touches Electron APIs itself —
 * `apps/desktop`'s Main process owns sender validation, IPC, and the `MessageChannelMain` bridge to
 * the Renderer; this class only owns the helper process and the pipe.
 *
 * **Pipe topology, deliberately this way round:** the native helper creates and owns the named pipe
 * (it is the pipe server); this supervisor is the client that connects out to it. This is why
 * `protocol.ts`'s `Hello` message flows main -> helper and not the reverse — the helper is the one
 * accepting an unauthenticated inbound connection (Windows named pipe names are enumerable by any
 * local process via `\\.\pipe\`, so "the connection arrived" is not by itself proof of anything), so
 * it is the helper's job to demand proof (the shared per-launch token, delivered to both sides only
 * via each process's own environment block, never argv or disk) before trusting the connection with
 * anything else. **This means the native helper implementation itself must create its pipe with
 * `FILE_FLAG_FIRST_PIPE_INSTANCE`** (refuse to start if a pipe by this exact name already exists —
 * defeats a same-user process racing to pre-create the name before the real helper does) **and a
 * security descriptor restricting connections to the current user SID** — this TypeScript module has
 * no ability to enforce either from the client side, so this is a hard requirement on the helper's
 * own `CreateNamedPipe` call, not a suggestion.
 */

export interface ProcessLoopbackSupervisorOptions {
  /** Absolute path to the native helper executable. Never accept this from the Renderer or any
   * other untrusted input — the caller (Main process startup code) must resolve it itself, normally
   * relative to this package's own module location so both the dev tree and a packaged
   * `app.asar.unpacked` layout resolve identically. */
  readonly helperPath: string;
  /** Fixed argument list for the helper process — empty for every real helper launch (all
   * configuration travels via the environment block set up in `start()`, never argv). Exists only
   * so tests can point `helperPath` at `node` and pass a stub script path; this is a caller-only
   * knob never sourced from the Renderer or any other untrusted input. Defaults to `[]`. */
  readonly helperArgs?: readonly string[];
  /** Extra environment variables merged on top of `process.env` for the helper process, alongside
   * this supervisor's own `OVNICHAT_PIPE_NAME`/`OVNICHAT_HELLO_TOKEN_HEX`. Exists only for tests to
   * steer a stub helper's behavior (e.g. `STUB_MODE`) without mutating the real process's own
   * environment; a real helper launch never sets this. */
  readonly env?: Readonly<Record<string, string>>;
  /** Milliseconds to wait for the helper to create its pipe, accept this supervisor's connection,
   * and complete the Hello/Ready handshake before giving up and killing it. Defaults to 5000. */
  readonly handshakeTimeoutMs?: number;
  /** Milliseconds between connection attempts while waiting for the helper's pipe to exist.
   * Defaults to 50. Exposed only so tests can avoid a real timer's wall-clock delay. */
  readonly connectRetryDelayMs?: number;
}

interface ProcessLoopbackSupervisorEvents {
  /** The helper accepted this connection and completed the Hello/Ready handshake. */
  ready: () => void;
  enumerateResponse: (candidates: readonly ProcessCandidate[]) => void;
  format: (format: FormatPayload) => void;
  audioFrame: (frame: AudioFramePayload) => void;
  /** The captured target process (and its tree) exited on its own — not an error. */
  targetEnded: () => void;
  error: (error: ErrorPayload) => void;
  /** Acknowledges a requested `stop()` — the helper is about to exit on its own. */
  stopped: () => void;
  /**
   * The helper process exited without this supervisor asking it to (a native crash, being killed
   * externally, etc.) — always fired, including after a clean `stop()`-initiated exit, so a caller
   * can use this as the single source of truth for "the helper is gone" regardless of how it got
   * there. `expected` is `true` only when this followed a `stop()` call or `dispose()`.
   */
  helperExit: (info: { readonly code: number | null; readonly expected: boolean }) => void;
}

/** Bounds how many decoded `AudioFrame` events this supervisor will emit without the consumer
 * calling {@link ProcessLoopbackSupervisor.acknowledgeAudioFrame} before it pauses reading further
 * data off the pipe — the mandatory "bounded/backpressured PCM delivery" requirement (T12 Section
 * 27/64): a slow or stalled consumer (a busy Renderer, a stalled `MessageChannelMain` port) must
 * never make this process buffer PCM audio without limit. */
const AUDIO_FRAME_HIGH_WATERMARK = 32;
/** Once paused, reading resumes only after the unacknowledged count drops to this level, not the
 * instant it drops below the high watermark — avoids rapidly toggling pause/resume on the socket. */
const AUDIO_FRAME_LOW_WATERMARK = 8;

function generatePipeName(): string {
  return `\\\\.\\pipe\\ovnichat-process-loopback-${randomBytes(16).toString('hex')}`;
}

function isRetryableConnectError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ECONNREFUSED';
}

export class ProcessLoopbackSupervisor {
  private readonly helperPath: string;
  private readonly helperArgs: readonly string[];
  private readonly extraEnv: Readonly<Record<string, string>>;
  private readonly handshakeTimeoutMs: number;
  private readonly connectRetryDelayMs: number;

  private readonly listeners: {
    [K in keyof ProcessLoopbackSupervisorEvents]: Set<ProcessLoopbackSupervisorEvents[K]>;
  } = {
    ready: new Set(),
    enumerateResponse: new Set(),
    format: new Set(),
    audioFrame: new Set(),
    targetEnded: new Set(),
    error: new Set(),
    stopped: new Set(),
    helperExit: new Set(),
  };

  private socket: Socket | undefined;
  private child: ChildProcess | undefined;
  private decoder = new FrameDecoder();
  private helloToken: Buffer | undefined;
  private authenticated = false;
  private stopRequested = false;
  private disposed = false;
  private unacknowledgedAudioFrames = 0;
  private paused = false;

  constructor(options: ProcessLoopbackSupervisorOptions) {
    this.helperPath = options.helperPath;
    this.helperArgs = options.helperArgs ?? [];
    this.extraEnv = options.env ?? {};
    this.handshakeTimeoutMs = options.handshakeTimeoutMs ?? 5000;
    this.connectRetryDelayMs = options.connectRetryDelayMs ?? 50;
  }

  on<K extends keyof ProcessLoopbackSupervisorEvents>(
    event: K,
    listener: ProcessLoopbackSupervisorEvents[K],
  ): void {
    this.listeners[event].add(listener);
  }

  off<K extends keyof ProcessLoopbackSupervisorEvents>(
    event: K,
    listener: ProcessLoopbackSupervisorEvents[K],
  ): void {
    this.listeners[event].delete(listener);
  }

  private emit<K extends keyof ProcessLoopbackSupervisorEvents>(
    event: K,
    ...args: Parameters<ProcessLoopbackSupervisorEvents[K]>
  ): void {
    for (const listener of this.listeners[event]) {
      (listener as (...listenerArgs: typeof args) => void)(...args);
    }
  }

  /**
   * Spawns the helper, connects to the pipe it creates (retrying while it starts up), and completes
   * the Hello/Ready handshake. Resolves once `ready` would fire; rejects (and cleans up) if the
   * helper fails to launch, its pipe never appears, or the handshake times out. Never call more than
   * once per instance — construct a new supervisor per helper launch, mirroring one helper process
   * per capture session (T12 Section 22).
   */
  async start(): Promise<void> {
    const pipeName = generatePipeName();
    const token = randomBytes(TOKEN_LENGTH_BYTES);
    this.helloToken = token;

    return new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        fn();
      };

      const deadlineAt = Date.now() + this.handshakeTimeoutMs;
      const deadline = setTimeout(() => {
        settle(() => {
          this.cleanup();
          reject(new Error('Timed out waiting for the process-loopback helper to become ready'));
        });
      }, this.handshakeTimeoutMs);

      let child: ChildProcess;
      try {
        child = spawn(this.helperPath, this.helperArgs, {
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            ...this.extraEnv,
            OVNICHAT_PIPE_NAME: pipeName,
            OVNICHAT_HELLO_TOKEN_HEX: token.toString('hex'),
          },
        });
      } catch (err) {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
        return;
      }
      this.child = child;
      child.on('exit', (code) => this.handleHelperExit(code));
      child.on('error', (err) => {
        settle(() => {
          this.cleanup();
          reject(err);
        });
      });

      const attemptConnect = (): void => {
        if (settled) return;
        const socket = net.createConnection(pipeName);
        socket.once('connect', () => {
          this.socket = socket;
          this.attachSocketHandlers(socket, settle, resolve, reject);
        });
        socket.once('error', (err) => {
          socket.destroy();
          if (settled) return;
          if (isRetryableConnectError(err) && Date.now() < deadlineAt) {
            setTimeout(attemptConnect, this.connectRetryDelayMs);
            return;
          }
          settle(() => {
            this.cleanup();
            reject(err);
          });
        });
      };
      attemptConnect();
    });
  }

  private attachSocketHandlers(
    socket: Socket,
    settle: (fn: () => void) => void,
    resolve: () => void,
    reject: (err: Error) => void,
  ): void {
    socket.on('data', (chunk: Buffer) => {
      let messages: DecodedMessage[];
      try {
        messages = this.decoder.push(chunk);
      } catch (err) {
        settle(() => reject(err instanceof Error ? err : new Error(String(err))));
        this.fatalProtocolError(err);
        return;
      }

      for (const message of messages) {
        if (!this.authenticated) {
          if (message.type !== MessageType.Ready) {
            settle(() => {
              this.cleanup();
              reject(
                new Error(
                  `Expected Ready as the first helper message, got ${String(message.type)}`,
                ),
              );
            });
            return;
          }
          this.authenticated = true;
          settle(resolve);
          this.emit('ready');
          continue;
        }
        this.handleMessage(message);
      }
    });

    socket.on('error', (err) => {
      // Before authentication a lost connection means the handshake itself failed (the helper may
      // have rejected an invalid token by simply closing) — fail fast rather than waiting out the
      // full timeout. After authentication, a lost pipe is reported via the child's own 'exit' event
      // (handleHelperExit); a bare socket error there isn't independently actionable.
      if (!this.authenticated) {
        settle(() => {
          this.cleanup();
          reject(err);
        });
      }
    });

    socket.on('close', () => {
      // A clean close with no prior error (e.g. the helper rejected an invalid token by simply
      // destroying the connection, rather than erroring it) still means the handshake failed —
      // fail fast instead of waiting out the full timeout for the same outcome.
      if (!this.authenticated) {
        settle(() => {
          this.cleanup();
          reject(new Error('Helper closed the connection before completing the handshake'));
        });
      }
    });

    // Hello is this connection's only client-initiated message — proof this supervisor is the
    // process that actually spawned the helper (holds the same token it passed the helper via the
    // helper's own environment block at spawn time), not merely something that connected to a
    // discovered pipe name. Everything after it is helper-initiated (Ready, then whatever this
    // supervisor's own commands elicit).
    const token = this.helloToken;
    if (!token) throw new Error('start() must set helloToken before attaching socket handlers');
    socket.write(encodeHello(token));
  }

  private handleMessage(message: DecodedMessage): void {
    switch (message.type) {
      case MessageType.EnumerateResponse:
        this.emit('enumerateResponse', message.payload.candidates);
        return;
      case MessageType.Format:
        this.emit('format', message.payload);
        return;
      case MessageType.AudioFrame:
        this.unacknowledgedAudioFrames += 1;
        this.emit('audioFrame', message.payload);
        this.applyBackpressure();
        return;
      case MessageType.TargetEnded:
        this.emit('targetEnded');
        return;
      case MessageType.Error:
        this.emit('error', message.payload);
        return;
      case MessageType.Stopped:
        this.emit('stopped');
        return;
      default:
        this.fatalProtocolError(
          new ProtocolError(`Unexpected message type from helper: ${String(message.type)}`),
        );
    }
  }

  /**
   * The consumer of `audioFrame` events must call this once it has durably handed a frame onward
   * (e.g. posted it through a `MessageChannelMain` port) — this is the other half of the
   * backpressure bound described on {@link AUDIO_FRAME_HIGH_WATERMARK}. Safe to call even if nothing
   * is currently paused.
   */
  acknowledgeAudioFrame(): void {
    if (this.unacknowledgedAudioFrames > 0) this.unacknowledgedAudioFrames -= 1;
    this.applyBackpressure();
  }

  private applyBackpressure(): void {
    const socket = this.socket;
    if (!socket) return;
    if (!this.paused && this.unacknowledgedAudioFrames >= AUDIO_FRAME_HIGH_WATERMARK) {
      this.paused = true;
      socket.pause();
    } else if (this.paused && this.unacknowledgedAudioFrames <= AUDIO_FRAME_LOW_WATERMARK) {
      this.paused = false;
      socket.resume();
    }
  }

  private fatalProtocolError(err: unknown): void {
    this.emit('error', {
      code: ProcessAudioErrorCode.ProtocolViolation,
      hresult: 0,
      message: err instanceof Error ? err.message : String(err),
    });
    this.cleanup();
  }

  /** Requests enumeration of current audio-capable processes; results arrive via the
   * `enumerateResponse` event, not this method's return value — the helper may take a moment to
   * enumerate, and this supervisor makes no request/response pairing guarantee beyond ordering. */
  requestEnumerate(): void {
    this.writeToHelper(encodeEnumerateRequest());
  }

  /** Starts capture of one target. `includeProcessTree` defaults to `true` — sharing "this
   * application's audio" means the whole process tree by default (T12 Section 17, mandatory); no
   * public API here currently offers a way to pass `false`.
   *
   * `expectedExeName` must be the exe basename from the very same `enumerateResponse` candidate the
   * caller resolved `targetProcessId` from (e.g. `candidate.exeName`) — never a value the caller
   * derives independently. This closes the PID-reuse TOCTOU window between an `EnumerateResponse`
   * the user saw and clicked on and the helper actually processing this `Start` command (which can
   * be seconds later): the helper cross-checks this name against the resolved PID's actual exe
   * basename immediately after opening it and before activation, rejecting with `TargetNotFound` on
   * any mismatch rather than silently capturing whatever process now holds that PID. */
  startCapture(targetProcessId: number, expectedExeName: string): void {
    this.writeToHelper(encodeStart({ targetProcessId, includeProcessTree: true, expectedExeName }));
  }

  /** Requests a clean stop; the helper is expected to send `Stopped` and then exit on its own. Does
   * not itself kill the process — see `dispose()` for a forced teardown. */
  stop(): void {
    this.stopRequested = true;
    this.writeToHelper(encodeStop());
  }

  private writeToHelper(frameBytes: Uint8Array): void {
    if (!this.socket || !this.authenticated) {
      throw new Error('Cannot send a command before the helper handshake has completed');
    }
    this.socket.write(frameBytes);
  }

  private handleHelperExit(code: number | null): void {
    const expected = this.stopRequested || this.disposed;
    this.cleanup();
    this.emit('helperExit', { code, expected });
  }

  /** Forcibly tears down the helper process and pipe — for a caller that needs to abandon a session
   * immediately (e.g. the app is quitting) rather than wait for a clean `stop()`/`Stopped` exchange. */
  dispose(): void {
    this.disposed = true;
    this.cleanup();
  }

  private cleanup(): void {
    this.socket?.destroy();
    this.socket = undefined;
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) {
      this.child.kill();
    }
  }
}
