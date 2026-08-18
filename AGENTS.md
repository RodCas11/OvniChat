# Engineering agent map

This monorepo is the scaffold for a self-hosted Windows desktop communication app. Read
[`CLAUDE.md`](CLAUDE.md) for persistent constraints and use [`docs/`](docs/) as the engineering
source of truth. Current implementation status is in [`docs/HANDOFF.md`](docs/HANDOFF.md).

## Work safely

- Read the relevant file in [`docs/tasks/`](docs/tasks/) before feature work.
- Inspect the current implementation and applicable ADRs before planning changes.
- Preserve package ownership in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); propose and document
  architectural changes instead of introducing them casually.
- Keep edits scoped, strict-TypeScript clean, formatted, and free of secrets.
- Add or update tests for behavior and regressions. Never infer completion from code inspection alone.
- Update documentation and an ADR when a decision or boundary changes.
- Do not implement roadmap work that is outside the active task.

## Standard commands

```text
pnpm install
pnpm dev
pnpm audit
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm verify
pnpm check
```

At T0, `pnpm dev` is compilation watch mode, not a working application. Run the smallest relevant
checks while iterating and `pnpm check` before a substantial handoff. State exactly what was run.

Feature requirements belong in task documents, not this map. Security rules are in
[`docs/SECURITY.md`](docs/SECURITY.md), and completion rules are in
[`docs/DEFINITION_OF_DONE.md`](docs/DEFINITION_OF_DONE.md).
