# T15 — Chantivo Distribution, Easy Install & Dedicated Server Releases

Turns T14's proven-but-manual deployment into something a non-expert operator can install with one
script, and gives the desktop client a real Windows installer. See
[`../SELF_HOSTING.md`](../SELF_HOSTING.md) for the operator-facing quick-install guide and
[`../adr/0025-release-versioning-and-installer-architecture.md`](../adr/0025-release-versioning-and-installer-architecture.md)
for the design decisions and their alternatives.

## Status

**COMPLETE.** All code slices are implemented and passing the full repository gate. This task was
reopened four times after review: first for real gaps (insufficient Windows upgrade proof, no
TLS/Caddy automation, an honesty gap in the arm64 support claim, under-labeled fixture-vs-real-host
evidence); then for a genuine security finding surfaced while closing the first round — the initial
admin token was leaking into `journalctl`/`docker compose logs` (a pre-existing T9-era design, not
something this task introduced, but this task's own installer-output requirement is what surfaced it);
then for two real product findings from the first packaged-client test against the real public beta
server — a bare hostname (no `wss://` prefix) failed to connect, and `/healthz`/`/readyz` were publicly
exposed through Caddy; then a fourth time for a release-blocking real-world finding — one real Windows
packaged client consistently failed all peer media (voice, screen share) against real
`beta.chantivo.app`, traced to the beta server's own `DISCO_VOADOR_TURN_URLS` being misconfigured to a
loopback address (`turn:127.0.0.1:3478`, unreachable from any real client), plus a second, independent
defect (a real, general TURN-relay self-healing gap in `packages/rtc-core`, and a too-short credential
TTL with no refresh path). All four rounds are closed with real evidence; see
[Verification](#verification), [TLS / Caddy automation](#tls--caddy-automation),
[Bootstrap token log leak](#bootstrap-token-log-leak),
[Client address normalization and public endpoint hardening](#client-address-normalization-and-public-endpoint-hardening),
and [TURN relay reliability](#turn-relay-reliability) for the full record, including five rounds of
security/product review and every defect found and fixed.

## What changed

**Versioning.** Root `package.json`'s `version` (bumped `0.0.0` → `0.1.0`, marking "first installable
release") is now the single source of truth, propagated by `scripts/bump-version.mjs` and checked for
drift by `scripts/verify-version.mjs` (wired into `pnpm check`).

**Release artifacts.** `scripts/release/build-dedicated-server-artifact.mjs` produces a real Linux
tarball reusing the exact same `pnpm deploy --prod` pruning the Dockerfile already uses. `scripts/
release/build-manifest.mjs` emits `release-manifest.json` and `SHA256SUMS`, verified with a real
`sha256sum -c` pass.

**Architecture support.** Linux **x64 only** is supported in this release. `lib/fetch-verify.sh`'s
`detect_arch()` `die`s with an explicit, actionable message on arm64/aarch64 hosts instead of silently
constructing a doomed download URL — arm64 is not advertised as supported anywhere (release manifest,
installer detection, and docs all agree). Nothing in the dedicated-server's dependency closure requires
native compilation, so arm64 is realistically buildable in a future release, but no arm64 artifact has
been built or run on real arm64 hardware — this release deliberately reports "not yet supported" rather
than a weaker "appears buildable."

**Installer.** `infrastructure/install/install-chantivo.sh` (native + Docker modes, `--mode`,
`--hostname`, `--yes`, `--release-source`, `--with-turn`/`--no-turn`, `--with-tls`/`--no-tls`/
`--tls-only`/`--skip-dns-check`, `--configure-firewall`, `--force-reinstall` + a separate data-affecting
confirmation flag), `infrastructure/install/chantivo-server` (operator CLI dispatcher),
`infrastructure/install/lib/fetch-verify.sh` (shared download/checksum/extraction logic, sourced by
both, never duplicated). Reproduces T14's Coturn Docker-permission fix (`chown 65534:65534`/`chmod 400`,
created with that mode from the first byte) in its own dedicated code path, separate from native
Coturn's `root:turnserver`/`640` model.

**Native release layout.** `/opt/chantivo/releases/<version>/` + an atomically-flipped `/opt/chantivo/
current` symlink, replacing T14's single fixed path — enables `chantivo-server update`'s atomic swap
and rollback. (T14's own original validation deployment still runs its pre-T15 fixed-path layout —
`--tls-only` was exercised against it via a temporary, reversible compatibility symlink; see
[Fresh environment proof](#fresh-environment-and-real-host-proof) below.)

**Operator CLI backend.** `services/dedicated-server/src/cli-admin-token.ts` (mints a Server Admin
recovery token via the existing, already-tested `AuthorizationStore.createToken`, deliberately
bypassing the data-directory instance lock — proven safe against a live server by a dedicated same-file
concurrent-access integration test, and independently re-confirmed by a focused 7-point design review;
see [Security review](#security-review)) and `cli-doctor.ts` (config/data-directory/SQLite-file/
health-endpoint/TURN-mint checks). Both directly importable/testable, not just child-process-invoked.
`chantivo-server`'s native-mode `doctor`/`admin-token create` now source `/etc/chantivo/server.env`
before invoking these (a real, VPS-fixture-found bug: without it, both silently used the wrong default
data directory and either failed outright or reported a false FAIL despite the live service being
healthy).

**Bootstrap-claim E2E.** The existing real-protocol integration test asserts a second
`client:authorization-redeem-token` attempt against an already-consumed admin token is correctly
rejected with `TOKEN_ALREADY_USED` over the real WebSocket connection, not just via a direct store call.

**Initial admin token: found and fixed a real log-leak, then redesigned the delivery mechanism.** An
earlier iteration of this closure pass made the installer's final output echo the admin token inline by
scraping it out of `journalctl`/`docker compose logs` — which surfaced the real, pre-existing problem
this was built on top of: the Dedicated Server's own supervised process had **always** (since T9)
printed that token into its own stdout, which systemd/Docker capture wholesale. A real, raw token was
confirmed sitting in the validation VPS's own journal. This is now fixed at the root, not papered over:
the server no longer generates or prints an admin token at all. `AuthorizationStore.seedFreshDatabase()`
seeds only the built-in groups; the very first Server Admin credential a server ever has — and every
later recovery credential — comes exclusively from the already-safe, one-shot `chantivo-server
admin-token create` process (`cli-admin-token.ts`), whose stdout is never part of the supervised
service's captured log stream. The installer now runs this command automatically immediately after the
server reports healthy and displays ITS direct output — never journal/log-derived — in its own final
summary, alongside an explicit per-component Status block. `admit()`'s invite-only admission gate (which
used to accept the removed `'bootstrap'`-kind token to prevent an operator from locking themselves out
of their own invite-only server) now accepts a `'privilege'`-kind token instead — the kind
`admin-token create` mints — granting no new capability (a `'privilege'` token was already redeemable
with identical effect via `redeemToken()`; this only changes _when_ it can be consumed, not what it
grants). See [Bootstrap token log leak](#bootstrap-token-log-leak) below for the full finding, fix, and
proof.

**TLS/Caddy automation.** See [TLS / Caddy automation](#tls--caddy-automation) below — this is the
largest single piece of new functionality added in the closure pass.

**Windows installer.** `@electron-forge/maker-squirrel` + `electron-squirrel-startup`, producing a real
`Chantivo-0.1.0 Setup.exe`. A genuine two-version Squirrel **upgrade** proof (not a fresh-install/
uninstall cycle) confirmed the T13.5 `userData` pin survives a real upgrade; see
[Windows real upgrade proof](#windows-real-upgrade-proof). No auto-update feed wired (no real release
hosting exists yet).

## Deployment/distribution model

```
Operator's fresh Ubuntu VPS/host
   |
 install-chantivo.sh --mode native|docker --release-source <url|path> [--hostname <host>]
   |
 downloads + checksum-verifies a release-manifest.json-described artifact
   |
 automates the T14-proven native/Docker procedure, plus (when a hostname is given) Caddy/TLS
   |
 chantivo-server (operator CLI): status | logs | restart | doctor | backup | update |
                                  admin-token create | version
```

Adding a hostname/TLS to an already-installed deployment later, without touching server data:

```
install-chantivo.sh --mode native|docker --hostname <host> --tls-only --yes
```

Windows client: `apps/desktop/out/make/squirrel.windows/x64/Chantivo-<version> Setup.exe`, built via
`pnpm build:desktop-runtime` followed by `pnpm --filter @disco-voador/desktop run make` (the first
step compiles the `@disco-voador/*` `dist/` output Forge's Vite build resolves against; on a clean
checkout `make` alone fails with `Failed to resolve entry for package "@disco-voador/config"`).
`scripts/release/build-windows-artifact.mjs` runs both steps itself.

## What's deliberately not in T15

No CI/CD pipeline, no container-registry publishing, no real public release hosting (the
`--release-source` abstraction prepares for it without requiring it to exist yet). No auto-update feed.
No public GitHub Release, npm publish, Docker image publish, or DNS change beyond the one operator-owned
record created to validate this task's own TLS automation — this task produces and proves the
distribution pipeline, it does not publish anything, per explicit instruction. No T16 work.

## TLS / Caddy automation

When a real `--hostname` is given, the installer offers (defaulting to yes)
`Configure HTTPS/WSS automatically with Caddy?`. `configure_tls_caddy` is one shared code path used
identically by native install, Docker install, and `--tls-only` — a host-level Caddy fronting the app's
`127.0.0.1:8090` listener works the same regardless of how the app itself got there.

- **DNS validation** (`dns_resolves_to_this_host`) is local-only — `getent hosts` compared against
  `hostname -I` — deliberately never a third-party IP-echo service, matching this project's
  no-required-external-SaaS rule. A mismatch prints an actionable message (create/update the DNS
  record, then rerun with `--tls-only`) and skips TLS non-fatally; the rest of the install still
  succeeds. No unbounded retry anywhere in this path.
- **Pre-existing Caddy is never touched directly.** If Caddy/a Caddyfile already exists, the Chantivo
  site block is written to a dedicated `/etc/caddy/conf.d/chantivo.caddy` instead, and the main
  Caddyfile is only reloaded (never restarted) if it already `import`s that directory — otherwise the
  installer prints the exact snippet to add and stops, non-fatally.
- **IP-only installs remain fully valid.** No hostname means no TLS prompt at all; the summary
  explicitly explains that public CA-issued TLS needs a real hostname (a bare IP cannot get one), that
  the server is reachable now over plain `ws://`, and gives the exact `--tls-only` rerun command —
  which never touches `/var/lib/chantivo`, `/opt/chantivo/releases`, or the Docker Compose stack.
- **`--tls-only`** requires an existing install for the given `--mode` (reusing the same detection
  already used by the normal preflight checks) and only runs DNS validation + Caddy install/config +
  readiness check — nothing else.
- Firewall automation opens `80/443/tcp` in addition to the existing rules whenever TLS is enabled.

### Security review and fixes (Caddy/TLS code)

A focused security review of this new surface found two release-blocking issues and three lower-severity
ones, all fixed and independently re-verified (shellcheck-clean, and the specific false-positive/
overwrite scenarios directly reproduced and confirmed fixed):

1. **High** — `caddy_preexisting` was derived only from whether the `caddy` binary/unit was currently
   installed, not from whether `/etc/caddy/Caddyfile` already had real content. A plausible, ordinary
   sequence (`apt-get remove caddy` without `--purge`, which removes the binary/unit but leaves the
   conffile) would have been treated as "safe to overwrite." Fixed: a non-empty `Caddyfile` is now
   independently sufficient to route to the safe conf.d path, regardless of package/unit presence.
   **Real-VPS-fixture-reproduced and confirmed fixed** (see Fresh environment proof).
2. **High** — `caddyfile_imports_confd`'s match was an unanchored, comment-blind `grep`, which could
   false-positive on a commented-out import line or one nested inside an unrelated site's own block —
   then reload (falling back to `restart` on failure) against a config that doesn't actually serve the
   Chantivo site, risking an outage of any other sites Caddy already hosted. Fixed: comment-stripping +
   brace-depth tracking so only a genuine top-level import counts, and the restart fallback was removed
   entirely for the pre-existing-Caddy branch (a failed reload is now reported and left for the operator,
   never escalated to a restart). **Real-VPS-fixture-reproduced and confirmed fixed.**
3. **Medium** — the shared hostname validator permits `{`, `}`, `#` (needed by its other caller, a
   version-string check), which are exactly the characters that give a Caddyfile its block/comment
   syntax — a crafted `--hostname` could have injected a second site block. Fixed: a
   `validate_hostname_arg()` wrapper additionally rejects those three characters for `--hostname`
   specifically.
4. **Low** — the two privileged writes in `install_caddy_package` (GPG keyring, apt source list) were
   missing the symlink-guard convention every other privileged write in the file uses. Fixed for
   consistency. Also newly found via real-fixture testing: `gpg --dearmor -o` on Caddy's own package
   already refuses to silently overwrite an existing regular file (interactive `/dev/tty` prompt,
   hard-fails non-interactively) — a real, 100%-reproducible failure on any second `install_caddy_package`
   invocation against a host where its own prior keyring file remains. Fixed by removing any pre-existing
   regular file (not just a symlink) before writing.
5. **Informational** — the fetched Cloudsmith apt-source-list content is now asserted to still scope
   trust via `signed-by=` to the exact keyring this script writes, before being written, `die`ing rather
   than silently installing an apt-wide-trusted third-party repository if that ever changed upstream.

A separate, focused 7-point confirmatory review of the pre-existing `admin-token create` concurrent-
SQLite design (transactionality, no accidental schema migration/reseed against a live server, bounded
busy-timeout, race-safety, token uniqueness, scope of the data-dir-lock bypass) passed 6 of 7 points
outright; the seventh found one latent (not currently triggerable) gap — `cli-admin-token.ts` runs the
same migration-runner logic the live server's startup uses, with no explicit guard preventing it from
applying a not-yet-applied migration against a database a live, possibly older-binary server process
still has open. Harmless today (the authorization store has exactly one migration, already applied by
the time this CLI's own precondition check lets it proceed), but tracked as a required follow-up before a
second migration is ever added to `authorization/migrations.ts` — not a release blocker, per explicit
instruction not to redesign this concurrent-access model absent a concrete invariant violation.

## Bootstrap token log leak

**Finding.** The Dedicated Server's one-time initial Server Admin token had, since T9, been printed by
the server's own supervised process (`cli.ts`'s `printStartupBanner`, via `console.info`) — and that
process's stdout is captured wholesale by `journalctl -u chantivo-server` / `docker compose logs`. A
real, raw token was confirmed sitting in the validation VPS's own journal. This was surfaced while
building this closure pass's "installer shows the token directly" requirement, which (in its first,
now-replaced iteration) made the leak more visible by having the installer itself scrape the token out
of the journal — the right fix was closing the leak at its root, not automating around it.

**Fix.** `AuthorizationStore.seedFreshDatabase()` no longer mints or returns a token — a fresh store
seeds only its three built-in groups and claims no admin. The server's startup banner shows only a
safe, non-secret hint while unclaimed ("No administrator has claimed this server yet. Run: sudo
chantivo-server admin-token create"), gated on a new `hasAnyServerAdmin()` check so it never repeats
after the server is claimed. The initial admin credential — and every later recovery credential — now
comes exclusively from the already-safe `chantivo-server admin-token create` (`cli-admin-token.ts`), a
distinct one-shot process whose stdout was never part of the supervised service's log stream even
before this fix. `admit()`'s invite-only admission gate (which used the now-removed `'bootstrap'`-kind
token to guarantee an operator could never lock themselves out of their own invite-only server) now
accepts `'privilege'`-kind tokens instead — the kind `admin-token create` mints — granting no new
capability: `'privilege'` tokens were already redeemable with identical effect via `redeemToken()`
before this change; only _when_ they can be consumed changed, never _what_ they grant. The installer
(`install-chantivo.sh`) now runs `chantivo-server admin-token create` automatically immediately after
the server reports healthy and displays its direct stdout — never journal/log-derived — in its own
final summary.

**Regression test.** `tests/dedicated-server/token-leak-regression.test.ts` spawns the real, unmodified
`cli.ts`/`cli-admin-token.ts` as genuine OS child processes with piped stdio (every other test in this
suite injects an in-process logger double, which never exercises the actual `console.info` call sites
systemd/Docker capture). Proves, with a known real minted token value (not a pattern match): the CLI's
own stdout receives it (positive control); the still-running server's stdout AND stderr never contain
that exact value, even after it is redeemed against that server over a real WebSocket connection; and a
restarted, already-claimed server never repeats the "unclaimed" hint.

**Security review.** A focused independent review of the fix (the `admit()` gate change specifically,
since it is the most safety-critical part) confirmed: no new capability or attack surface (minting a
`'privilege'` token remains gated behind `authorization.tokens.manage` over the network, or local
root-shell access via the CLI); the leak is genuinely closed at every checked surface (`doctor`,
`status`, `backup`, `logs`, native and Docker paths — `docker exec`-spawned output is not part of
`docker compose logs` by Docker's own documented behavior); no other leak path exists (tokens are only
ever persisted as SHA-256 digests, never raw, anywhere at rest); the regression test's assertions hold
up under scrutiny. One low-severity, self-healing note: an old, pre-T15, still-unredeemed `'bootstrap'`-
kind token on an upgraded invite-only server would no longer satisfy the (changed) admission gate — the
operator's local shell access to re-run `admin-token create` remains the recovery path, so this is a
one-command inconvenience at worst, never a lockout with no recovery.

**Real proof (fresh isolated fixtures on the validation VPS, real production untouched throughout).**
Both native and Docker fixtures were built from the exact current source (including this fix), via the
real release pipeline for native and a real `docker compose ... up -d --build` from this checkout's own
Dockerfile for Docker — not a stale prior artifact.

|                                                       | Native | Docker |
| ----------------------------------------------------- | ------ | ------ |
| Installer's own output shows the token                | YES    | YES    |
| Journal / `docker compose logs` contain the raw token | NO     | NO     |
| Real redemption over the real protocol succeeds       | YES    | YES    |
| Reusing the same token a second time is rejected      | YES    | YES    |

A hand-run `chantivo-server admin-token create` recovery call (native) also worked, minting an
independent second token, redeemed successfully, with the full journal re-confirmed clean afterward.
Real production's `chantivo-server`/`coturn`/`caddy` were confirmed active and un-restarted (unchanged
`ActiveEnterTimestamp`) throughout — only the two isolated fixture containers were ever mutated. Fixtures
and their on-host install logs (which had captured real token values) were fully destroyed afterward.

## Client address normalization and public endpoint hardening

Two real product findings from the first packaged-client test against the real public beta server.

**1. Bare hostname failed to connect.** `apps/desktop/src/renderer/connection/parse-server-address.ts`
(the single, already-shared address-parsing helper used by every Add/Edit Server and reconnect path —
confirmed no parallel implementation exists) defaulted a scheme-less input to insecure `ws://` on port 8090. A real production hostname typed bare — exactly what a normal user types — silently resolved to
the wrong scheme and wrong port. Fixed: bare input now defaults to `wss://` (port 443). An explicit
`ws://host[:port]` is unchanged and remains the deliberate path for local/dev use
(`ws://localhost:8090`, `ws://127.0.0.1:8090`) and IP-only self-hosting without TLS — only an explicitly
typed `ws://` ever produces a plain-`ws://` result now; a bare `localhost`/`127.0.0.1` is not
special-cased and also defaults to `wss://`, for consistency rather than implicit guessing. No
`wss://`-to-`ws://` fallback-on-failure logic exists anywhere in the codebase (confirmed by grep both
before and after this change). `http://`/`https://` input remains a clear, deliberate rejection rather
than a silent scheme remap. `AddServerDialog.tsx` was also fixed to persist the canonical
`wss://host:port` form in bookmarks instead of the raw typed string — every read path already re-parses
`bookmark.serverAddress` through the same shared helper at use time, so existing bookmarks (bare or
raw `ws://` strings) keep working with zero migration, resolving correctly the next time they're used.

**2. `/healthz`/`/readyz` were publicly exposed.** T15's own Caddy automation proxied every path,
including the two internal-only operational endpoints, to anyone on the internet.
`infrastructure/reverse-proxy/Caddyfile.example` now blocks them explicitly (a named matcher +
`respond ... 404`, placed before the `reverse_proxy` catch-all) while leaving the Dedicated Server's own
`/healthz`/`/readyz` fully intact for internal use (Docker/systemd health checks, the installer's own
readiness probe, `chantivo-server doctor`) — this is a reverse-proxy-layer change only, nothing was
removed from `services/realtime`. The installer's own `wait_for_https_health` readiness check, which
used to poll the now-intentionally-blocked `/healthz` through Caddy, now proves a real WebSocket
upgrade (`101 Switching Protocols`) at `/` instead — a stronger check, since it proves the actual thing
this product needs (WSS working end-to-end), not just an HTTP 200. The pre-existing-Caddy safety logic
(never touching an operator's own Caddyfile, conf.d routing, import detection) is untouched.

**Real proof, both fixes, both deployment modes:**

|                                        | Native (real production `beta.chantivo.app`) | Docker (fresh isolated fixture)                                    |
| -------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------ |
| External `/healthz`/`/readyz`          | `404`                                        | `404`                                                              |
| Internal `/healthz`/`/readyz`          | `200`                                        | `200` (published port, in-container, and Dockerfile `HEALTHCHECK`) |
| `chantivo-server doctor`               | 9/9 PASS                                     | 8/8 PASS                                                           |
| Real WSS upgrade (`101`) through Caddy | confirmed                                    | confirmed                                                          |
| Caddy reload vs. restart               | reload only, same PID throughout             | n/a (fresh fixture)                                                |

The native proof ran directly against the real, live `beta.chantivo.app` deployment: backed up first,
config validated before every reload, verified reload (not restart) via an unchanged Caddy PID, and
`chantivo-server`/`coturn`/`caddy` confirmed active with all existing data/config/TURN
secret/certificate untouched throughout. The packaged/client-side fix was proven with a real, live
Electron app (dev-mode build — the existing packaged `.exe` predated the fix and a full Squirrel
rebuild was judged unnecessary for a Renderer-only change already separately proven safe by the earlier
upgrade-lifecycle work) driven via genuine Chrome DevTools Protocol input events against real DOM
elements — not a unit test, not a mock: typing bare `beta.chantivo.app` and connecting reached the real
production server's own name, real voice channels, and real member list, which is only reachable via a
successful `wss://` handshake. The saved bookmark's Edit view confirmed the canonical
`wss://beta.chantivo.app:443` form. One incidental, disclosed side effect: debugging the verification's
own input driver briefly deleted and recreated a real local bookmark on the operator's desktop profile
during cleanup — the final state is a legitimate, correctly-canonicalized bookmark for the same server,
though its bookmark ID changed from the original.

## TURN relay reliability

A release-blocking real-world finding: one real Windows packaged client consistently failed all peer
media (remote/outbound voice, remote/outbound screen share) against real `beta.chantivo.app`, while two
other real clients worked fine with each other. Real Chromium logs showed ICE performing host/UDP
checks only, timing out, and `IceConnectionState: checking -> failed` — never a relay candidate
selected. The user's own initial hypothesis (a client-side race between TURN-credential arrival and
peer-connection creation) was investigated and **disproven with real measurement**: `server:turn-
credentials` arrives in the same synchronous post-auth burst as `server:hello`, strictly before any
`voice:joined` reply is structurally possible over the same WebSocket, on every path (initial connect,
reconnect-restore, channel switch, server switch, late arrival).

**Actual root cause**: the real beta server's `/etc/chantivo/server.env` had `DISCO_VOADOR_TURN_URLS=
turn:127.0.0.1:3478` — the client's own loopback address, handed to every client verbatim
(`mint-turn-credentials.ts`) as their _only_ ICE server (no STUN is separately configurable for a
packaged client). Unreachable from any real client, so both relay and server-reflexive candidates
failed — only host candidates remained, which only works when peers are directly reachable. This
precisely explains "one client fails, others don't": the working clients' networks apparently didn't
strictly require relay. A second, independent defect was found in the same investigation: TURN
credentials were minted once per connection with a 300-second TTL and no refresh path — any voice join
more than ~5 minutes after connecting received expired, useless credentials (confirmed against real
Coturn: `401 Unauthorized`, zero relay candidates).

**Fixes applied:**

1. **Production config correction** (explicitly authorized before applying, backed up first): `DISCO_
VOADOR_TURN_URLS` → `turn:beta.chantivo.app:3478`; `DISCO_VOADOR_TURN_CREDENTIAL_TTL_SECONDS` → `21600`
   (6h, Coturn's own default). Applied via `systemctl restart chantivo-server` — Coturn and Caddy were
   never restarted or touched.
2. **General TURN self-healing** (`packages/rtc-core`): `P2PMeshTransport.setIceServers()` previously
   only affected peer connections created _after_ the call — an existing peer that predated a TURN-
   server update (for any reason, not just this specific bug) could never recover. Now, any peer that
   has not yet established a working transport is healed via `RTCPeerConnection.setConfiguration()` +
   `restartIce()`, flowing through the existing perfect-negotiation renegotiation path — already-working
   peers are never disturbed. This directly corrects a prior (incorrect) doc comment claiming Chromium
   doesn't support updating a live connection's ICE servers — proven wrong on this project's own real
   Electron/Chromium build (a connection with `iceServers: []` gathered host-only candidates; after
   `setConfiguration()` + `restartIce()`, the _same_ connection gathered srflx and relay).
3. **Reconnect no longer discards known TURN state**: `use-voice-channel.ts`'s `recreateTransport()`
   (used on every automatic reconnect) previously rebuilt with only the base ICE list; it now carries
   forward the last-known combined STUN+TURN list.
4. **Failure UX**: a participant whose connection genuinely reaches `'failed'` now shows a plain-
   language indicator ("Voice connection problem") in the roster — no ICE/STUN/TURN/DTLS jargon exposed
   to normal users. A connection-level banner and an Advanced/debug diagnostics view were flagged as
   legitimate follow-up scope (no such surface exists yet anywhere in this codebase) rather than rushed.

**Real proof, not simulated**, at every stage: a forced-relay proof (real Electron/Chromium
`RTCPeerConnection`s, `iceTransportPolicy: 'relay'`, `RTCDataChannel` only, no media) first against a
corrected URL to prove the mechanism, then — after the production fix was applied — reproduced with
**unmodified, real production-minted credentials**, and a third time as two genuinely independent
Electron **processes** (not one process talking to itself), each performing its own real handshake
against production, each selecting a real relay↔relay candidate pair, exchanging real bidirectional
data (symmetric byte counts across the two independent processes). A real two-instance desktop-client
retest on the same development machine confirmed real bidirectional decoded audio — honestly caveated
that a single machine's two instances resolve to a host/host pair locally and cannot itself prove relay
reliance; that evidence is the forced-relay proofs above. Production's existing data, Coturn, and Caddy
were confirmed completely unaffected throughout (unchanged service uptimes, unchanged SQLite file
mtimes, no channels/tokens/bans/messages created by any of the testing).

**Known, explicitly flagged follow-ups (not blocking, not silently dropped)**: no mid-session TURN
credential refresh protocol exists yet (6h is a safe margin, not a real fix — needs a realtime-protocol
addition); operators have no way to advertise a `stun:` URL to clients; Coturn advertises additional
relay addresses (Docker bridge, `::1`) alongside the public one
— benign in every allocation observed, but not pinned; a peer that reaches `'failed'` is still closed
permanently with no automatic retry for the remainder of the session.

## Windows real upgrade proof

A genuine, actual-installer-lifecycle Squirrel **upgrade** (not install→launch→uninstall of a single
version) was proven on the real Windows development workstation: a real, independently-built baseline
installer (version `0.0.9`, built in a fully isolated scratch copy — never a hardlinked/faked directory,
and the real repository's own `0.1.0` version state was confirmed untouched afterward) was installed for
real, a real nickname/identity was created through the actual first-run UI via genuine OS-level keyboard
input, then the real, already-built `Chantivo-0.1.0 Setup.exe` was run over that existing install.
Squirrel's own install log recorded the real upgrade signature ("Install path ... already exists, burning
it to the ground") that did not appear during the baseline's own first install, and the registry/on-disk
`app-<version>` directory transitioned `0.0.9 → 0.1.0`. The identity and nickname set under the baseline
were confirmed byte-identical before and after the upgrade, and the upgraded app launched directly to the
signed-in state with no first-run prompt — proving `%APPDATA%\@disco-voador\desktop` (the T13.5 pin) was
read, not regenerated or migrated. The machine's real pre-existing userData (if any) was backed up before
testing and restored afterward; the test install was fully uninstalled at the end.

## Fresh environment and real-host proof

Evidence in this task is explicitly labeled by its actual environment, per the completion brief's
requirement never to conflate them:

- **Real VPS host** (the actual validation VPS's live, native T14 deployment): confirmed intact and
  healthy (`chantivo-server`/`coturn`/`caddy` all active, `/healthz`/`/readyz` OK) before, during, and
  after every phase of this task's testing, including the real TLS proof below.
- **Fresh, isolated, systemd-capable Docker fixture** (hosted on the real VPS, but never touching its
  live native services): used for native-mode installer testing, including the pre-existing-Caddy safety
  path, the `apt-get remove caddy` (no `--purge`) leftover-Caddyfile scenario (both confirmed safely
  handled after the fixes above), `--tls-only`'s data-directory non-interference (byte-identical
  checksums before/after), and the token leak-check matrix (zero matches for a minted token across
  `journalctl`, `status`, `doctor`, and health/readiness output, under both native and Docker mode).
- **Real, bookended production test** (explicitly authorized, narrowly scoped): with the real VPS's own
  live services otherwise undisturbed, a temporary, reversible compatibility symlink was added so the
  real (pre-T15-layout) validation deployment satisfied `--tls-only`'s precondition check, the real
  `install-chantivo.sh` was run against a real, operator-created public DNS record for a subdomain of
  the product's own domain, and — after also opening `80/443/tcp` in the host firewall (previously only
  a custom internal-CA port was open) — Caddy obtained a **real, publicly CA-issued Let's Encrypt
  certificate** (verified independently via `openssl s_client`, full chain to ISRG's real root,
  `Verify return code: 0 (ok)`), and a real WSS upgrade (`HTTP/1.1 101 Switching Protocols`) was
  confirmed through it. Caddy was **reloaded, not restarted**, throughout (confirmed via its unchanged
  process start time) — the pre-existing internal-CA site never went down. This subdomain and the
  firewall change were kept live afterward at the operator's explicit direction, alongside the real T14
  site, rather than reverted as a one-off test. The real host's public IP address is deliberately not
  recorded in this file or any other committed document.
- **Real Windows development workstation**: the Squirrel upgrade proof above.

## Verification

**Passing, with real evidence:**

- `corepack pnpm check`: 1709/1709 tests, all guardrails, clean — run after every closure-pass fix.
- Real dedicated-server tarball built, checksummed, extracted outside the repo, run standalone —
  `/healthz` responded correctly with no `pnpm dev`/cloned-repo/TypeScript-runtime requirement.
- Real same-file concurrent `AuthorizationStore` access test, plus the separate focused 7-point design
  review above.
- Real bootstrap-claim E2E: fresh server → real token → real redemption → real Server Admin membership
  → real second-redemption rejection, asserted at the full WebSocket-protocol level.
- Real Windows Squirrel **upgrade** proof (see above) — supersedes the earlier, explicitly-rejected
  install→launch→uninstall proof.
- Real TLS/Caddy automation proof, including a genuine public Let's Encrypt certificate (see above) —
  supersedes the earlier "no automated TLS" framing entirely.
- `docker compose config` validated against the real Compose files for both installer-generated
  topologies.
- The original real-VPS installer-flow proof (native, in an isolated fixture; Docker, bookended against
  the real host) that found and fixed two defects (a directory-creation-ordering bug, and a
  `path.resolve`-vs-`realpathSync` symlink bug in `cli-doctor.ts`/`cli-admin-token.ts`) remains valid and
  unaffected by the closure-pass changes.

## Security review

Two rounds, both code-level (security-reviewer, read-only): the original pass (Coturn Docker-conf
TOCTOU, missing symlink guards, missing `busy_timeout` — all fixed) and the closure-pass TLS/Caddy review
above (two High findings fixed, three lower-severity fixed), plus the separate focused admin-token
concurrent-design review (6/7 points pass outright, one tracked non-blocking follow-up). Everything else
from the original review remains valid and unaffected: `validate_safe_string()`/`validate_hostname_arg()`
invoked at every real call site; non-interactive `--mode` hard-fail is real code; checksum-before-extract
with unpredictable `mktemp -d` paths; real tar path-traversal hardening; `--force-reinstall` cannot reach
`/var/lib/chantivo` without a separate flag; firewall automation always allows SSH first and never
force-enables/resets; `electron-squirrel-startup` correctly placed with no IPC/Preload/Renderer
trust-boundary change; release manifest/`SHA256SUMS` contain no secrets/environment values/build-machine
paths; `doctor`'s TURN check mints locally only, no credential ever printed.

## Impact-based regression

T15 touches: packaging (Forge maker), installer/release scripts, server authorization (recovery token),
filesystem/update/backup tooling, desktop installation lifecycle, and (closure pass) reverse-proxy/TLS
automation. No camera/screen/screen-audio/process-audio/PTT E2E was run — no shared media-dependency
path was touched. No audible test tones.
