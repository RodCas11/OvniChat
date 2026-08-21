/**
 * T12 — the framed wire protocol between the native process-loopback helper (a separate,
 * out-of-process executable — see `docs/adr/0017-windows-process-loopback-native-boundary.md` for
 * why a helper, not an in-process Node-API addon) and this package's `ProcessLoopbackSupervisor`
 * (`process-loopback-supervisor.ts`), which owns the Node/Electron-Main side of the connection.
 *
 * Deliberately a single, uniform framed protocol carrying both control messages and raw PCM audio
 * frames, never console-log-style unstructured text mixed onto the same stream (T12 Section 27,
 * mandatory) — every message is `[type: 1 byte][length: 4 bytes LE][payload: length bytes]`, with
 * every length bounded (`MAX_FRAME_PAYLOAD_BYTES`) so a malformed or hostile helper can never cause
 * unbounded buffering on the Node side.
 *
 * This module is pure, environment-neutral TypeScript (no `node:net`, no Electron) so it is directly
 * unit-testable without a real pipe or a real native helper — `FrameDecoder` in particular is the
 * load-bearing piece: named pipes are byte streams, not message streams, so partial/coalesced reads
 * must be reassembled correctly regardless of how the underlying transport chunks them.
 */

// TypeScript's typed arrays are generic over their backing buffer (`Uint8Array<ArrayBuffer>` vs.
// `Uint8Array<ArrayBufferLike>`) — `.subarray()` views (used throughout this module's zero-copy
// framing) return the wider `ArrayBufferLike` form, which a bare `Uint8Array` annotation does not
// accept everywhere. Every signature in this module uses this alias instead of the bare type so a
// view and a freshly allocated buffer stay interchangeable without a cast at each call site.
type Bytes = Uint8Array<ArrayBufferLike>;

export const PROTOCOL_VERSION = 1;

/** Generous headroom above one real WASAPI buffer's worth of PCM (typically a few KB to tens of KB
 * depending on format/buffer duration) — bounds every frame so a malformed/hostile helper can never
 * make the supervisor allocate an unbounded buffer. Not a real expected size. */
export const MAX_FRAME_PAYLOAD_BYTES = 262_144; // 256 KiB

const FRAME_HEADER_BYTES = 5; // 1 (type) + 4 (length, u32 LE)

export enum MessageType {
  /** main -> helper, first message on every connection: proves the connecting Main process is the
   * one that actually launched this helper instance (see the supervisor's per-launch random token),
   * not merely something that discovered the pipe name. */
  Hello = 0x01,
  /** helper -> main: the helper is alive, authenticated the Hello token, and is ready for a command. */
  Ready = 0x02,
  /** main -> helper: list current audio-capable processes (T12 Section 12/41 — friendly candidates,
   * not a raw PID dump). No payload. */
  EnumerateRequest = 0x03,
  /** helper -> main: the enumeration result. */
  EnumerateResponse = 0x04,
  /** main -> helper: begin process-loopback capture for one target. */
  Start = 0x05,
  /** helper -> main: the actual PCM format WASAPI is delivering — sent once, right after a
   * successful `Start`, before any `AudioFrame`. Never assumed in advance (T12 Section 30). */
  Format = 0x06,
  /** helper -> main: one buffer of captured PCM, tagged with a monotonic sequence number so a
   * consumer (or a test) can cheaply detect a drop/reorder without inspecting audio content. */
  AudioFrame = 0x07,
  /** helper -> main: the target process (and its whole captured tree) has exited — capture ends,
   * this is not an error (T12 Section 19/68). */
  TargetEnded = 0x08,
  /** helper -> main: a typed, mapped failure — never a raw stringified native exception (T12
   * Section 75). */
  Error = 0x09,
  /** main -> helper: stop the current capture (if any) and exit. */
  Stop = 0x0a,
  /** helper -> main: acknowledges `Stop` — the helper exits immediately after sending this. */
  Stopped = 0x0b,
}

/** A closed set of locally-meaningful error classes — never "UNKNOWN_NATIVE_ERROR" as the only
 * shape (T12 Section 75, mandatory). The native helper maps whatever HRESULT/exception it actually
 * hit into one of these before ever sending an `Error` message; the raw HRESULT still travels
 * alongside it (see {@link ErrorPayload}) as local diagnostic-only detail, never surfaced to the
 * Renderer/user as the primary message. */
