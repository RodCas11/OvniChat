---
name: electron-development
description: Implement or review Electron Main, Preload, Renderer, IPC, BrowserWindow, content loading, lifecycle, Forge, Vite, or Windows packaging in Disco Voador. Use whenever the desktop process boundary or packaged Electron artifact changes.
---

# Develop the Electron boundary

Read `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/references/ELECTRON.md`, and the active task.
Consult `electron-desktop-engineer`; add `security-reviewer` for privileged or permission surfaces.

## Workflow

1. Assign ownership explicitly to Main, Preload, or Renderer.
2. Keep Renderer browser-compatible; reject Node/Electron imports.
3. Set `nodeIntegration: false`, `contextIsolation: true`, and `sandbox: true` explicitly.
4. Expose narrow capability methods through `contextBridge`; validate sender, origin, and payload in
   Main. Never expose raw IPC, shell, filesystem, process, or arbitrary channels.
5. Deny unplanned navigation, windows, permissions, and external protocols. Install both permission
   check and request handlers with default deny.
6. Keep CSP restrictive and use a secure custom application protocol when established by the task.
7. Preserve aligned Forge packages, `asar`/fuses, and pnpm hoisting. Re-check official release notes
   before upgrading.
8. Test configuration and negative paths, then run actual Electron start/load/quit smoke tests.
9. When build/runtime dependencies or packaging change, inspect and launch a Windows package
   artifact; a Vite compile alone is insufficient.
10. Update task evidence and architecture/security docs when boundaries change.

Report preferences asserted, bridge surface, denied paths, commands run, Windows/package evidence,
and remaining risk.
