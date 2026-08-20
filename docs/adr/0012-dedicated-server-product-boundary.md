# ADR 0012: Dedicated Server product boundary

## Status

Accepted and implemented (T8).

## Context

ADR 0010 established that Disco Voador must never require a central account system or a mandatory
Disco Voador–operated cloud service. ADR 0011 (T7) implemented the client-identity half of the
resulting architecture: every client has a local cryptographic identity a server can verify with no
central authority. T8 is the task that turns the _server_ side of that architecture from "an
internal service every test bypassed into directly" into an explicit, independently-operable
product — the piece ADR 0010 anticipated but did not itself decide the shape of.

The concrete question: what is the cleanest long-term relationship between the existing
`services/realtime` (T2, extended through T7 with voice signaling and identity auth) and a new
"Disco Voador Dedicated Server" product? Two shapes were on the table:

1. **Composition**: a new `services/dedicated-server` (or `apps/dedicated-server`) owns
   configuration, composition, CLI/process entrypoint, and product identity; `services/realtime`
   stays a reusable transport/session **library** underneath it.
2. **Rename in place**: `services/realtime` itself becomes the product — its own CLI grows
   configuration/banner/product-identity concerns directly.

A `software-architect` review was requested specifically to avoid mechanically renaming folders
before understanding `services/realtime`'s actual current responsibilities and consumers.

## Decision

**Composition, not renaming.** A new workspace, `services/dedicated-server`
(`@disco-voador/dedicated-server`), is the product. `services/realtime` is unchanged in identity,
branding, and its own independent runnability — it gains exactly one new, optional
dependency-injection seam (`RealtimeServerDependencies.voiceChannels` / `.serverMetadata`, both
defaulting to the pre-T8 hardcoded values so no existing consumer needs to change) so a composing
caller can supply its own channel catalog and server display identity.

`services/dedicated-server` depends on `@disco-voador/realtime` as an ordinary package dependency.
Its own responsibility is exactly the product-facing layer `services/realtime` never had:
configuration loading (file + environment, with clear validation and precedence), a composition
root (`createDedicatedServer(config)`) that turns that configuration into a running server by
composing `createRealtimeServer`, a CLI/process entrypoint with a startup banner and signal
handling, and the fixed capability set (`voice`, `camera`, `screen-video`, `screen-audio`) this
product currently offers.

`services/realtime/src/index.ts` (the package's import surface) was split from its CLI bootstrap
(moved unchanged to `services/realtime/src/cli.ts`) specifically so `services/dedicated-server`
importing the package does not have the side effect of starting a second, unwanted realtime server
— `index.ts` is now a pure barrel export.

**Workspace location: `services/dedicated-server`, not `apps/dedicated-server`.** In this
repository, `apps/*` specifically means "Electron Main/Preload/Renderer GUI-shell composition" (see
the ownership table in `docs/ARCHITECTURE.md`) — a headless, operator-run Node server product does
not fit that meaning, regardless of it also being a top-level "product." It belongs alongside its
own dependency, `services/realtime`, under `services/`.

No new ADR was strictly required by the architect's own assessment — ADR 0010 already established
the target direction this task implements a piece of — but this one is recorded anyway per the
task's own explicit documentation requirement, and because "how services/realtime relates to the
Dedicated Server" is exactly the kind of package-boundary decision this repository's workflow
(`docs/DEVELOPMENT.md`) requires recording when architecture changes.

## Consequences

- Disco Voador now distributes two clearly separate products with no infrastructure dependency
  between them: **Disco Voador Client** (`apps/desktop`) and **Disco Voador Dedicated Server**
  (`services/dedicated-server`). See [`docs/architecture/DEDICATED_SERVER.md`](../architecture/DEDICATED_SERVER.md)
  for the full design this ADR authorizes.
- `services/realtime` remains independently runnable and testable exactly as it was before T8
  (`pnpm --filter @disco-voador/realtime run dev`); its own tests and consumers required no changes
  beyond the `cli.ts`/`index.ts` split.
- The realtime protocol version bumped 2 → 3: `server:hello` gained required `serverName`/
  `serverCapabilities` fields so a client learns which server it connected to and what it offers,
  without a second, parallel HTTP API — reusing the same strict, versioned protocol package
  identity/voice signaling already use.
- Voice channels became server-owned configuration (a Dedicated Server's config file) rather than a
  client-side hardcoded constant — the one piece of this task with real client-visible product
  behavior beyond "you now have to type an address."
- `apps/desktop`'s Renderer gained an explicit connect/disconnect state machine and a manually
  entered server-address screen, replacing the previous "always auto-connect to one implicit
  development server" behavior — a client can now connect to, disconnect from, and reconnect to a
  _different_ independently-operated server within one running app instance, with no server-specific
  state leaking between connections (verified: T3–T7's existing effect-teardown lifecycle already
  handled this correctly with zero new teardown code).
- This ADR does not implement T9 (server-local permissions/groups/invite tokens/bans), T10 (text
  chat), T13 (production TLS/TURN/Docker packaging), or T14 (installer/release distribution) — all
  remain future tasks that build _on top of_ the product boundary this task establishes.

## Alternatives

- **Rename `services/realtime` in place:** rejected — would conflate "generic realtime transport
  library" and "the Dedicated Server product" into one thing, making a future second consumer of the
  transport layer (unlikely today, but the same reasoning `packages/rtc-core` already follows for
  environment-neutral reuse) harder rather than easier, and would have required either duplicating
  or awkwardly overloading the existing, already-tested `services/realtime` test suite with
  product-specific concerns it has no reason to know about.
- **`apps/dedicated-server`:** rejected — contradicts this repository's own established meaning of
  `apps/*` (Electron GUI-shell composition specifically); a headless server product is not that,
  even though both are, in a loose sense, "top-level deployables."
- **Fork/copy `services/realtime`'s logic into the new workspace:** rejected outright, and not
  seriously considered — this repository has exactly one canonical realtime implementation by
  design; duplicating it would immediately create two codepaths to keep in sync and directly
  contradicts the task's own explicit instruction to compose, not duplicate, T2-T7 logic.
