# Installer scripts (T15)

This directory contains the Chantivo Dedicated Server installer and the operator CLI it installs.
Real execution has already happened against a real Ubuntu VPS for the app/Coturn/firewall paths (two
real bugs were found and fixed there — see "Idempotency / pre-flight signals" and the `set -e`/`ERR`
history below, and `docs/tasks/T15_DISTRIBUTION_AND_EASY_INSTALL.md` for the full record). The Caddy/
TLS automation added afterward (`--with-tls`/`--no-tls`/`--tls-only`) has been syntax-checked
(`bash -n`), linted (`shellcheck -x`, zero findings), and unit-tested in isolation (DNS-matching logic,
Caddyfile-import detection, template substitution — see "Testing locally" below) — its actual
`apt-get install caddy`/systemd/DNS-resolution mutation paths have not yet been exercised against a
real host; that is deferred to the next real-VPS validation pass (the `qa-engineer` role), per this
task's own boundaries.

## Files

| File                  | What it does                                                                                                                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `install-chantivo.sh` | First install: native (systemd) or Docker Compose. Real, mutating; `--help` documents every flag.                                                                                   |
| `chantivo-server`     | Operator CLI, installed to `/usr/local/bin/chantivo-server`. Subcommands: `status`, `logs`, `restart`, `version`, `doctor`, `backup`, `update`, `admin-token create`.               |
| `lib/fetch-verify.sh` | Shared library, `source`d by both scripts above: `validate_safe_string`, download/checksum-verify/extract of a release tarball, and `wait_for_health`. Exists in exactly one place. |

`install-chantivo.sh` also installs `lib/fetch-verify.sh` itself to
`/usr/local/lib/chantivo/fetch-verify.sh`, so `chantivo-server` (copied out to `/usr/local/bin` on its
own) can still `source` it after the fact. Both scripts prefer a co-located `lib/` (running straight
from a repository checkout) over that fixed installed path, so local testing needs no installation
step at all.

## The Public Server Endpoint (`--hostname` / `--turn-url`)

The installer works from ONE operator-facing concept: the **Public Server Endpoint** — the single
public hostname (or public IPv4) this deployment is reachable at. Both the client address and the
advertised TURN URL derive from it, so an operator configures one thing and cannot end up with a
working signaling address and a broken TURN address.

| Invocation                              | Client address            | Advertised TURN URL           | Scope    |
| --------------------------------------- | ------------------------- | ----------------------------- | -------- |
| `--hostname voice.example.com`          | `wss://voice.example.com` | `turn:voice.example.com:3478` | `public` |
| `--hostname 203.0.113.10`               | `ws://203.0.113.10:8090`  | `turn:203.0.113.10:3478`      | `public` |
| no `--hostname`, host has a public IPv4 | `ws://<that IP>:8090`     | `turn:<that IP>:3478`         | `public` |
| no `--hostname`, no public IPv4         | `ws://<LAN address>:8090` | `turn:<LAN address>:3478`     | `local`  |

TURN needs no domain name — a bare public IPv4 is a perfectly good TURN endpoint. Public CA-issued
TLS is the part that genuinely requires a hostname, and that limitation is unchanged and separate
(see the TLS section below).

**`--turn-url <turn:…|turns:…>` (advanced)** overrides the derived default, for the one case that
needs it: Coturn running on a _different_ machine than the Dedicated Server. WSS-hostname and
TURN-hostname are not architecturally coupled — the derivation is only the easy-install default.

Two rules are enforced by `resolve_turn_url()` and cannot be bypassed:

1. There is **no placeholder fallback**. A value like `turn:REPLACE_WITH_YOUR_HOSTNAME:3478`
   validates fine, starts fine, and silently breaks every relay-dependent client — the installer
   `die`s with an actionable message instead of writing one.
2. A **public** deployment may never advertise a loopback, private-network, CGNAT, link-local, or
   container-only address (`turn:127.0.0.1:3478`, `turn:coturn:3478`). A **local/LAN** deployment
   may — that is the correct value there, and is deliberately left alone.

