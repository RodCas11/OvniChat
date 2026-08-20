#include "pipe_io.h"

namespace ovnichat {

namespace {

// Performs one overlapped ReadFile/WriteFile call and blocks the CALLING thread (only) until it
// completes, via a throwaway per-call event - see pipe_io.h's top comment for why this must be
// overlapped rather than a plain synchronous call. Returns false on any failure (including a
// broken/closed pipe); `*outTransferred` is only meaningful when this returns true.
bool DoOverlappedIo(HANDLE pipe, bool isRead, void* buf, DWORD len, DWORD* outTransferred) {
  OVERLAPPED ov = {};
  ov.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!ov.hEvent) return false;

  BOOL immediate = isRead ? ReadFile(pipe, buf, len, nullptr, &ov) : WriteFile(pipe, buf, len, nullptr, &ov);
  if (!immediate && GetLastError() != ERROR_IO_PENDING) {
    CloseHandle(ov.hEvent);
    return false;
  }

  DWORD transferred = 0;
  BOOL ok = GetOverlappedResult(pipe, &ov, &transferred, TRUE /* block this thread until done */);
  CloseHandle(ov.hEvent);
  if (!ok) return false;

  *outTransferred = transferred;
  return true;
}

// Reads exactly `len` bytes into `out`. Returns false on any short read caused by a broken/closed pipe.
bool ReadExact(HANDLE pipe, uint8_t* out, size_t len) {
  size_t total = 0;
  while (total < len) {
    DWORD chunk = 0;
    if (!DoOverlappedIo(pipe, true, out + total, static_cast<DWORD>(len - total), &chunk)) return false;
    if (chunk == 0) return false;
    total += chunk;
  }
  return true;
}

} // namespace

bool WaitForClientConnection(HANDLE pipe) {
  OVERLAPPED ov = {};
  ov.hEvent = CreateEventW(nullptr, TRUE, FALSE, nullptr);
  if (!ov.hEvent) return false;

  BOOL ok = ConnectNamedPipe(pipe, &ov);
  if (ok) {
    // Not expected for an overlapped handle per docs, but handle defensively.
    CloseHandle(ov.hEvent);
    return true;
  }

  DWORD err = GetLastError();
  if (err == ERROR_PIPE_CONNECTED) {
    CloseHandle(ov.hEvent);
    return true;
  }
  if (err != ERROR_IO_PENDING) {
    CloseHandle(ov.hEvent);
    return false;
  }

  DWORD transferred = 0;
  BOOL done = GetOverlappedResult(pipe, &ov, &transferred, TRUE);
  CloseHandle(ov.hEvent);
  return done != FALSE;
}

std::optional<RawMessage> ReadOneMessage(HANDLE pipe) {
  uint8_t header[kFrameHeaderBytes];
  if (!ReadExact(pipe, header, kFrameHeaderBytes)) return std::nullopt;

  MessageType type = static_cast<MessageType>(header[0]);
  uint32_t length = static_cast<uint32_t>(header[1]) | (static_cast<uint32_t>(header[2]) << 8) |
                     (static_cast<uint32_t>(header[3]) << 16) | (static_cast<uint32_t>(header[4]) << 24);
  if (length > kMaxFramePayloadBytes) {
    throw ProtocolError("Peer declared an oversized frame length");
  }

  RawMessage msg;
  msg.type = type;
  msg.payload.resize(length);
  if (length > 0 && !ReadExact(pipe, msg.payload.data(), length)) return std::nullopt;
  return msg;
}

bool WriteFramed(HANDLE pipe, const std::vector<uint8_t>& framedMessage) {
  size_t total = 0;
  while (total < framedMessage.size()) {
    DWORD chunk = 0;
    if (!DoOverlappedIo(pipe, false, const_cast<uint8_t*>(framedMessage.data() + total),
                         static_cast<DWORD>(framedMessage.size() - total), &chunk)) {
      return false;
    }
    total += chunk;
  }
  return true;
}

} // namespace ovnichat
