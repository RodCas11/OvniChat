#include "audio_capture.h"
#include "pipe_io.h"
#include "util.h"

#include <objbase.h>
#include <objidl.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audioclientactivationparams.h>

#include <algorithm>
#include <vector>

namespace ovnichat {

namespace {

// --- IActivateAudioInterfaceCompletionHandler implementation --------------------------------
//
// ActivateAudioInterfaceAsync delivers its result on a threadpool thread via this callback, signaled
// through a manual-reset event so the capture thread can wait on it alongside the target-process
// handle and the stop event (T12's PID-reuse-safety requirement: never blindly wait on activation
// alone without also watching for the target dying mid-activation).
//
// This handler must be agile / free-threaded: without answering QueryInterface for IAgileObject (or,
// as a fallback, IMarshal via an aggregated free-threaded marshaler), ActivateAudioInterfaceAsync
// fails synchronously with E_ILLEGAL_METHOD_CALL (0x8000000E) before activation ever starts -
// confirmed empirically against this exact handler during this task's real-hardware end-to-end smoke
// test (see the T12 handoff report for the failure/fix trail). IAgileObject is the primary, cheaper
// check modern (Windows 8+) COM/WinRT-adjacent APIs like this one make first; the free-threaded
// marshaler is kept as defense in depth for any caller that instead falls back to IMarshal.
class ActivationCompletionHandler : public IActivateAudioInterfaceCompletionHandler {
 public:
  ActivationCompletionHandler() : refCount_(1) {
    event_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    CoCreateFreeThreadedMarshaler(static_cast<IActivateAudioInterfaceCompletionHandler*>(this), &marshaler_);
  }

  HANDLE Event() const { return event_; }
  HRESULT Result() const { return activateResult_; }
  // Transfers ownership of the activated interface pointer (already AddRef'd by the runtime) to the
  // caller; returns nullptr if activation failed or this was already taken.
  IUnknown* TakeInterface() {
    IUnknown* p = activatedInterface_;
    activatedInterface_ = nullptr;
    return p;
  }

  HRESULT __stdcall QueryInterface(REFIID riid, void** ppv) override {
    if (!ppv) return E_POINTER;
    if (riid == __uuidof(IUnknown) || riid == __uuidof(IActivateAudioInterfaceCompletionHandler)) {
      *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }
    if (riid == __uuidof(IAgileObject)) {
      // IAgileObject adds zero vtable methods beyond IUnknown (a pure marker interface) - any of our
      // own interface pointers already satisfies its ABI shape.
      *ppv = static_cast<IActivateAudioInterfaceCompletionHandler*>(this);
      AddRef();
      return S_OK;
    }
    if (riid == __uuidof(IMarshal) && marshaler_) {
      return marshaler_->QueryInterface(riid, ppv);
    }
    *ppv = nullptr;
    return E_NOINTERFACE;
  }
  ULONG __stdcall AddRef() override { return static_cast<ULONG>(InterlockedIncrement(&refCount_)); }
  ULONG __stdcall Release() override {
    LONG r = InterlockedDecrement(&refCount_);
    if (r == 0) {
      if (event_) CloseHandle(event_);
      if (marshaler_) marshaler_->Release();
      delete this;
    }
    return static_cast<ULONG>(r);
  }

  HRESULT __stdcall ActivateCompleted(IActivateAudioInterfaceAsyncOperation* operation) override {
    HRESULT activateResult = E_FAIL;
    IUnknown* iface = nullptr;
    HRESULT hr = operation ? operation->GetActivateResult(&activateResult, &iface) : E_POINTER;
    activateResult_ = SUCCEEDED(hr) ? activateResult : hr;
    activatedInterface_ = SUCCEEDED(hr) ? iface : nullptr;
    SetEvent(event_);
    return S_OK;
  }

