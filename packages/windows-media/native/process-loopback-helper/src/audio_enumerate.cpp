#include "audio_enumerate.h"
#include "util.h"

#include <objbase.h>
#include <mmdeviceapi.h>
#include <audiopolicy.h>
#include <shlwapi.h>

#include <algorithm>
#include <unordered_set>

namespace ovnichat {

namespace {

template <typename T>
void SafeRelease(T** ppT) {
  if (*ppT) {
    (*ppT)->Release();
    *ppT = nullptr;
  }
}

// Resolves a session display name, which is sometimes an indirect MUI resource reference
// ("@%SystemRoot%\\System32\\...,-203") rather than a literal string - SHLoadIndirectString resolves
// those; a plain literal string passes through unchanged. Returns empty string if nothing usable.
std::wstring ResolveDisplayName(LPCWSTR raw) {
  if (!raw || raw[0] == L'\0') return std::wstring();
  wchar_t resolved[1024] = {};
  if (raw[0] == L'@' && SUCCEEDED(SHLoadIndirectString(raw, resolved, static_cast<UINT>(std::size(resolved)), nullptr))) {
    return std::wstring(resolved);
  }
  return std::wstring(raw);
}

} // namespace

std::vector<ProcessCandidate> EnumerateAudioCandidates(const std::vector<DWORD>& excludePids) {
  std::vector<ProcessCandidate> results;

  IMMDeviceEnumerator* deviceEnumerator = nullptr;
  IMMDevice* device = nullptr;
  IAudioSessionManager2* sessionManager = nullptr;
  IAudioSessionEnumerator* sessionEnumerator = nullptr;

  HRESULT hr = CoCreateInstance(__uuidof(MMDeviceEnumerator), nullptr, CLSCTX_ALL,
                                 __uuidof(IMMDeviceEnumerator), reinterpret_cast<void**>(&deviceEnumerator));
  if (FAILED(hr)) return results;

  // eRender/eConsole: the default output endpoint's "console" role - matches T6's own system-loopback
  // endpoint selection and docs/references/WINDOWS_MEDIA.md's documented session-enumeration path.
  hr = deviceEnumerator->GetDefaultAudioEndpoint(eRender, eConsole, &device);
  if (SUCCEEDED(hr)) {
    hr = device->Activate(__uuidof(IAudioSessionManager2), CLSCTX_ALL, nullptr,
                           reinterpret_cast<void**>(&sessionManager));
  }
  if (SUCCEEDED(hr)) {
    hr = sessionManager->GetSessionEnumerator(&sessionEnumerator);
  }

  if (SUCCEEDED(hr)) {
    int count = 0;
    sessionEnumerator->GetCount(&count);

    std::unordered_set<DWORD> seenPids;
    for (int i = 0; i < count && results.size() < kMaxEnumerateCandidates; ++i) {
      IAudioSessionControl* control = nullptr;
      if (FAILED(sessionEnumerator->GetSession(i, &control)) || !control) continue;

      IAudioSessionControl2* control2 = nullptr;
      HRESULT qi = control->QueryInterface(__uuidof(IAudioSessionControl2), reinterpret_cast<void**>(&control2));
      SafeRelease(&control);
      if (FAILED(qi) || !control2) continue;

      DWORD pid = 0;
      control2->GetProcessId(&pid);

      bool excluded = pid == 0 || std::find(excludePids.begin(), excludePids.end(), pid) != excludePids.end();
      if (!excluded && seenPids.insert(pid).second) {
        std::string exeName = GetExeBasenameForPid(pid);
        if (!exeName.empty()) {
          std::wstring displayTitle;
          LPWSTR rawDisplayName = nullptr;
          if (SUCCEEDED(control2->GetDisplayName(&rawDisplayName)) && rawDisplayName) {
            displayTitle = ResolveDisplayName(rawDisplayName);
            CoTaskMemFree(rawDisplayName);
          }
          if (displayTitle.empty()) {
            displayTitle = FindTopLevelWindowTitleForPid(pid);
          }

          ProcessCandidate candidate;
          candidate.pid = pid;
          candidate.exeNameUtf8 = exeName;
          candidate.displayTitleUtf8 = WideToUtf8(displayTitle);
          results.push_back(std::move(candidate));
        }
      }

      SafeRelease(&control2);
    }
  }

  SafeRelease(&sessionEnumerator);
  SafeRelease(&sessionManager);
  SafeRelease(&device);
  SafeRelease(&deviceEnumerator);

  return results;
}

} // namespace ovnichat