export enum ProcessAudioErrorCode {
  /** The target process id did not resolve to a running process at activation time (already exited,
   * or never existed — e.g. a stale/reused-PID selection — see `resolveProcessTarget`). */
  TargetNotFound = 1,
  /** `ActivateAudioInterfaceAsync` (or the subsequent `IAudioClient::Initialize`) failed for a
   * reason not covered by a more specific code below — the HRESULT is the real diagnostic. */
  ActivationFailed = 2,
  /** The target process could not be captured due to access/protection (e.g. a protected-content or
   * elevated/protected process) — T12 Section 44/76: never request elevation automatically, just
   * report this honestly. */
  AccessDenied = 3,
  /** This Windows build does not support process-loopback capture at all (build < 20348) — should
   * normally be caught by capability detection before ever launching a helper for capture, but kept
   * as a defined code in case the helper itself is the one to discover it. */
  UnsupportedPlatform = 4,
  /** The capture session started successfully but failed later (e.g. the audio engine glitched or
   * the endpoint changed) — distinct from `ActivationFailed` (which never got capture running at
   * all) so a caller can tell "never worked" from "was working, then broke." */
  CaptureFailed = 5,
  /** A message violated this protocol itself (unknown type, oversized length, malformed payload) —
   * the helper is expected to send this (if it can) and then close the connection; the supervisor
   * treats a protocol violation as fatal regardless of whether this message actually arrives. */
  ProtocolViolation = 6,
}

export interface HelloPayload {
  readonly token: Bytes;
}

export interface ReadyPayload {
  readonly protocolVersion: number;
}

/** One audio-capable candidate — deliberately minimal (T12 Section 12/13/41): only what a picker UI
 * needs to display plus the opaque `pid` the supervisor needs internally to start a capture. Never a
 * full command line, environment, or filesystem path. */
export interface ProcessCandidate {
  readonly pid: number;
  /** Executable basename only (e.g. `"PathOfExileSteam.exe"`), never a full path. */
  readonly exeName: string;
  /** A friendly window/session title where the platform provides one; empty string if unavailable —
   * never fabricated. */
  readonly displayTitle: string;
}

export interface EnumerateResponsePayload {
  readonly candidates: readonly ProcessCandidate[];
}

export interface StartPayload {
  readonly targetProcessId: number;
  /** Always `true` in this product's default behavior (T12 Section 17, mandatory: capture the
   * selected process's own tree, matching "share this application's audio," not "exclude it") —
   * kept as an explicit field rather than hardcoded so the protocol itself doesn't bake in a
   * one-way decision, but the supervisor's public API does not currently expose a way to set it to
   * `false`. */
  readonly includeProcessTree: boolean;
  /** Executable basename (e.g. `"PathOfExileSteam.exe"`) of the process the caller actually
   * enumerated and the user actually selected — carried here (rather than trusting `targetProcessId`
   * alone) so the helper can cross-check it against the resolved PID's *actual* exe basename at
   * `Start`-time, immediately after `OpenProcess` succeeds and before any activation call. This is
   * the fix for the PID-reuse TOCTOU window between an `EnumerateResponse` the user saw and clicked
   * on and the helper actually processing `Start` some time later: if the PID has been recycled to a
   * different process in the meantime, this name will not match and the helper rejects with
   * `TargetNotFound` rather than silently capturing the wrong process (see
   * `docs/SECURITY.md`'s "never imply that a PID equals a security identity" rule). Same bound as
   * `ProcessCandidate.exeName` (`MAX_EXE_NAME_BYTES`); truncated the same way by `encodeStart`. */
  readonly expectedExeName: string;
}

export interface FormatPayload {
  readonly sampleRateHz: number;
  readonly channelCount: number;
  readonly bitsPerSample: number;
  readonly isFloat: boolean;
}

export interface AudioFramePayload {
  readonly sequence: number;
  readonly pcm: Bytes;
}

export interface ErrorPayload {
  readonly code: ProcessAudioErrorCode;
  /** The raw HRESULT that produced this error, for local diagnostics only — never surfaced to the
   * Renderer/user as the primary message (T12 Section 74/75). `0` when not applicable (e.g.
   * `ProtocolViolation`, which has no HRESULT). */
  readonly hresult: number;
  /** A short, human-readable, English diagnostic string — local-only, never a secret, but also never
   * PCM content or a full process command line. Bounded to keep the frame small. */
  readonly message: string;
}