 private:
  volatile LONG refCount_;
  HANDLE event_ = nullptr;
  IUnknown* marshaler_ = nullptr; // aggregated free-threaded marshaler (IMarshal delegate only).
  HRESULT activateResult_ = E_FAIL;
  IUnknown* activatedInterface_ = nullptr;
};

typedef HRESULT(WINAPI* ActivateAudioInterfaceAsyncFn)(
    LPCWSTR deviceInterfacePath, REFIID riid, PROPVARIANT* activationParams,
    IActivateAudioInterfaceCompletionHandler* completionHandler,
    IActivateAudioInterfaceAsyncOperation** activationOperation);

ProcessAudioErrorCode MapPreCaptureHresult(HRESULT hr) {
  if (hr == E_ACCESSDENIED) return ProcessAudioErrorCode::AccessDenied;
  return ProcessAudioErrorCode::ActivationFailed;
}

void SendError(HANDLE pipe, ProcessAudioErrorCode code, HRESULT hresult, const char* message) {
  WriteFramed(pipe, EncodeError(code, static_cast<int32_t>(hresult), message));
}

enum class PumpResult { Ok, CaptureFailed, PipeBroken };

// Drains every currently-available WASAPI packet, writing each as one or more (bounds-checked)
// AudioFrame messages, and releases every buffer it acquires - a mismatched GetBuffer/ReleaseBuffer
// pair would stall the shared audio engine for every other client on the same endpoint, not just this
// one, so every return path below releases before returning.
PumpResult PumpAvailablePackets(IAudioCaptureClient* captureClient, HANDLE pipe, UINT32 blockAlign,
                                 uint32_t* sequence, HRESULT* outHr) {
  for (;;) {
    UINT32 packetFrames = 0;
    HRESULT nph = captureClient->GetNextPacketSize(&packetFrames);
    if (FAILED(nph)) {
      *outHr = nph;
      return PumpResult::CaptureFailed;
    }
    if (packetFrames == 0) return PumpResult::Ok;

    BYTE* data = nullptr;
    UINT32 framesAvailable = 0;
    DWORD flags = 0;
    HRESULT gb = captureClient->GetBuffer(&data, &framesAvailable, &flags, nullptr, nullptr);
    if (FAILED(gb)) {
      *outHr = gb;
      return PumpResult::CaptureFailed;
    }

    size_t byteLen = static_cast<size_t>(framesAvailable) * blockAlign;
    std::vector<uint8_t> zeroBuf;
    const uint8_t* src = reinterpret_cast<const uint8_t*>(data);
    // AUDCLNT_BUFFERFLAGS_SILENT: the buffer's content is not meaningful - synthesize real zeros
    // rather than trust `data` to point at valid silence, per Microsoft's own documented caveat.
    if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0) {
      zeroBuf.assign(byteLen, 0);
      src = zeroBuf.data();
    }

    bool pipeOk = true;
    const size_t maxChunk = kMaxFramePayloadBytes - 4; // 4 bytes reserved for the sequence field.
    size_t offset = 0;
    do {
      size_t chunk = (std::min)(maxChunk, byteLen - offset);
      auto framed = EncodeAudioFrame((*sequence)++, src + offset, chunk);
      if (!WriteFramed(pipe, framed)) {
        pipeOk = false;
        break;
      }
      offset += chunk;
    } while (offset < byteLen);

    captureClient->ReleaseBuffer(framesAvailable);
    if (!pipeOk) return PumpResult::PipeBroken;
  }
}

} // namespace

