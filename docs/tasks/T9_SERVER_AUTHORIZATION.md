# T9 — Server-local groups, permissions, invite/privilege tokens, and bans

## Goal

Give the Disco Voador Dedicated Server (T8) its first authorization model: server-local groups and
permissions keyed by T7's cryptographic `identityId`, TeamSpeak-style privilege/invite bearer
tokens, identity-based bans, and a one-time Server Admin bootstrap token so a fresh server's
operator can administer it without ever creating an account or password. This is **not** an account
system — a Dedicated Server remembers "this identityId is Server Admin here," never "this human owns
a Disco Voador account." The same identity can be Server Admin on one server and an ordinary Guest
on another, with no relationship between the two.

## Context

T7 gave every client a local cryptographic identity a server can verify. T8 turned the realtime
backend into an independently-operated Dedicated Server product with no persistent runtime state.
Neither task added any notion of authorization — every authenticated connection could do everything
an authenticated connection could do. T9 is the first task to introduce persistent Dedicated Server
runtime state at all, and the first to distinguish _authentication_ ("which identity is this?",
answered by T7) from _authorization_ ("what is that identity allowed to do here?", answered by this
task).

## In scope

- Server-local RBAC: three built-in protected groups (Guest, Member, Server Admin), custom groups an
  administrator can create/update/delete, a small closed permission registry.
- Persistent identity -> group membership, but **never** for a Guest with no concrete reason to
  persist (data minimization — T9 Section 8).
- A SQLite-backed authorization store (`node:sqlite`, zero new dependencies — see
  [ADR 0013](../adr/0013-server-authorization-storage-and-rbac.md)) with restart persistence and
  atomic token consumption.
- Bearer tokens: privilege keys (admin-issued, any target group), invite tokens (admission-time,
  invite-only servers), and a one-time Server Admin bootstrap token.
- Identity-based bans (permanent or temporary), enforced at admission and live against an already-
  connected participant.
- Server access modes: `open` (default, non-persistent Guest baseline) and `invite-only`.
- Minimal, functional server administration UI (groups, tokens, bans, per-participant moderation),
  gated presentationally by the connection's own permissions but always re-enforced server-side.
- Full protocol/architecture documentation: see
  [`docs/architecture/SERVER_AUTHORIZATION.md`](../architecture/SERVER_AUTHORIZATION.md) for the
  complete design.

## Out of scope

Text chat (T10), device/bookmark/reconnect UX overhaul (T11), process/game-specific audio (T12),
production TURN/TLS/Docker packaging (T13), installer/release distribution (T14), monetization,
licensing, central accounts of any kind, cross-server authorization state, IP/hardware-fingerprint
bans, a full admin web dashboard, and TeamSpeak's own numeric permission-priority/skip/power system
(a small, explicit, additive RBAC model was used instead — see ADR 0013).

## Architecture constraints

- Authentication (T7) and authorization (T9) remain layered, never merged — admission is evaluated
  strictly after the identity proof succeeds, never in place of it.
- `services/realtime` stays authorization-model-agnostic: it depends only on the narrow
  `AuthorizationPort` interface (`services/realtime/src/authorization-port.ts`), defaulting to a
  permissive no-op implementation when nothing is injected, mirroring T8's `voiceChannels`/
  `serverMetadata` seam exactly.
- The authorization store and RBAC logic live inside `services/dedicated-server`, not a new shared
  package — see [ADR 0013](../adr/0013-server-authorization-storage-and-rbac.md) for why.
- Every `AuthorizationPort`/`AuthorizationStore` method is synchronous, preserving the connection
  state machine's existing fully-synchronous design and making token-redemption atomicity a
  structural guarantee, not a best-effort one.
- No client message ever asserts its own authorization — every mutation is re-validated
  server-side against the caller's _actual_ current permissions; targets are resolved from
  server-owned state (`participantId` -> identity), never trusted from the client, with the single
  documented exception of `client:authorization-unban`'s `identityId` (an administrator managing
  bans legitimately needs it; T9 Section 25).

## Relevant packages

`services/dedicated-server` (new `authorization/` module), `services/realtime` (new injection seam),
`packages/protocol` (new authorization schemas), `apps/desktop` (connection-screen token field,
`AuthorizationPanel`, participant badges).

## Relevant agents

`realtime-backend-engineer` for the protocol/handler wiring; `software-architect` for the storage/
package-boundary decision (see ADR 0013); `electron-desktop-engineer` for the client UI;
`security-reviewer` and `qa-engineer` before completion.

## Relevant skills

`project-orientation`, `planning-feature`, `realtime-protocol`, `self-hosting`, `security-review`,
`testing-quality`.

## Acceptance criteria

- A fresh Dedicated Server generates a one-time bootstrap Server Admin token, printed once, never
  persisted in raw form, never shown again.
- Redeeming it grants Server Admin; this survives a server restart against the same data directory.
- An admitted Guest with no concrete reason to persist creates no database row.
- `open` and `invite-only` access modes both work as specified, including the bootstrap-token-as-
  invite fix for a fresh invite-only server.
