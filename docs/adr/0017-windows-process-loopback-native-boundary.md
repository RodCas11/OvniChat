# ADR 0017: Windows process-loopback capture as an out-of-process native helper

## Status

Accepted and implemented (T12).

## Context

ADR 0007 reserved `packages/windows-media` for Windows-specific capture and explicitly left "native
addon versus isolated signed helper" as an open hypothesis, deferred to "T6 and T9 spikes." T6
resolved system-wide loopback without needing any native code at all — Electron/Chromium's
`getDisplayMedia` already does the WASAPI work internally for that case. T9 became Dedicated
Server authorization and never touched native capture; the actual process-scoped (per-application)
loopback spike happened in T12, this ADR's actual origin, not T9 as ADR 0007 originally guessed.

Process-scoped loopback capture (`ActivateAudioInterfaceAsync` with
`AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`) has no Electron/Chromium equivalent — confirmed by
this repo's own prior primary-source research (`docs/references/WINDOWS_MEDIA.md`). Genuine native
Win32/WASAPI C++ code is unavoidable for T12; this is the first native code anywhere in this
repository. A `software-architect` review was conducted before implementation to decide the one
question ADR 0007 left open plus the concrete integration shape.

## Decision

**An out-of-process native helper executable, not an in-process Node-API/N-API addon.** The
load-bearing reason is crash isolation: a native addon crash takes down the entire Electron Main
process (and with it every other feature — voice, chat, screen share); a helper process crash
degrades to "process-audio capture ended, everything else in the app keeps running," matching the
failure shape T6's own `releasePublishedScreen()` already established for a lost screen source. Two
reinforcing (non-load-bearing) reasons: this repository's toolchain had never exercised a node-gyp/
Python native-addon build before T12 (only raw MSVC/Windows SDK was installed and verified), and a
helper has zero Electron-ABI coupling — no rebuild-on-every-Electron-upgrade risk, unlike a native
addon linked against Electron's specific Node ABI.

**Both the C++ helper source and its TypeScript supervisor/protocol/client live in
`packages/windows-media`** (`native/process-loopback-helper/` and `src/` respectively), per ADR
0007's own literal boundary text. `apps/desktop` depends on `@disco-voador/windows-media` as an
ordinary workspace package; it never links against or spawns Win32 APIs directly.

**The PCM/control bridge is a length-prefixed framed protocol over a Windows named pipe**, built on
bare `node:net` (no new runtime dependency) — see `packages/windows-media/src/protocol.ts` for the
exact wire format (`[type: 1 byte][length: 4 bytes LE][payload]`, every length bounded by
`MAX_FRAME_PAYLOAD_BYTES`) and `FrameDecoder` for stream reassembly. A per-launch random token
(`Hello`/`Ready` handshake) authenticates the connecting Main process to the helper it just spawned,
since named-pipe names are otherwise guessable. From Main to the sandboxed Renderer, decoded PCM
frames travel over a `MessageChannelMain`-transferred `MessagePort` — not per-frame
`ipcRenderer.invoke`/`send`, which would impose per-call IPC overhead on what is effectively a
continuous audio stream.

**Runtime Windows-build detection is a fail-narrow, non-native feature test** (`capability.ts`),
parsing the numeric build out of `os.release()` rather than any product-name string —
`docs/references/WINDOWS_MEDIA.md` and this task's own firsthand finding on the actual development
machine (registry `ProductName` reporting "Windows 10 Pro" while `CurrentBuild` and `os.release()`
both correctly report `26200`) both confirm product-name strings are unreliable. `false` from this
check must never be treated as license to silently fall back to broader (system-wide) capture — see
`docs/tasks/T12_WINDOWS_PROCESS_AUDIO.md`'s architecture constraints.

## Consequences

- A packaging change is required. **Corrected during the Electron integration pass (T12 Main/Preload/
  Renderer wiring):** the mechanism originally anticipated here — `asar.unpack` for the compiled
  helper binary, with the TS wrapper resolving `app.asar` -> `app.asar.unpacked` at runtime — turned
  out to be unworkable once actually exercised against a real `electron-forge package` build:
  `@electron-forge/plugin-vite`'s Rollup build inlines every workspace package's JS directly into
  `main.cjs`/`preload.cjs`, so the packaged `app.asar` ends up with **no**
  `node_modules/@disco-voador/*` tree at all — there is nothing for `asar.unpack` to find, and a
  `require.resolve('@disco-voador/windows-media/...')`-based lookup throws in a packaged build.
  `apps/desktop/forge.config.ts` instead uses `packagerConfig.extraResource` to copy the compiled
  helper directly into the packaged app's `resources` directory at package time (outside the asar
  entirely, so no unpack step is needed); `main/process-audio.ts`'s `resolveHelperExecutablePath`
  reads it back via `process.resourcesPath` when `app.isPackaged`, falling back to a
  `require.resolve`-based dev-tree lookup otherwise. Verified against a real packaged `.exe`: the
  helper landed at `resources/process-loopback-helper.exe` and a real enumeration round-trip
  (spawn, Hello/Ready handshake, `EnumerateResponse` with genuinely running processes) succeeded.
- The native build is a separate, explicit build step (locating the installed MSVC toolchain via
  `vswhere`, since it is not on `PATH` by default) rather than something `tsc -b` produces — a
  reproducible source-to-binary path is required; an opaque committed binary is not acceptable.
- Every additional native-boundary concern ADR 0007 already flagged (sender validation, PID-reuse/
  exit races, no Renderer-controlled paths or shell execution, bounded/backpressured PCM delivery)
  applies unchanged to this concrete helper design.
- `packages/windows-media`'s public TypeScript surface (`capability.ts`, `protocol.ts`, and the
  supervisor built on top of them) is directly unit-testable without a real helper process or real
  Windows hardware; only the native helper itself and the end-to-end capture path require a real
  Windows machine.

## Alternatives

- **In-process Node-API addon:** rejected — a crash in native code would take down the whole Electron
  Main process, unacceptable given every other concurrently-active feature (voice, chat, other media
  sources) would be lost with it; also carries Electron-ABI rebuild coupling this repository has never
  had to manage before.
- **DLL injection or a hooking library into the target game process:** rejected outright per T12's own
  scope — explicitly listed as out of scope, and a categorically more invasive technique than a
  process-loopback capture that requires no code to run inside the target at all.
- **Skip process-scoped capture, keep only T6's system-wide loopback:** rejected — defeats T12's actual
  goal (sharing one application's audio without also exposing everything else playing on the system).
