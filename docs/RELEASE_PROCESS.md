# Release process

How a Chantivo version goes from a commit to something a new operator can install. Three phases, three
separate human decisions, three separate failure domains:

| Phase       | Trigger                                                      | What it does                                                           | Writes to R2        |
| ----------- | ------------------------------------------------------------ | ---------------------------------------------------------------------- | ------------------- |
| **Build**   | pushing a `v*` tag (automatic)                               | builds + verifies a candidate, uploads it as a GitHub Actions artifact | no                  |
| **Publish** | manual `workflow_dispatch`, `publish=true`, run from the tag | writes the immutable `releases/<version>/` objects                     | yes                 |
| **Promote** | manual `workflow_dispatch` on a separate workflow            | moves the `stable` pointer to an already-published release             | yes (pointers only) |

These are never conflated. **A tag push cannot write to R2.** **Publishing a version does not move the
stable pointer.** **Promoting stable does not rebuild anything.**

Workflows: [`.github/workflows/release.yml`](../.github/workflows/release.yml) and
[`.github/workflows/promote-release.yml`](../.github/workflows/promote-release.yml). Their structure is
pinned by `tests/repository/release-workflows.test.mjs`, so a future edit cannot silently remove a
gate.

## Phase 0 — bump the version

Root `package.json` is the single source of truth; `apps/desktop` and `services/dedicated-server`
follow it. Never edit a version field by hand.

```sh
corepack pnpm bump-version 0.1.1
corepack pnpm format
corepack pnpm check
```

`scripts/verify-version.mjs` (wired into `pnpm check`) fails if the three ever disagree.

Commit that, then tag:

```sh
git tag v0.1.1
git push origin v0.1.1
```

The tag name must be exactly `v` + the root `package.json` version. A mismatch in either direction
(package `0.1.1` + tag `v0.1.2`, or the reverse) is rejected by `resolve-metadata` within seconds,
before any build runs.

## Phase 1 — Build (automatic on tag push)

`release.yml` runs:

1. **`quality-gate`** — the full existing `pnpm check` on `windows-latest`. Everything downstream is
   blocked on it.
2. **`resolve-metadata`** — [`scripts/release/resolve-release-metadata.mjs`](../scripts/release/resolve-release-metadata.mjs),
   the one canonical resolver for the version, tag, release directory, and every artifact filename. It
   also validates the trigger: valid SemVer, no accidental leading `v`, tag matches the package
   version, dispatch input matches the package version, and — when publishing — the workflow's own ref
   is the matching tag. Runs with no dependencies installed, so mistakes cost seconds, not a
   30-minute Electron build.
