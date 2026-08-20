// T12 - enumerates currently audio-capable processes via active WASAPI render sessions on the
// default output endpoint. Never a raw process dump: only processes actually holding an audio
// session right now are returned, matching protocol.ts's EnumerateResponse contract (T12 Section
// 12/41).
#pragma once

#include "protocol.h"
#include "target_version.h"

#include <windows.h>

#include <vector>

namespace ovnichat {

// `excludePids` are skipped even if they hold an audio session (this helper's own pid and, best
// effort, the Electron Main process that spawned it - see util.h's GetParentProcessId).
std::vector<ProcessCandidate> EnumerateAudioCandidates(const std::vector<DWORD>& excludePids);

} // namespace ovnichat