The resolved scope is written to the deployment's environment as `DISCO_VOADOR_DEPLOYMENT_SCOPE`, so
`chantivo-server doctor` can tell a deliberate LAN loopback address apart from a broken public one.
In Docker mode the client-facing TURN URL is the same resolved value: how containers reach Coturn
internally is a separate concern (`compose.turn.example.yaml` uses `network_mode: host`, so there is
no separate internal address at all), and a Docker service name or bridge IP must never be
advertised to remote clients.

Nothing here ever falls back to a Chantivo-operated relay or signaling service. Chantivo has no
central service: every self-hosted install owns its own Dedicated Server, its own Coturn, and its own
TURN traffic. `scripts/verify-infrastructure.mjs` fails the repository gate if that ever changes.

## TLS/Caddy automation (`--with-tls` / `--no-tls` / `--tls-only`)

When a real `--hostname` is given, the installer offers (and, by default, performs) automatic HTTPS/
WSS via Caddy — for BOTH native and Docker deployment modes, since Docker mode already publishes the
app on `127.0.0.1:8090` on the host (`infrastructure/docker/compose.server.example.yaml`), so one
host-level Caddy-fronting-127.0.0.1:8090 code path (`configure_tls_caddy` in `install-chantivo.sh`)
covers native, Docker, and `--tls-only` identically.

- **Prompt/default**: with `--hostname` given and neither `--with-tls` nor `--no-tls` passed,
  interactive runs are asked `Configure HTTPS/WSS automatically with Caddy? [Y/n]` (default: **yes** —
  unlike the TURN prompt, which defaults to no); non-interactive runs (or `--yes`) also default to yes.
  No `--hostname` means no TLS prompt at all — a bare IP cannot get a publicly-trusted certificate.
- **DNS check**: `dns_resolves_to_this_host()` resolves the hostname via `getent hosts` (NSS/
  `/etc/resolv.conf`) and compares against this host's own addresses via `hostname -I` — no
  third-party IP-echo/SaaS dependency, consistent with this project's "fully self-hostable" rule. One
  check, no retry. A mismatch prints an actionable message and skips TLS for this run (never aborts the
  whole install); `--skip-dns-check` bypasses the check for hostnames behind something this host can't
  see (e.g. a CDN).
- **Caddy install**: from Caddy's official apt repository (Cloudsmith GPG key + apt source list),
  matching `install_native_coturn()`'s own `apt-get`/`DEBIAN_FRONTEND=noninteractive` pattern.
- **Never touches a pre-existing Caddy config it didn't create**: if Caddy (binary or systemd unit) is
  already present, the Chantivo site block is written to `/etc/caddy/conf.d/chantivo.caddy` instead of
  `/etc/caddy/Caddyfile`. If the existing Caddyfile already `import`s that directory, Caddy is reloaded;
  if not, the script prints the exact snippet to add and leaves the existing Caddyfile untouched — TLS
  is reported as skipped for this run, not fabricated as working.
