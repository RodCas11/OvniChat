import { describe, expect, it } from 'vitest';

import {
  FrameDecoder,
  MAX_FRAME_PAYLOAD_BYTES,
  MessageType,
  ProcessAudioErrorCode,
  ProtocolError,
  TOKEN_LENGTH_BYTES,
  encodeAudioFrame,
  encodeEnumerateRequest,
  encodeEnumerateResponse,
  encodeError,
  encodeFormat,
  encodeHello,
  encodeReady,
  encodeStart,
  encodeStop,
  encodeStopped,
  encodeTargetEnded,
} from '../../packages/windows-media/src/protocol.js';

function decodeOne(frameBytes: Uint8Array) {
  const decoder = new FrameDecoder();
  const messages = decoder.push(frameBytes);
  expect(messages).toHaveLength(1);
  expect(decoder.bufferedByteCount).toBe(0);
  const message = messages[0];
  if (!message) throw new Error('decoder produced no message');
  return message;
}

describe('round-trip encode/decode for every message type', () => {
  it('Hello', () => {
    const token = new Uint8Array(TOKEN_LENGTH_BYTES).map((_, i) => i);
    const message = decodeOne(encodeHello(token));
    expect(message).toEqual({ type: MessageType.Hello, payload: { token } });
  });

  it('rejects a Hello token of the wrong length', () => {
    expect(() => encodeHello(new Uint8Array(TOKEN_LENGTH_BYTES - 1))).toThrow(ProtocolError);
  });

  it('Ready', () => {
    const message = decodeOne(encodeReady(1));
    expect(message).toEqual({ type: MessageType.Ready, payload: { protocolVersion: 1 } });
  });

  it('EnumerateRequest', () => {
    const message = decodeOne(encodeEnumerateRequest());
    expect(message).toEqual({ type: MessageType.EnumerateRequest, payload: undefined });
  });

  it('EnumerateResponse with candidates', () => {
    const candidates = [
      { pid: 1234, exeName: 'game.exe', displayTitle: 'My Game' },
      { pid: 5678, exeName: 'other.exe', displayTitle: '' },
    ];
    const message = decodeOne(encodeEnumerateResponse(candidates));
    expect(message).toEqual({
      type: MessageType.EnumerateResponse,
      payload: { candidates },
    });
  });

  it('EnumerateResponse rejects more candidates than the protocol bound', () => {
    const tooMany = Array.from({ length: 257 }, (_, i) => ({
      pid: i,
      exeName: 'a.exe',
      displayTitle: '',
    }));
    expect(() => encodeEnumerateResponse(tooMany)).toThrow(ProtocolError);
  });

  it('EnumerateResponse truncates an oversized exeName/displayTitle rather than throwing', () => {
    const longName = 'a'.repeat(1000);
    const message = decodeOne(
      encodeEnumerateResponse([{ pid: 1, exeName: longName, displayTitle: longName }]),
    );
    if (message.type !== MessageType.EnumerateResponse) throw new Error('unexpected type');
    expect(message.payload.candidates[0]?.exeName.length).toBeLessThanOrEqual(260);
    expect(message.payload.candidates[0]?.displayTitle.length).toBeLessThanOrEqual(128);
  });

  it('Start', () => {
    const message = decodeOne(encodeStart({ targetProcessId: 4242, includeProcessTree: true }));
    expect(message).toEqual({
      type: MessageType.Start,
      payload: { targetProcessId: 4242, includeProcessTree: true },
    });
  });

  it('Format', () => {
    const payload = { sampleRateHz: 48_000, channelCount: 2, bitsPerSample: 32, isFloat: true };
    const message = decodeOne(encodeFormat(payload));
    expect(message).toEqual({ type: MessageType.Format, payload });
  });

  it('AudioFrame', () => {
    const pcm = new Uint8Array([1, 2, 3, 4, 5]);
    const message = decodeOne(encodeAudioFrame({ sequence: 7, pcm }));
    expect(message).toEqual({ type: MessageType.AudioFrame, payload: { sequence: 7, pcm } });
  });

  it('TargetEnded', () => {
    const message = decodeOne(encodeTargetEnded());
    expect(message).toEqual({ type: MessageType.TargetEnded, payload: undefined });
  });

  it('Error', () => {
    const payload = {
      code: ProcessAudioErrorCode.AccessDenied,
      hresult: -2147024891,
      message: 'Access was denied',
    };
    const message = decodeOne(encodeError(payload));
    expect(message).toEqual({ type: MessageType.Error, payload });
  });

  it('Error truncates an oversized message rather than throwing', () => {
    const longMessage = 'x'.repeat(10_000);
    const message = decodeOne(
      encodeError({ code: ProcessAudioErrorCode.CaptureFailed, hresult: 0, message: longMessage }),
    );
    if (message.type !== MessageType.Error) throw new Error('unexpected type');
    expect(message.payload.message.length).toBeLessThanOrEqual(512);
  });

  it('Stop', () => {
    const message = decodeOne(encodeStop());
    expect(message).toEqual({ type: MessageType.Stop, payload: undefined });
  });

  it('Stopped', () => {
    const message = decodeOne(encodeStopped());
    expect(message).toEqual({ type: MessageType.Stopped, payload: undefined });
  });
});

