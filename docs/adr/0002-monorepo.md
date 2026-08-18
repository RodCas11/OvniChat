# ADR 0002: pnpm monorepo and workspace ownership

## Status

**Accepted (repository structure).** T0 creates workspace markers and dependency guardrails; most workspaces intentionally contain no product implementation.

## Context

The system will contain an Electron client, a self-hosted realtime service, shared protocol contracts, generic RTC/media logic, configuration, and Windows-only media adapters. These parts evolve together but run in different environments and must not collapse into one package or duplicate contracts.

## Decision

**Accepted decisions:**

- Use one pnpm workspace with `apps/*`, `services/*`, and `packages/*`.
- Give each workspace one primary ownership boundary as defined in [the target architecture](../ARCHITECTURE.md#workspace-ownership).
- Keep `packages/protocol` canonical for future runtime-validated wire contracts; client and server must not maintain handwritten copies.
- Keep `rtc-core` and `media-core` environment-neutral, and keep Windows capture in `windows-media`.
- Add dependency edges only when real code needs them. Keep `shared` small and limited to stable primitives with multiple consumers.
- Enforce the highest-risk forbidden imports in repository verification and expand those checks as implementation introduces real boundaries.

**Hypotheses requiring later validation:**

- The proposed workspace split is sufficient for the first vertical slices; package interfaces and exact dependency edges are not designed in T0.
- Voice signaling, presence, text, and connection handling can begin as internal modules of one realtime deployable.
- Additional build orchestration or remote caching will be useful only if measured repository scale warrants it.

## Consequences

Atomic changes can update contracts, client, service, tests, and documentation together, with one toolchain and lockfile. The structure also makes ownership and environment boundaries reviewable. The cost is stronger coupling risk inside one repository, more workspace configuration, and a continuing need for architecture checks rather than relying on directory names alone.

## Alternatives

- **Separate repositories:** deferred because cross-cutting protocol and vertical-slice changes would require coordinated releases before that overhead provides value.
- **One application package:** rejected because it would blur runtime, platform, and security boundaries.
- **Nx, Turborepo, or another orchestrator in T0:** not adopted; pnpm plus TypeScript project references and repository scripts are sufficient until measurements show a need.
