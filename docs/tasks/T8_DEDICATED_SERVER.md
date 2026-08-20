# T8 — Dedicated Server product boundary

## Goal

Turn the previously-internal `services/realtime` backend into an explicitly independently-operated
**Disco Voador Dedicated Server** product that any user can self-host, and that the desktop client
connects to directly — with no mandatory Disco Voador–operated infrastructure anywhere in the path.
After T8, Disco Voador Dedicated Server A and someone else's Disco Voador Dedicated Server B can run
with no relationship between those installations and no Disco Voador–operated control plane. The
software project distributes the tools; the server operator runs the server; the client chooses
where to connect.

## Context

T0–T7 delivered the full P2P media-engineering vertical (voice, camera, screen-video, screen-audio)
and local cryptographic client identity (T7) against a realtime service that, until now, only ever
ran as an internal dependency of the test/dev tooling — no E2E script, and no real desktop session,
ever connected to anything a person would call "a server they chose." ADR 0010 recorded the
product-direction guardrail this task implements a concrete piece of; ADR 0011 (T7) implemented the
identity half of that architecture. T8 implements the server-product half: a real, standalone,
configurable, independently runnable server process, and a client that explicitly connects to one
instead of an implicit development default.

## In scope

- A new workspace, `services/dedicated-server` (`@disco-voador/dedicated-server`) — the product's
  composition root, configuration loader, CLI/process entrypoint, and startup banner.
- A dependency-injection seam in `services/realtime` (`voiceChannels`/`serverMetadata` on
  `RealtimeServerDependencies`) so a composing product can supply its own channel catalog and server
  identity instead of the previous hardcoded defaults every consumer shared.
- Typed, strictly validated server configuration: a JSON config file plus environment variables
  (`defaults < file < environment`), covering server name, listen host/port, connection cap, and the
  voice-channel catalog.
- Server-owned voice channels delivered to the client via the existing `voice:catalog` message — no
  more client-side hardcoded channel constant.
- Server metadata (`serverName`, `serverCapabilities`) added to `server:hello` — protocol version
  bumped 2 → 3.
- A real desktop connection UX: an explicit `ConnectionScreen` (nickname context, server-address
  field, Connect button — no login/password/email), a `parseServerAddress` parser (hostname/IPv4/
  bracketed-IPv6/`localhost` + port), an explicit Disconnect action, and the ability to connect to a
  second, independent server within one running app instance with no leaked session state.
- Graceful startup/shutdown (`SIGINT`/`SIGTERM`), clear config-validation/port-collision/
  server-full failure behavior.
- Two-independent-server isolation proof (real sockets, real ports, in one Vitest process) and a
  standalone Dedicated Server smoke test, both exercising the real product entrypoint.
- Updated all six pre-existing Electron E2E scripts to launch the real Dedicated Server CLI entry
  instead of a bypassed internal path, plus one new connection-specific E2E.

## Out of scope

T9 (server-local groups/permissions/invite tokens/bans), text chat (T10), game/process-specific
audio (T12), TURN/TLS production deployment and Docker packaging (T13), installer/release
distribution (T14), monetization, licensing, a public server directory, and any Disco
Voador–operated cloud service. No global server password, no admin UI/API, no hot-reload, no
SQLite/database introduced merely because the server is now a standalone product.

## Architecture constraints

- `services/dedicated-server` composes `@disco-voador/realtime` as an ordinary package dependency —
  it does not fork, copy, or duplicate any protocol/session logic. There is exactly one canonical
  realtime implementation.
- `services/realtime` remains a reusable, product-agnostic library, unchanged in identity/branding,
  independently runnable exactly as before T8.
- `services/dedicated-server` never depends on Electron, the Renderer, or desktop application state
  — it is a standalone Node process, runnable headless.
- Configuration is parsed/validated once, near startup, into a typed object — no scattered
  `process.env` reads in low-level packages.
- No account/user database is introduced anywhere by this task.
- See [`docs/adr/0012-dedicated-server-product-boundary.md`](../adr/0012-dedicated-server-product-boundary.md)
  for the full composition decision and rationale.

## Relevant packages

`services/dedicated-server` (new), `services/realtime`, `packages/protocol`, `packages/config`,
`apps/desktop` (Renderer connection UX, Main E2E gating).

## Relevant agents

`software-architect` for the `services/realtime`-vs-Dedicated-Server boundary decision;
`realtime-backend-engineer`/`infrastructure-engineer` for the server product implementation;
`electron-desktop-engineer` for the client connection UX; `security-reviewer` and `qa-engineer`
before completion.

## Relevant skills

`project-orientation`, `planning-feature`, `realtime-protocol`, `self-hosting`,
`electron-development`, `security-review`, `testing-quality`.

## Acceptance criteria

- The Dedicated Server starts independently of the desktop client, with a clear startup banner and
  no secrets ever printed.
- Typed, validated configuration exists (name, listen host/port, connection cap, voice channels);
  invalid configuration and port collisions fail clearly and non-destructively.
- Voice channels are server-owned; a client renders whatever channel list the connected server
  actually configured, with zero source-code change required to connect to a differently configured
  server.
