---
name: planning-feature
description: Plan a substantial Disco Voador feature or cross-package change before implementation. Use for new product behavior, multi-file vertical slices, protocol or persistence changes, privileged integration, architecture impact, or work whose acceptance and verification are not already obvious.
---

# Plan a feature

Read the active task, `docs/ARCHITECTURE.md`, `docs/SECURITY.md`, applicable ADRs, and existing code.
Run `project-orientation` first when context is incomplete.

Produce a concise plan that identifies:

1. observable goal and explicit non-goals;
2. affected workspaces and dependency direction;
3. existing interfaces to reuse and the minimum new interface needed;
4. protocol/configuration/persistence impacts and compatibility concerns;
5. trust boundaries, sensitive data, abuse cases, and required security review;
6. failure, cancellation, cleanup, and recovery behavior;
7. unit, integration, two-client, Electron, Windows, and manual tests that apply;
8. documentation/ADR changes;
9. ordered coherent slices with a verification point after each;
10. acceptance criteria and applicable `docs/DEFINITION_OF_DONE.md` items.

Name specialist subagents only where their expertise changes the plan. Flag hypotheses and decisions
that require a spike instead of inventing an abstraction in advance.
