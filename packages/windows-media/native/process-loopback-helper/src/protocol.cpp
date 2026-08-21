#include "protocol.h"

namespace ovnichat {

std::string TruncateUtf8(const std::string& value, size_t maxBytes) {
  if (value.size() <= maxBytes) return value;
  return value.substr(0, maxBytes);
}

std::vector<uint8_t> Frame(MessageType type, const std::vector<uint8_t>& payload) {
  if (payload.size() > kMaxFramePayloadBytes) {
    throw ProtocolError("Refusing to encode an oversized payload");
  }
  std::vector<uint8_t> out;
  out.reserve(kFrameHeaderBytes + payload.size());
  out.push_back(static_cast<uint8_t>(type));
  uint32_t len = static_cast<uint32_t>(payload.size());
  out.push_back(static_cast<uint8_t>(len & 0xff));
  out.push_back(static_cast<uint8_t>((len >> 8) & 0xff));
  out.push_back(static_cast<uint8_t>((len >> 16) & 0xff));
  out.push_back(static_cast<uint8_t>((len >> 24) & 0xff));
  out.insert(out.end(), payload.begin(), payload.end());
  return out;
}

std::vector<uint8_t> EncodeReady(uint8_t protocolVersion) {
  ByteWriter w;
  w.U8(protocolVersion);
  return Frame(MessageType::Ready, w.data());
}

std::vector<uint8_t> EncodeEnumerateResponse(const std::vector<ProcessCandidate>& candidates) {
  ByteWriter w;
  size_t count = candidates.size();
  if (count > kMaxEnumerateCandidates) count = kMaxEnumerateCandidates;
  w.U16(static_cast<uint16_t>(count));
  for (size_t i = 0; i < count; ++i) {
    const ProcessCandidate& c = candidates[i];
    std::string exeName = TruncateUtf8(c.exeNameUtf8, kMaxExeNameBytes);
    std::string displayTitle = TruncateUtf8(c.displayTitleUtf8, kMaxDisplayTitleBytes);
    w.U32(c.pid);
    w.String16(exeName);
    w.String8(displayTitle);
  }
  return Frame(MessageType::EnumerateResponse, w.data());
}

std::vector<uint8_t> EncodeFormat(const FormatPayload& payload) {
  ByteWriter w;
  w.U32(payload.sampleRateHz);
  w.U8(payload.channelCount);
  w.U8(payload.bitsPerSample);
  w.U8(payload.isFloat ? 1 : 0);
  return Frame(MessageType::Format, w.data());
}

std::vector<uint8_t> EncodeAudioFrame(uint32_t sequence, const uint8_t* pcm, size_t pcmLen) {
  ByteWriter w;
  w.U32(sequence);
  w.Bytes(pcm, pcmLen);
  return Frame(MessageType::AudioFrame, w.data());
}

std::vector<uint8_t> EncodeTargetEnded() { return Frame(MessageType::TargetEnded, {}); }

std::vector<uint8_t> EncodeError(ProcessAudioErrorCode code, int32_t hresult, const std::string& message) {
  ByteWriter w;
  std::string msg = TruncateUtf8(message, kMaxErrorMessageBytes);
  w.U32(static_cast<uint32_t>(code));
  w.I32(hresult);
  w.String16(msg);
  return Frame(MessageType::Error, w.data());
}

std::vector<uint8_t> EncodeStopped() { return Frame(MessageType::Stopped, {}); }

std::vector<uint8_t> DecodeHelloToken(const uint8_t* payload, size_t len) {
  if (len != kTokenLengthBytes) throw ProtocolError("Hello payload has the wrong length");
  return std::vector<uint8_t>(payload, payload + len);
}

StartPayload DecodeStart(const uint8_t* payload, size_t len) {
  ByteReader r(payload, len);
  StartPayload out;
  out.targetProcessId = r.U32();
  out.includeProcessTree = r.U8() != 0;
  out.expectedExeNameUtf8 = r.String16();
  r.AssertExhausted();
  return out;
}

} // namespace ovnichat
