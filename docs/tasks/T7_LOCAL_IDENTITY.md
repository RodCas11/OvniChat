# T7 — Local cryptographic client identity

## Goal

Every Disco Voador client has a local cryptographic identity — an Ed25519 keypair generated and
kept on the client, proven to a realtime server via a challenge/response handshake — with no
central account, no email, no password, and no global user database anywhere. The user experience
is old-school TeamSpeak: choose a nickname, connect, the client already knows who it is
cryptographically.

## Context

T0–T6 delivered the full P2P media-engineering vertical (voice, camera, screen-video, screen-audio)
against a realtime service with no authentication at all — `connectionId` was explicitly documented
as not an identity signal. ADR 0010 recorded the product-direction guardrail (no mandatory central
accounts/control plane) and anticipated T7 as the first step toward the real TeamSpeak-style product
architecture: local identity, an eventual independently-operated Dedicated Server (T8), server-local
permissions (T9). T7 implements the identity half of that chain.

## In scope

- **Ed25519 keypair generation, signing, and verification** — new `packages/identity` (Node-only,
  Main-process/`services/realtime`-only).
- **Private key storage**: OS-encrypted (`safeStorage`/Windows DPAPI) on disk at
  `%APPDATA%/DiscoVoador/identity/identity.json`, atomic writes, corruption detection that never
  silently regenerates.
- **A stable, server-derived `identityId`** (`dv1_<base64url(SHA-256(publicKey))>`).
- **A challenge/response handshake** inserted into the existing T2 handshake: `client:hello` gains
  `nickname`/`publicKey`; a new `server:identity-challenge` / `client:identity-proof` exchange must
  succeed before `server:hello` (now carrying `identityId`) is ever sent.
- **Nickname as a client-local preference**, explicitly not identity — editable without regenerating
  anything, never a server-side registry key.
- **A narrow, anti-oracle Main/Preload/Renderer boundary**: the Renderer can request a public
  identity or a signature over a specific structured challenge; it can never see or extract the
  private key, or use the signing API to sign arbitrary data.
- **An explicit, confirmation-gated, destructive "Regenerate Identity" action** — never automatic.
- **A minimal first-run nickname prompt and a settings Identity panel** (nickname, Identity ID +
  Copy, Regenerate) — no account/login/password UI language anywhere.
- Two new dedicated E2E scripts (`e2e:identity-persistence`, `e2e:identity-auth`) plus re-verification
  of all four existing media E2Es under the new mandatory identity gate.

## Out of scope

Central accounts, email/password/phone/social login, a global user database, a Dedicated Server
product package (T8), server-local permissions/groups/invite tokens/bans (T9), text chat (T10),
portable identity export/backup, multiple-local-identity management UI, monetization, ads, and a
mandatory Disco Voador cloud/control-plane service.

## Architecture constraints

- `packages/identity` is Node-only and importable only by `apps/desktop/src/main/**` and
  `services/realtime` — never Renderer/Preload, never the environment-neutral packages
  (`protocol`/`rtc-core`/`media-core`/`shared`). Enforced by `scripts/verify-architecture.mjs`'s new
  `isIdentity()` check.
- `packages/protocol` stays crypto-free — wire schemas and a pure canonical-payload builder only —
  so it remains safe for the sandboxed Renderer to import directly.
- The private key never crosses into the Renderer in any form. `signIdentityChallenge`'s IPC surface
  accepts only structured, bounded parameters; Main reconstructs the canonical payload itself from
  its own stored public key, never trusting one the Renderer supplies.
- The server never trusts a client-supplied `identityId` — it always re-derives it from the verified
  public key.
- No account/users/profile database is introduced anywhere, client or server. Server-side identity
  state is connection-lifetime only.
- Identity verification happens once at connection setup, not continuously.

## Relevant packages

`packages/identity` (new), `packages/protocol`, `services/realtime`, `apps/desktop` (Main, Preload,
Renderer).

## Relevant agents

`software-architect` for the `packages/identity` boundary decision; `webrtc-media-engineer`/
`realtime-backend-engineer` for the handshake state machine; `electron-desktop-engineer` for the
Main-process identity service, IPC surface, and Renderer UI; `security-reviewer` for the private-key
storage, IPC anti-oracle design, and challenge-security review; `qa-engineer` for first-run/
persistence/corruption/replay/regression review.

## Relevant skills

`project-orientation`, `planning-feature`, `electron-development`, `testing-quality`,
`security-review`.

## Acceptance criteria

- First launch generates a local identity with no email/password/account of any kind.
- Nickname is independent of identity: changing it never regenerates the keypair.
- The private key never reaches the Renderer, in any form.
- The private key is never stored in plaintext; secure storage is unavailable → fail closed with an
  actionable error, never a plaintext fallback.
- Identity survives an app restart against the same profile; a different profile gets a different
  identity.
- The server always derives `identityId` from the verified public key — never a client-supplied
  value.