describe('FrameDecoder byte-stream reassembly', () => {
  it('decodes multiple frames delivered coalesced in a single chunk', () => {
    const decoder = new FrameDecoder();
    const combined = new Uint8Array([
      ...encodeReady(1),
      ...encodeTargetEnded(),
      ...encodeStopped(),
    ]);
    const messages = decoder.push(combined);
    expect(messages.map((m) => m.type)).toEqual([
      MessageType.Ready,
      MessageType.TargetEnded,
      MessageType.Stopped,
    ]);
    expect(decoder.bufferedByteCount).toBe(0);
  });

  it('decodes a single frame split across many arbitrary chunk boundaries', () => {
    const decoder = new FrameDecoder();
    const bytes = encodeAudioFrame({ sequence: 99, pcm: new Uint8Array([9, 8, 7, 6, 5, 4, 3]) });
    const collected: ReturnType<FrameDecoder['push']> = [];
    for (let i = 0; i < bytes.length; i += 1) {
      collected.push(...decoder.push(bytes.subarray(i, i + 1)));
    }
    expect(collected).toHaveLength(1);
    expect(collected[0]).toEqual({
      type: MessageType.AudioFrame,
      payload: { sequence: 99, pcm: new Uint8Array([9, 8, 7, 6, 5, 4, 3]) },
    });
  });

  it('buffers a partial frame until the rest arrives, growing bufferedByteCount, then drains it', () => {
    const decoder = new FrameDecoder();
    const bytes = encodeFormat({
      sampleRateHz: 48_000,
      channelCount: 2,
      bitsPerSample: 16,
      isFloat: false,
    });
    const firstHalf = bytes.subarray(0, 3);
    const secondHalf = bytes.subarray(3);

    expect(decoder.push(firstHalf)).toEqual([]);
    expect(decoder.bufferedByteCount).toBe(firstHalf.length);

    const messages = decoder.push(secondHalf);
    expect(messages).toHaveLength(1);
    expect(decoder.bufferedByteCount).toBe(0);
  });

  it('throws ProtocolError and never buffers unboundedly on a declared length exceeding the bound', () => {
    const decoder = new FrameDecoder();
    const header = new Uint8Array(5);
    header[0] = MessageType.AudioFrame;
    const oversized = MAX_FRAME_PAYLOAD_BYTES + 1;
    header[1] = oversized & 0xff;
    header[2] = (oversized >>> 8) & 0xff;
    header[3] = (oversized >>> 16) & 0xff;
    header[4] = (oversized >>> 24) & 0xff;

    expect(() => decoder.push(header)).toThrow(ProtocolError);
  });

  it('throws ProtocolError on an unrecognized message type', () => {
    const decoder = new FrameDecoder();
    const header = new Uint8Array([0xff, 0, 0, 0, 0]);
    expect(() => decoder.push(header)).toThrow(ProtocolError);
  });

  it('throws ProtocolError on a fixed-shape message with trailing bytes', () => {
    const decoder = new FrameDecoder();
    const bytes = encodeStop();
    const withGarbage = new Uint8Array([...bytes]);
    // Stop has no payload, so declaring a length of 1 with a trailing byte violates the fixed shape.
    withGarbage[1] = 1;
    const padded = new Uint8Array([...withGarbage, 0]);
    expect(() => decoder.push(padded)).toThrow(ProtocolError);
  });
});
