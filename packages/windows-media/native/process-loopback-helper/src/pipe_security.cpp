#include "pipe_security.h"

#include <sddl.h>

#include <cstdint>
#include <vector>

namespace ovnichat {

namespace {

// Builds "D:P(A;;GA;;;<current-user-SID>)" - a DACL (marked protected, "P", so it does not inherit
// broader ACEs from a parent container) granting GENERIC_ALL only to the SID of the user this helper
// process is running as. Returns an empty string on failure.
std::wstring BuildCurrentUserOnlySddl() {
  HANDLE token = nullptr;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return std::wstring();

  DWORD needed = 0;
  GetTokenInformation(token, TokenUser, nullptr, 0, &needed);
  if (needed == 0) {
    CloseHandle(token);
    return std::wstring();
  }

  std::vector<uint8_t> buffer(needed);
  BOOL ok = GetTokenInformation(token, TokenUser, buffer.data(), needed, &needed);
  CloseHandle(token);
  if (!ok) return std::wstring();

  auto* tokenUser = reinterpret_cast<TOKEN_USER*>(buffer.data());
  LPWSTR sidString = nullptr;
  if (!ConvertSidToStringSidW(tokenUser->User.Sid, &sidString)) return std::wstring();

  std::wstring sddl = L"D:P(A;;GA;;;";
  sddl += sidString;
  sddl += L")";
  LocalFree(sidString);
  return sddl;
}

} // namespace

HANDLE CreateSecuredNamedPipe(const std::wstring& pipeName, std::string* outError) {
  std::wstring sddl = BuildCurrentUserOnlySddl();
  if (sddl.empty()) {
    if (outError) *outError = "Failed to build a current-user-only security descriptor";
    return INVALID_HANDLE_VALUE;
  }

  PSECURITY_DESCRIPTOR sd = nullptr;
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &sd, nullptr)) {
    if (outError) *outError = "Failed to convert the security descriptor";
    return INVALID_HANDLE_VALUE;
  }

  SECURITY_ATTRIBUTES sa;
  sa.nLength = sizeof(sa);
  sa.lpSecurityDescriptor = sd;
  sa.bInheritHandle = FALSE;

  // FILE_FLAG_FIRST_PIPE_INSTANCE: fail outright (ERROR_ACCESS_DENIED) if a pipe by this exact name
  // already exists - defeats a same-user process racing to pre-create the name before this helper
  // does. FILE_FLAG_OVERLAPPED: required so a pending read on this handle from one thread never
  // blocks a write from another thread on the same handle - see pipe_io.h's top comment for the real
  // deadlock this fixes (confirmed empirically, not theoretical). Every caller still gets synchronous
  // call semantics on its own thread via pipe_io.cpp's GetOverlappedResult(..., bWait=TRUE) wrapper.
  HANDLE pipe = CreateNamedPipeW(pipeName.c_str(),
                                  PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE | FILE_FLAG_OVERLAPPED,
                                  PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
                                  1, // max instances - exactly one client, ever, per helper launch.
                                  65536, 65536,
                                  0, // default timeout
                                  &sa);

  LocalFree(sd); // CreateNamedPipeW copies the descriptor into the kernel object.

  if (pipe == INVALID_HANDLE_VALUE) {
    if (outError) *outError = "CreateNamedPipe failed";
  }
  return pipe;
}

} // namespace ovnichat