- The challenge uses secure randomness, is single-use, connection-bound, and expires.
- A replayed, cross-connection, wrong-key, or expired proof is rejected before `ready`.
- All four pre-existing media E2Es still pass under the new mandatory identity gate.
- A dedicated identity-persistence E2E and identity-authentication E2E each pass 3 consecutive clean
  runs on final code.
- Security and QA review of the new private-key/IPC/protocol surface.

## Definition of Done

See [`../DEFINITION_OF_DONE.md`](../DEFINITION_OF_DONE.md). T7 additionally requires:
`e2e:identity-persistence` and `e2e:identity-auth` each passing 3 consecutive clean runs (done); all
four pre-existing media E2Es re-verified green under the new identity gate (done);
`docs/architecture/CLIENT_IDENTITY.md` written (done); ADR 0011 recorded (done); security and QA
review of the new surface (see "Security and QA review outcomes" below).

## Handoff notes

### What is real and verified

- **Ed25519 via `node:crypto`**: live-verified against this project's pinned Node runtime —
  `generateKeyPairSync('ed25519')`, JWK raw-byte extraction (`x`/`d`), round-trip reconstruction, and
  safe (`false`-returning, non-throwing) handling of a schema-valid-but-degenerate (all-zero) key. No
  third-party crypto dependency was added.
- **`packages/identity`**: keygen/sign/verify/identityId-derivation/nonce-generation, 14 unit tests
  covering round-trip signing, cross-key/tampered-payload rejection, degenerate-key safety, and
  malformed-input `IdentityCryptoError` paths.
- **`packages/protocol`'s identity schemas and `buildIdentityAuthPayload`**: bounded, pattern-
  validated wire schemas plus the pure, environment-neutral canonical-payload builder; protocol
  version bumped 1 → 2 (breaking: `client:hello` gained required fields).
- **`services/realtime`'s full challenge/proof state machine**: new `awaiting_identity_proof`
  connection state, per-connection `pendingChallenge` tracking, server-side signature verification
  and `identityId` derivation via `@disco-voador/identity`. The existing handshake timer now also
  covers the new state. 103 realtime tests, including an exhaustive replay-resistance matrix (valid
  proof; same-connection replay; cross-connection replay; expired challenge; modified-nickname
  signature; wrong-key signature; degenerate public key) and full real-socket integration coverage.
- **`apps/desktop/src/main/identity/`**: `identity-service.ts` (load-or-create with in-flight race
  protection, `safeStorage`-encrypted persistence, public/private key mismatch self-check, explicit
  destructive regeneration), `identity-file.ts` (atomic write, versioned schema, corruption
  detection), `nickname-store.ts` (a fully separate preferences file — nickname is never identity).
  20 unit tests against a real temporary `userData` directory (real file I/O, real atomic writes,
  real crypto — only the OS-level `safeStorage` half is faked, with a simple reversible transform).
- **A narrow, anti-oracle IPC surface**: `getIdentity`, `signIdentityChallenge`, `regenerateIdentity`,
  `getNickname`, `setNickname` — all five behind the same `assertTrustedSender` check every other IPC
  channel in this app uses, with `signIdentityChallenge` accepting only structured, bounded
  parameters (never raw bytes to sign).
- **Renderer**: `IdentitySigner`/`IpcIdentitySigner` (a narrow, IPC-shaped dependency `RealtimeClient`
  uses to answer a challenge, unit-testable with a fake signer, no Electron involved), a fully
  reworked `RealtimeClient` (async hello → challenge → proof → ready), a minimal first-run nickname
  prompt, and a settings Identity panel (nickname edit, Identity ID + Copy, confirmation-gated
  Regenerate). 21 `RealtimeClient` tests, 149 total desktop tests (169 including the new identity
  test files).
- **612 total Vitest tests, full `corepack pnpm check` green** (formatting, lint, whole-repo
  typecheck, tests, composite build, repository verification, dependency audit — one pre-existing,
  already-accepted high-severity advisory, no new advisories introduced).

### E2E evidence

- **`e2e:identity-persistence`**: 3 consecutive clean runs. Real evidence, not simulated: the same
  `--user-data-dir` produced the identical `identityId` across two separate real Electron process
  launches every run; a different `--user-data-dir` always produced a different `identityId`.
- **`e2e:identity-auth`**: 3 consecutive clean runs. Two distinct local profiles, real DPAPI-backed
  identities, real realtime service, real WebRTC voice: each instance's locally-reported `identityId`
  matched the server-authenticated `identityId` returned in `server:hello` every run; the two
  instances' identities were always distinct; both reached a connected peer connection with
  genuinely non-silent decoded remote audio every run.
- **`e2e:voice-smoke`**, **`e2e:camera-smoke`**, **`e2e:screen-smoke`**, **`e2e:screen-audio-smoke`**:
  each re-run once against final code and passed cleanly, confirming the now-mandatory identity
  handshake introduces no regression to any existing media capability.
