// T12 - framed message I/O helpers over the named pipe HANDLE.
//
// The pipe is created WITH FILE_FLAG_OVERLAPPED (see pipe_security.cpp) and every call here issues
// its own throwaway OVERLAPPED+event and blocks (via GetOverlappedResult's bWait=TRUE) only the
// calling thread until that one operation completes. This is deliberate and load-bearing, not
// incidental: a *synchronous* (non-overlapped) named pipe handle serializes I/O per kernel driver
// instance, so a control thread blocked in a synchronous ReadFile (waiting for the next client
// message) would also block a *different* thread's WriteFile on the very same handle until that read
// completes - confirmed empirically during this task's own real end-to-end smoke test, where the
// capture thread's first WriteFile (the Format message) hung indefinitely while the control thread's
// ReadFile sat waiting for a Stop message that hadn't been sent yet. Overlapped mode removes that
// cross-thread serialization while still letting each call here behave synchronously from its own
// thread's point of view - exactly the "one reader thread, one writer thread, both blocking calls"
// model main.cpp's top-of-file comment describes.
#pragma once

#include "protocol.h"
#include "target_version.h"

#include <windows.h>

#include <optional>

namespace ovnichat {

struct RawMessage {
  MessageType type;
  std::vector<uint8_t> payload;
};

// Blocks the calling thread until a client connects (or the pipe is broken). Returns false on
// failure - the caller should treat that as fatal for this pipe instance.
bool WaitForClientConnection(HANDLE pipe);

// Reads exactly one framed message from the pipe. Returns std::nullopt if the pipe was closed/broken
// before a complete message arrived (never partial garbage). Throws ProtocolError for a
// protocol-level violation (oversized declared length).
std::optional<RawMessage> ReadOneMessage(HANDLE pipe);

// Writes a fully-framed message (as produced by protocol.h's Encode* functions) to the pipe. Returns
// false if the write failed (broken pipe) - callers should treat that as "the peer is gone", not throw.
bool WriteFramed(HANDLE pipe, const std::vector<uint8_t>& framedMessage);

} // namespace ovnichat