3. **`windows-build`** — `scripts/release/build-windows-artifact.mjs`: builds the desktop runtime
   dependency graph itself (`tsc -b apps/desktop`, the root `build:desktop-runtime` script — every
   `@disco-voador/*` package resolves through its compiled `dist/`, and a GitHub Actions job never
   inherits another job's filesystem), then the real Forge/Squirrel make, then a deterministic search
   for the genuine `Setup.exe` (never a hardcoded filename), validated and copied to
   `dist-release/<version>/ChantivoSetup-<version>.exe`.
4. **`linux-build`** — `scripts/release/build-dedicated-server-artifact.mjs`, then
   `scripts/release/verify-linux-server-artifact.mjs`: archive readable via `tar -tzf`, single
   `chantivo-dedicated-server/` top level, `dist/cli.js` present, the `package.json` inside the archive
   agreeing with the release version, no path escaping the extraction directory, no arm64 anywhere.
5. **`assemble`** — downloads both artifacts, copies
   `infrastructure/install/install-chantivo.sh` out of the checkout, generates `SHA256SUMS` and
   `release-manifest.json`, re-verifies with `sha256sum -c SHA256SUMS`, and then runs the completeness
   check. Uploads the whole directory as artifact `chantivo-release-<version>`.

`dist-release/<version>/` must contain **exactly** these five files — nothing missing, nothing extra,
nothing zero-byte:

```
ChantivoSetup-<version>.exe
chantivo-dedicated-server-<version>-linux-x64.tar.gz
install-chantivo.sh
release-manifest.json
SHA256SUMS
```

This check exists because of a real T15 bug: Forge genuinely produced a `Setup.exe`, the build reported
success, and the file simply was not in `dist-release/<version>/`. Nothing was looking, so nothing
failed. `scripts/release/verify-release-directory.mjs` now fails loudly on anything missing, extra,
zero-byte, wrongly named (including a near-miss filename from another version), or claiming arm64.

Every tag push produces this artifact, so a candidate can always be downloaded and inspected before
anyone decides whether it deserves to exist publicly.

### `release-manifest.json`

Deterministic: a pure function of the version, the artifact bytes, and the commit. No wall-clock
timestamp, no build-environment detail, no credentials — that is what makes republication safety
decidable (see below).

```json
{
  "schemaVersion": 1,
  "product": "Chantivo",
  "version": "0.1.1",
  "artifacts": {
    "linux-installer": {
      "filename": "install-chantivo.sh",
      "sha256": "<64 hex characters>",
      "size": 80385,
      "platform": "linux",
      "arch": null,
      "kind": "install-script"
    },
    "linux-server-x64": {
      "filename": "chantivo-dedicated-server-0.1.1-linux-x64.tar.gz",
      "sha256": "<64 hex characters>",
      "size": 7400000,
      "platform": "linux",
      "arch": "x64",
      "kind": "dedicated-server-tarball"
    },
    "windows-x64": {
      "filename": "ChantivoSetup-0.1.1.exe",
      "sha256": "<64 hex characters>",
      "size": 91000000,
      "platform": "windows",
      "arch": "x64",
      "kind": "desktop-installer"
    }
  },
  "gitCommit": "<40 hex characters>"
}
```

`arch: null` on the installer is truthful, not a gap: the shell script runs anywhere, but the only
server artifact it can install is linux-x64. **linux-x64 and windows-x64 are the only architectures
Chantivo has actually built and run.** An arm64 claim anywhere in a manifest, a checksum file, or a
filename is a hard failure at every stage — see `detect_arch()` in
`infrastructure/install/lib/fetch-verify.sh`, which fails honestly on arm64 hosts for the same reason.

`SHA256SUMS` is plain `sha256sum` format (`<hex><two spaces><filename>`), covering the three real
artifacts. It is verified with `sha256sum -c` immediately after generation — an unverified checksum
file must never sit around looking trustworthy.

## Phase 2 — Publish (manual, explicit, from the tag)

Actions → **Release** → _Run workflow_, with:

- **Use workflow from**: `v<version>` — the tag itself, not a branch.
- `version`: `<version>` (bare SemVer, e.g. `0.1.1`).
- `publish`: `true` (the input defaults to `false`).

All three conditions must hold or the publish job does not run, and `resolve-metadata` fails loudly
rather than letting the run go green with a silently skipped job. A branch commit that merely happens
to carry the right `package.json` version is not sufficient: the published bytes must be provably the
tagged commit's.

### R2 object layout

```
releases/<version>/ChantivoSetup-<version>.exe
releases/<version>/chantivo-dedicated-server-<version>-linux-x64.tar.gz
releases/<version>/install-chantivo.sh
releases/<version>/release-manifest.json      <- completeness marker, written LAST
releases/<version>/SHA256SUMS
channels/stable.json                          <- mutable pointer (promotion only)
installer/install-chantivo.sh                 <- canonical bootstrap copy (promotion only)
```

### Immutability

A published version means one exact set of bytes, forever. `scripts/release/publish-release-to-r2.mjs`
asks the bucket what it already holds and then:

| Existing state                                                             | Behaviour                                                                                                                  |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Absent**                                                                 | Publish: upload artifacts, then `SHA256SUMS`, then `release-manifest.json` last.                                           |
| **Present and identical** (recorded `sha256` metadata and size both match) | Report an idempotent no-op; upload nothing, alter nothing.                                                                 |
| **Present and different**, or present with no recorded checksum            | **Fail hard.** Nothing is overwritten. A changed release requires a new version number.                                    |
| **Partially present** (some objects, and/or no completeness marker)        | Report the partial state honestly and re-upload only what is missing, still refusing to overwrite anything that conflicts. |

`release-manifest.json` is written last and is treated everywhere as the "this release is complete"
signal, so an interrupted publication leaves an obviously-incomplete release rather than a
complete-looking one with a missing artifact.

Identity is decided by a `sha256` user-metadata value written on every upload, not by ETags (multipart
uploads make ETags non-MD5, and R2 makes no S3-identical ETag guarantee). An existing object with no
recorded checksum cannot be proven identical, so it is treated as a conflict — never as "probably
fine".

### Cache headers

| Objects                                                 | `Cache-Control`                       | Why                                                                                                                            |
| ------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `releases/<version>/*`                                  | `public, max-age=31536000, immutable` | Genuinely immutable; caching them forever is correct.                                                                          |
| `channels/stable.json`, `installer/install-chantivo.sh` | `no-cache`                            | Mutable pointers. A stale edge serving an old stable pointer or an old bootstrap installer is exactly the failure this avoids. |

## Phase 3 — Promote to stable (manual, separate, no rebuild)

Actions → **Promote release to stable** → _Run workflow_, with `version: <version>` (and optionally a
different `public_base_url`; it defaults to `https://downloads.chantivo.app`). May run from `main`.

`promote-release.yml` contains **zero build steps** — no Electron build, no Forge make, no server
build, no `pnpm build`, no `pnpm install`, no artifact generation of any kind. It only runs small,
dependency-free repository helper scripts. The bytes an operator downloads after a promotion are the
exact bytes published earlier from the tagged commit.

It:

1. Validates the requested version (`scripts/release/validate-promotion-input.mjs`) before touching a
   credential.
2. Fetches `releases/<version>/release-manifest.json` and `releases/<version>/SHA256SUMS` read-only.
3. Verifies: both exist; the manifest's `version` equals the request; all three artifacts are declared;
   declared checksums agree with `SHA256SUMS`; the real artifact objects exist with matching recorded
   checksums and sizes; platform/architecture fields are truthful; no arm64 claim anywhere.
4. Downloads `releases/<version>/install-chantivo.sh` and verifies its SHA-256 against the manifest
   before copying it. The canonical installer is **copied byte-for-byte**, never regenerated during
   promotion.
5. Writes, in this order:
   1. `installer/install-chantivo.sh`
   2. `channels/stable.json`

Any inconsistency fails hard with **no partial promotion**.

### Why the installer is written first

S3-compatible storage offers no multi-object transaction, so some ordering window always exists; the
question is which window is harmless. With the installer first, the window holds a **newer installer
alongside an older stable pointer**: that installer reads the old pointer, resolves
`releases/<old-version>/`, and installs an immutable, complete, previously-validated release. Nothing
breaks. The reverse order would hand an **older installer a newer pointer** — a client asked to
interpret a channel document written after it, which is the direction that cannot be reasoned about
safely.

Reruns are idempotent: an object already holding these exact bytes is left untouched.

### `channels/stable.json`

```json
{
  "schemaVersion": 1,
  "channel": "stable",
  "version": "0.1.1",
  "releaseBaseUrl": "https://downloads.chantivo.app/releases/0.1.1",
  "manifestUrl": "https://downloads.chantivo.app/releases/0.1.1/release-manifest.json"
}
```

A base URL under this project's own domain is accepted **only** for the distribution host. Any other
Chantivo-operated host — the website, or one operator's own running Dedicated Server — is rejected: it
would bake a wrong download location into every new install. A mirror on your own domain is always
fine.

## What the installer does with all this

`install-chantivo.sh`'s `--release-source` now defaults to `https://downloads.chantivo.app`.

- With `--version <version>`: resolves directly to `<source>/releases/<version>/`.
- Without it: reads `<source>/channels/stable.json` and resolves to `<source>/releases/<that
version>/`.
- An **explicitly overridden** `--release-source`/`$CHANTIVO_RELEASE_SOURCE` that has no
  `channels/stable.json` is used directly as the release directory — the local-fixture/mirror layout
  this repository's own installer testing depends on. The installer says which resolution path it took
  in its confirmation summary.
- The built-in default with no readable channel document is a hard failure. It never guesses a version.

Whatever the source, the downloaded `release-manifest.json` must declare the version that was asked
for; a source serving something else is a hard error, never a silent substitution. Every artifact is
verified against that directory's own `SHA256SUMS` **before** extraction, and a mismatch aborts without
extracting, installing, restarting, or mutating an existing deployment. Standard SHA-256 only; no
custom scheme. **Code signing is out of scope** — the Windows installer is unsigned, and SmartScreen
will say so.

`downloads.chantivo.app` is distribution only. It serves release files over HTTPS and nothing else: no
signaling, no relay, no directory, no telemetry. An installed Chantivo server never contacts it at
runtime, and an operator installing from a local mirror never touches it at all. Chantivo has no
central service (see [`docs/adr/0010-*`](adr/) and [`docs/SECURITY.md`](SECURITY.md)); this default
makes downloading the software work without a checkout, and nothing more.

## GitHub configuration (already done by the operator — do not change it from code)

These already exist and are managed by the repository owner. No workflow, script, or task in this
repository creates or modifies them; they are listed here by **name only**, never by value:

- Environment: **`production`** — restricted to branch `main` and tag pattern `v*`. It is attached to
  exactly two jobs in the whole repository: `release.yml`'s `publish` job and `promote-release.yml`'s
  `promote` job. No build or test job can see its secrets.
- Secrets: `CLOUDFLARE_R2_ACCOUNT_ID`, `CLOUDFLARE_R2_ACCESS_KEY_ID`, `CLOUDFLARE_R2_SECRET_ACCESS_KEY`.
- Variable: `CLOUDFLARE_R2_BUCKET`.

The S3-compatible endpoint is derived at the point of use from the account-id secret
(`https://<account-id>.r2.cloudflarestorage.com`), so there is no separate endpoint secret to keep in
sync. Access goes through the AWS CLI, already present on GitHub-hosted runners — no S3 SDK dependency
and no hand-written request signing.

**Operational recommendation (not configured by this repository):** keep the R2 API token
bucket-scoped — Object Read & Write on the releases bucket only, no account-level or other-bucket
access. Both workflows request `permissions: contents: read` and nothing more; neither creates a GitHub
Release, moves a tag, or pushes a commit.

## Rollback

There is no "unpublish". A published version is immutable by design, and pulling bytes out from under
operators who already downloaded them would be worse than the problem it solves.

- **A bad release was published but never promoted**: nothing to do. New installs are unaffected — they
  follow `channels/stable.json`, which never pointed at it.
- **A bad release was promoted**: re-run **Promote release to stable** with the previous known-good
  `version`. That rewrites both pointers to the earlier immutable release, which is still present and
  still verifiable. Both pointers are `no-cache`, so the change is visible immediately rather than
  after a CDN TTL.
- **A release needs different content**: bump to a new version and publish that. Overwriting a
  published version is refused by design, in code, not by convention.

An already-installed Dedicated Server is unaffected by any of this: it runs from
`/opt/chantivo/releases/<version>/` behind the `/opt/chantivo/current` symlink and only changes when an
operator runs `chantivo-server update` (see [`docs/SELF_HOSTING.md`](SELF_HOSTING.md)).
