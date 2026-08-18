# Electron and desktop capture

Snapshot: **2026-08-17**. This is guidance for the T1 desktop shell, not an implementation contract.

## Security boundary

Treat the renderer as untrusted web content and keep operating-system access in the main process or a narrowly scoped preload.

- Set `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true` explicitly on every `BrowserWindow`, even though current Electron defaults are secure.
- Expose one typed `contextBridge` method per capability. Do not expose `ipcRenderer`, arbitrary channels, filesystem access, shell access, or command execution.
- Validate every IPC argument at runtime and verify the sender frame and origin in the main process.
- Keep `webSecurity` enabled, use a restrictive Content Security Policy, deny unexpected navigation and new windows, and allowlist any URL passed to `shell.openExternal`.
- Prefer a standard, secure custom application protocol to `file://`. Register its privileges before `app` becomes ready; a custom scheme does not justify bypassing CSP or origin checks.

Electron automatically approves permission requests when no application handler is installed. A production shell therefore needs **both** `session.setPermissionCheckHandler` and `session.setPermissionRequestHandler`; Electron documents both as necessary for complete permission handling. Default-deny, then allowlist the exact application origin, top-level frame, permission (`media` or `display-capture`), and requested media type.

Primary guidance: [Electron security](https://www.electronjs.org/docs/latest/tutorial/security), [context isolation](https://www.electronjs.org/docs/latest/tutorial/context-isolation), [process sandboxing](https://www.electronjs.org/docs/latest/tutorial/sandbox), [IPC](https://www.electronjs.org/docs/latest/tutorial/ipc), [Session permissions](https://www.electronjs.org/docs/latest/api/session), and [custom protocols](https://www.electronjs.org/docs/latest/api/protocol).

## Screen and window capture

`desktopCapturer.getSources({ types: ['screen', 'window'] })` enumerates candidates; it is not permission to capture them. The application should present an explicit, user-triggered picker and pass the chosen `DesktopCapturerSource` through `session.setDisplayMediaRequestHandler`.

Do not copy the documentation sample's convenient `sources[0]` auto-grant into product code. The handler must validate `frame`, `securityOrigin`, `videoRequested`, `audioRequested`, and `userGesture` before granting a source. As documented at this snapshot, Electron's experimental native system picker is available only on macOS 15 or later, so the Windows client needs an application-controlled picker.

Important constraints:

- `navigator.mediaDevices.getDisplayMedia()` cannot select a desktop source by `deviceId`; source selection belongs to the main-process display-media handler.
- On Windows, granting audio as `loopback` or `loopbackWithMute` captures system-output audio, not audio isolated to the selected window or process. Per-process/game capture belongs behind the future Windows native-media boundary.
- Display audio is optional even when requested. Inspect the returned tracks instead of assuming one exists.
- Loopback can recapture remote-participant playback and create feedback. Treat audio routing as a product and test concern; do not depend on draft `windowAudio` or `restrictOwnAudio` constraints.
- Display capture requires a focused active context and transient user activation, and its permission cannot be persisted. Initial `getDisplayMedia()` constraints cannot use `min`, `exact`, or `advanced` to narrow the user's choices.
- Listen for track `ended`, `mute`, and `unmute`. Stop every track and detach previews during replacement, cancellation, teardown, and application exit; pausing a media element does not stop capture. Calling `MediaStreamTrack.stop()` itself does not dispatch `ended`.
- Source names and thumbnails may reveal sensitive information. Render names as untrusted text, avoid logging them, and request no thumbnails (`thumbnailSize: { width: 0, height: 0 }`) when the UI does not need them.

Primary references: [desktopCapturer](https://www.electronjs.org/docs/latest/api/desktop-capturer), [DesktopCapturerSource](https://www.electronjs.org/docs/latest/api/structures/desktop-capturer-source), [display-media request handler](https://www.electronjs.org/docs/latest/api/session#sessetdisplaymediarequesthandlerhandler-opts), and the [Screen Capture specification](https://www.w3.org/TR/screen-capture/).

## Packaging hardening

Use ASAR packaging and Forge's fuses plugin. The intended production fuse posture is:

- `RunAsNode: false`
- `EnableCookieEncryption: true`
- `EnableNodeOptionsEnvironmentVariable: false`
- `EnableNodeCliInspectArguments: false`
- `EnableEmbeddedAsarIntegrityValidation: true`
- `OnlyLoadAppFromAsar: true`

Verify the packaged Windows artifact, not only the dev server: it must launch with the expected custom scheme, CSP, sandbox, preload bridge, permission handlers, and fuses. See [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) and [Forge's fuses plugin](https://js.electronforge.io/modules/_electron_forge_plugin_fuses.html).
