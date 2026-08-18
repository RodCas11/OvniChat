# ADR 0001: Windows-first Electron desktop client

## Status

**Accepted (target architecture).** T0 establishes repository boundaries and tooling only; no working desktop client or product capability is implied.

## Context

The product is a lightweight, self-hosted desktop communication application whose first supported clients are Windows 10/11 x64. It needs React UI, WebRTC, explicit window/monitor capture, Windows audio integration, and a distributable desktop process with a controlled privilege boundary. A separately deployed browser client and non-Windows clients are initial non-goals.

## Decision

**Accepted decisions:**

- Build the first client as an Electron application with a React renderer.
- Use Electron Forge and Vite as the desktop build and packaging path.
- Support Windows 10/11 x64 first; isolate Windows-specific capture behind `packages/windows-media` rather than spreading platform checks through UI or generic media code.
- Keep generic media and RTC behavior separable from Electron so platform-first does not become platform-entangled.
- Use Electron/Chromium system loopback as the first system-audio path where suitable; treat it as endpoint-mix capture, not per-window audio.

**Hypotheses requiring later validation:**

- The exact Forge 7.11.2, Vite 7.3.6, and security-override combination is compatible in a real
  application; T1 must prove both development launch and packaged Windows launch.
- Process-tree audio is feasible through supported Windows APIs on capable systems. T9 will choose an isolated helper or native addon after a spike; ordinary Windows 10 support is not assumed.
- Installer format, code signing, update delivery, and support beyond Windows x64 remain undecided.

## Consequences

The team can use mature web UI and WebRTC APIs while retaining desktop capture and native integration. In return, every Electron release, permission policy, preload bridge, fuse configuration, and packaged artifact becomes part of the security and compatibility surface. Platform-specific behavior needs real Windows testing, and later platforms require new adapters rather than conditional logic in shared packages.

## Alternatives

- **Browser/PWA:** not selected because the product is desktop-first and requires controlled desktop capture and future Windows-native audio integration.
- **Windows-native UI:** not selected for the initial client because it would give up the chosen React/Electron/WebRTC composition without removing the need for media abstraction.
- **Cross-platform launch:** deferred; it would expand validation and packaging scope before the Windows media path is proven.
