---
name: security-review
description: Perform a repeatable security review of Disco Voador changes affecting Electron IPC, navigation, permissions, realtime inputs, authentication, secrets, logs, native helpers, paths/shells, dependencies, or TURN credentials, and before security-sensitive completion claims.
---

# Review security

Read the diff/task, `docs/SECURITY.md`, affected architecture, and relevant reference docs. Consult
`security-reviewer` for independent findings; do not let the author’s expectations limit review.

Check applicable surfaces:

- Electron isolation, CSP, custom protocol, navigation/windows, permission handlers, sender/frame
  validation, and narrow Preload capabilities;
- runtime validation, authentication/authorization, sizes/rates/timeouts, replay/idempotency, error
  disclosure, and WebSocket resource exhaustion;
- secret/config lifecycle, redaction, ignored files, diagnostics, screenshots, and crash reports;
- path traversal, unsafe URL handling, shell/command injection, filesystem boundaries, and native
  helper protocol/privilege/buffer limits;
- media consent, indicators, source metadata, teardown, protected content, and cross-source leakage;
- TURN shared-secret isolation, credential TTL, quotas, peer restrictions, TLS, and exposed ports;
- dependency provenance, security notes, license obligations, and Electron update cadence.

Run relevant negative tests and `pnpm verify:secrets`; inspect results instead of assuming scripts
are complete controls. A read-only reviewer without shell access asks the orchestrator or QA agent
to run those commands and reports whether the resulting evidence was supplied.

Report findings first, ordered by severity, with file/evidence, impact, and remediation. Then list
assumptions, checks run, coverage gaps, and residual risk. Say explicitly when no finding is found.
