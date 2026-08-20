// T12 - C++ mirror of packages/windows-media/src/protocol.ts's wire format.
//
// This is the ONE source of truth for the byte layout on the TypeScript side; this file must stay
// byte-for-byte compatible with it. Do not invent new message types or change field order/width here
// - if the protocol can't express something this helper needs, that is a signal to stop and report
// back, not to diverge silently (see the T12 task brief).
//
// Wire format for every message: [type: u8][length: u32 LE][payload: length bytes], length bounded by
// kMaxFramePayloadBytes so a malformed peer can never make either side buffer without limit.
#pragma once

#include "target_version.h"

#include <windows.h>

#include <cstdint>
#include <stdexcept>
#include <string>
#include <vector>

namespace ovnichat {

constexpr uint8_t kProtocolVersion = 1;
constexpr uint32_t kMaxFramePayloadBytes = 262144; // 256 KiB - mirrors protocol.ts's MAX_FRAME_PAYLOAD_BYTES.
constexpr size_t kFrameHeaderBytes = 5;
constexpr size_t kTokenLengthBytes = 32;
constexpr size_t kMaxExeNameBytes = 260; // MAX_PATH
constexpr size_t kMaxDisplayTitleBytes = 128;
constexpr size_t kMaxErrorMessageBytes = 512;
constexpr size_t kMaxEnumerateCandidates = 256;

enum class MessageType : uint8_t {
  Hello = 0x01,
  Ready = 0x02,
  EnumerateRequest = 0x03,
  EnumerateResponse = 0x04,
  Start = 0x05,
  Format = 0x06,
  AudioFrame = 0x07,
  TargetEnded = 0x08,
  Error = 0x09,
  Stop = 0x0a,
  Stopped = 0x0b,
};

// Mirrors protocol.ts's ProcessAudioErrorCode enum exactly (values and meaning).
enum class ProcessAudioErrorCode : uint32_t {
  TargetNotFound = 1,
  ActivationFailed = 2,
  AccessDenied = 3,
  UnsupportedPlatform = 4,
  CaptureFailed = 5,
  ProtocolViolation = 6,
};

class ProtocolError : public std::runtime_error {
 public:
  explicit ProtocolError(const std::string& message) : std::runtime_error(message) {}
};

struct ProcessCandidate {
  uint32_t pid = 0;
  std::string exeNameUtf8;    // basename only, never a full path.
  std::string displayTitleUtf8; // best-effort, empty string when unavailable - never fabricated.
};

struct StartPayload {
  uint32_t targetProcessId = 0;
  bool includeProcessTree = true;
};

struct FormatPayload {
  uint32_t sampleRateHz = 0;
  uint8_t channelCount = 0;
  uint8_t bitsPerSample = 0;
  bool isFloat = false;
};

// --- Small byte writer/reader, mirroring protocol.ts's Writer/Reader --------------------------

class ByteWriter {
 public:
  void U8(uint8_t value) { buf_.push_back(value); }
  void U16(uint16_t value) {
    buf_.push_back(static_cast<uint8_t>(value & 0xff));
    buf_.push_back(static_cast<uint8_t>((value >> 8) & 0xff));
  }
  void U32(uint32_t value) {
    buf_.push_back(static_cast<uint8_t>(value & 0xff));
    buf_.push_back(static_cast<uint8_t>((value >> 8) & 0xff));
    buf_.push_back(static_cast<uint8_t>((value >> 16) & 0xff));
    buf_.push_back(static_cast<uint8_t>((value >> 24) & 0xff));
  }
  void I32(int32_t value) { U32(static_cast<uint32_t>(value)); }
  void Bytes(const uint8_t* data, size_t len) { buf_.insert(buf_.end(), data, data + len); }
  void Bytes(const std::vector<uint8_t>& data) { Bytes(data.data(), data.size()); }
  // UTF-8 string prefixed by its own byte length (u16). Caller must have already bounded `value`.
  void String16(const std::string& value) {
    U16(static_cast<uint16_t>(value.size()));
    Bytes(reinterpret_cast<const uint8_t*>(value.data()), value.size());
  }
  // UTF-8 string prefixed by its own byte length (u8). Caller must have already bounded `value`.
  void String8(const std::string& value) {
    U8(static_cast<uint8_t>(value.size()));
    Bytes(reinterpret_cast<const uint8_t*>(value.data()), value.size());
  }
  const std::vector<uint8_t>& data() const { return buf_; }

 private:
  std::vector<uint8_t> buf_;
};

class ByteReader {
 public:
  ByteReader(const uint8_t* data, size_t len) : data_(data), len_(len) {}

  uint8_t U8() {
    Require(1);
    return data_[offset_++];
  }
  uint16_t U16() {
    Require(2);
    uint16_t v = static_cast<uint16_t>(data_[offset_] | (data_[offset_ + 1] << 8));
    offset_ += 2;
    return v;
  }
  uint32_t U32() {
    Require(4);
    uint32_t v = static_cast<uint32_t>(data_[offset_]) | (static_cast<uint32_t>(data_[offset_ + 1]) << 8) |
                 (static_cast<uint32_t>(data_[offset_ + 2]) << 16) |
                 (static_cast<uint32_t>(data_[offset_ + 3]) << 24);
    offset_ += 4;
    return v;
  }
  const uint8_t* Bytes(size_t count) {
    Require(count);
    const uint8_t* p = data_ + offset_;
    offset_ += count;
    return p;
  }
  std::string String16() {
    uint16_t len = U16();
    const uint8_t* p = Bytes(len);
    return std::string(reinterpret_cast<const char*>(p), len);
  }
  std::string String8() {
    uint8_t len = U8();
    const uint8_t* p = Bytes(len);
    return std::string(reinterpret_cast<const char*>(p), len);
  }
  size_t Remaining() const { return len_ - offset_; }
  const uint8_t* RemainingPtr() const { return data_ + offset_; }
  void AssertExhausted() const {
    if (offset_ != len_) throw ProtocolError("Message payload had trailing bytes after decoding");
  }

 private:
  void Require(size_t count) const {
    if (offset_ + count > len_) throw ProtocolError("Message payload ended before an expected field");
  }
  const uint8_t* data_;
  size_t len_;
  size_t offset_ = 0;
};

// --- Framing -------------------------------------------------------------------------------

// Truncates a UTF-8 string to at most maxBytes bytes (byte-wise, matching protocol.ts's own
// truncateUtf8 - does not special-case multi-byte codepoint boundaries).
std::string TruncateUtf8(const std::string& value, size_t maxBytes);

std::vector<uint8_t> Frame(MessageType type, const std::vector<uint8_t>& payload);

std::vector<uint8_t> EncodeReady(uint8_t protocolVersion);
std::vector<uint8_t> EncodeEnumerateResponse(const std::vector<ProcessCandidate>& candidates);
std::vector<uint8_t> EncodeFormat(const FormatPayload& payload);
std::vector<uint8_t> EncodeAudioFrame(uint32_t sequence, const uint8_t* pcm, size_t pcmLen);
std::vector<uint8_t> EncodeTargetEnded();
std::vector<uint8_t> EncodeError(ProcessAudioErrorCode code, int32_t hresult, const std::string& message);
std::vector<uint8_t> EncodeStopped();

// Decodes a Hello payload (already length-delimited); throws ProtocolError if malformed.
std::vector<uint8_t> DecodeHelloToken(const uint8_t* payload, size_t len);
// Decodes a Start payload (already length-delimited); throws ProtocolError if malformed.
StartPayload DecodeStart(const uint8_t* payload, size_t len);

} // namespace ovnichat