export type DecodedMessage =
  | { readonly type: MessageType.Hello; readonly payload: HelloPayload }
  | { readonly type: MessageType.Ready; readonly payload: ReadyPayload }
  | { readonly type: MessageType.EnumerateRequest; readonly payload: undefined }
  | { readonly type: MessageType.EnumerateResponse; readonly payload: EnumerateResponsePayload }
  | { readonly type: MessageType.Start; readonly payload: StartPayload }
  | { readonly type: MessageType.Format; readonly payload: FormatPayload }
  | { readonly type: MessageType.AudioFrame; readonly payload: AudioFramePayload }
  | { readonly type: MessageType.TargetEnded; readonly payload: undefined }
  | { readonly type: MessageType.Error; readonly payload: ErrorPayload }
  | { readonly type: MessageType.Stop; readonly payload: undefined }
  | { readonly type: MessageType.Stopped; readonly payload: undefined };

const TOKEN_LENGTH_BYTES = 32;
const MAX_EXE_NAME_BYTES = 260; // MAX_PATH — a real basename never exceeds this on Windows.
const MAX_DISPLAY_TITLE_BYTES = 128;
const MAX_ERROR_MESSAGE_BYTES = 512;
const MAX_ENUMERATE_CANDIDATES = 256;

class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

// --- Small buffer-writer/reader helpers (no external dependency) ---------------------------------

class Writer {
  private chunks: number[] = [];

  u8(value: number): this {
    this.chunks.push(value & 0xff);
    return this;
  }

  u16(value: number): this {
    this.chunks.push(value & 0xff, (value >>> 8) & 0xff);
    return this;
  }

  u32(value: number): this {
    this.chunks.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
    return this;
  }

  i32(value: number): this {
    return this.u32(value >>> 0);
  }

  bytes(value: Bytes): this {
    for (const byte of value) this.chunks.push(byte);
    return this;
  }

  /** UTF-8 string prefixed by its own byte length (u16) — bounded by the caller before calling this. */
  string16(value: string): this {
    const encoded = new TextEncoder().encode(value);
    return this.u16(encoded.length).bytes(encoded);
  }

  /** UTF-8 string prefixed by its own byte length (u8) — bounded by the caller before calling this. */
  string8(value: string): this {
    const encoded = new TextEncoder().encode(value);
    return this.u8(encoded.length).bytes(encoded);
  }

  toUint8Array(): Bytes {
    return Uint8Array.from(this.chunks);
  }
}

class Reader {
  private offset = 0;
  constructor(private readonly data: Bytes) {}

  private require(count: number): void {
    if (this.offset + count > this.data.length) {
      throw new ProtocolError('Message payload ended before an expected field');
    }
  }

  /** `require()` above already guarantees `index` is in bounds for every call site in this class —
   * this just gives TypeScript's `noUncheckedIndexedAccess` a throwing fallback instead of a
   * forbidden non-null assertion (`!`), and fails loudly rather than silently defaulting to `0` in
   * the (should-be-impossible) case that assumption is ever wrong. */
  private byteAt(index: number): number {
    const value = this.data[index];
    if (value === undefined) throw new ProtocolError('Message payload index out of bounds');
    return value;
  }

  u8(): number {
    this.require(1);
    return this.byteAt(this.offset++);
  }

  u16(): number {
    this.require(2);
    const value = this.byteAt(this.offset) | (this.byteAt(this.offset + 1) << 8);
    this.offset += 2;
    return value;
  }

  u32(): number {
    this.require(4);
    const value =
      (this.byteAt(this.offset) |
        (this.byteAt(this.offset + 1) << 8) |
        (this.byteAt(this.offset + 2) << 16) |
        (this.byteAt(this.offset + 3) << 24)) >>>
      0;
    this.offset += 4;
    return value;
  }

  i32(): number {
    return this.u32() | 0;
  }

  bytes(count: number): Bytes {
    this.require(count);
    const slice = this.data.subarray(this.offset, this.offset + count);
    this.offset += count;
    return slice;
  }

  string16(): string {
    const length = this.u16();
    return new TextDecoder().decode(this.bytes(length));
  }

  string8(): string {
    const length = this.u8();
    return new TextDecoder().decode(this.bytes(length));
  }

  remainingBytes(): Bytes {
    const slice = this.data.subarray(this.offset);
    this.offset = this.data.length;
    return slice;
  }

  assertExhausted(): void {
    if (this.offset !== this.data.length) {
      throw new ProtocolError('Message payload had trailing bytes after decoding');
    }
  }
}

// --- Encoding --------------------------------------------------------------------------------

function frame(type: MessageType, payload: Bytes): Bytes {
  if (payload.length > MAX_FRAME_PAYLOAD_BYTES) {
    throw new ProtocolError(
      `Refusing to encode a ${String(payload.length)}-byte payload for message type ${String(type)} ` +
        `(max ${String(MAX_FRAME_PAYLOAD_BYTES)})`,
    );
  }
  const header = new Writer().u8(type).u32(payload.length).toUint8Array();
  const out = new Uint8Array(header.length + payload.length);
  out.set(header, 0);
  out.set(payload, header.length);
  return out;
}