- Tokens (privilege, invite, bootstrap) are single-use, digest-only in storage, expire correctly,
  and are provably atomic under concurrent redemption attempts.
- Bans are identity-based, support permanent and temporary durations, apply at admission and live
  against an already-connected participant, and are reversible.
- The last Server Admin can never be removed by any combination of group edits or membership
  revocation.
- Every privileged mutation is server-enforced regardless of what any client UI shows or omits.
- Two independent Dedicated Servers share no authorization state whatsoever — proven with real
  sockets, not asserted.
- A real Electron client can complete the full bootstrap -> redeem -> ban -> reject -> unban ->
  reconnect journey with its identity unchanged throughout.
- Existing T3–T8 capabilities (voice/camera/screen/screen-audio media, T7 identity auth/persistence,
  T8 connection UX) show no regression under the new mandatory admission gate.

## Definition of Done

See [`../DEFINITION_OF_DONE.md`](../DEFINITION_OF_DONE.md). T9 additionally required:
`docs/architecture/SERVER_AUTHORIZATION.md` written (done); ADR 0013 recorded (done); the Dedicated
Server smoke test and all pre-existing media/identity/connection E2E scripts re-verified against the
real product entrypoint under T9's new mandatory admission gate (done); a new real-Electron
authorization E2E passing (done, three consecutive clean runs); security and QA review of the new
surface, including any findings fixed (done — see [Security and QA review](#security-and-qa-review)
below).

## Handoff notes

### What is real and verified

- **Protocol** (`packages/protocol/src/authorization.ts`,
  `packages/protocol/src/messages/authorization.ts`): permission/group/token/ban schemas, twelve new
  client message types, six new server message types, two new fatal + eight new non-fatal error
  codes — all additive; `CURRENT_PROTOCOL_VERSION` intentionally not bumped (see
  `docs/architecture/REALTIME_PROTOCOL.md`'s evolution policy).
- **`services/realtime`**: `AuthorizationPort` injection seam, `Connection` now retains its own
  `identityId`, `RouteResult` gained an optional `identityId`, `OutgoingAction` gained a `'close'`
  variant for moderation actions targeting a different connection than the sender, `VoiceRegistry`
  gained `identityId`-aware records and `findByParticipantId`.
- **`services/dedicated-server/src/authorization/`**: `AuthorizationStore` (implements
  `AuthorizationPort` against real `node:sqlite`), `migrations.ts`, `permissions.ts` (built-in
  groups/registry), `token-crypto.ts`. Composition root (`create-dedicated-server.ts`) opens the
  store before `start()` is ever called, so a corrupt/unreadable store fails composition
  immediately — fail-closed, per T9 Section 69.
- **Desktop client**: `ConnectionScreen`'s optional Server Token field, `AuthorizationPanel.tsx`
  (redemption, groups, tokens, bans, per-participant moderation — gated by `myPermissions`, always
  server-re-enforced), participant group badges, `use-voice-channel.ts`'s new authorization
  state/actions.
- **Tests**: 90 store-level tests (`tests/dedicated-server/authorization-store.test.ts`), a real-
  socket "T9 authorization" suite in `tests/dedicated-server/integration.test.ts`, and (added during
  the security/QA follow-up fixes below) 16 new `protocol-handlers.ts` unit tests covering the six
  previously-untested authorization handlers — **740 total Vitest tests project-wide** (up from 667
  at the end of T8), all passing.

### E2E evidence

- **`pnpm --filter @disco-voador/dedicated-server run smoke`**: extended to capture and redeem the
  real bootstrap token over a real socket through the real product CLI — passed.
- **`pnpm --filter @disco-voador/desktop run e2e:authorization`** (new): a real Electron client's
  full bootstrap/redeem/ban/reject/unban/reconnect journey, same local identity throughout — **three
  consecutive clean runs** (two before the security/QA follow-up fixes, one more afterward against a
  freshly repackaged build, confirming no regression from either fix; the `INVITE_REQUIRED` close-
  code correction itself is exercised by the dedicated `integration.test.ts` revoke-group test, not
  this script's own ban/kick paths). Found and fixed a real Windows-specific bug while building it:
  relaunching
  the same `--user-data-dir` immediately after externally killing the previous instance produced a
  reproducible `safeStorage`/DPAPI decrypt failure; fixed by having each instance exit via Electron's
  own `app.exit()` (the same technique `e2e-identity-persistence.mjs` already used) instead of an
  external `kill()`.
- **`e2e:voice-smoke`, `e2e:camera-smoke`, `e2e:screen-smoke`, `e2e:screen-audio-smoke`,
  `e2e:identity-auth`, `e2e:identity-persistence`, `e2e:connection-smoke`**: all re-verified passing
  against T9's default `open` access mode — no regression from the new mandatory admission gate.

### Security and QA review

`security-reviewer` and `qa-engineer` were dispatched independently against the full T9 surface.
Both reported **no release-blocking findings**; two real, non-blocking gaps were found and fixed
before sign-off.

**Security review** — verdict: no release-blocking findings. Confirmed by direct code reading (not
doc-trust): SQL parameterization throughout, bootstrap key entropy/one-time-ness/no-logging, token
entropy and digest-only storage, atomic redemption (traced the full call chain and confirmed no
`await` exists between the compare-and-swap check and write), invite-only admission gating
unbypassable, all handlers server-side enforced, target/participant resolution never trusts a
client-supplied identity (except the documented `unban` exception, still permission-gated),
immediate ban enforcement, data minimization (Guest writes no row), no accidental central service,
and E2E automation hooks unreachable in a packaged build.

One **Medium, non-blocking** finding: `deleteGroup()` lacked the same `stillAdmitted`/force-
disconnect symmetry `revokeGroup()` already had. Concrete scenario: on an `invite-only` server, if
an admin deletes a custom group that was an online identity's _sole_ persistent membership, the FK
cascade silently removed the membership row without closing that identity's live connection or
signaling that its admission basis was gone — its live session would keep evaluating permissions
against the Guest baseline for the rest of that connection. **Fixed**: `deleteGroup()` now computes
and returns `noLongerAdmitted: readonly string[]` (mirroring `RevokeGroupResult.stillAdmitted`),
and `handleAuthorizationDeleteGroup` force-closes every online connection for an affected identity,
via a new `VoiceRegistry.findAllByIdentityId()` lookup. Regression tests added at both the
`AuthorizationStore` unit layer and the `protocol-handlers.ts` unit layer (force-close wiring,
using a mock `AuthorizationPort`).

**QA review** — re-ran and independently verified the full test suite (`pnpm vitest run` — 53
files, 723 tests passing before QA's own edits), `pnpm typecheck`, `pnpm lint`, `pnpm build`, the
Dedicated Server smoke test, the real-Electron `e2e:authorization` script, and `e2e:connection-
smoke`, plus 4 repeated runs of `tests/dedicated-server/integration.test.ts` to rule out flake.
Fixed one latent test-only race risk (an undrained second reply after `client:authorization-redeem-
token`, the same "two replies from one redemption" pattern already documented as a hazard in
`e2e-authorization.mjs`) and added a new integration test proving `revokeGroup`'s force-close
branch actually closes a live connection over a real socket — no test had exercised it before.

While building that test, QA found a second **minor, non-blocking** finding: the force-close for a
revoked-to-no-admission-basis identity used the `AUTHORIZATION_DENIED` error code, which has no
entry in `CLOSE_CODE_BY_ERROR` and silently fell back to the generic `INTERNAL_ERROR` (4500) WS
close code — misleading, since nothing had actually gone wrong server-side. **Fixed**: both
`handleAuthorizationRevokeGroup`'s and the new `handleAuthorizationDeleteGroup`'s force-close paths
now use `INVITE_REQUIRED` (4420) instead — it already has a real close-code mapping and accurately
describes _why_ the connection can no longer stay open (no remaining admission basis under this
server's current access rules). Verified with an updated integration test asserting both the
message-level code and the real WS close code (4420).

QA also flagged, as the most actionable non-blocking follow-up, that six handlers
(`kick`, `list-bans`, `list-groups`, `update-group`, `delete-group`, `grant-group`) had no test
coverage at any layer beyond `AuthorizationStore` unit tests — `protocol-handlers.ts`'s own
permission-check-then-mutate wiring for those six was unverified. **Closed**: 16 new unit tests
added to `tests/realtime/protocol-handlers.test.ts` (permission-denied paths, `resolveTarget`
not-found paths, and success paths for all six, including the `deleteGroup` force-close wiring and
confirmation that `kick` creates no persistent ban).

**Post-review verification** (after both fixes): one canonical `corepack pnpm check` run — Prettier,
ESLint, whole-repo typecheck, `vitest run` (53 files, **740 tests**, up from 723), composite build,
`verify-repository.mjs`, and the dependency audit all pass; Dedicated Server smoke test re-run and
passing; `e2e:authorization` re-run against a freshly packaged Electron build and passing (third
consecutive clean run) with no regression from either fix.

### Privacy statement

T9 introduces the Dedicated Server's first persistent runtime state, and nothing beyond what
server-local authorization actually requires: `identityId`s, group memberships, token digests
(never raw tokens), and ban records. No email, phone, real name, password, hardware fingerprint, IP
address, or nickname is ever persisted by the authorization store. A Guest with no concrete
authorization event (no invite/privilege redemption, no admin grant, no ban) creates no database row
at all. No cross-server authorization state exists or is introduced — two independent Dedicated
Servers share nothing, even for the same connecting identity.

### Next task

T9 is marked COMPLETE in [`STATUS.md`](STATUS.md) — security/QA review sign-off, both non-blocking
findings fixed, and a closing `corepack pnpm check` run all done. **T10 — Minimal/ephemeral text
chat** is next, expected to continue the same privacy philosophy (server-local, minimal retention,
no central history). Do not implement T10 as part of T9.
