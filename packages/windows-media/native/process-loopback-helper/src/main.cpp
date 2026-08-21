// T12 - process-loopback-helper: the out-of-process native half of Windows per-process/game audio
// capture (see docs/adr/0017-windows-process-loopback-native-boundary.md for why this is a separate
// executable rather than an in-process addon, and packages/windows-media/src/process-loopback-supervisor.ts
// for the TypeScript side of this exact protocol).
//
// Process shape, deliberately this way round (do not redesign - see the supervisor's own doc
// comment): this executable is the named-pipe SERVER; the Node/Electron-Main supervisor that spawned
// it is the CLIENT that connects out. This process takes zero argv - every configuration value
// (`OVNICHAT_PIPE_NAME`, `OVNICHAT_HELLO_TOKEN_HEX`) comes only from its own environment block, set by
// the supervisor at spawn time.
//
// Threading model: exactly two threads ever touch the pipe HANDLE.
//   - This control/main thread only ever calls ReadFile (via ReadOneMessage) once capturing hasn't
//     started, and calls WriteFile only when it is guaranteed no other thread is concurrently writing
//     (before a capture thread exists, or after joining one that has fully returned).
//   - The capture thread (audio_capture.cpp), once spawned by a Start message, is the only thread that
//     calls WriteFile for Format/AudioFrame/TargetEnded/Error while it runs; it never calls ReadFile.
// This split means a Stop message can always be read promptly by this thread even while audio is
// streaming, without needing overlapped I/O on this thread.
//
// This process is expected to exit after handling exactly one capture session's worth of work,
// mirroring ProcessLoopbackSupervisor's one-helper-per-session lifecycle.
#include "target_version.h"

#include <windows.h>
#include <objbase.h>
#include <process.h>

#include "audio_capture.h"
#include "audio_enumerate.h"
#include "pipe_io.h"
#include "pipe_security.h"
#include "protocol.h"
#include "util.h"

#include <vector>

using namespace ovnichat;

namespace {

unsigned __stdcall CaptureThreadTrampoline(void* param) {
  RunCaptureThread(static_cast<CaptureThreadContext*>(param));
  return 0;
}

// No connected/authenticated peer to report to yet - exit quietly rather than hang or crash
// silently. Never used after the Hello handshake has succeeded.
[[noreturn]] void FailStartup() { ExitProcess(1); }

} // namespace

