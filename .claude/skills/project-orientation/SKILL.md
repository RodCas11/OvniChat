---
name: project-orientation
description: Orient substantial work in the Disco Voador monorepo before planning or implementation. Use when entering the project, changing an unfamiliar area, resuming after a handoff, or locating the correct package, task, ADR, agent, and constraints.
---

# Orient in the project

1. Read `CLAUDE.md`; do not eagerly load every linked document.
2. Inspect the current tree and `git status` before assuming the roadmap matches reality. A
   read-only subagent without shell access must request the status/diff snapshot from the
   orchestrator and identify that evidence gap if it is unavailable.
3. Read `docs/PRODUCT.md`, `docs/HANDOFF.md`, and `docs/tasks/STATUS.md`.
4. Read `docs/ARCHITECTURE.md` sections for the affected runtime/package.
5. Locate and read the active task under `docs/tasks/`; stop if no task authorizes substantial
   feature work and create/propose one.
6. Inspect the affected source, manifests, tests, and package README files.
7. Read applicable ADRs and only the relevant files under `docs/references/`.
8. Identify specialist agents and follow-on skills from `docs/DEVELOPMENT.md`.

Before implementation, summarize the active task, actual implementation state, owning packages,
fixed constraints, relevant ADRs, open decisions, required evidence, and any mismatch between docs
and code. Treat marker modules as unimplemented.
