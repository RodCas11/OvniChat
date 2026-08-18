---
name: testing-quality
description: Design, implement, or review Disco Voador tests and completion evidence. Use for regression work, feature plans, flaky or missing coverage, Electron smoke tests, realtime/WebRTC two-client scenarios, Windows validation, packaging checks, and before declaring a substantial task complete.
---

# Establish quality evidence

Read the active task, `docs/DEFINITION_OF_DONE.md`, `docs/DEVELOPMENT.md`, and changed code. Consult
`qa-engineer` for a substantial completion claim.

1. Convert each acceptance criterion into observable evidence.
2. Reproduce a regression before its fix when practical.
3. Use the lowest useful layer without substituting mocks for the claim:
   - unit for deterministic rules and lifecycle;
   - integration for protocol, IPC, storage, and module boundaries;
   - Electron smoke for actual start/load/quit/security;
   - two-client realtime for connection/state/reconnect;
   - two-client WebRTC for actual tracks, ICE/TURN, coexistence, and cleanup;
   - real Windows/manual checks for capture, devices, helpers, installers, and packages.
4. Cover success, invalid input, timeout/cancel, cleanup, retry/reconnect, partial capability, and
   resource-leak paths relevant to the change.
5. Keep tests deterministic, isolated, bounded by timeouts, and diagnostic on failure.
6. Run targeted checks while iterating and the applicable root quality gate before handoff.
7. Record environment, topology, commands/results, manual observations, skipped evidence, and risk.

Challenge “it works” unless the claim’s real boundary was exercised. A signaling test does not prove
media; a Vite build does not prove a packaged Electron app; Coturn liveness does not prove relay.