- Both `e2e:identity-persistence` and `e2e:identity-auth` were re-run once more (a 4th clean run
  each) after the QA-driven `IdentityErrorScreen`/`useIdentity.regenerate()` fixes and a fresh
  `electron-forge package`, confirming those fixes introduced no regression to either flow.

### Security and QA review

**`security-reviewer`: no release-blocking issues.** Confirmed correct by direct code reading (not
just doc comments): fail-closed `safeStorage` handling (no plaintext fallback path exists);
sign-then-verify self-check catches a public/private key mismatch at load time; atomic write/read
correctly distinguishes "no file yet" from every corruption mode; `signIdentityChallenge` is
genuinely not a generic signing oracle (Main reconstructs the payload from its own stored public
key, every field independently bounded by the same schemas the wire protocol uses);
`assertTrustedSender` applied consistently to all five new IPC channels; delimiter-injection is
actually prevented (every payload field is independently pattern-restricted, none can contain
`\n`); the challenge nonce uses real `randomBytes`; the handshake timeout genuinely covers
`awaiting_identity_proof`, verified by a real integration test, not just a comment; the server never
trusts a client-supplied `identityId`; `packages/identity`'s Ed25519 module fails safe (returns
`false`, never throws, for a degenerate-but-schema-valid key); `verify-architecture.mjs`'s
`isIdentity()` check is real and correctly scoped; no central account database or persisted
server-side identity state exists anywhere; logging discipline holds (no private-key material in
any log/error path).

Two non-blocking notes, both addressed: (1) Low — `regenerateIdentity` has no _additional_
Main-side confirmation beyond the Renderer's UI gate; accepted, since a Renderer compromise capable
of triggering it unprompted already has equivalent access via `signIdentityChallenge` (full
impersonation of the current identity), so this does not materially widen what such a compromise
could already do. (2) Informational — `docs/architecture/CLIENT_IDENTITY.md` and this task document
were still being written at review time, and `docs/tasks/STATUS.md` still showed T7 as `NOT
STARTED`; both are now complete/updated.

**`qa-engineer`**: verified acceptance criteria against real test evidence (table cross-referencing
every criterion to a specific test), independently re-ran the full suite (612/612), confirmed the
first-run gating logic has no dead-end/blank-screen state, confirmed the E2E auto-nickname path
(`AutoFirstRun`) is genuinely unreachable in a packaged build (traced `window.ts`'s
`!app.isPackaged` gate directly, not just the comment claiming it), confirmed `regenerateIdentity`
has exactly one call site (the confirmation-gated settings button) via a full grep, confirmed the
replay-resistance matrix's seven scenarios are complete and each tests real behavior (not
tautological assertions), and confirmed `defaultDisplayName` is a non-destructive pre-fill only.
Found and this task fixed two items before completion:

- **Should-fix, fixed**: the corrupted-identity error screen had no in-app recovery action — a user
  hitting real corruption was stuck with no path forward inside the app. Added
  `IdentityErrorScreen.tsx` with the same confirmation-gated "start over" action `IdentityPanel`'s
  Regenerate button already used, and fixed `useIdentity()`'s `regenerate()` (previously a targeted
  state patch that only applied from the `'ready'` state, silently doing nothing from `'error'`) to
  reload fully instead, so it now works from either starting state.
- **Should-fix, resolved by timing**: `pnpm check` had not yet passed cleanly at the moment
  `qa-engineer` sampled it (broken doc-links and unformatted files, both because the review ran
  concurrently with these very docs being written) — re-run to completion after all docs settled;
  see [Repository checks](#repository-checks)-equivalent evidence above (612/612 tests, full
  `pnpm check` green, confirmed again after the two fixes above and a package re-verification).

One nice-to-have was reviewed and left as designed: `nickname-store.ts` silently treats a corrupted
preferences file as "no nickname yet" rather than throwing (unlike `identity-file.ts`'s strict
corruption handling) — intentional, since losing a nickname has no security implication and is
trivially re-enterable, unlike losing a cryptographic identity's server-recognized history; a doc
comment now records this explicitly. The QA agent also self-disclosed and self-corrected an
accidental `git checkout` that briefly reverted `App.tsx` during its own investigation — verified
independently afterward (`git diff --stat`, a full file read, and a clean `pnpm check`) that the
restoration was exact and no other tracked file was affected.

### Privacy statement

T7 introduces **none** of the following: a central account service, email collection, password
storage, phone number collection, a global user profile, or a mandatory cloud service. The realtime
server persists no identity data beyond one connection's lifetime.

### Next task

T7 is COMPLETE. See [`STATUS.md`](STATUS.md) for the roadmap: **T8 — Dedicated Server product
boundary** is next. Do not implement T8 or T9 as part of T7 — this task deliberately stops at
"the server can recognize a returning cryptographic identity," not "the server has permissions,
groups, or a product packaging boundary."
