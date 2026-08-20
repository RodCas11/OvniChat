// T12 - creates the named pipe this helper serves, restricted to the current user's SID and refusing
// to start if a pipe by this exact name already exists (defeats a same-user process racing to
// pre-create the name before this helper does). See process-loopback-supervisor.ts's top-of-file
// doc comment for the full pipe-topology rationale - this file implements the helper-side half of it.
#pragma once

#include "target_version.h"

#include <windows.h>

#include <string>

namespace ovnichat {

// Returns INVALID_HANDLE_VALUE on any failure; `outError` is set to a short, non-sensitive
// diagnostic (never includes the pipe name's random suffix or any user-controlled content).
HANDLE CreateSecuredNamedPipe(const std::wstring& pipeName, std::string* outError);

} // namespace ovnichat