- The client requires an explicit, manually entered server address; there is no login/password/email
  field anywhere, and no auto-connect in a packaged build.
- The client can disconnect, and can connect to a second, independent server within the same running
  app instance, with no server-specific session state leaking between the two.
- The same local T7 identity authenticates independently to two different Dedicated Servers, with no
  cross-server correlation of any kind.
- Two independent Dedicated Server instances are proven isolated (sessions, channel state, signaling,
  metadata) against real sockets.
- No central server directory, no mandatory Disco Voador cloud service, and no new user/account
  database exist anywhere in the result.
- All four pre-existing media E2Es (voice/camera/screen/screen-audio) and both T7 identity E2Es pass
  through the real Dedicated Server product entrypoint, not a bypassed internal path.
- A dedicated Dedicated Server smoke test and a real-Electron desktop connection smoke test both
  pass.
- Security and QA review of the new server/client surface.

## Definition of Done

See [`../DEFINITION_OF_DONE.md`](../DEFINITION_OF_DONE.md). T8 additionally requires:
`docs/architecture/DEDICATED_SERVER.md` written (done); ADR 0012 recorded (done); all six E2E
scripts re-verified against the real Dedicated Server entrypoint (done); a passing Dedicated Server
smoke test (done) and desktop connection E2E (done); security and QA review of the new surface (see
below).

## Handoff notes

### What is real and verified

- **`services/dedicated-server`**: `config.ts` (config-file + environment precedence, reusing
  `@disco-voador/realtime`'s already-tested `loadRealtimeConfig` rather than a parallel
  implementation), `server-config-file.ts` (strict JSON schema, duplicate-channel-id rejection,
  fail-closed on any read/parse/validation error except a genuinely absent file),
  `create-dedicated-server.ts` (the composition root — `createDedicatedServer(config, deps)`,
  process-lifecycle-free, directly integration-testable), `cli.ts` (startup banner, signal handling,
  the only place that touches `process.env`/`process.exit`).
- **`services/realtime`'s new seam**: `RealtimeServerDependencies.voiceChannels`/`.serverMetadata`,
  both optional and defaulting to the pre-T8 values — zero existing consumers changed.
  `services/realtime/src/index.ts` (barrel) and `cli.ts` (bootstrap, renamed from the old `index.ts`)
  split apart so importing the package as a library no longer has the side effect of starting a
  server.
- **`packages/protocol`**: `server-metadata.ts` (new `serverNameSchema`/`serverCapabilitySchema`/
  `serverCapabilitiesSchema`), `server:hello` extended with required `serverName`/
  `serverCapabilities`, protocol version bumped 2 → 3.
- **Desktop client**: `parse-server-address.ts` (16 unit tests, `URL`-parser-based, correctly handles
  bracketed IPv6), `ConnectionScreen.tsx`, `App.tsx`'s new connect/disconnect state machine (reusing
  T3–T7's existing effect-teardown lifecycle with zero new teardown code), `realtime-client.ts`'s new
  `'authenticating'` state and `serverInfo` event, `use-voice-channel.ts`/`VoiceChannelView.tsx`
  rendering the received server name/capabilities.
- **Tests**: `tests/dedicated-server/server-config-file.test.ts` (18), `config.test.ts` (8),
  `integration.test.ts` (6, real sockets, real ephemeral ports, two independent server instances,
  cross-server identity reuse, port collision, in-process graceful shutdown, server-full) — 32 total.
  Existing suites updated: `tests/protocol/server-messages.test.ts`, `tests/realtime/connection.test.ts`,
  `tests/realtime/protocol-handlers.test.ts`, `tests/realtime/integration.test.ts`,
  `tests/desktop/realtime-client.test.ts`, `tests/desktop/content-security-policy.test.ts`,
  `tests/desktop/protocol-handler-headers.test.ts`, `tests/desktop/ipc.test.ts`, plus the new
  `tests/desktop/parse-server-address.test.ts` (16). 667 total Vitest tests project-wide.

### E2E evidence

- **`pnpm --filter @disco-voador/dedicated-server run smoke`**: real process spawn, real `ws`
  client, full T7 handshake, `server:hello` (serverName/serverCapabilities asserted), voice-channel
  catalog, disconnect, `SIGTERM` — passed. (Windows cross-process `SIGTERM` does not reach the
  child's own signal handler — a known, already-documented Node/Windows limitation, see
  `DEDICATED_SERVER.md`; the smoke script accounts for this, and the underlying graceful-shutdown
  logic is separately verified in-process by the integration test suite.)
- **`apps/desktop/scripts/e2e-connection-smoke.mjs`** (new, Section 58): one real, unpackaged
  Electron instance starts disconnected, connects to a real Dedicated Server configured with a
  distinctive name (`"Connection Smoke Test Server"`) and a single custom channel, authenticates via
  T7 identity, and renders the server's actual configured name — passed. After the security review's
  CSP finding (see below), the script was strengthened to deliberately point
  `DISCO_VOADOR_REALTIME_URL` at an always-refused decoy address while connecting to the real server
  through a separate override — proving the fix genuinely restores the ability to reach an address
  different from the one baked in at launch, not just an address that happened to match. Re-verified
  passing after the fix and after `qa-engineer`'s separate `serverName`-validation fix.
