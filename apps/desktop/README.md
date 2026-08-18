# Desktop application boundary

This workspace owns Electron Main, Preload, Renderer, and desktop composition.

T1 delivered the secure application shell: a `BrowserWindow` with `nodeIntegration: false`,
`contextIsolation: true`, and `sandbox: true`; a narrow typed Preload bridge
(`window.desktopApp.getVersionInfo()`) with sender-origin-validated IPC; a custom `app://`
protocol for packaged content loading instead of `file://`; a restrictive CSP; default-deny
navigation, window-open, and permission handlers; and a minimal React Renderer that states which
product capabilities are not implemented yet. See [`docs/tasks/T1_ELECTRON_SHELL.md`](../../docs/tasks/T1_ELECTRON_SHELL.md)
for the full implementation and manual verification record.

There is still no WebRTC, microphone/camera/screen capture, text chat, WebSocket signaling,
realtime service integration, or persistence — those begin with later tasks.

Generic RTC and media behavior must live in the corresponding packages, not here. See
[`docs/ARCHITECTURE.md`](../../docs/ARCHITECTURE.md).

## Development

```bash
pnpm dev                                          # from repo root: electron-forge start
pnpm --filter @disco-voador/desktop run package   # electron-forge package (win32/x64)
```
