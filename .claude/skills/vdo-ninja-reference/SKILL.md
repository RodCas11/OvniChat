---
name: vdo-ninja-reference
description: Research a specific WebRTC, media capture, signaling, ICE/TURN, reconnection, bitrate, codec, track, or statistics behavior in VDO.Ninja or its websocket_server while preserving Disco Voador licensing and provenance boundaries.
---

# Use VDO.Ninja as a controlled reference

Read `docs/references/VDO_NINJA.md`, `docs/LICENSING.md`, and ADR 0008 before inspecting upstream.

1. State the exact behavior/question and why standards/project code are insufficient.
2. Use the pinned upstream SHA unless the task explicitly researches a newer revision.
3. Locate only relevant files/functions and inspect their file-level notices plus repository license.
4. Corroborate the behavior with W3C, Electron, Chromium, Microsoft, or other primary specifications
   and with black-box/interoperability observation when practical.
5. Write original requirements and tests, then independently implement generic concepts in the
   project’s architecture. Do not imitate unique names, comments, structure, or control flow.
6. Never paste or vendor large upstream modules, minified/obfuscated source, translations, assets,
   models, tests, or bundled third-party files.
7. Record repository, SHA, path/line, question, observed behavior, standards basis, and whether any
   expression was materially adapted in `docs/references/VDO_NINJA.md` or the task handoff.
8. If material adaptation seems necessary, stop implementation for explicit licensing/legal review.
   Isolation and attribution aid auditability but do not erase AGPL obligations.

Report the behavioral finding, authoritative corroboration, provenance record, independent test
idea, and licensing conclusion/uncertainty. This procedure is conservative engineering policy, not
legal advice.
