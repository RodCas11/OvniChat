# Development roadmap

This roadmap orders validation and implementation; it is not authorization to implement later
phases while an earlier task is active. Each phase needs a detailed task file before work starts.

| Phase   | Outcome                                                                     | Key evidence before completion                                                         |
| ------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| **T0**  | Repository and Claude development harness                                   | Full quality gate, harness/docs/guardrail audit                                        |
| **T1**  | Secure Electron desktop shell and application foundation                    | Windows start/quit and packaged smoke; Main/Preload/Renderer security tests            |
| **T2**  | Shared runtime-validated realtime protocol and WebSocket service foundation | Invalid-message tests and real two-client connect/reconnect                            |
| **T3**  | Voice-channel microphone WebRTC vertical slice                              | Two-client audio, mute/deafen semantics, ICE/TURN failure tests, cleanup               |
| **T4**  | Independent camera publishing                                               | Voice + camera coexistence, device/permission/change tests                             |
| **T5**  | Monitor/window streaming                                                    | Explicit source selection, quality controls, voice continuity, stop/end cleanup        |
| **T6**  | Windows system-loopback screen audio                                        | Windows 10/11 system mix tests, echo/routing behavior, optional-track degradation      |
| **T7**  | Text channels, realtime messaging, SQLite persistence                       | History/edit/delete, authorization, restart persistence, migration/backup tests        |
| **T8**  | Recovery, diagnostics, and device management                                | Network/device interruption matrix and actionable privacy-safe diagnostics             |
| **T9**  | Process/game audio research and implementation                              | Windows 11 capability spike, process-tree semantics, helper/addon ADR, lifecycle tests |
| **T10** | Self-hosted deployment hardening and Coturn integration                     | Fresh-host runbook, forced relay across NAT, TLS, credential expiry, backup/restore    |
| **T11** | Windows packaging and installer hardening                                   | Clean-machine install/upgrade/repair/uninstall and signing/update decision             |
| **T12** | Security, QA, and performance hardening                                     | Threat review, abuse tests, soak/load results, latency/resource baselines              |
| **T13** | SFU evaluation or migration if scale requires it                            | Measured mesh limit, build-vs-adopt ADR, UI unchanged by transport experiment          |

## Sequencing rationale

- Establish the secure process boundary before product behavior.
- Establish one canonical protocol before signaling or chat expands.
- Prove microphone end-to-end before adding more sources.
- Add camera and screen separately to enforce independent track semantics.
- Ship system loopback before the substantially riskier process-loopback boundary.
- Add persistence only when text-chat operations provide concrete storage requirements.
- Defer SFU selection until measured room/fan-out needs justify its operational complexity.

T9 is explicitly Windows 11-oriented for process-tree audio because Microsoft’s application
loopback API requires build 20348+, while normal Windows 10 22H2 is build 19045. System loopback
remains the Windows 10/11 path.

## Cross-phase rules

Every phase remains self-hostable, updates protocol/docs/tests together, and preserves the semantic
media model. Diagnostics and failure recovery are delivered incrementally rather than postponed
entirely to T8/T12. Security and licensing review applies whenever a surface changes.