- **`e2e:voice-smoke`, `e2e:camera-smoke`, `e2e:screen-smoke`, `e2e:screen-audio-smoke`,
  `e2e:identity-auth`, `e2e:identity-persistence`**: all six re-verified passing against the real
  Dedicated Server product entrypoint (`services/dedicated-server/dist/cli.js`), launched via the new
  shared `start-dedicated-server.mjs` helper rather than a bypassed internal path — no regression
  from the connect/disconnect UX change or the mandatory-address requirement.

### Security and QA review

**`security-reviewer`** found one release-blocking issue, fixed before completion: through T7, the
Renderer's Content-Security-Policy `connect-src` allowlisted exactly one pre-declared realtime
origin (the deployment-fixed `DISCO_VOADOR_REALTIME_URL`). T8's `ConnectionScreen` made the server
address a genuine runtime, user-typed value, but the CSP wiring was never updated to match — a real
user typing any address other than the one baked in at launch would have had every connection
attempt silently blocked by Chromium's own CSP enforcement, defeating T8's core "connect to
whichever address your operator gives you" deliverable outside of test tooling that happened to set
matching environment variables. Fixed by scoping `connect-src` to the `ws:`/`wss:` schemes
generically (`apps/desktop/src/main/content-security-policy.ts`) rather than one pre-declared
origin — every other directive stays exactly as restrictive as before. Verified with a genuine
regression test: `e2e:connection-smoke` was changed to point `DISCO_VOADOR_REALTIME_URL` at an
always-refused decoy address while connecting to the real server through a separate,
E2E-only-`connectUrl` override — proving the fix actually restores the ability to reach an address
different from the one baked in at launch, the exact scenario the finding described. No other
release-blocking issues were found; the review separately confirmed config-parsing fail-closed
behavior, identity-gate integrity, no auth bypass, bounded/validated server metadata, genuine
per-instance (non-shared) server state, logging discipline, and correct E2E production gating — all
by direct code reading, not by trusting doc comments.

**`qa-engineer`** ran the full suite (667/667 passing), re-ran the Dedicated Server smoke test and
`e2e:connection-smoke` directly, and found and fixed one real bug: the config file's `name` field and
the `DISCO_VOADOR_SERVER_NAME` environment override both used weaker bounds than the wire protocol's
`serverNameSchema` (max 100 chars, no control characters). A server configured with a name violating
those bounds started successfully with no error, then sent that invalid name in a real `server:hello`
— which a real client's `.strict()`-validated `parseServerMessage` silently rejected, leaving the
client hung in "connecting" with no visible error. Reproduced end to end (real server, real client)
before fixing. Fixed by reusing the shared `serverNameSchema` from `@disco-voador/protocol` in both
`server-config-file.ts` and `config.ts`, so an invalid name now fails config loading loudly, before
the server ever binds a socket — consistent with every other field's existing behavior. Added 4
regression tests (2 at the config-file layer, 2 at the environment-override layer). Also confirmed:
no hardcoded client-side channel list remains, dynamic channel/server-metadata delivery traced
end-to-end, connect/disconnect/reconnect teardown correct by direct code reading, all six E2E scripts
launch the real Dedicated Server entrypoint (not a bypassed internal path), and no
racing-`ws.once('message')`-style false-positive test pattern exists in the new suite. One
non-blocking note recorded, not fixed in T8: `ConnectionScreen`'s `connectionError` prop is currently
always `undefined` in `App.tsx` — there is no user-visible error message yet for a failed connection
attempt (wrong address, server down, protocol mismatch); a user hits a silent stuck "Connecting…"
state instead. This does not violate any T8 acceptance criterion (T8 never promised connection-
failure UX) but is a real, worthwhile follow-up for T9/T11 to pick up.

### Privacy statement

T8 introduces **no** central account service, no server directory, no mandatory Disco
Voador–operated cloud service, and no new user/account database, client- or server-side. A Dedicated
Server holds connection state only for a connection's lifetime; its config file holds only
display/network/channel settings an operator authored themselves. The same local T7 identity may
authenticate independently to any number of Dedicated Servers with no service anywhere correlating
those connections.

### Next task

**T8 is COMPLETE** — see [`STATUS.md`](STATUS.md). All acceptance criteria and
[`DEFINITION_OF_DONE.md`](../DEFINITION_OF_DONE.md) items are satisfied; security and QA review both
completed with their findings fixed (see above); the full `corepack pnpm check` gate passes (667
Vitest tests, formatting, lint, whole-repo typecheck, composite build, repository verification, and
the dependency audit — the same one pre-existing, already-allowlisted high-severity advisory carried
since T0, no new advisories). **T9 — Server-local groups, permissions, invite/privilege tokens,
bans** is next, all keyed by T7's `identityId` and scoped per-server per this task's isolation
guarantee. Do not implement T9 as part of T8.