export function encodeHello(token: Bytes): Bytes {
  if (token.length !== TOKEN_LENGTH_BYTES) {
    throw new ProtocolError(`Hello token must be exactly ${String(TOKEN_LENGTH_BYTES)} bytes`);
  }
  return frame(MessageType.Hello, token);
}

export function encodeReady(protocolVersion: number): Bytes {
  return frame(MessageType.Ready, new Writer().u8(protocolVersion).toUint8Array());
}

export function encodeEnumerateRequest(): Bytes {
  return frame(MessageType.EnumerateRequest, new Uint8Array(0));
}

export function encodeEnumerateResponse(candidates: readonly ProcessCandidate[]): Bytes {
  if (candidates.length > MAX_ENUMERATE_CANDIDATES) {
    throw new ProtocolError(
      `Refusing to encode ${String(candidates.length)} candidates (max ${String(MAX_ENUMERATE_CANDIDATES)})`,
    );
  }
  const writer = new Writer().u16(candidates.length);
  for (const candidate of candidates) {
    const exeName = truncateUtf8(candidate.exeName, MAX_EXE_NAME_BYTES);
    const displayTitle = truncateUtf8(candidate.displayTitle, MAX_DISPLAY_TITLE_BYTES);
    // exeName's bound (260, MAX_PATH) exceeds string8's 255-byte length-prefix ceiling, so it needs
    // string16; displayTitle's smaller bound fits string8 either way.
    writer.u32(candidate.pid).string16(exeName).string8(displayTitle);
  }
  return frame(MessageType.EnumerateResponse, writer.toUint8Array());
}

export function encodeStart(payload: StartPayload): Bytes {
  const expectedExeName = truncateUtf8(payload.expectedExeName, MAX_EXE_NAME_BYTES);
  const writer = new Writer()
    .u32(payload.targetProcessId)
    .u8(payload.includeProcessTree ? 1 : 0)
    // MAX_EXE_NAME_BYTES (260, MAX_PATH) exceeds string8's 255-byte length-prefix ceiling, so this
    // needs string16 — same reasoning as EnumerateResponse's exeName field above.
    .string16(expectedExeName);
  return frame(MessageType.Start, writer.toUint8Array());
}

export function encodeFormat(payload: FormatPayload): Bytes {
  const writer = new Writer()
    .u32(payload.sampleRateHz)
    .u8(payload.channelCount)
    .u8(payload.bitsPerSample)
    .u8(payload.isFloat ? 1 : 0);
  return frame(MessageType.Format, writer.toUint8Array());
}

export function encodeAudioFrame(payload: AudioFramePayload): Bytes {
  const writer = new Writer().u32(payload.sequence).bytes(payload.pcm);
  return frame(MessageType.AudioFrame, writer.toUint8Array());
}

export function encodeTargetEnded(): Bytes {
  return frame(MessageType.TargetEnded, new Uint8Array(0));
}

export function encodeError(payload: ErrorPayload): Bytes {
  const message = truncateUtf8(payload.message, MAX_ERROR_MESSAGE_BYTES);
  const writer = new Writer().u32(payload.code).i32(payload.hresult).string16(message);
  return frame(MessageType.Error, writer.toUint8Array());
}

export function encodeStop(): Bytes {
  return frame(MessageType.Stop, new Uint8Array(0));
}

export function encodeStopped(): Bytes {
  return frame(MessageType.Stopped, new Uint8Array(0));
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(value);
  if (encoded.length <= maxBytes) return value;
  return new TextDecoder().decode(encoded.subarray(0, maxBytes));
}

// --- Decoding a single, already-length-delimited payload ---------------------------------------

