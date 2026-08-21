#include "util.h"

#include <tlhelp32.h>

namespace ovnichat {

bool ConstantTimeEquals(const uint8_t* a, const uint8_t* b, size_t len) {
  uint8_t diff = 0;
  for (size_t i = 0; i < len; ++i) {
    diff |= static_cast<uint8_t>(a[i] ^ b[i]);
  }
  return diff == 0;
}

namespace {
int HexNibble(char c) {
  if (c >= '0' && c <= '9') return c - '0';
  if (c >= 'a' && c <= 'f') return 10 + (c - 'a');
  if (c >= 'A' && c <= 'F') return 10 + (c - 'A');
  return -1;
}
} // namespace

std::optional<std::vector<uint8_t>> HexDecode(const std::string& hex) {
  if (hex.size() % 2 != 0) return std::nullopt;
  std::vector<uint8_t> out;
  out.reserve(hex.size() / 2);
  for (size_t i = 0; i < hex.size(); i += 2) {
    int hi = HexNibble(hex[i]);
    int lo = HexNibble(hex[i + 1]);
    if (hi < 0 || lo < 0) return std::nullopt;
    out.push_back(static_cast<uint8_t>((hi << 4) | lo));
  }
  return out;
}

std::wstring Utf8ToWide(const std::string& s) {
  if (s.empty()) return std::wstring();
  int needed = MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), nullptr, 0);
  if (needed <= 0) return std::wstring();
  std::wstring out(static_cast<size_t>(needed), L'\0');
  MultiByteToWideChar(CP_UTF8, 0, s.data(), static_cast<int>(s.size()), out.data(), needed);
  return out;
}

std::string WideToUtf8(const std::wstring& w) {
  if (w.empty()) return std::string();
  int needed =
      WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
  if (needed <= 0) return std::string();
  std::string out(static_cast<size_t>(needed), '\0');
  WideCharToMultiByte(CP_UTF8, 0, w.data(), static_cast<int>(w.size()), out.data(), needed, nullptr,
                       nullptr);
  return out;
}

bool EqualsIgnoreCaseUtf8(const std::string& a, const std::string& b) {
  std::wstring wa = Utf8ToWide(a);
  std::wstring wb = Utf8ToWide(b);
  // CompareStringOrdinal ignoring case - avoids CharUpper/locale-table lookups entirely, matching
  // how Windows itself treats filename case-insensitivity.
  int result = CompareStringOrdinal(wa.c_str(), static_cast<int>(wa.size()), wb.c_str(),
                                     static_cast<int>(wb.size()), TRUE);
  return result == CSTR_EQUAL;
}

std::optional<std::wstring> GetEnvVar(const wchar_t* name) {
  DWORD needed = GetEnvironmentVariableW(name, nullptr, 0);
  if (needed == 0) return std::nullopt; // unset (GetLastError() would be ERROR_ENVVAR_NOT_FOUND)
  std::wstring value(needed, L'\0');
  DWORD written = GetEnvironmentVariableW(name, value.data(), needed);
  if (written == 0 || written >= needed) return std::nullopt;
  value.resize(written);
  return value;
}

std::string GetExeBasenameForPid(DWORD pid) {
  HANDLE process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!process) return std::string();

  wchar_t pathBuf[MAX_PATH * 2] = {};
  DWORD size = static_cast<DWORD>(std::size(pathBuf));
  BOOL ok = QueryFullProcessImageNameW(process, 0, pathBuf, &size);
  CloseHandle(process);
  if (!ok) return std::string();

  std::wstring full(pathBuf, size);
  size_t slash = full.find_last_of(L"\\/");
  std::wstring base = (slash == std::wstring::npos) ? full : full.substr(slash + 1);
  return WideToUtf8(base);
}

DWORD GetParentProcessId(DWORD pid) {
  HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
  if (snapshot == INVALID_HANDLE_VALUE) return 0;

  PROCESSENTRY32W entry;
  entry.dwSize = sizeof(entry);
  DWORD parentPid = 0;
  if (Process32FirstW(snapshot, &entry)) {
    do {
      if (entry.th32ProcessID == pid) {
        parentPid = entry.th32ParentProcessID;
        break;
      }
    } while (Process32NextW(snapshot, &entry));
  }
  CloseHandle(snapshot);
  return parentPid;
}

namespace {
struct FindWindowContext {
  DWORD targetPid;
  std::wstring title;
};

BOOL CALLBACK FindWindowCallback(HWND hwnd, LPARAM lParam) {
  auto* ctx = reinterpret_cast<FindWindowContext*>(lParam);
  DWORD windowPid = 0;
  GetWindowThreadProcessId(hwnd, &windowPid);
  if (windowPid != ctx->targetPid) return TRUE; // keep enumerating
  if (!IsWindowVisible(hwnd)) return TRUE;
  if (GetWindow(hwnd, GW_OWNER) != nullptr) return TRUE; // prefer top-level, unowned windows
  int len = GetWindowTextLengthW(hwnd);
  if (len <= 0) return TRUE;
  std::wstring title(static_cast<size_t>(len) + 1, L'\0');
  int copied = GetWindowTextW(hwnd, title.data(), len + 1);
  if (copied <= 0) return TRUE;
  title.resize(static_cast<size_t>(copied));
  ctx->title = title;
  return FALSE; // stop - found one
}
} // namespace

std::wstring FindTopLevelWindowTitleForPid(DWORD pid) {
  FindWindowContext ctx{pid, std::wstring()};
  EnumWindows(FindWindowCallback, reinterpret_cast<LPARAM>(&ctx));
  return ctx.title;
}

} // namespace ovnichat
