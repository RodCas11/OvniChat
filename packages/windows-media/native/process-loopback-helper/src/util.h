// T12 - small platform utility helpers shared across the helper's translation units. Nothing here
// logs captured content, process command lines, full paths, or window titles - callers are
// responsible for keeping any diagnostic text non-sensitive (see docs/SECURITY.md).
#pragma once

#include "target_version.h"

#include <windows.h>

#include <optional>
#include <string>
#include <vector>

namespace ovnichat {

// Constant-time byte comparison - deliberately NOT memcmp, which can short-circuit on the first
// differing byte and leak timing information about how many leading bytes matched. Used only for the
// Hello handshake token check.
bool ConstantTimeEquals(const uint8_t* a, const uint8_t* b, size_t len);

// Decodes a lowercase/uppercase hex string into raw bytes. Returns std::nullopt if the string has odd
// length or contains a non-hex character.
std::optional<std::vector<uint8_t>> HexDecode(const std::string& hex);

std::wstring Utf8ToWide(const std::string& s);
std::string WideToUtf8(const std::wstring& w);

// Reads an environment variable from this process's own block. Returns std::nullopt if unset.
std::optional<std::wstring> GetEnvVar(const wchar_t* name);

// Resolves just the basename (e.g. "PathOfExileSteam.exe") of the executable backing `pid`, using
// only PROCESS_QUERY_LIMITED_INFORMATION + QueryFullProcessImageNameW - never returns a full path.
// Returns an empty string if the process can't be opened/queried (e.g. protected/elevated process).
std::string GetExeBasenameForPid(DWORD pid);

// Returns the parent process id of `pid` via a CreateToolhelp32Snapshot walk, or 0 if it cannot be
// determined (e.g. the parent already exited and its pid slot was reused - a best-effort lookup only,
// never treated as a security boundary).
DWORD GetParentProcessId(DWORD pid);

// Best-effort: the title of the first visible top-level (unowned) window belonging to `pid`, or an
// empty string if none is found. Never fabricated.
std::wstring FindTopLevelWindowTitleForPid(DWORD pid);

} // namespace ovnichat
