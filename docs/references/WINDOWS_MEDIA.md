# Windows media capture reference

Research date: **2026-08-17**

This note records upstream platform facts separately from decisions made for the T0 scaffold. It is not an implementation guide or a claim that every capability is exposed by Electron.

## Verified platform facts

### WASAPI system loopback

- WASAPI loopback captures the audio mix played by a render endpoint. The native sequence is to select an `IMMDevice`, initialize `IAudioClient` with `AUDCLNT_STREAMFLAGS_LOOPBACK`, and read through `IAudioCaptureClient`.
- Loopback capture works only in shared mode. Protected/DRM audio may be unavailable. Capturing the default endpoint can include audio outside this application and, in Terminal Services, outside the current session.
- Event-driven loopback is directly supported on Windows 10 version 1703 and later. Earlier releases require the render-stream workaround described by Microsoft.

Primary source: [Microsoft — Loopback Recording](https://learn.microsoft.com/en-us/windows/win32/coreaudio/loopback-recording)

### Application/process-tree loopback

- Windows exposes process-loopback activation through `ActivateAudioInterfaceAsync`, using `VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK`, `AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK`, and an `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS` blob.
- `TargetProcessId` can be captured with its child-process tree or excluded with its child-process tree. This is process-tree capture, not exact-window capture.
- The capture is render-endpoint independent. A target tree that is not rendering produces silence.
- The Microsoft sample and all process-activation type/structure pages specify a minimum supported client of **Windows build 20348**. The general `ActivateAudioInterfaceAsync` page instead says build **20438** for process loopback; that isolated value appears inconsistent. Implementations must feature-test and report the actual OS build rather than trusting product names alone.
- Windows 10 22H2 is build 19045, below either threshold. Windows 11 starts at build 22000. Consequently, normal Windows 10 client installations do not have this API, while Windows 11 satisfies the documented build floor. Windows 10 reached general end of support on 2025-10-14; ESU does not change its build into a process-loopback-capable client.

Primary sources:

- [Microsoft — Application Loopback API Capture sample](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/)
- [Microsoft — `AUDIOCLIENT_ACTIVATION_PARAMS`](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_activation_params)
- [Microsoft — `AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS`](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ns-audioclientactivationparams-audioclient_process_loopback_params)
- [Microsoft — `AUDIOCLIENT_ACTIVATION_TYPE`](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-audioclient_activation_type)
- [Microsoft — `PROCESS_LOOPBACK_MODE`](https://learn.microsoft.com/en-us/windows/win32/api/audioclientactivationparams/ne-audioclientactivationparams-process_loopback_mode)
- [Microsoft — `ActivateAudioInterfaceAsync`](https://learn.microsoft.com/en-us/windows/win32/api/mmdeviceapi/nf-mmdeviceapi-activateaudiointerfaceasync)
- [Microsoft — Windows 10 release information](https://learn.microsoft.com/en-us/windows/release-health/release-information)
- [Microsoft — Windows 11 release information](https://learn.microsoft.com/en-us/windows/release-health/windows11-release-information)
- [Microsoft — ApplicationLoopback source](https://github.com/microsoft/Windows-classic-samples/tree/d59e5f1dc9c768615e4e1ab1f0f009e6a3ed747c/Samples/ApplicationLoopback)

### Electron, Chromium, and web capture boundaries

- Electron's documented capture flow is `session.setDisplayMediaRequestHandler()` followed by renderer `navigator.mediaDevices.getDisplayMedia()`. Its documented audio responses are `'loopback'`, `'loopbackWithMute'`, or a `WebFrameMain`; string loopback is currently Windows-only. `getDisplayMedia()` does not allow selecting a source by `deviceId`.
- `'loopback'` is system/default-output capture. It does not scope audio to the selected window. `'loopbackWithMute'` additionally mutes local system output. A `WebFrameMain` captures audio from that Electron frame.
- Electron has no documented PID/process-loopback selector. Chromium contains additional internal audio device identifiers, including application loopback, but they are not a stable Electron API.
- Chromium enabled its Windows application-audio feature by default in January 2026 and its current support check requires Windows 11. Chromium resolves the selected window to a root process, so capture can include audio from other windows in the same process tree.
- As of the research date, Electron stable is **43.4.0** with Chromium **150**. Electron supports its latest three stable majors. Chromium capability in an Electron build does not by itself prove that Electron exposes that capability through a documented API.
- Under the Screen Capture specification, audio is optional even when requested; source hints may be ignored, display-source selection cannot be forced through constraints, and capture requires active user consent.

Primary sources:

- [Electron — `desktopCapturer`](https://www.electronjs.org/docs/latest/api/desktop-capturer)
- [Electron — `session`](https://www.electronjs.org/docs/latest/api/session)
- [Electron 43.4.0 source — display media handler](https://github.com/electron/electron/blob/v43.4.0/shell/browser/electron_browser_context.cc)
- [Electron — release index](https://releases.electronjs.org/)
- [Electron — release/support timelines](https://www.electronjs.org/docs/latest/tutorial/electron-timelines)
- [Chromium — audio device identifiers](https://chromium.googlesource.com/chromium/src/+/5dd5bdb2e5d905e6e1a1f07e1927304f52b7bb0e/media/audio/audio_device_description.h)
- [Chromium — Windows application-audio default enablement](https://chromium.googlesource.com/chromium/src/+/5dd5bdb2e5d905e6e1a1f07e1927304f52b7bb0e)
- [Chromium — application/window process-selection design](https://chromium.googlesource.com/chromium/src/+/1c058d1fe091acfb268fdf26af27cebc638d58c6)
- [Chromium — Windows loopback implementation](https://chromium.googlesource.com/chromium/src/+/5dd5bdb2e5d905e6e1a1f07e1927304f52b7bb0e/media/audio/win/audio_low_latency_input_win.cc)
- [W3C — Screen Capture](https://www.w3.org/TR/screen-capture/)

### Licensing

- Microsoft Windows classic samples: [MIT](https://github.com/microsoft/Windows-classic-samples/blob/d59e5f1dc9c768615e4e1ab1f0f009e6a3ed747c/LICENSE). Retain the notice if sample code is copied.
- Electron: [MIT](https://github.com/electron/electron/blob/v43.4.0/LICENSE).
- Chromium: [BSD 3-Clause](https://chromium.googlesource.com/chromium/src/+/5dd5bdb2e5d905e6e1a1f07e1927304f52b7bb0e/LICENSE), plus third-party component licenses.

## T0 scaffold decisions

- Represent endpoint-wide and process-tree capture as separate capabilities: `SystemLoopbackAudioCapture` and `ProcessLoopbackAudioCapture`.
- Permit system loopback on supported Windows 10/11 releases. Treat its output track as optional and verify that it is present and live.
- Gate process capture on runtime build `>= 20348`; document Windows 11 as the practical client baseline. Return a typed `unsupported` result containing the detected build and reason on older systems.
- Keep process-loopback implementation inside `packages/windows-media`. The main process owns enumeration, PID validation, start/stop, and cleanup; renderers receive only a narrow typed API and opaque target identifiers.
- Do not claim exact-window isolation. Make process-tree semantics, child-process behavior, PID lifetime, and target exit explicit in UI and diagnostics.
- Do not depend on undocumented Chromium audio identifiers. Validate Electron 43 on Windows 11 during T9 before deciding whether its current picker behavior can replace native capture.
- Defer native addon versus isolated signed helper to T9. The helper offers ABI and crash isolation; an addon may reduce media copies but couples native code to Electron's ABI.
- Preserve an explicit user gesture, visible capture indicator, and stop control for native capture.
- Test Windows 10 build 19045 rejection; current Windows 11 include/exclude modes; silence; child spawn and process exit; PID reuse; output-device changes; protected content; mic plus loopback; teardown; own-audio echo; and the local-mute behavior of `'loopbackWithMute'`.

_Resolved (T12, not T9 as originally guessed — T9 became Dedicated Server authorization instead):_
an out-of-process helper won over an in-process addon, primarily for crash isolation — see
[`../adr/0017-windows-process-loopback-native-boundary.md`](../adr/0017-windows-process-loopback-native-boundary.md).
Every test scenario listed above (PID reuse included — closed via an exe-name cross-check the
helper performs at activation time, not merely the held-handle window) was implemented and proven
against real Windows audio hardware, including a mandatory frequency-domain isolation proof between
two genuinely independent Windows processes — see
[`../tasks/T12_WINDOWS_PROCESS_AUDIO.md`](../tasks/T12_WINDOWS_PROCESS_AUDIO.md).
