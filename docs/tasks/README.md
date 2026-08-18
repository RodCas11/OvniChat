# Task system

Task files are executable scopes for the main engineering session. The roadmap orders outcomes;
the task file defines what may be implemented now. Use one file per coherent task or subtask and
name it `T<number>_<SHORT_NAME>.md` (or `T<number>.<subnumber>_<SHORT_NAME>.md` when a phase is split).

## Workflow

1. Create/review the task before implementation.
2. Keep [`STATUS.md`](STATUS.md) at `NOT STARTED` until work begins.
3. Record discovered constraints and approved scope changes in the task, not only chat history.
4. Keep partial work `IN PROGRESS`; use handoff notes for blockers and remaining evidence.
5. Mark `COMPLETE` only after task acceptance criteria and the project Definition of Done pass.

The main implementation session owns status updates. Specialist subagents report findings but do
not independently declare a phase complete.

## Template

```markdown
# Tn — Short outcome

## Goal

## Context

## In scope

## Out of scope

## Architecture constraints

## Relevant packages

## Relevant agents

## Relevant skills

## Acceptance criteria

## Required tests

## Manual verification

## Definition of Done

## Handoff notes
```

Write acceptance criteria as observable outcomes. Required tests name the layer/scenario, not only
“add tests.” Manual verification identifies OS, topology, devices, or artifact needed. Handoff notes
state actual results, remaining risk, and follow-up tasks.