- **Readiness**: after (re)starting/reloading Caddy, `wait_for_https_health()` performs a real
  WebSocket upgrade handshake through the proxy (`https://<hostname>/`, expecting a genuine
  `101 Switching Protocols`) with a bounded timeout (mirrors `wait_for_health`'s polling shape). This
  deliberately does NOT poll `/healthz` through Caddy — see
  `infrastructure/reverse-proxy/README.md`'s "Public vs. internal routes": `/healthz`/`/readyz` are
  blocked at the Caddy layer for anyone hitting them publicly, this installer included, so a real
  protocol-level WebSocket handshake is the check that actually proves Caddy is correctly routing to
  the Dedicated Server. Failure is reported honestly in the final summary as `TLS/WSS: FAILED (...)`
  with a pointer to `journalctl -u caddy` — TLS failure is never fatal to the rest of the install.
- **`--tls-only`**: adds a hostname/TLS to an ALREADY-installed deployment without touching
  `/var/lib/chantivo`, `/opt/chantivo/releases`, or the Docker Compose stack — requires `--mode` and
  `--hostname`, and `die`s with an actionable message if no existing install is detected for that mode.
  This is also the documented rerun path for a DNS mismatch once the record has propagated.
- **IP-only installs remain a fully valid, successful path** — no Caddy code runs speculatively when no
  hostname is given; the final summary explains why and gives the exact `--tls-only` rerun command.
- **Firewall**: `--configure-firewall` opens `80/tcp` and `443/tcp` alongside the existing rules
  whenever TLS automation was attempted this run (gated on the decision to attempt, not the outcome —
  the ports must be open before Caddy's certificate-issuance attempt for it to have any chance of
  succeeding).

## What these scripts do NOT do

- No Docker installation — `docker_install()` checks for `docker`/`docker compose` and prints the
  official install command if missing, rather than installing Docker itself (too privileged, out of
  scope).
- No live deployment, no real secret generation outside a real install run, no touching a real VPS.

## Ground truth this implementation follows exactly

- Native systemd layout, hardening, and `/etc/chantivo/server.env` shape: `docs/SELF_HOSTING.md`'s
  "Native Linux with systemd" worked example.
- Docker Coturn's `chown 65534:65534` / `chmod 400` permission fix (a real bug found and corrected
  during T14): `infrastructure/docker/README.md`.
- Native Coturn's `root:turnserver` / `640` permission model: the same document, contrasted with the
  Docker path.
- Coturn relay range (`49152-49351`) and the production `turnserver.conf.example` template: reused
  unchanged, never re-invented.
- Release artifact naming (`chantivo-dedicated-server-<version>-linux-<x64|arm64>.tar.gz`),
  `release-manifest.json`, and `SHA256SUMS` format: `scripts/release/build-dedicated-server-artifact.mjs`
  / `scripts/release/build-manifest.mjs` (the actual, already-in-progress release-build tooling this
  installer consumes — read directly, not guessed at).

## The native release/`current` symlink scheme

```
/opt/chantivo/releases/<version>/     # one directory per installed version — extracted tarball content
/opt/chantivo/current                 # symlink, atomically flipped (ln -s + mv -Tf) to one releases/<version>
```

`chantivo-server.service`'s `WorkingDirectory=`/`ExecStart=` always point at `/opt/chantivo/current`,
never a specific version directory directly — this is what makes `chantivo-server update` (atomic
symlink swap, with rollback on a failed post-update health check) possible without ever taking the
service down mid-swap.

## Idempotency / pre-flight signals

- **Native**: "already installed" = `/opt/chantivo/current` resolves to a real target AND
  `systemctl is-enabled chantivo-server` succeeds. A `/etc/chantivo/.install-in-progress` marker file
  is written at the very start of a real install and removed only on full success, so a later run can
  tell a prior attempt didn't finish.