function decodePayload(type: MessageType, payload: Bytes): DecodedMessage {
  const reader = new Reader(payload);
  switch (type) {
    case MessageType.Hello: {
      if (payload.length !== TOKEN_LENGTH_BYTES) {
        throw new ProtocolError('Hello payload has the wrong length');
      }
      return { type, payload: { token: payload } };
    }
    case MessageType.Ready: {
      const protocolVersion = reader.u8();
      reader.assertExhausted();
      return { type, payload: { protocolVersion } };
    }
    case MessageType.EnumerateRequest: {
      reader.assertExhausted();
      return { type, payload: undefined };
    }
    case MessageType.EnumerateResponse: {
      const count = reader.u16();
      if (count > MAX_ENUMERATE_CANDIDATES) {
        throw new ProtocolError('EnumerateResponse candidate count exceeds the protocol bound');
      }
      const candidates: ProcessCandidate[] = [];
      for (let i = 0; i < count; i += 1) {
        const pid = reader.u32();
        const exeName = reader.string16();
        const displayTitle = reader.string8();
        candidates.push({ pid, exeName, displayTitle });
      }
      reader.assertExhausted();
      return { type, payload: { candidates } };
    }
    case MessageType.Start: {
      const targetProcessId = reader.u32();
      const includeProcessTree = reader.u8() !== 0;
      const expectedExeName = reader.string16();
      reader.assertExhausted();
      return { type, payload: { targetProcessId, includeProcessTree, expectedExeName } };
    }
    case MessageType.Format: {
      const sampleRateHz = reader.u32();
      const channelCount = reader.u8();
      const bitsPerSample = reader.u8();
      const isFloat = reader.u8() !== 0;
      reader.assertExhausted();
      return { type, payload: { sampleRateHz, channelCount, bitsPerSample, isFloat } };
    }
    case MessageType.AudioFrame: {
      const sequence = reader.u32();
      const pcm = reader.remainingBytes();
      return { type, payload: { sequence, pcm } };
    }
    case MessageType.TargetEnded: {
      reader.assertExhausted();
      return { type, payload: undefined };
    }
    case MessageType.Error: {
      const code = reader.u32() as ProcessAudioErrorCode;
      const hresult = reader.i32();
      const message = reader.string16();
      reader.assertExhausted();
      return { type, payload: { code, hresult, message } };
    }
    case MessageType.Stop: {
      reader.assertExhausted();
      return { type, payload: undefined };
    }
    case MessageType.Stopped: {
      reader.assertExhausted();
      return { type, payload: undefined };
    }
    default: {
      throw new ProtocolError(`Unknown message type ${String(type as number)}`);
    }
  }
}

/**
 * Reassembles length-prefixed frames from a byte stream that may deliver them split across
 * arbitrary chunk boundaries, coalesced together, or (in test/fuzz scenarios) both — named pipes
 * and TCP sockets alike offer no message-boundary guarantee at the `net.Socket` level Node exposes.
 * `push(chunk)` returns every complete message the chunk completed, in order; a partial trailing
 * frame is buffered internally until more data arrives. Throws {@link ProtocolError} (via
 * `decodePayload`/the length bound below) for any malformed input — the supervisor treats a thrown
 * error here as fatal for the whole connection, never a soft/ignorable event, matching T12 Section
 * 27's "malformed helper data must fail locally and safely."
 */
export class FrameDecoder {
  private buffer: Bytes = new Uint8Array(0);

  push(chunk: Bytes): DecodedMessage[] {
    this.buffer = concat(this.buffer, chunk);
    const messages: DecodedMessage[] = [];

    for (;;) {
      if (this.buffer.length < FRAME_HEADER_BYTES) break;
      const type = byteAt(this.buffer, 0);
      const length =
        (byteAt(this.buffer, 1) |
          (byteAt(this.buffer, 2) << 8) |
          (byteAt(this.buffer, 3) << 16) |
          (byteAt(this.buffer, 4) << 24)) >>>
        0;
      if (length > MAX_FRAME_PAYLOAD_BYTES) {
        throw new ProtocolError(
          `Helper declared a ${String(length)}-byte frame, exceeding the ${String(MAX_FRAME_PAYLOAD_BYTES)}-byte bound`,
        );
      }
      const totalLength = FRAME_HEADER_BYTES + length;
      if (this.buffer.length < totalLength) break; // wait for more data

      const payload = this.buffer.subarray(FRAME_HEADER_BYTES, totalLength);
      messages.push(decodePayload(type as MessageType, payload));
      this.buffer = this.buffer.subarray(totalLength);
    }

    return messages;
  }

  /** Bytes currently buffered awaiting the rest of a frame — exposed only for tests asserting this
   * never grows unbounded relative to `MAX_FRAME_PAYLOAD_BYTES`. */
  get bufferedByteCount(): number {
    return this.buffer.length;
  }
}

/** Mirrors `Reader.byteAt` (see its doc comment) for `FrameDecoder`, which reads directly out of its
 * own buffered `Bytes` rather than through a `Reader`. */
function byteAt(data: Bytes, index: number): number {
  const value = data[index];
  if (value === undefined) throw new ProtocolError('Frame buffer index out of bounds');
  return value;
}

function concat(a: Bytes, b: Bytes): Bytes {
  if (a.length === 0) return b;
  if (b.length === 0) return a;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

export { ProtocolError, TOKEN_LENGTH_BYTES };