void RunCaptureThread(CaptureThreadContext* ctx) {
  // CoInitializeEx per-thread: this thread never touched COM before (main.cpp's control thread does
  // its own, separate CoInitializeEx for enumeration).
  HRESULT coHr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
  bool needCoUninit = SUCCEEDED(coHr) || coHr == S_FALSE;

  // Resolved dynamically (never a static import) so a pre-20348 OS - which capability.ts's runtime
  // gate should already have refused to spawn this helper for, but defense in depth matters here -
  // fails gracefully with UnsupportedPlatform instead of this executable failing to even load due to
  // a missing DLL export.
  HMODULE mmdevapi = LoadLibraryW(L"mmdevapi.dll");
  ActivateAudioInterfaceAsyncFn activateFn =
      mmdevapi ? reinterpret_cast<ActivateAudioInterfaceAsyncFn>(
                     GetProcAddress(mmdevapi, "ActivateAudioInterfaceAsync"))
               : nullptr;
  if (!activateFn) {
    SendError(ctx->pipe, ProcessAudioErrorCode::UnsupportedPlatform, 0,
              "ActivateAudioInterfaceAsync is not available on this Windows build");
    if (needCoUninit) CoUninitialize();
    ExitProcess(1);
  }

  HANDLE targetProcess =
      OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, ctx->targetProcessId);
  if (!targetProcess) {
    SendError(ctx->pipe, ProcessAudioErrorCode::TargetNotFound,
              HRESULT_FROM_WIN32(GetLastError()), "The target process could not be opened");
    if (needCoUninit) CoUninitialize();
    ExitProcess(1);
  }

  // PID-reuse TOCTOU guard: OpenProcess succeeding above only proves *some* process is currently
  // running as ctx->targetProcessId - it does not by itself prove it is still the same process the
  // caller enumerated and the user selected, which may have exited and had its PID recycled in the
  // (human-decision-time-plus-one-IPC-round-trip) window between EnumerateResponse and this Start
  // being processed. Re-resolve the exe basename for this exact PID now, while the process is
  // provably still alive (this handle is open), and cross-check it against what the caller expects
  // before ever touching activation. A mismatch is treated identically to "the PID did not resolve
  // to a running process" - from the caller's perspective the process it selected is simply gone.
  std::string actualExeName = GetExeBasenameForPid(ctx->targetProcessId);
  if (actualExeName.empty() || !EqualsIgnoreCaseUtf8(actualExeName, ctx->expectedExeNameUtf8)) {
    CloseHandle(targetProcess);
    SendError(ctx->pipe, ProcessAudioErrorCode::TargetNotFound, 0,
              "The target process id no longer matches the process that was selected");
    if (needCoUninit) CoUninitialize();
    ExitProcess(1);
  }

  AUDIOCLIENT_ACTIVATION_PARAMS activationParams = {};
  activationParams.ActivationType = AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK;
  activationParams.ProcessLoopbackParams.TargetProcessId = ctx->targetProcessId;
  activationParams.ProcessLoopbackParams.ProcessLoopbackMode =
      ctx->includeProcessTree ? PROCESS_LOOPBACK_MODE_INCLUDE_TARGET_PROCESS_TREE
                               : PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE;

  PROPVARIANT activationProp;
  PropVariantInit(&activationProp);
  activationProp.vt = VT_BLOB;
  activationProp.blob.cbSize = sizeof(activationParams);
  activationProp.blob.pBlobData = reinterpret_cast<BYTE*>(&activationParams);

  auto* handler = new ActivationCompletionHandler();
  IActivateAudioInterfaceAsyncOperation* asyncOp = nullptr;
  HRESULT hr = activateFn(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, __uuidof(IAudioClient), &activationProp,
                           handler, &asyncOp);
  if (asyncOp) asyncOp->Release();
  if (FAILED(hr)) {
    handler->Release();
    CloseHandle(targetProcess);
    SendError(ctx->pipe, MapPreCaptureHresult(hr), hr, "ActivateAudioInterfaceAsync call failed");
    if (needCoUninit) CoUninitialize();
    ExitProcess(1);
  }

  HANDLE activationWait[] = {handler->Event(), targetProcess, ctx->stopEvent};
  DWORD wr = WaitForMultipleObjects(3, activationWait, FALSE, INFINITE);

  if (wr == WAIT_OBJECT_0 + 2) {
    // Stop arrived before activation finished. We cannot cancel an in-flight
    // ActivateAudioInterfaceAsync call, so wait (bounded) for it to actually complete before letting
    // this thread's resources go out of scope - the control thread is about to ExitProcess() shortly
    // after joining us regardless, so a bounded leak on timeout is harmless.
    DWORD settleWait = WaitForSingleObject(handler->Event(), 2000);
    if (settleWait == WAIT_OBJECT_0) {
      IUnknown* iface = handler->TakeInterface();
      if (iface) iface->Release();
    }
    handler->Release();
    CloseHandle(targetProcess);
    if (needCoUninit) CoUninitialize();
    return; // control thread owns sending Stopped and exiting.
  }

  if (wr == WAIT_OBJECT_0 + 1) {
    // Target process exited before activation ever completed - never got capture running.
    handler->Release();
    CloseHandle(targetProcess);
    SendError(ctx->pipe, ProcessAudioErrorCode::TargetNotFound, 0,
              "Target process exited before activation completed");
    if (needCoUninit) CoUninitialize();
    ExitProcess(1);
  }

  // wr == WAIT_OBJECT_0: activation completed.
  HRESULT activateResult = handler->Result();
  IUnknown* rawIface = handler->TakeInterface();
  handler->Release();

  if (FAILED(activateResult) || !rawIface) {
    if (rawIface) rawIface->Release();
    CloseHandle(targetProcess);
    SendError(ctx->pipe, MapPreCaptureHresult(activateResult), activateResult,
              "Process-loopback activation failed");
    if (needCoUninit) CoUninitialize();
    ExitProcess(1);
  }

  IAudioClient* audioClient = nullptr;
  HRESULT qi = rawIface->QueryInterface(__uuidof(IAudioClient), reinterpret_cast<void**>(&audioClient));
  rawIface->Release();
  if (FAILED(qi) || !audioClient) {
    CloseHandle(targetProcess);
    SendError(ctx->pipe, ProcessAudioErrorCode::ActivationFailed, qi,
              "The activated interface is not an IAudioClient");
    if (needCoUninit) CoUninitialize();
    ExitProcess(1);
  }

  // The virtual process-loopback device exposes no mix format to query (unlike a real render/capture
  // endpoint) - the client must supply one. 48 kHz / stereo / 32-bit IEEE float is the format used by
  // Microsoft's own process-loopback sample and is broadly compatible; whatever WASAPI actually
  // accepts here is what gets reported in the Format message below - this is not assumed in advance
  // by the wire protocol, it is determined by whether Initialize() below succeeds with it. Verified
  // against real process audio on this task's own development machine (see the T12 handoff report).
  WAVEFORMATEX format = {};
  format.wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
  format.nChannels = 2;
  format.nSamplesPerSec = 48000;
  format.wBitsPerSample = 32;
  format.nBlockAlign = static_cast<WORD>(format.nChannels * format.wBitsPerSample / 8);
  format.nAvgBytesPerSec = format.nSamplesPerSec * format.nBlockAlign;
  format.cbSize = 0;

  HRESULT initHr = audioClient->Initialize(AUDCLNT_SHAREMODE_SHARED,
                                            AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
                                            200000 /* 20ms, in 100ns units */, 0, &format, nullptr);
  if (FAILED(initHr)) {
    audioClient->Release();
    CloseHandle(targetProcess);
    SendError(ctx->pipe, MapPreCaptureHresult(initHr), initHr, "IAudioClient::Initialize failed");
    if (needCoUninit) CoUninitialize();
    ExitProcess(1);
  }

  HANDLE bufferEvent = CreateEventW(nullptr, FALSE, FALSE, nullptr);
  HRESULT sehr = audioClient->SetEventHandle(bufferEvent);
  IAudioCaptureClient* captureClient = nullptr;
  HRESULT gsHr = SUCCEEDED(sehr) ? audioClient->GetService(__uuidof(IAudioCaptureClient),
                                                            reinterpret_cast<void**>(&captureClient))
                                  : sehr;
  if (FAILED(sehr) || FAILED(gsHr) || !captureClient) {
    CloseHandle(bufferEvent);
    audioClient->Release();
    CloseHandle(targetProcess);
    SendError(ctx->pipe, ProcessAudioErrorCode::ActivationFailed, FAILED(sehr) ? sehr : gsHr,
              "Failed to obtain the WASAPI capture client");
    if (needCoUninit) CoUninitialize();
    ExitProcess(1);
  }

  HRESULT startHr = audioClient->Start();
  if (FAILED(startHr)) {
    captureClient->Release();
    CloseHandle(bufferEvent);
    audioClient->Release();
    CloseHandle(targetProcess);
    SendError(ctx->pipe, MapPreCaptureHresult(startHr), startHr, "IAudioClient::Start failed");
    if (needCoUninit) CoUninitialize();
    ExitProcess(1);
  }

  FormatPayload formatPayload;
  formatPayload.sampleRateHz = format.nSamplesPerSec;
  formatPayload.channelCount = static_cast<uint8_t>(format.nChannels);
  formatPayload.bitsPerSample = static_cast<uint8_t>(format.wBitsPerSample);
  formatPayload.isFloat = true;
  bool pipeStillOk = WriteFramed(ctx->pipe, EncodeFormat(formatPayload));

  uint32_t sequence = 0;
  bool stoppedByRequest = false;
  bool targetEnded = false;
  bool captureFailed = false;
  HRESULT captureFailHr = S_OK;

  if (pipeStillOk) {
    HANDLE captureWait[] = {bufferEvent, ctx->stopEvent, targetProcess};
    for (;;) {
      DWORD cw = WaitForMultipleObjects(3, captureWait, FALSE, INFINITE);
      if (cw == WAIT_OBJECT_0 + 1) {
        stoppedByRequest = true;
        break;
      }
      if (cw == WAIT_OBJECT_0 + 2) {
        targetEnded = true;
        break;
      }
      if (cw == WAIT_OBJECT_0) {
        PumpResult pr = PumpAvailablePackets(captureClient, ctx->pipe, format.nBlockAlign, &sequence,
                                              &captureFailHr);
        if (pr == PumpResult::CaptureFailed) {
          captureFailed = true;
          break;
        }
        if (pr == PumpResult::PipeBroken) {
          pipeStillOk = false;
          break;
        }
        continue;
      }
      // WAIT_FAILED or an unexpected value - treat as a capture failure rather than spinning forever.
      captureFailed = true;
      captureFailHr = HRESULT_FROM_WIN32(GetLastError());
      break;
    }
  }

  audioClient->Stop();
  captureClient->Release();
  CloseHandle(bufferEvent);
  audioClient->Release();
  CloseHandle(targetProcess);
  if (needCoUninit) CoUninitialize();

  if (stoppedByRequest) {
    return; // control thread owns sending Stopped and exiting the process.
  }
  if (targetEnded) {
    WriteFramed(ctx->pipe, EncodeTargetEnded());
    ExitProcess(0);
  }
  if (captureFailed) {
    SendError(ctx->pipe, ProcessAudioErrorCode::CaptureFailed, captureFailHr,
              "WASAPI capture failed after starting");
    ExitProcess(1);
  }
  // !pipeStillOk: the supervisor's connection is gone - nothing left to report to.
  ExitProcess(0);
}

} // namespace ovnichat
