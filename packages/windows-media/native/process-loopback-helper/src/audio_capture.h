// T12 - drives one process-loopback capture session end to end: dynamic ActivateAudioInterfaceAsync
// resolution (so an unsupported OS fails gracefully instead of failing to load), IAudioClient
// initialization, the PID-reuse-safe target-process watch, and the Format/AudioFrame/TargetEnded/Error
// streaming loop. Runs entirely on a background thread spawned by main.cpp; writes directly to the
// pipe HANDLE it is given (see pipe_io.h's concurrency contract).
#pragma once

#include "protocol.h"
#include "target_version.h"

#include <windows.h>

#include <string>

namespace ovnichat {

struct CaptureThreadContext {
  HANDLE pipe = nullptr;
  DWORD targetProcessId = 0;
  bool includeProcessTree = true;
  // Exe basename the caller expects targetProcessId to still resolve to at Start-time (see
  // protocol.h's StartPayload.expectedExeNameUtf8) - cross-checked against the actual resolved exe
  // basename immediately after OpenProcess succeeds, closing the PID-reuse TOCTOU window between
  // enumeration and Start. Compared case-insensitively.
  std::string expectedExeNameUtf8;
  // Set by the control thread when it receives Stop; the capture thread polls this at every wait
  // point and, if set, returns quietly without writing anything further (the control thread owns
  // writing Stopped once it has joined this thread) - see main.cpp's top-of-file comment.
  HANDLE stopEvent = nullptr;
};

// Thread entry point (matches Windows' unsigned(__stdcall*)(void*) shape via a thin wrapper in
// main.cpp). Never returns a value the caller needs; all outcomes are communicated over the pipe or
// by the process exiting.
void RunCaptureThread(CaptureThreadContext* ctx);

} // namespace ovnichat