- **Docker**: "already installed" = a container exists labeled
  `com.docker.compose.project=chantivo-server` or `com.docker.compose.project=chantivo-self-hosted`
  (Compose's own project label — no volume-name-guessing).
- **`--force-reinstall`** bypasses both checks but, by itself, never touches `/var/lib/chantivo` (no
  code path in this script deletes or overwrites that directory's contents). If existing data is found
  there anyway, an additional, distinct `--i-understand-this-may-affect-data` flag is required before
  the script will proceed at all — deliberately hard to trigger by accident.

## Coturn's two permission paths are genuinely separate code

`install_native_coturn()` (native, `apt install coturn`, writes `/etc/turnserver.conf` as
`root:turnserver` / `640`) and `chown_docker_coturn_conf()` (Docker, writes the Compose-mounted
`turnserver.conf` as `65534:65534` / `400`) are two independent, clearly-named functions — not one
"guess the right owner" helper. Each has its own doc comment explaining exactly why its uid/gid is
fixed and non-interchangeable with the other. Docker's pinned `coturn/coturn:4.17.2-r0` image runs
`turnserver` as a fixed numeric `uid=65534 gid=65534` — this repository's own T14 finding, restated
here rather than re-discovered.

## Testing locally (no live host required)

Build a real local release with this repo's own tooling, then point the installer at it with a
`file://` release source:

```sh
node scripts/release/build-dedicated-server-artifact.mjs
# build-manifest.mjs enforces a COMPLETE release (Windows installer + Linux tarball +
# install-chantivo.sh) by default. --allow-partial is for exactly this Linux-only local fixture; a
# partial manifest can never be published, since verify-release-directory.mjs and the promote
# workflow both independently require the full artifact set.
node scripts/release/build-manifest.mjs --allow-partial
# produces dist-release/<version>/{chantivo-dedicated-server-<version>-linux-x64.tar.gz,
#                                   release-manifest.json, SHA256SUMS}

./infrastructure/install/install-chantivo.sh --mode native \
  --release-source "file://$(pwd)/dist-release/<version>" --yes
```

`--release-source` here is an explicit override that points DIRECTLY at a release directory, and it
stays fully supported: when an explicitly-given source has no `channels/stable.json`, the installer
uses it as the release directory and says so in its confirmation summary. Without an override, the
installer follows `https://downloads.chantivo.app`'s `channels/stable.json` (or `--version <version>`)
— see [`docs/RELEASE_PROCESS.md`](../../docs/RELEASE_PROCESS.md).

The download/checksum-verify/extract pipeline itself (`lib/fetch-verify.sh`'s
`download_and_verify_release` / `extract_release_tarball`) can be exercised in complete isolation, with
no root and no system mutation, by `source`ing the library directly and calling its functions against a
synthetic fake release directory — this is exactly how it was verified during this task (a throwaway
`chantivo-dedicated-server-9.9.9-linux-x64.tar.gz` + hand-built `release-manifest.json`/`SHA256SUMS` in
a scratch directory, covering: a successful download+verify+extract, a corrupted checksum, a missing
`SHA256SUMS` entry, an empty release source, and a nonexistent release source — all five produced the
expected pass/fail outcome with the expected error message).

Similarly, `configure_tls_caddy()`'s building blocks were exercised in isolation, outside of any real
`apt`/`systemd`/DNS mutation:

- `dns_resolves_to_this_host()` against fake `getent`/`hostname -I` output: a resolving-and-matching
  hostname, a resolving-but-mismatched hostname, and an unresolvable hostname all produced the expected
  match/no-match/no-match outcome.
- `caddyfile_imports_confd()` against a fake Caddyfile with an `import /etc/caddy/conf.d/*.caddy` line,
  one without it, and a nonexistent file: correctly detected present/absent/absent.
- `write_caddy_site_block()`'s underlying `sed` substitution, run directly against the real
  `infrastructure/reverse-proxy/Caddyfile.example`, correctly replaces `{$CHANTIVO_PUBLIC_HOSTNAME}`
  with a real hostname while leaving the rest of the template (including its comment header) intact.

## Verification actually performed for this task

- `bash -n` on all three installer files (`install-chantivo.sh`, `chantivo-server`, `lib/fetch-verify.sh`): pass.
- `shellcheck -x` (v0.11.0, fetched as a standalone static binary into a scratch directory for this
  session only — not installed system-wide) on all three files, using `-P` so cross-file `source`s
  resolve: **zero findings** on all three, including after the `--with-tls`/`--no-tls`/`--tls-only`
  additions to `install-chantivo.sh`.
- Functional exercise of `lib/fetch-verify.sh` against a synthetic fake release (see above): happy
  path, corrupted checksum, missing checksum entry, empty source, nonexistent source — all five behaved
  correctly.
- `install-chantivo.sh --help` / unknown-flag / non-interactive-without-`--mode` /
  non-interactive-without-`--yes` / invalid-`--hostname` / not-running-as-root: all produce the correct
  exit code and exactly one clear error message. Re-confirmed after adding `--with-tls`/`--no-tls`/
  `--tls-only`/`--skip-dns-check` — `--help` documents all four; `--tls-only` without root, and an
  invalid `--hostname` containing `/`, both still fail with a single clear message.
- A real, reproduced `set -e`/`ERR`-trap false positive was found and fixed during this task's own
  testing: a function whose _last executed statement_ is a bare `cond && action` chain (no `if`, no
  `||` fallback) can return non-zero purely because the condition was false — a normal case — which
  then spuriously fired the `ERR` trap when that function was invoked as a bare statement (both
  scripts' `cleanup()`, called via `trap cleanup EXIT`, on every clean `exit 0` including `--help`).
  Fixed by rewriting both `cleanup()` implementations (and, defensively, `native_already_installed()`)
  to use `if`, which bash explicitly exempts from this behavior. Re-verified: `--help` now exits `0`,
  real errors still exit `1` with a single clear message, no duplicate/confusing trap output.
- `docker compose -f infrastructure/docker/compose.server.example.yaml config`,
  `... compose.self-hosted.example.yaml config`, and `... compose.self-hosted.example.yaml --profile
turn config` all validated cleanly (Docker Compose v5.4.0 was available on this dev machine) against a
  scratch copy of `infrastructure/docker/` + a real `.env` copied from `.env.example` — never against
  the tracked repository's own `.env`/`turnserver.conf` (which stay gitignored and untouched). This
  also confirmed the real Compose-resolved data-volume name
  (`chantivo-self-hosted_chantivo-server-data`), which `write_docker_deployment_marker()` resolves
  dynamically via `docker volume ls --filter label=com.docker.compose.project=...` rather than
  hardcoding Compose's project-name-joining convention.

## Not verified here (deferred to real-VPS validation)

- Any actual `useradd`/`systemctl`/`apt`/`ufw` mutation, since this dev environment is Windows with no
  real Ubuntu host to run them against.
- The actual `apt-get install caddy` (Cloudsmith apt repository) install path, real Caddy systemd
  start/reload, and real public ACME/Let's Encrypt certificate issuance against real public DNS — this
  is the one part of TLS automation that genuinely needs a real internet-reachable host with a real
  domain to prove end to end. `dns_resolves_to_this_host()`'s own logic was unit-tested (see above), but
  never against a real `/etc/resolv.conf` resolving a real record.
- The "pre-existing Caddy config, no `import` directive" branch's actual `systemctl reload caddy` /
  file-write behavior against a real running Caddy instance (the branch logic itself — conf.d file
  creation, import detection, the printed manual-step message — was exercised via the unit tests above,
  not against a real Caddy process).
- `--tls-only`'s `native_already_installed`/`docker_already_installed` reuse against a real prior
  install (both functions are unchanged and were already real-VPS-validated for the normal install
  flow; their reuse here is new call sites, not new logic).
- The Docker install path's actual `docker compose ... up -d --build` against the real Dockerfile (the
  Compose file structure was validated with `config`, not a real build/run).
- `chantivo-server doctor`/`admin-token create`'s dispatch to `dist/cli-doctor.js` /
  `dist/cli-admin-token.js` — those files are being built by a parallel task and did not exist yet at
  the time this installer work was done; this dispatcher only assumes their documented invocation
  shape (`node dist/cli-doctor.js`, `node dist/cli-admin-token.js create`), not their actual behavior.
- `chantivo-server update`'s full download → verify → backup → atomic swap → restart → readiness-wait →
  rollback sequence end-to-end against a real running systemd service (the download/verify/extract
  building blocks it reuses from `lib/fetch-verify.sh` were verified in isolation, per above).
- Real firewall behavior (`ufw`), real Coturn startup log inspection, and the actual bootstrap-token
  journal line this installer's summary points operators at.
