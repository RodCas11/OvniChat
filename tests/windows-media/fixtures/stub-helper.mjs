// Test-only stand-in for the not-yet-built native process-loopback helper. Deliberately plain JS
// (no TypeScript, no build step) so it can be spawned directly as a child process by
// ProcessLoopbackSupervisor's tests without any prior `pnpm build` of packages/windows-media — it
// hand-encodes the exact wire format `packages/windows-media/src/protocol.ts` defines, rather than
// importing that module, precisely to avoid that build-order coupling in a test fixture.
//
// Behavior is selected via STUB_MODE (default "normal"):
//   normal              - real Hello/Ready handshake, then answers EnumerateRequest/Start/Stop.
//   silent              - accepts the connection but never responds (handshake-timeout test).
//   close-before-ready  - destroys the connection immediately after accepting it, before Hello even
//                         arrives (simulates a helper that rejects the connecting party).
//   exit-after-ready    - completes the handshake, then exits non-zero without being asked to stop
//                         (simulates a native crash mid-session).
//   echo-start-exe      - like "normal", but decodes the real `expectedExeName` field out of the
//                         Start payload it receives and echoes it back as the `displayTitle` of a
//                         single synthetic EnumerateResponse candidate (pid 999) sent right after
//                         Format — proving `ProcessLoopbackSupervisor.startCapture(pid, exeName)`
//                         genuinely serializes and transmits the caller's `exeName` argument onto
//                         the wire (via the real `encodeStart`), not merely that *some* Start frame
//                         triggers a response (see this task's own T12 TOCTOU security fix: the
//                         native helper cross-checks this exact field against the resolved PID's
//                         real exe name before activation).
import net from 'node:net';

const MessageType = {
  Hello: 0x01,
  Ready: 0x02,
  EnumerateRequest: 0x03,
  EnumerateResponse: 0x04,
  Start: 0x05,
  Format: 0x06,
  AudioFrame: 0x07,
  TargetEnded: 0x08,
  Error: 0x09,
  Stop: 0x0a,
  Stopped: 0x0b,
};

function frame(type, payload) {
  const header = Buffer.alloc(5);
  header.writeUInt8(type, 0);
  header.writeUInt32LE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

function encodeReady(protocolVersion) {
  return frame(MessageType.Ready, Buffer.from([protocolVersion]));
}

function encodeEnumerateResponse(candidates) {
  const parts = [Buffer.alloc(2)];
  parts[0].writeUInt16LE(candidates.length, 0);
  for (const c of candidates) {
    const pid = Buffer.alloc(4);
    pid.writeUInt32LE(c.pid, 0);
    const exeName = Buffer.from(c.exeName, 'utf8');
    const exeNameLen = Buffer.alloc(2);
    exeNameLen.writeUInt16LE(exeName.length, 0);
    const displayTitle = Buffer.from(c.displayTitle, 'utf8');
    const displayTitleLen = Buffer.alloc(1);
    displayTitleLen.writeUInt8(displayTitle.length, 0);
    parts.push(pid, exeNameLen, exeName, displayTitleLen, displayTitle);
  }
  return frame(MessageType.EnumerateResponse, Buffer.concat(parts));
}

function encodeFormat({ sampleRateHz, channelCount, bitsPerSample, isFloat }) {
  const payload = Buffer.alloc(7);
  payload.writeUInt32LE(sampleRateHz, 0);
  payload.writeUInt8(channelCount, 4);
  payload.writeUInt8(bitsPerSample, 5);
  payload.writeUInt8(isFloat ? 1 : 0, 6);
  return frame(MessageType.Format, payload);
}

function encodeAudioFrame(sequence, pcm) {
  const seq = Buffer.alloc(4);
  seq.writeUInt32LE(sequence, 0);
  return frame(MessageType.AudioFrame, Buffer.concat([seq, pcm]));
}

function encodeStopped() {
  return frame(MessageType.Stopped, Buffer.alloc(0));
}

const mode = process.env.STUB_MODE ?? 'normal';
const pipeName = process.env.OVNICHAT_PIPE_NAME;
if (!pipeName) throw new Error('OVNICHAT_PIPE_NAME not set');

const server = net.createServer((socket) => {
  server.close();

  if (mode === 'close-before-ready') {
    socket.destroy();
    return;
  }
  if (mode === 'silent') {
    return; // accept and do nothing
  }

  let receivedHello = false;
  let buffer = Buffer.alloc(0);

  socket.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 5) return;
      const type = buffer.readUInt8(0);
      const length = buffer.readUInt32LE(1);
      if (buffer.length < 5 + length) return;
      // Normally this stub never needs to inspect a payload's contents (not even Hello's token or
      // Start's targetProcessId) — every response is fixed, keyed only on message type. The one
      // exception is `echo-start-exe` mode below, which decodes Start's own `expectedExeName` field
      // to prove the supervisor actually put it on the wire (see this file's own top-of-file doc
      // comment for why).
      const payload = buffer.subarray(5, 5 + length);
      buffer = buffer.subarray(5 + length);

      if (!receivedHello) {
        if (type !== MessageType.Hello) {
          socket.destroy();
          return;
        }
        receivedHello = true;
        socket.write(encodeReady(1));
        if (mode === 'exit-after-ready') {
          setTimeout(() => process.exit(7), 20);
        }
        continue;
      }

      if (type === MessageType.EnumerateRequest) {
        socket.write(
          encodeEnumerateResponse([
            { pid: 111, exeName: 'game.exe', displayTitle: 'Test Game' },
            { pid: 222, exeName: 'other.exe', displayTitle: '' },
          ]),
        );
      } else if (type === MessageType.Start) {
        socket.write(
          encodeFormat({ sampleRateHz: 48000, channelCount: 2, bitsPerSample: 16, isFloat: false }),
        );
        if (mode === 'echo-start-exe') {
          // Decode Start's payload: u32 targetProcessId, u8 includeProcessTree, then a string16
          // (u16 length-prefix + utf8 bytes) expectedExeName — see `protocol.ts`'s `encodeStart`/
          // `decodePayload(MessageType.Start)` for the authoritative wire shape this mirrors.
          const exeNameLen = payload.readUInt16LE(5);
          const exeName = payload.subarray(7, 7 + exeNameLen).toString('utf8');
          socket.write(
            encodeEnumerateResponse([{ pid: 999, exeName: 'echo.exe', displayTitle: exeName }]),
          );
        }
        for (let i = 0; i < 3; i += 1) {
          socket.write(encodeAudioFrame(i, Buffer.from([1, 2, 3, 4])));
        }
      } else if (type === MessageType.Stop) {
        socket.write(encodeStopped());
        setTimeout(() => process.exit(0), 20);
      }
    }
  });
});

server.listen(pipeName);
