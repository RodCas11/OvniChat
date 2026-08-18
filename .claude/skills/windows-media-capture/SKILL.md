---
name: windows-media-capture
description: Plan, implement, debug, or review Windows monitor/window capture, Electron desktop capture, system loopback, process-tree loopback, target selection, or native helper boundaries in Disco Voador.
---

# Develop Windows media capture

Read `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, `docs/references/WINDOWS_MEDIA.md`, and the active
task. Consult `windows-media-engineer`; consult `security-reviewer` for native/IPC changes.

1. Keep platform implementation in `packages/windows-media`; expose generic semantic sources to
   media/RTC consumers.
2. Require explicit user intent, show capture state, and provide reliable stop behavior.
3. Treat screen video and audio as independent; an absent audio track is a supported outcome.
4. For initial system loopback, state that it captures the endpoint mix—not the selected window.
5. For process capture, model the target process tree and runtime-gate Windows build 20348+; handle
   unsupported Windows 10 explicitly.
6. Do not depend on undocumented Chromium device identifiers.
7. Use opaque target handles across narrow IPC. Validate origin, payload, PID lifecycle/reuse, buffer
   bounds, and helper protocol versions; never expose generic command execution.
8. Consider process exit, child processes, silence, output-device change, protected media, capture
   end, helper crash, and teardown.
9. Decide native addon versus isolated helper only from a task-specific spike and ADR.
10. Verify on real supported Windows with real audio routing; simulations do not prove capture.

Report OS/build, API/capability path, consent/indicator behavior, sensitive metadata handling,
failure matrix, real-device evidence, and cleanup.