int main() {
  auto pipeNameOpt = GetEnvVar(L"OVNICHAT_PIPE_NAME");
  auto tokenHexOpt = GetEnvVar(L"OVNICHAT_HELLO_TOKEN_HEX");
  if (!pipeNameOpt || !tokenHexOpt) FailStartup();

  auto tokenBytesOpt = HexDecode(WideToUtf8(*tokenHexOpt));
  if (!tokenBytesOpt || tokenBytesOpt->size() != kTokenLengthBytes) FailStartup();
  const std::vector<uint8_t> expectedToken = *tokenBytesOpt;

  std::string pipeCreateError;
  HANDLE pipe = CreateSecuredNamedPipe(*pipeNameOpt, &pipeCreateError);
  if (pipe == INVALID_HANDLE_VALUE) FailStartup();

  if (!WaitForClientConnection(pipe)) {
    CloseHandle(pipe);
    FailStartup();
  }

  // --- Hello handshake: the only client-initiated message this helper ever accepts before it has
  // proven the connecting peer holds the same per-launch token this helper was given at spawn time.
  std::optional<RawMessage> first;
  try {
    first = ReadOneMessage(pipe);
  } catch (const ProtocolError&) {
    CloseHandle(pipe);
    ExitProcess(1);
  }

  if (!first || first->type != MessageType::Hello) {
    // Wrong first message or the peer vanished - refuse silently, no response (never leak that a
    // handshake attempt even reached this far).
    CloseHandle(pipe);
    ExitProcess(1);
  }

  bool tokenOk = false;
  try {
    std::vector<uint8_t> receivedToken = DecodeHelloToken(first->payload.data(), first->payload.size());
    tokenOk = receivedToken.size() == expectedToken.size() &&
              ConstantTimeEquals(receivedToken.data(), expectedToken.data(), expectedToken.size());
  } catch (const ProtocolError&) {
    tokenOk = false;
  }

  if (!tokenOk) {
    // An unauthenticated peer gets nothing - not even an Error message (T12 spec, mandatory).
    CloseHandle(pipe);
    ExitProcess(1);
  }

  if (!WriteFramed(pipe, EncodeReady(kProtocolVersion))) {
    CloseHandle(pipe);
    ExitProcess(1);
  }

  // --- Post-handshake control loop -------------------------------------------------------------
  CoInitializeEx(nullptr, COINIT_MULTITHREADED); // this thread's own COM apartment, for enumeration.

  const DWORD ownPid = GetCurrentProcessId();
  const DWORD parentPid = GetParentProcessId(ownPid); // best-effort: skip the Electron Main process too.

  HANDLE stopEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  HANDLE captureThread = nullptr;
  CaptureThreadContext captureCtx;
  bool capturing = false;

  for (;;) {
    std::optional<RawMessage> msg;
    try {
      msg = ReadOneMessage(pipe);
    } catch (const ProtocolError& e) {
      if (capturing) {
        SetEvent(stopEvent);
        WaitForSingleObject(captureThread, INFINITE);
      }
      WriteFramed(pipe, EncodeError(ProcessAudioErrorCode::ProtocolViolation, 0, e.what()));
      CloseHandle(pipe);
      ExitProcess(1);
    }

    if (!msg) {
      // Connection lost - nothing left to report to.
      if (capturing) {
        SetEvent(stopEvent);
        WaitForSingleObject(captureThread, INFINITE);
      }
      CloseHandle(pipe);
      ExitProcess(0);
    }

    if (!capturing) {
      if (msg->type == MessageType::EnumerateRequest) {
        std::vector<DWORD> exclude = {ownPid};
        if (parentPid != 0) exclude.push_back(parentPid);
        auto candidates = EnumerateAudioCandidates(exclude);
        if (!WriteFramed(pipe, EncodeEnumerateResponse(candidates))) {
          CloseHandle(pipe);
          ExitProcess(0);
        }
        continue;
      }

      if (msg->type == MessageType::Start) {
        StartPayload start;
        try {
          start = DecodeStart(msg->payload.data(), msg->payload.size());
        } catch (const ProtocolError& e) {
          WriteFramed(pipe, EncodeError(ProcessAudioErrorCode::ProtocolViolation, 0, e.what()));
          CloseHandle(pipe);
          ExitProcess(1);
        }

        captureCtx.pipe = pipe;
        captureCtx.targetProcessId = start.targetProcessId;
        captureCtx.includeProcessTree = start.includeProcessTree;
        captureCtx.expectedExeNameUtf8 = start.expectedExeNameUtf8;
        captureCtx.stopEvent = stopEvent;
        ResetEvent(stopEvent);

        captureThread = reinterpret_cast<HANDLE>(
            _beginthreadex(nullptr, 0, CaptureThreadTrampoline, &captureCtx, 0, nullptr));
        if (!captureThread) {
          WriteFramed(pipe, EncodeError(ProcessAudioErrorCode::CaptureFailed,
                                         HRESULT_FROM_WIN32(GetLastError()),
                                         "Failed to start the capture thread"));
          CloseHandle(pipe);
          ExitProcess(1);
        }
        capturing = true;
        continue;
      }

      if (msg->type == MessageType::Stop) {
        // Nothing was capturing yet - "stop the current capture (if any) and exit" still applies.
        WriteFramed(pipe, EncodeStopped());
        CloseHandle(pipe);
        ExitProcess(0);
      }

      WriteFramed(pipe, EncodeError(ProcessAudioErrorCode::ProtocolViolation, 0,
                                     "Unexpected message type before Start"));
      CloseHandle(pipe);
      ExitProcess(1);
    }

    // Capturing: the capture thread may already have terminated the whole process itself for a
    // self-detected terminal condition (TargetEnded/Error) by the time control flow reaches here -
    // in that case none of the following ever executes.
    if (msg->type == MessageType::Stop) {
      SetEvent(stopEvent);
      WaitForSingleObject(captureThread, INFINITE);
      CloseHandle(captureThread);
      WriteFramed(pipe, EncodeStopped());
      CloseHandle(pipe);
      ExitProcess(0);
    }

    SetEvent(stopEvent);
    WaitForSingleObject(captureThread, INFINITE);
    WriteFramed(pipe, EncodeError(ProcessAudioErrorCode::ProtocolViolation, 0,
                                   "Unexpected message type during capture"));
    CloseHandle(pipe);
    ExitProcess(1);
  }
}
