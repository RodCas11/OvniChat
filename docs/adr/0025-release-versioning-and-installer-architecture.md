# ADR 0025: Release versioning, artifact, and installer architecture

## Status

Accepted and implemented (T15 — Chantivo Distribution, Easy Install & Dedicated Server Releases).

## Context

T14 proved the Dedicated Server runs correctly natively and via Docker, with real evidence, but every
step was done by hand. T15 needed to decide: where does a release version number come from, what does
a "release artifact" actually contain and how is it verified, how does a non-expert operator install
without cloning this repository, how does the operator CLI's more complex subcommands (`admin-token
create`, `doctor`) get implemented without inventing a second authorization system or a heavyweight
CLI framework, and how does an update mechanism swap versions without downtime-that-loses-data.

## Decision

**Versioning**: root `package.json`'s `version` field is the single source of truth, propagated to
`apps/desktop/package.json` and `services/dedicated-server/package.json` by `scripts/bump-version.mjs`
and checked for drift by `scripts/verify-version.mjs` (wired into `pnpm check` via
`verify-repository.mjs`, matching every other `verify-*.mjs` guardrail's own pattern). No pre-release/
build-metadata suffix support — plain `MAJOR.MINOR.PATCH` only, added when a real need for more exists.

**Release artifact**: `scripts/release/build-dedicated-server-artifact.mjs` reuses the exact same
`pnpm --filter @disco-voador/dedicated-server deploy --prod --config.inject-workspace-packages=true`
pruning `services/dedicated-server/Dockerfile`'s build stage already uses — the tarball and the Docker
image's runtime contents come from the same real build step, not two parallel implementations that
could drift. `scripts/release/build-manifest.mjs` emits `release-manifest.json` (structured metadata)
and `SHA256SUMS` (plain `sha256sum`-format — what installers actually verify against, since that's the
tool operators already have and trust). No container-registry publishing or CI/CD pipeline was built —
out of scope; Docker deployment stays "build from source via Compose," honestly documented, since
standing up real release hosting/CI was not itself part of what T15 needed to prove.

**Installer**: one script (`infrastructure/install/install-chantivo.sh`), not several, because the
brief's success criterion is literally "one installer script." It automates exactly the native/Docker
procedures T14 already proved by hand in `docs/SELF_HOSTING.md` — including reproducing the Coturn
Docker-image `chown 65534:65534`/`chmod 400` secret-permission fix verbatim in its own dedicated code
path, deliberately never unified with native Coturn's separate `root:turnserver`/`640` model, since
"guess the right owner" was the exact bug T14 caught once already. TLS/Caddy is not automated — DNS
can't be safely verified from an unattended script, so gambling on unattended certificate issuance was
rejected as unforced risk; the installer points at the manual doc section instead.

**Native release layout**: introduces `/opt/chantivo/releases/<version>/` + an atomically-flipped
`/opt/chantivo/current` symlink, replacing T14's single fixed path — this is what makes
`chantivo-server update`'s atomic-swap-with-rollback model possible. This is new work T14 didn't need
(it only ever ran one version); it is scoped narrowly to the native path, since Docker's own
recreate-on-change semantics already solve the equivalent problem without a bespoke scheme.

**Operator CLI split**: `chantivo-server` is a thin Bash dispatcher for subcommands that are genuinely
one shell-out (`status`, `logs`, `restart`, `version`, `backup` — the last one being a simple
stop→tar→start sequence with no need for real application logic). `admin-token create` and `doctor`'s
deeper checks need real authorization/protocol logic, so those `exec` two small new Node entrypoints
shipped inside the release artifact (`services/dedicated-server/src/cli-admin-token.ts`,
`cli-doctor.ts`) rather than reimplementing T9's token cryptography in shell (drift risk, no test
reuse) or building a new CLI framework dependency (unjustified for two subcommands).

**`admin-token create` is safe to run against a live server**: `services/dedicated-server/src/storage/
sqlite-store-utils.ts` already sets `PRAGMA journal_mode = WAL` on every store open — SQLite's own
documented mechanism for safe multi-process one-writer/many-readers access.
`services/dedicated-server/src/storage/data-dir-lock.ts`'s instance lock guards two full server
_processes_ from sharing a data directory (each with its own in-memory rate limiters/caches) — a
distinct, coarser concern from a single short `AuthorizationStore.createToken()` call. `cli-admin-
token.ts` deliberately opens its own `AuthorizationStore` directly against the live `dataDir`,
bypassing `acquireDataDirLock` (acquiring it would simply fail while the server runs — wrong behavior
for a recovery tool), and calls the already-existing `createToken({tokenKind: 'privilege', groupId:
SERVER_ADMIN_GROUP_ID, expiresInMs})`. This claim is backed by a new, dedicated integration test
proving same-file concurrent access from two independent `AuthorizationStore` instances doesn't
disrupt a live server or corrupt state — existing tests only proved cross-_file_ isolation between
separate servers' own data directories, a materially different claim.

**`doctor`'s external-reachability honesty**: "LISTENING LOCALLY" comes from a real loopback
`/healthz` check; "EXTERNALLY VERIFIED" is never fabricated via an invented Chantivo-operated check
service (would reintroduce exactly the central-dependency ADR 0010 forbids) — an optional, operator-
supplied `--external-check-url` is the only way to get that signal, explicitly labeled as
operator-provided, not Chantivo-verified.

## Consequences

- A release version is always consistent across every artifact that ships it, or `pnpm check` fails
  loudly — no silent drift between what the desktop app reports and what the server reports.
- The Linux tarball and the Docker image are provably the same build output, not two things that could
  quietly diverge.
- Two genuinely new pieces of runtime behavior were introduced beyond what T14 built:
  the native releases/current symlink scheme, and the same-file concurrent `AuthorizationStore` access
  pattern — both are real, if narrow, additions to the trusted surface, each with dedicated test
  coverage precisely because they're new, not because existing coverage happened to already prove them.
- No public release hosting exists yet — `install-chantivo.sh`'s `--release-source`/
  `CHANTIVO_RELEASE_SOURCE` abstraction means adding one later is a documentation and default-value
  change, not a script rewrite.
- TLS/certificate issuance remains a manual step for every deployment mode; this is an accepted,
  deliberate scope boundary, not an oversight.

## Alternatives

- **A single monolithic Node CLI application for every operator subcommand**: rejected — most
  subcommands are one real shell-out; building a framework around them for two subcommands that need
  real logic is unjustified complexity (matches this repo's existing "don't add a dependency for what
  a few lines already do" discipline, e.g. `cli.ts`'s own zero-added-dependency shape).
- **Unifying the native and Docker Coturn permission-fix code paths behind one "detect and adapt"
  helper**: rejected — the two paths need genuinely different owners (`root:turnserver` vs. a fixed
  numeric `65534:65534`) for genuinely different reasons (a real system user vs. a container image's
  fixed runtime UID); a shared "guess" abstraction is exactly the shape of the bug T14 already found
  and fixed once.
- **Requiring the server to be stopped for `admin-token create`**: considered as the simpler, more
  conservative option, but rejected once SQLite's WAL-mode multi-process guarantees were confirmed
  applicable and backed by a real test — an operator who's locked out of a running, otherwise-healthy
  server gets recovery without downtime, which is a materially better outcome for the exact "I lost my
  token" scenario this feature exists for.
- **Automating TLS/Caddy certificate issuance in the installer**: rejected — DNS correctness can't be
  safely verified from inside an unattended script, and a failed unattended certificate attempt is a
  worse operator experience than a documented manual step with real, verifiable Caddy logs (see
  `docs/architecture/PRODUCTION_SELF_HOSTING.md`'s TLS section for the reasoning this inherits).
