#!/usr/bin/env bash
# infrastructure/install/install-chantivo.sh
#
# Installs a Chantivo Dedicated Server on this Linux host, either as a native systemd service or as a
# Docker Compose stack. This is a REAL, MUTATING install script — read it (and --help) before running
# it, especially if you were told to pipe it straight into `bash` (see the --mode requirement below,
# which exists specifically to make an unattended `curl | bash` invocation fail safely instead of
# guessing).
#
# Optionally automates HTTPS/WSS via Caddy when a real public hostname is given (see --with-tls/
# --no-tls/--tls-only below) — gated by a local, no-third-party-dependency DNS-resolves-to-this-host
# check (see dns_resolves_to_this_host/configure_tls_caddy). Does not install Docker itself.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"

# shellcheck source=lib/fetch-verify.sh
source "${SCRIPT_DIR}/lib/fetch-verify.sh"

# --- Cleanup / error handling -----------------------------------------------------------------------

cleanup() {
  local path
  for path in "${CLEANUP_PATHS[@]-}"; do
    # Deliberately `if`, not `cond && action`: under `set -e`, a bare `&&` chain that is the LAST
    # command executed in a function (true here on every iteration where $path is empty/missing —
    # the normal case) makes the *function's own* return status reflect that "false" outcome, which
    # then spuriously fires the ERR trap when cleanup is invoked via `trap cleanup EXIT` — even on a
    # perfectly successful `exit 0`. `if`'s test condition is explicitly exempted from `-e` by bash's
    # own documented rules; a bare `&&`/`||` list used as an entire statement is not. Confirmed by a
    # real, reproduced false positive during this task's own local testing before this fix.
    if [ -n "$path" ] && [ -e "$path" ]; then
      rm -rf -- "$path"
    fi
  done
}
trap cleanup EXIT

on_err() {
  local exit_code=$?
  echo "install-chantivo.sh: failed (exit ${exit_code}) at line ${BASH_LINENO[0]:-?}, command: ${BASH_COMMAND:-?}" >&2
  exit "$exit_code"
}
trap on_err ERR

# --- Defaults / flags --------------------------------------------------------------------------------

MODE=""
HOSTNAME_ARG=""
TURN_URL_ARG=""
ASSUME_YES=0
RELEASE_SOURCE="${CHANTIVO_RELEASE_SOURCE:-}"
CONFIGURE_FIREWALL=0
FORCE_REINSTALL=0
I_UNDERSTAND_DATA_RISK=0
INSTALL_COTURN=0
TURN_DECISION_MADE=0
INSTALL_TLS=0
TLS_DECISION_MADE=0
TLS_ONLY=0
SKIP_DNS_CHECK=0

# --- Public Server Endpoint ----------------------------------------------------------------------
#
# ONE operator-facing concept: the single public address this deployment is reachable at. Both the
# client's WSS address and the TURN URL handed to remote clients normally derive from it, so an
# operator configures one thing (`--hostname`) and cannot end up with a working signaling address and
# a broken TURN address — the exact failure mode this whole block exists to make impossible.
#
# PUBLIC_ENDPOINT   the resolved endpoint: --hostname when given, else an auto-detected public IPv4,
#                   else empty (a local/LAN deployment — a fully supported posture, not an error).
# DEPLOYMENT_SCOPE  "public" (remote/internet clients intended) or "local" (development/LAN-only).
#                   Written to server.env as DISCO_VOADOR_DEPLOYMENT_SCOPE so `chantivo-server doctor`
#                   can tell a deliberate LAN loopback TURN address apart from a broken public one.
# TURN_URL          the final client-facing TURN URL, resolved by resolve_turn_url below.
#
# Never a Chantivo-operated address: this project has no central service. Every self-hosted install
# owns its own Dedicated Server, its own Coturn, and its own TURN traffic. Nothing in this script
# falls back to any Chantivo-operated relay, signaling service, or hostname if the operator's own
# TURN is missing or unreachable — if TURN is unavailable, direct P2P may still work and otherwise
# media fails visibly, with `chantivo-server doctor` explaining the real, local, server-side cause.
PUBLIC_ENDPOINT=""
DEPLOYMENT_SCOPE="local"
TURN_URL=""
TURN_URL_SOURCE=""

# Populated by install steps for use in the final summary / by generated config.
RELEASE_VERSION=""
TURN_SECRET_FOR_COTURN_CONF=""
# The final, honest, one-line TLS/WSS outcome for this run, printed verbatim in
# print_summary_native/print_summary_docker/print_summary_tls_only. Never fabricated — every code path
# that sets this corresponds to something that genuinely happened (or explicitly did not). Left at this
# default whenever TLS automation never ran at all (no --hostname given).
TLS_STATUS="SKIPPED (no hostname given)"

print_help() {
  cat <<'EOF'
Usage: install-chantivo.sh --mode <native|docker> [options]

Installs a Chantivo Dedicated Server on this host. Real, mutating install — read this help (and the
script itself) before running it, especially via `curl | bash`.

Options:
  --mode <native|docker>            Deployment mode. REQUIRED for non-interactive use (no TTY on
                                     stdin) — if omitted with a TTY attached, an interactive menu is
                                     shown instead; if omitted with no TTY, this script refuses to
                                     guess and exits with an error (deliberate curl|bash mitigation).
  --hostname <value>                The Public Server Endpoint: the one public hostname (or public
                                     IPv4) this server is reachable at. Clients connect to
                                     wss://<value> (or ws://<value>:8090 without TLS), and — if
                                     Coturn is installed — TURN is advertised as
                                     turn:<value>:3478 and Coturn's realm is set to it. Never used
                                     for binding. With no --hostname, this script uses a public IPv4
                                     of this host if it has one, and otherwise treats the install as
                                     a local/LAN deployment.
  --turn-url <turn:...|turns:...>   ADVANCED: advertise this exact TURN URL to clients instead of the
                                     one derived from --hostname. Only needed when Coturn runs on a
                                     DIFFERENT machine than the Dedicated Server. Wins over the
                                     derived default. A public deployment (a real --hostname or a
                                     public IP) may not point this at a loopback/private/container-
                                     only address — remote clients could never reach it.
  --yes                             Skip the confirmation prompt. Required in place of that prompt
                                     when running non-interactively.
  --release-source <url-or-path>    Where to download the release tarball/SHA256SUMS/manifest from
                                     (native mode only — docker mode builds from this checkout's own
                                     Dockerfile and does not use a release tarball at all). An
                                     http(s):// URL, a file://<path> URI, or a bare local directory
                                     path. Overridable via the CHANTIVO_RELEASE_SOURCE environment
                                     variable. No default is provided (no public release hosting exists
                                     yet) — native mode fails with a clear message if neither is set.
  --with-turn                       Install/configure Coturn (TURN relay) alongside the server.
  --no-turn                         Do not install Coturn. (Default when non-interactive and neither
                                     flag is given.)
  --with-tls                        Automatically configure HTTPS/WSS via Caddy (requires --hostname).
                                     When --hostname is given and neither this nor --no-tls is passed,
                                     you are prompted (default: YES, unlike the TURN prompt above) —
                                     or, non-interactively/with --yes, this is the default outcome.
  --no-tls                          Skip Caddy/TLS automation even though --hostname is given.
  --tls-only                        Configure ONLY DNS-validation + Caddy/TLS for an ALREADY-installed
                                     deployment (requires --mode and --hostname). Never touches
                                     /var/lib/chantivo, /opt/chantivo/releases, or the Docker Compose
                                     stack — this is the safe way to add a hostname/TLS after the fact,
                                     or to retry TLS once DNS has propagated. Fails with an actionable
                                     message if no existing install is detected for --mode.
  --skip-dns-check                  Skip the local DNS-resolves-to-this-host check before configuring
                                     Caddy/TLS (e.g. your hostname is behind a proxy/CDN this host
                                     cannot see). Off by default — most operators should not need this.
  --configure-firewall              Opt-in: add ufw rules for the ports this deployment needs (always
                                     22/tcp first; adds 80/443/tcp too when TLS automation is enabled).
                                     Off by default. Never force-enables ufw itself.
  --force-reinstall                 Allow re-running install steps against an apparently-existing
                                     installation. By itself this NEVER touches /var/lib/chantivo.
  --i-understand-this-may-affect-data
                                     Required together with --force-reinstall whenever existing data is
                                     found under /var/lib/chantivo, as a distinct, explicit
                                     confirmation beyond --force-reinstall alone.
  -h, --help                        Show this help and exit.

Examples:
  ./install-chantivo.sh --mode native \
      --release-source file:///opt/chantivo-dist/dist-release/0.1.0 --hostname voice.example.com --yes

  ./install-chantivo.sh --mode docker --hostname voice.example.com --with-turn --configure-firewall

  # Add a hostname + automatic TLS later, without touching an existing native install's data:
  ./install-chantivo.sh --mode native --hostname voice.example.com --tls-only --yes
EOF
}

# --- Argument parsing ---------------------------------------------------------------------------------

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --mode)
        MODE="${2:-}"
        shift 2
        ;;
      --mode=*)
        MODE="${1#*=}"
        shift
        ;;
      --hostname)
        HOSTNAME_ARG="${2:-}"
        shift 2
        ;;
      --hostname=*)
        HOSTNAME_ARG="${1#*=}"
        shift
        ;;
      --turn-url)
        TURN_URL_ARG="${2:-}"
        shift 2
        ;;
      --turn-url=*)
        TURN_URL_ARG="${1#*=}"
        shift
        ;;
      --yes)
        ASSUME_YES=1
        shift
        ;;
      --release-source)
        RELEASE_SOURCE="${2:-}"
        shift 2
        ;;
      --release-source=*)
        RELEASE_SOURCE="${1#*=}"
        shift
        ;;
      --with-turn)
        INSTALL_COTURN=1
        TURN_DECISION_MADE=1
        shift
        ;;
      --no-turn)
        INSTALL_COTURN=0
        TURN_DECISION_MADE=1
        shift
        ;;
      --with-tls)
        INSTALL_TLS=1
        TLS_DECISION_MADE=1
        shift
        ;;
      --no-tls)
        INSTALL_TLS=0
        TLS_DECISION_MADE=1
        shift
        ;;
      --tls-only)
        TLS_ONLY=1
        shift
        ;;
      --skip-dns-check)
        SKIP_DNS_CHECK=1
        shift
        ;;
      --configure-firewall)
        CONFIGURE_FIREWALL=1
        shift
        ;;
      --force-reinstall)
        FORCE_REINSTALL=1
        shift
        ;;
      --i-understand-this-may-affect-data)
        I_UNDERSTAND_DATA_RISK=1
        shift
        ;;
      -h | --help)
        print_help
        exit 0
        ;;
      *)
        die "Unknown argument: $1 (see --help)"
        ;;
    esac
  done
}

prompt_mode_menu() {
  echo "Select deployment mode:" >&2
  echo "  1) native (systemd)" >&2
  echo "  2) docker (Compose)" >&2
  local choice
  read -r -p "Enter 1 or 2: " choice
  case "$choice" in
    1) printf 'native' ;;
    2) printf 'docker' ;;
    *) die "Invalid selection: $choice" ;;
  esac
}

resolve_mode() {
  if [ -z "$MODE" ]; then
    if [ -t 0 ]; then
      MODE="$(prompt_mode_menu)"
    else
      die "No --mode given and stdin is not a TTY (a non-interactive invocation, e.g. curl | bash) — pass --mode native or --mode docker explicitly. This script never guesses a deployment mode for you."
    fi
  fi
  case "$MODE" in
    native | docker) ;;
    *) die "Invalid --mode: $MODE (must be 'native' or 'docker')" ;;
  esac
}

resolve_turn_decision() {
  if [ "$TURN_DECISION_MADE" -ne 1 ]; then
    if [ -t 0 ] && [ "$ASSUME_YES" -ne 1 ]; then
      local answer
      read -r -p "Install/configure Coturn (TURN relay) alongside the server? [y/N]: " answer
      case "$answer" in
        y | Y | yes | YES) INSTALL_COTURN=1 ;;
        *) INSTALL_COTURN=0 ;;
      esac
    else
      INSTALL_COTURN=0
      echo "Neither --with-turn nor --no-turn given, running non-interactively (or --yes) — defaulting to no TURN (STUN/P2P-only). Pass --with-turn to enable Coturn." >&2
    fi
  fi
}

# resolve_tls_decision: TLS is only ever offered when a real --hostname was given (a bare IP cannot get
# a publicly-trusted certificate — see configure_tls_caddy/print_tls_summary_block). Unlike
# resolve_turn_decision above, BOTH the interactive prompt's empty-input default AND the
# non-interactive/--yes default are YES here — this is the user-facing behavior this task exists to
# close: "Configure HTTPS/WSS automatically with Caddy? [Y/n]" defaulting to on.
resolve_tls_decision() {
  if [ -z "$HOSTNAME_ARG" ]; then
    INSTALL_TLS=0
    return 0
  fi
  if [ "$TLS_DECISION_MADE" -ne 1 ]; then
    if [ -t 0 ] && [ "$ASSUME_YES" -ne 1 ]; then
      local answer
      read -r -p "Configure HTTPS/WSS automatically with Caddy? [Y/n]: " answer
      case "$answer" in
        n | N | no | NO) INSTALL_TLS=0 ;;
        *) INSTALL_TLS=1 ;;
      esac
    else
      INSTALL_TLS=1
      echo "Neither --with-tls nor --no-tls given, running non-interactively (or --yes) with --hostname set — defaulting to yes (automatic HTTPS/WSS via Caddy). Pass --no-tls to disable." >&2
    fi
  fi

  # TLS_STATUS defaults to "SKIPPED (no hostname given)", which is wrong once we reach here (a
  # hostname WAS given). If TLS ends up declined (explicit --no-tls, or a "no" answer above),
  # configure_tls_caddy never runs to set a more specific TLS_STATUS — set an accurate one now so
  # print_tls_summary_block never prints a stale/misleading reason. configure_tls_caddy overwrites this
  # with the real outcome if TLS automation does run.
  if [ "$INSTALL_TLS" -ne 1 ]; then
    TLS_STATUS="SKIPPED (not requested — pass --with-tls, or rerun later with --tls-only, to enable)"
  fi
}

confirm_and_summarize() {
  echo
  echo "About to install Chantivo Dedicated Server:"
  echo "  Mode:            $MODE"
  echo "  Public server:   ${PUBLIC_ENDPOINT:-<none — local/LAN deployment>}"
  echo "  Deployment:      ${DEPLOYMENT_SCOPE}"
  echo "  Install Coturn:  $([ "$INSTALL_COTURN" -eq 1 ] && echo yes || echo no)"
  if [ "$INSTALL_COTURN" -eq 1 ]; then
    echo "  TURN URL:        ${TURN_URL} (${TURN_URL_SOURCE})"
  fi
  if [ -z "$HOSTNAME_ARG" ]; then
    echo "  Configure TLS:   no (no --hostname given — a bare IP cannot get a public TLS certificate)"
  else
    echo "  Configure TLS:   $([ "$INSTALL_TLS" -eq 1 ] && echo yes || echo no) (Caddy, automatic HTTPS/WSS)"
  fi
  echo "  Configure ufw:   $([ "$CONFIGURE_FIREWALL" -eq 1 ] && echo yes || echo no)"
  if [ "$MODE" = native ]; then
    echo "  Release source:  ${RELEASE_SOURCE:-<none — will fail>}"
  fi
  echo

  if [ "$ASSUME_YES" -eq 1 ]; then
    return 0
  fi
  if [ ! -t 0 ]; then
    die "Running non-interactively without --yes — pass --yes to proceed with the summary above, or run this script interactively."
  fi
  local answer
  read -r -p "Proceed? [y/N]: " answer
  case "$answer" in
    y | Y | yes | YES) return 0 ;;
    *)
      echo "Aborted — no changes made."
      exit 0
      ;;
  esac
}

# --- Shared small helpers ------------------------------------------------------------------------------

# validate_hostname_arg: lib/fetch-verify.sh's validate_safe_string() blocks shell/sed-metacharacters
# generically, but deliberately permits '{', '}', '#', and ':' — all unremarkable for its OTHER caller
# (a package.json version string) but '{'/'}'/'#' are exactly the characters that give a Caddyfile its
# block-nesting/comment syntax (see infrastructure/reverse-proxy/Caddyfile.example's own
# `{$CHANTIVO_PUBLIC_HOSTNAME} {` line). --hostname is later spliced verbatim into a generated Caddyfile
# (write_caddy_site_block) and a Coturn realm line, so a value like `evil.com { reverse_proxy ... } x`
# could add an unintended second Caddy site. A real DNS hostname or IP address never legitimately needs
# '{', '}', or '#' — this closes the gap without widening/weakening the shared validate_safe_string
# helper its other caller still relies on (security-review finding, T15 follow-up).
validate_hostname_arg() {
  local value="$1"
  validate_safe_string "$value" 253 || return 1
  case "$value" in
    *'{'* | *'}'* | *'#'*) return 1 ;;
  esac
  return 0
}

# --- Public Server Endpoint resolution -------------------------------------------------------------
#
# host_is_non_public / turn_url_host below are a deliberate, documented reimplementation of
# services/dedicated-server/src/turn/public-endpoint.ts's classifyTurnHost/turnUrlHost. This installer
# is a standalone Bash script that must work from a bare checkout with nothing built, so it cannot
# import that module; scripts/verify-infrastructure.mjs holds a third copy for the repository guard.
# tests/repository/installer-turn-endpoint.test.mjs and tests/dedicated-server/cli-doctor.test.ts both
# assert the SHARED case table in tests/turn-host-classification-cases.json against their respective
# implementation, so the copies cannot silently diverge.

# host_is_non_public <host> — returns 0 (true) when a remote client on the internet could never reach
# this host: loopback, RFC1918, CGNAT, link-local, IPv6 ULA, or a single-label/private-suffix name
# (a Docker Compose service name like `coturn`, a container hostname, `foo.local`). Returns 1 for
# anything at least plausibly public. Never a claim that a "public" host IS reachable — nothing this
# script can run on the server itself could prove that (see print_endpoint_summary_block's own note).
host_is_non_public() {
  local host
  host="$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | tr -d '[]')"
  case "$host" in
    '') return 0 ;;
    localhost | *.localhost) return 0 ;;
    *.local | *.internal | *.localdomain | *.invalid | *.test | *.example) return 0 ;;
    '::1' | '::' | '::0') return 0 ;;
    fc*:* | fd*:*) return 0 ;;
    fe8*:* | fe9*:* | fea*:* | feb*:*) return 0 ;;
    127.*) return 0 ;;
    0.*) return 0 ;;
    10.*) return 0 ;;
    192.168.*) return 0 ;;
    169.254.*) return 0 ;;
    172.1[6-9].* | 172.2[0-9].* | 172.3[01].*) return 0 ;;
    100.6[4-9].* | 100.[7-9][0-9].* | 100.1[01][0-9].* | 100.12[0-7].*) return 0 ;;
  esac
  # A name with no dot at all is never publicly resolvable. IPv6 literals were already handled above.
  case "$host" in
    *.* | *:*) ;;
    *) return 0 ;;
  esac
  return 1
}

# turn_url_host <turn-uri> — the host portion of a turn:/turns: URI. RFC 7065 URIs have no `//`
# authority prefix (turn:host:3478?transport=udp); the turn://host spelling operators sometimes write
# is tolerated. Prints nothing and returns 1 for anything that is not a turn:/turns: URI.
turn_url_host() {
  local url="$1" scheme rest
  scheme="${url%%:*}"
  case "$(printf '%s' "$scheme" | tr '[:upper:]' '[:lower:]')" in
    turn | turns) ;;
    *) return 1 ;;
  esac
  rest="${url#*:}"
  rest="${rest#//}"
  rest="${rest%%\?*}"
  [ -n "$rest" ] || return 1
  case "$rest" in
    '['*)
      rest="${rest#\[}"
      printf '%s' "${rest%%\]*}"
      return 0
      ;;
  esac
  printf '%s' "${rest%%:*}"
}

# validate_turn_url_arg <value> — same metacharacter discipline as validate_hostname_arg (this value
# is spliced verbatim into a generated env file), plus a real turn:/turns: scheme and host check.
validate_turn_url_arg() {
  local value="$1"
  validate_safe_string "$value" 300 || return 1
  case "$value" in
    *'{'* | *'}'* | *'#'* | *' '*) return 1 ;;
  esac
  local host
  host="$(turn_url_host "$value")" || return 1
  [ -n "$host" ] || return 1
  return 0
}

# detect_public_ipv4 — the first globally-routable IPv4 among this host's own addresses, via
# `hostname -I` (iproute2, already present on any Ubuntu base image). Deliberately local-only: this
# project's "no required external SaaS" rule rules out asking an IP-echo service, and a wrong answer
# here would be worse than none. Prints nothing and returns 1 when this host has no public IPv4
# (the normal case for a home server, a container, or a NAT'd VM) — that is a local/LAN deployment.
detect_public_ipv4() {
  command -v hostname >/dev/null 2>&1 || return 1
  local addr
  for addr in $(hostname -I 2>/dev/null || true); do
    case "$addr" in *:*) continue ;; esac
    if ! host_is_non_public "$addr"; then
      printf '%s' "$addr"
      return 0
    fi
  done
  return 1
}

# detect_primary_ipv4 — this host's first IPv4 address of any kind, public or private. Only used for
# a local/LAN deployment's TURN URL, where a private address is the CORRECT answer (LAN clients reach
# the relay at exactly that address).
detect_primary_ipv4() {
  command -v hostname >/dev/null 2>&1 || return 1
  local addr
  for addr in $(hostname -I 2>/dev/null || true); do
    case "$addr" in *:*) continue ;; esac
    printf '%s' "$addr"
    return 0
  done
  return 1
}

resolve_public_endpoint() {
  if [ -n "$HOSTNAME_ARG" ]; then
    PUBLIC_ENDPOINT="$HOSTNAME_ARG"
    if host_is_non_public "$HOSTNAME_ARG"; then
      # `--hostname 192.168.1.10` / `--hostname myserver.local` is a legitimate, deliberate LAN
      # deployment — never rejected, just not treated as an internet-facing one.
      DEPLOYMENT_SCOPE="local"
    else
      DEPLOYMENT_SCOPE="public"
    fi
    return 0
  fi

  local detected
  if detected="$(detect_public_ipv4)"; then
    PUBLIC_ENDPOINT="$detected"
    DEPLOYMENT_SCOPE="public"
    echo "No --hostname given, but this host has a public IPv4 address (${detected}) — using it as the Public Server Endpoint. TURN works fine with a bare IP; public TLS still does not (a bare IP cannot get a publicly-trusted certificate), so clients will use ws://${detected}:8090 unless you add a hostname later with --tls-only." >&2
    return 0
  fi

  PUBLIC_ENDPOINT=""
  DEPLOYMENT_SCOPE="local"
}

# resolve_turn_url — the single place a client-facing TURN URL is decided, for BOTH deployment modes.
# Precedence: explicit --turn-url > derived from the Public Server Endpoint > this host's own LAN
# address (local deployments only). There is deliberately no placeholder fallback: a value like
# `turn:REPLACE_WITH_YOUR_HOSTNAME:3478` validates fine, starts fine, and silently breaks every
# relay-dependent client — exactly the class of bug this function exists to make impossible.
#
# Docker mode note: this URL is what REMOTE CLIENTS are told, which is a completely separate concern
# from how containers reach Coturn inside the Compose network. compose.turn.example.yaml runs Coturn
# with `network_mode: host` precisely so there is no separate internal address at all — but even if
# that changed, a Docker service name or bridge IP must never appear here.
resolve_turn_url() {
  [ "$INSTALL_COTURN" -eq 1 ] || return 0

  if [ -n "$TURN_URL_ARG" ]; then
    TURN_URL="$TURN_URL_ARG"
    TURN_URL_SOURCE="explicit --turn-url"
  elif [ -n "$PUBLIC_ENDPOINT" ]; then
    TURN_URL="turn:${PUBLIC_ENDPOINT}:3478"
    TURN_URL_SOURCE="derived from the Public Server Endpoint (${PUBLIC_ENDPOINT})"
  else
    local lan
    lan="$(detect_primary_ipv4)" \
      || die "--with-turn needs an address to advertise to clients, and this host has none to derive one from (no --hostname, no public IPv4, and 'hostname -I' returned nothing). Pass --hostname <your-public-hostname-or-IP>, or --turn-url turn:<host>:3478 if Coturn runs elsewhere."
    TURN_URL="turn:${lan}:3478"
    TURN_URL_SOURCE="derived from this host's own LAN address (${lan}) — local/LAN deployment"
  fi

  local turn_host
  turn_host="$(turn_url_host "$TURN_URL")" \
    || die "Invalid TURN URL '${TURN_URL}' — must be a turn: or turns: URI, e.g. turn:voice.example.com:3478."

  if [ "$DEPLOYMENT_SCOPE" = public ] && host_is_non_public "$turn_host"; then
    die "Refusing to advertise TURN endpoint '${TURN_URL}' to remote clients: '${turn_host}' is a loopback, private-network, or container-only address that no client outside this host can reach. This deployment is public (endpoint: ${PUBLIC_ENDPOINT}). Either drop --turn-url so the URL is derived as turn:${PUBLIC_ENDPOINT}:3478, or pass --turn-url with the real public address of the machine running Coturn."
  fi
}

require_root() {
  [ "$(id -u)" -eq 0 ] || die "This script must be run as root (it writes to /etc, /opt, /var/lib, /usr/local, and — for --mode native — manages systemd)."
}

# --- Native mode ---------------------------------------------------------------------------------------

check_os_ubuntu() {
  [ -r /etc/os-release ] || die "Cannot read /etc/os-release — unable to confirm this is a supported Ubuntu host."
  local os_id os_version
  # shellcheck disable=SC1091  # /etc/os-release is a real target-host file this dev/lint environment
  # does not have — genuinely dynamic, not a resolvable local path.
  os_id="$(
    . /etc/os-release
    printf '%s' "$ID"
  )"
  # shellcheck disable=SC1091
  os_version="$(
    . /etc/os-release
    printf '%s' "$VERSION_ID"
  )"
  if [ "$os_id" != "ubuntu" ]; then
    die "Unsupported OS: $os_id. This installer supports Ubuntu (24.04 primary, 22.04 also supported). See docs/SELF_HOSTING.md for a manual native-install path on other distributions."
  fi
  case "$os_version" in
    24.04) ;;
    22.04)
      echo "WARNING: Ubuntu 22.04 detected. 24.04 is the primary validated target; 22.04 is supported on a best-effort basis — see infrastructure/coturn/README.md's note about an older packaged Coturn version silently ignoring two rate-limit directives on 22.04. Continuing." >&2
      ;;
    *)
      die "Unsupported Ubuntu version: $os_version. This installer supports 24.04 (primary) and 22.04."
      ;;
  esac
}

native_already_installed() {
  # Explicit if/return rather than a bare trailing `&&` chain — every current call site already
  # wraps this in `if`/`&&`, which exempts it from the `set -e` last-statement gotcha documented on
  # cleanup() above, but returning explicitly keeps this function safe to call bare in the future too.
  if [ -L /opt/chantivo/current ] && [ -e /opt/chantivo/current ] \
    && systemctl is-enabled --quiet chantivo-server >/dev/null 2>&1; then
    return 0
  fi
  return 1
}

preflight_native_or_exit() {
  local marker="/etc/chantivo/.install-in-progress"

  if native_already_installed && [ "$FORCE_REINSTALL" -ne 1 ]; then
    die "Chantivo already appears installed natively (systemd unit enabled, /opt/chantivo/current present) — use 'chantivo-server update' instead, or pass --force-reinstall."
  fi

  if [ -f "$marker" ] && [ "$FORCE_REINSTALL" -ne 1 ]; then
    die "A previous install attempt did not complete cleanly ($marker exists). Re-run with --force-reinstall to proceed (this alone will not touch /var/lib/chantivo)."
  fi

  if [ "$FORCE_REINSTALL" -eq 1 ] && [ -d /var/lib/chantivo ] \
    && [ -n "$(ls -A /var/lib/chantivo 2>/dev/null)" ] && [ "$I_UNDERSTAND_DATA_RISK" -ne 1 ]; then
    die "Existing data found at /var/lib/chantivo. --force-reinstall alone will not touch it (this script never deletes or overwrites that directory's contents), but re-running install against a live deployment is inherently risky — pass --i-understand-this-may-affect-data to confirm you understand and want to proceed anyway."
  fi

  mkdir -p /etc/chantivo
  : >"$marker"
}

create_chantivo_user() {
  if ! id -u chantivo >/dev/null 2>&1; then
    useradd --system --no-create-home --shell /usr/sbin/nologin chantivo
  fi
}

layout_native_directories() {
  mkdir -p /etc/chantivo
  chmod 755 /etc/chantivo
  mkdir -p /var/lib/chantivo
  chown chantivo:chantivo /var/lib/chantivo
  chmod 750 /var/lib/chantivo
  mkdir -p /opt/chantivo/releases
}

# Applies the deployed release directory's own permission model: root-owned, world-readable/executable
# (the `chantivo` service user reads it, nothing in it needs to be writable by anyone at runtime — the
# only writable path the service ever touches is /var/lib/chantivo via ReadWritePaths=).
harden_native_release_dir() {
  local release_dir="$1"
  chown -R root:root "$release_dir"
  find "$release_dir" -type d -exec chmod 755 {} +
  find "$release_dir" -type f -exec chmod 644 {} +
}

fetch_and_lay_out_native_release() {
  download_and_verify_release "$RELEASE_SOURCE"

  local extract_staging
  extract_staging="$(mktemp -d "${TMPDIR:-/tmp}/chantivo-install-extract.XXXXXX")"
  CLEANUP_PATHS+=("$extract_staging")
  extract_release_tarball "$RELEASE_TARBALL_PATH" "$extract_staging"

  local release_dir="/opt/chantivo/releases/${RELEASE_VERSION}"
  if [ -e "$release_dir" ]; then
    # Only reachable here after preflight_native_or_exit already required --force-reinstall (and, if
    # real data existed, the extra --i-understand-this-may-affect-data flag) — this removes a stale
    # prior extraction of the SAME version's application code, never /var/lib/chantivo.
    rm -rf -- "$release_dir"
  fi
  mv -- "${extract_staging}/chantivo-dedicated-server" "$release_dir"
  harden_native_release_dir "$release_dir"

  # Best-effort: carry the richer release-manifest.json (gitCommit, releasedAt) this script already
  # downloaded and verified alongside the tarball into the deployed release directory, so
  # `chantivo-server version`/`doctor` have it available locally with no extra network round trip. Not
  # fatal if absent — package.json's own "version" field (always present in a pnpm-deploy artifact) is
  # the guaranteed fallback the dispatcher also checks.
  cp -- "${RELEASE_DOWNLOAD_DIR}/release-manifest.json" "${release_dir}/release-manifest.json" 2>/dev/null || true
}

flip_current_symlink() {
  local target_dir="$1"
  local link="/opt/chantivo/current"
  local tmp_link
  tmp_link="/opt/chantivo/.current.tmp.$$"
  ln -s -- "$target_dir" "$tmp_link"
  mv -Tf -- "$tmp_link" "$link"
}

# Installs the operator CLI dispatcher (infrastructure/install/chantivo-server) to
# /usr/local/bin/chantivo-server, plus this same lib/fetch-verify.sh to a fixed system location
# (/usr/local/lib/chantivo/fetch-verify.sh) so the dispatcher can source it after being copied out of
# this checkout on its own — used identically by both native and docker mode, since both deployments
# get the same operator CLI.
install_cli_dispatcher() {
  install -m 644 -D "${SCRIPT_DIR}/lib/fetch-verify.sh" /usr/local/lib/chantivo/fetch-verify.sh
  install -m 755 "${SCRIPT_DIR}/chantivo-server" /usr/local/bin/chantivo-server
}

# The final, honest outcome of mint_initial_admin_token — never fabricated. print_summary_native/
# print_summary_docker print this verbatim.
ADMIN_TOKEN_OUTPUT=""
ADMIN_TOKEN_STATUS="not attempted"

# mint_initial_admin_token: security-review finding (T15 TLS follow-up) — the Dedicated Server's
# supervised service process must NEVER print the raw admin token itself, because systemd/Docker capture
# that process's stdout wholesale into journald/`docker compose logs` (confirmed for real: a genuine,
# raw token was found sitting in this validation host's own journal). `chantivo-server admin-token
# create` was already safe by construction — it is a distinct, ONE-SHOT CLI invocation the installer runs
# directly, not part of the supervised service, so its stdout goes only to whoever ran it (this
# installer), never into journald/docker logs. This function is the installer's ONLY source for the
# initial admin token: it calls that already-audited recovery primitive immediately after the server
# reports healthy, and is now also the server's sole initial-claim mechanism (the Dedicated Server no
# longer auto-generates or prints a bootstrap token of its own — see cli.ts/authorization/store.ts).
# Never `die`s: a failure here is reported honestly in the final summary, but must not fail an otherwise-
# successful install (the operator can always retry via 'chantivo-server admin-token create' by hand).
mint_initial_admin_token() {
  local output
  if output="$(/usr/local/bin/chantivo-server admin-token create 2>&1)"; then
    ADMIN_TOKEN_OUTPUT="$output"
    ADMIN_TOKEN_STATUS="OK"
  else
    ADMIN_TOKEN_STATUS="FAILED — 'chantivo-server admin-token create' did not succeed; the server itself is still healthy. Retry by hand once you've investigated: sudo chantivo-server admin-token create"
    echo "WARNING: could not mint the initial admin token automatically. Output was:" >&2
    echo "$output" >&2
  fi
}

write_server_env() {
  local env_path="/etc/chantivo/server.env"
  # Never a bare `> file` redirect into a path that could be a pre-existing symlink (which would
  # silently write through it to an attacker-chosen target) — explicit unlink-if-symlink guard, then
  # create with the final restrictive ownership/permissions via `install` BEFORE any secret content is
  # ever written, then append.
  [ -L "$env_path" ] && rm -f -- "$env_path"
  install -m 640 -o root -g chantivo /dev/null "$env_path"

  {
    printf 'DISCO_VOADOR_SERVER_DATA_DIR=%s\n' '/var/lib/chantivo'
    printf 'REALTIME_HOST=%s\n' '0.0.0.0'
    printf 'REALTIME_PORT=%s\n' '8090'
    if [ -n "$PUBLIC_ENDPOINT" ]; then
      printf 'DISCO_VOADOR_SERVER_PUBLIC_HOST=%s\n' "$PUBLIC_ENDPOINT"
    fi
    printf 'DISCO_VOADOR_DEPLOYMENT_SCOPE=%s\n' "$DEPLOYMENT_SCOPE"
    if [ "$INSTALL_COTURN" -eq 1 ]; then
      require_cmd openssl
      TURN_SECRET_FOR_COTURN_CONF="$(openssl rand -hex 32)"
      printf 'DISCO_VOADOR_TURN_SHARED_SECRET=%s\n' "$TURN_SECRET_FOR_COTURN_CONF"
      # $TURN_URL comes from resolve_turn_url (called in main before any install step) — never a
      # placeholder, and never a loopback/container-only address for a public deployment.
      printf 'DISCO_VOADOR_TURN_URLS=%s\n' "$TURN_URL"
    fi
  } >>"$env_path"
}

install_systemd_unit() {
  local unit_path="/etc/systemd/system/chantivo-server.service"
  local tmp_unit
  tmp_unit="$(mktemp "${TMPDIR:-/tmp}/chantivo-unit.XXXXXX")"
  CLEANUP_PATHS+=("$tmp_unit")

  cat >"$tmp_unit" <<'EOF'
[Unit]
Description=Chantivo Dedicated Server
After=network.target

[Service]
User=chantivo
Group=chantivo
WorkingDirectory=/opt/chantivo/current
EnvironmentFile=/etc/chantivo/server.env
ExecStart=/usr/bin/node /opt/chantivo/current/dist/cli.js
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/chantivo
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF

  # Security review finding (T15): consistency guard matching every other privileged write in this
  # file, even though GNU `install` unlinks-and-recreates its destination rather than writing through
  # an existing symlink in practice — defense in depth, not a known-exploitable gap here.
  [ -L "$unit_path" ] && rm -f -- "$unit_path"
  install -m 644 -o root -g root "$tmp_unit" "$unit_path"
  systemctl daemon-reload
}

# Native Coturn config: root:turnserver / 640 — the permission model matched by Ubuntu's own packaged
# coturn systemd unit (User=turnserver). Deliberately a SEPARATE function from
# chown_docker_coturn_conf below: the two run as different, fixed, non-interchangeable uids/gids and
# must never be unified into one "guess the right owner" helper (see that function's own comment).
install_native_coturn() {
  require_cmd apt-get
  DEBIAN_FRONTEND=noninteractive apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y coturn

  local template="${SCRIPT_DIR}/../coturn/turnserver.conf.example"
  # The template is read from this repository checkout, not fetched separately over the network.
  # SELF_HOSTING.md's own documented path already assumes an operator clones (or copies) this
  # repository onto the host before running anything here, so infrastructure/coturn/ is already
  # present next to this script in the normal case; fetching a second remote resource just for this
  # template would add another network/trust dependency for no benefit over reading the file the
  # operator already has. If this installer is ever redistributed standalone (e.g. a single-file
  # curl|bash with no repository checkout), this is the one thing that would need to change — hence
  # the explicit, actionable error below rather than a silent skip.
  [ -f "$template" ] \
    || die "Coturn template not found at $template — this installer expects to run from a checkout of the Chantivo repository (see infrastructure/install/README.md). Skip --with-turn, or run from a full checkout."

  local conf_path="/etc/turnserver.conf"
  [ -L "$conf_path" ] && rm -f -- "$conf_path"
  install -m 640 -o root -g turnserver /dev/null "$conf_path"

  if [ -n "$PUBLIC_ENDPOINT" ]; then
    sed "s/^realm=.*/realm=${PUBLIC_ENDPOINT}/" -- "$template" >>"$conf_path"
  else
    cat -- "$template" >>"$conf_path"
  fi
  {
    printf '\n# Generated by install-chantivo.sh on %s\n' "$(date -u +%FT%TZ)"
    printf 'static-auth-secret=%s\n' "$TURN_SECRET_FOR_COTURN_CONF"
  } >>"$conf_path"

  systemctl enable --now coturn
}

configure_firewall() {
  require_root
  require_cmd ufw
  echo "Configuring firewall (ufw)..."
  ufw allow 22/tcp
  ufw allow 8090/tcp
  if [ "$INSTALL_COTURN" -eq 1 ]; then
    ufw allow 3478/tcp
    ufw allow 3478/udp
    ufw allow 49152:49351/udp
  fi
  if [ "$INSTALL_TLS" -eq 1 ]; then
    # Caddy needs 80/tcp (HTTP-01 ACME challenge, and its own HTTP->HTTPS redirect) and 443/tcp
    # (HTTPS/WSS itself) reachable from the internet — gated on INSTALL_TLS (this run's decision to
    # attempt TLS automation), not on TLS_STATUS's eventual outcome, since these rules must already be
    # open BEFORE configure_tls_caddy's certificate-issuance attempt for that attempt to have any
    # chance of succeeding.
    ufw allow 80/tcp
    ufw allow 443/tcp
  fi
  local current_status_line
  current_status_line="$(ufw status | head -n1)"
  case "$current_status_line" in
    *inactive*)
      echo "ufw is currently inactive. Rules were added but ufw was NOT enabled automatically — review 'ufw status' below, then run 'ufw enable' yourself once you're sure the rule set is right (this script deliberately never force-enables ufw, to avoid locking you out over SSH with a misconfigured rule set)."
      ;;
    *)
      echo "ufw is already active — the rules above are now in effect."
      ;;
  esac
  ufw status verbose
}

# --- TLS / Caddy automation ---------------------------------------------------------------------------
#
# One shared code path used by native_install, docker_install, AND tls_only_install: in every
# deployment shape the app itself is already listening on 127.0.0.1:8090 by the time this runs (native:
# systemd unit already started; docker: the host port mapping in compose.*.example.yaml already
# publishes it; tls-only: reuses whatever is already running) — a host-level Caddy fronting
# 127.0.0.1:8090 works identically regardless of how the app itself got there.

CADDY_SITE_TEMPLATE="${SCRIPT_DIR}/../reverse-proxy/Caddyfile.example"
CADDY_CONFD_DIR="/etc/caddy/conf.d"
CADDY_CONFD_FILE="${CADDY_CONFD_DIR}/chantivo.caddy"
CADDY_MAIN_FILE="/etc/caddy/Caddyfile"

# dns_resolves_to_this_host <hostname>
#
# A local-only, no-third-party-SaaS DNS check (this project's own "fully self-hostable, no required
# external SaaS" rule rules out an IP-echo service): resolves <hostname> via `getent hosts` (NSS/
# /etc/resolv.conf — already part of any Ubuntu base image, no extra package) and compares against this
# host's own addresses via `hostname -I` (iproute2, also already present). Returns 0 only if the two
# sets intersect. One check, no retry, no unbounded wait — a DNS mismatch is a legitimate, common,
# non-fatal outcome (record not created yet, or not yet propagated), never something this function
# should spin on.
dns_resolves_to_this_host() {
  local hostname="$1"
  require_cmd getent
  require_cmd hostname

  local resolved
  resolved="$(getent hosts "$hostname" 2>/dev/null | awk '{print $1}')" || true
  [ -n "$resolved" ] || return 1

  local local_addrs
  local_addrs="$(hostname -I 2>/dev/null)" || true
  [ -n "$local_addrs" ] || return 1

  local raddr laddr
  for raddr in $resolved; do
    for laddr in $local_addrs; do
      if [ "$raddr" = "$laddr" ]; then
        return 0
      fi
    done
  done
  return 1
}

caddy_is_installed() {
  if command -v caddy >/dev/null 2>&1; then
    return 0
  fi
  if systemctl list-unit-files caddy.service 2>/dev/null | grep -q '^caddy\.service'; then
    return 0
  fi
  return 1
}

# install_caddy_package: the standard documented method (Caddy's official apt repository, Cloudsmith
# GPG key + apt source list) — matches install_native_coturn's `require_cmd apt-get` /
# `DEBIAN_FRONTEND=noninteractive apt-get install -y` pattern immediately above.
#
# Security-review findings (T15 follow-up): (1) both privileged writes below now use the same
# symlink-guard-before-write discipline as every other file this script creates, for consistency, even
# though /usr/share/keyrings and /etc/apt/sources.list.d are root:root 755 by default (low practical
# exploitability, still matched for defense-in-depth). (2) the fetched apt source-list content is now
# asserted to actually scope trust to the exact keyring this script writes (`signed-by=<keyring path>`)
# before being written — Cloudsmith's snippet does this correctly today (confirmed by reading its live
# output), but this script must never silently install an apt-wide-trusted third-party repository if
# that ever changed upstream.
install_caddy_package() {
  require_cmd apt-get
  require_cmd curl
  echo "Installing Caddy from its official apt repository (dl.cloudsmith.io)..."
  DEBIAN_FRONTEND=noninteractive apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
  require_cmd gpg

  # QA-VPS-tested real-fresh-host bug (T15 TLS follow-up): the symlink-only guard below is not enough
  # for THIS specific destination. Every other privileged write in this file goes through `install`,
  # which always overwrites its destination unconditionally; this one is the sole exception — it pipes
  # into `gpg --dearmor -o <path>`, and gpg's own `-o`/`--output` refuses to silently overwrite an
  # already-existing REGULAR file, instead interactively prompting "File ... exists. Overwrite?" on
  # /dev/tty. That prompt has no tty to answer under a non-interactive `curl | bash` (or, as reproduced
  # here, a `docker exec` with no pty), so it hard-fails with "gpg: cannot open '/dev/tty'" instead of
  # hanging forever. This is not a contrived edge case: it reproduces every time install_caddy_package
  # runs a SECOND time against a host where its own prior run already wrote this same keyring path —
  # exactly the real operator sequence in item 3 of this task's own dispatch (apt-get remove caddy
  # without --purge, leaving this script's previously-written keyring file on disk untouched by apt,
  # then rerunning the installer/--tls-only). Removing any pre-existing regular file here too (not just
  # a symlink) guarantees gpg always writes to a definitely-absent path, closing the gap without
  # weakening the existing hostile-symlink guard.
  local keyring_path="/usr/share/keyrings/caddy-stable-archive-keyring.gpg"
  { [ -L "$keyring_path" ] || [ -e "$keyring_path" ]; } && rm -f -- "$keyring_path"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor -o "$keyring_path"

  local source_list_path="/etc/apt/sources.list.d/caddy-stable.list"
  local caddy_apt_source
  caddy_apt_source="$(curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt')"
  case "$caddy_apt_source" in
    *"signed-by=${keyring_path}"*) ;;
    *)
      die "Caddy's apt source list from dl.cloudsmith.io no longer scopes trust to ${keyring_path} (missing the expected 'signed-by=' entry) — refusing to install an apt-wide-trusted third-party repository. Install Caddy manually instead (https://caddyserver.com/docs/install) and rerun with --no-tls."
      ;;
  esac
  [ -L "$source_list_path" ] && rm -f -- "$source_list_path"
  printf '%s\n' "$caddy_apt_source" >"$source_list_path"

  DEBIAN_FRONTEND=noninteractive apt-get update -y
  DEBIAN_FRONTEND=noninteractive apt-get install -y caddy
}

# write_caddy_site_block <hostname> <dest_path>
#
# Renders infrastructure/reverse-proxy/Caddyfile.example with the real hostname substituted for its
# {$CHANTIVO_PUBLIC_HOSTNAME} placeholder — the same sed-into-a-template mechanism
# install_native_coturn/generate_docker_turnserver_conf already use for their own realm substitution.
# Applies the exact same unlink-if-symlink-then-install-with-final-permissions discipline as every other
# privileged file this script writes. This file has no secret content (a public hostname and a
# reverse_proxy directive) — 644 root:root is fine, matching install_systemd_unit's own no-secret file.
write_caddy_site_block() {
  local hostname="$1" dest_path="$2"

  [ -f "$CADDY_SITE_TEMPLATE" ] \
    || die "Caddy site template not found at $CADDY_SITE_TEMPLATE — this installer expects to run from a checkout of the Chantivo repository."

  local tmp_site
  tmp_site="$(mktemp "${TMPDIR:-/tmp}/chantivo-caddy-site.XXXXXX")"
  CLEANUP_PATHS+=("$tmp_site")
  sed "s/{\$CHANTIVO_PUBLIC_HOSTNAME}/${hostname}/" -- "$CADDY_SITE_TEMPLATE" >"$tmp_site"

  mkdir -p -- "$(dirname -- "$dest_path")"
  [ -L "$dest_path" ] && rm -f -- "$dest_path"
  install -m 644 -o root -g root "$tmp_site" "$dest_path"
}

# caddyfile_imports_confd: true only if an EXISTING /etc/caddy/Caddyfile (a file this script did not
# create and must never modify) already contains a TOP-LEVEL, uncommented `import` directive that would
# pick up CADDY_CONFD_DIR/*.caddy. Deliberately conservative — a false negative here (telling an operator
# to add an import that turns out to already be effectively covered some other way) is safe; a false
# positive is not: it would make configure_tls_caddy believe our site is already wired in and reload
# Caddy against a config that doesn't actually serve it.
#
# Security-review finding (T15 follow-up): the original version was a bare, unanchored grep, which
# false-positived on (a) a commented-out `# import conf.d/*.caddy` line (Caddyfile line comments start
# with `#`, which plain grep does not understand) and (b) an `import` scoped inside a DIFFERENT site's
# own block (legitimate per-site imports are not effective at top level). Both are real, plausible
# operator Caddyfiles, not contrived. This now strips `#`-comments per line and tracks brace depth so
# only a top-level (depth-0) import counts.
caddyfile_imports_confd() {
  [ -f "$CADDY_MAIN_FILE" ] || return 1
  awk '
    {
      line = $0
      sub(/#.*/, "", line)
      if (depth == 0 && line ~ /^[[:space:]]*import[[:space:]]+(\/etc\/caddy\/conf\.d\/\*\.caddy|conf\.d\/\*\.caddy)[[:space:]]*$/) {
        found = 1
      }
      opens = gsub(/{/, "{", line)
      closes = gsub(/}/, "}", line)
      depth += opens - closes
    }
    END { exit !found }
  ' "$CADDY_MAIN_FILE"
}

# wait_for_https_health <hostname> [timeout_seconds]
#
# Proves the reverse proxy AND TLS termination both actually work end-to-end (not just that the Caddy
# process started) with a bounded timeout — mirrors lib/fetch-verify.sh's wait_for_health polling shape
# exactly (2s interval, plain bounded loop, never an unbounded retry).
#
# Security-review finding (production beta.chantivo.app, T15 follow-up): this used to poll GET
# https://<hostname>/healthz through Caddy — but /healthz is now deliberately blocked at the Caddy
# layer for anyone, including this installer, hitting it publicly (see
# infrastructure/reverse-proxy/Caddyfile.example's @blocked_health matcher and this directory's own
# README "Public vs. internal routes" section). Polling the now-intentionally-404'd path would either
# make this check pass on a false signal (404 looks like "reachable") or fail permanently on a
# correctly-configured deployment — neither is acceptable.
#
# Real replacement: perform an actual WebSocket upgrade handshake (the literal protocol this whole
# product depends on — see services/realtime/src/server.ts, which attaches `ws`'s WebSocketServer to
# its httpServer with no `path` restriction, so any path accepts an upgrade) through
# https://<hostname>/ and require a genuine `101 Switching Protocols` response. This is a stronger,
# more meaningful proof than GET /healthz ever was: it can only succeed if DNS resolves, the TLS
# certificate is valid, Caddy is correctly routing to 127.0.0.1:8090, AND the backend itself completed
# a real protocol-level WebSocket handshake — a broken/misconfigured Caddy (wrong upstream, no TLS,
# serving a different site, or a backend that's down) cannot produce a 101 by accident.
#
# Real-server-tested behavior (this task's own local validation, a minimal `ws`-backed HTTP server):
# once the backend answers `101 Switching Protocols`, it does NOT half-close or otherwise end the
# connection on its own — an ordinary WebSocket upgrade response leaves the socket open for the
# (never-sent) WebSocket frames that would normally follow. `curl`'s own `--max-time` is therefore
# REQUIRED here, or this probe would hang for its full default timeout (effectively unbounded) on every
# successful attempt. `--max-time` makes curl exit non-zero (timeout, exit 28) even on the success path
# once its bound elapses — confirmed by direct testing that curl's `--write-out '%{http_code}'` value is
# still correctly populated with `101` in stdout despite that non-zero exit, so the exit code itself
# must never be treated as this probe's pass/fail signal — only the captured status string is.
#
# Second real bug this same local validation caught: this whole script runs under `set -Eeuo pipefail`
# (see the top of this file). A bare `status="$(curl ...)"` with no `|| ...` guard is a simple command
# whose exit status equals curl's own (confirmed by direct testing: bash's `errexit` DOES trigger on a
# failing command-substitution assignment, contrary to a common assumption) — so on the very first
# successful upgrade, curl's `--max-time`-induced non-zero exit would trip the ERR trap and abort the
# entire installer, never reaching the `[ "$status" = "101" ]` check below at all. The fix is
# `|| true` (suppresses errexit, changes nothing about what was already captured in `$status`) — NOT
# `|| status="000"` (the original bug this whole function replaces: that pattern discards an
# already-correctly-captured "101" and overwrites it with a fabricated "000" on every single attempt,
# permanently masking success — also verified by direct testing, not merely reasoned about).
wait_for_https_health() {
  local hostname="$1" timeout_s="${2:-60}"
  require_cmd curl
  local waited=0
  # A fixed, syntactically-valid base64 Sec-WebSocket-Key: this probe never completes or reuses the
  # handshake, so a fresh random key per attempt buys nothing — only its well-formedness matters, so
  # the backend accepts the upgrade far enough to answer 101.
  local ws_key="dGhlIHNhbXBsZSBub25jZQ=="
  local status
  echo "Waiting for a real WebSocket upgrade to succeed through Caddy at https://${hostname}/ (timeout ${timeout_s}s)..."
  while [ "$waited" -lt "$timeout_s" ]; do
    # `|| true` (not `|| status="000"` — see the function doc comment above for why that would be a
    # regression) only suppresses `set -e` from aborting the whole installer on curl's --max-time exit;
    # it never touches $status itself. --write-out always writes SOME value to stdout (its documented
    # "000" placeholder default when no response was received at all), so only a genuinely empty
    # capture (e.g. curl itself failed to even run) needs an explicit fallback.
    status="$(curl --silent --show-error --max-time 5 --output /dev/null --write-out '%{http_code}' \
      --http1.1 \
      -H 'Connection: Upgrade' -H 'Upgrade: websocket' \
      -H 'Sec-WebSocket-Version: 13' -H "Sec-WebSocket-Key: ${ws_key}" \
      "https://${hostname}/" 2>/dev/null)" || true
    [ -n "$status" ] || status="000"
    if [ "$status" = "101" ]; then
      echo "wss upgrade through Caddy: OK (101 Switching Protocols)"
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  echo "WARNING: a real WebSocket upgrade through https://${hostname}/ did not succeed within ${timeout_s}s (last HTTP status: ${status:-none})." >&2
  return 1
}

# configure_tls_caddy <hostname>
#
# Shared by native_install, docker_install, and tls_only_install. NEVER fatal to the overall install —
# every DNS-mismatch/pre-existing-Caddy-config/readiness-timeout outcome sets TLS_STATUS and returns 0;
# only a genuinely unexpected hard dependency failure (missing template file, apt-get itself failing)
# still `die`s, matching how install_native_coturn/generate_docker_turnserver_conf already treat their
# own hard dependencies as fatal while treating DNS/reachability outcomes as soft, reported failures.
configure_tls_caddy() {
  local hostname="$1"

  if [ "$SKIP_DNS_CHECK" -ne 1 ]; then
    if ! dns_resolves_to_this_host "$hostname"; then
      echo "Hostname ${hostname} does not currently resolve to this server. Create/update its DNS A/AAAA record, wait for propagation, then rerun: sudo ./install-chantivo.sh --mode ${MODE} --hostname ${hostname} --tls-only --yes" >&2
      TLS_STATUS="SKIPPED (DNS does not currently resolve to this host — see message above)"
      return 0
    fi
  fi

  # Security-review finding (T15 follow-up): caddy_preexisting must NOT be derived from caddy_is_installed
  # alone. `apt-get remove caddy` (without --purge) removes the binary and unit file but leaves the
  # /etc/caddy/Caddyfile conffile — a real, ordinary admin action, not a contrived edge case — behind
  # with its real prior content intact. Deriving "safe to write $CADDY_MAIN_FILE directly" from "caddy
  # isn't currently installed" alone would silently destroy that real config on the next run. A
  # non-empty $CADDY_MAIN_FILE on disk is now ALSO treated as pre-existing config, regardless of whether
  # the package/unit is currently present — "safe to write the main file fresh" requires BOTH "Caddy
  # isn't installed" AND "no Caddyfile already exists."
  local caddy_preexisting=0
  if caddy_is_installed || [ -s "$CADDY_MAIN_FILE" ]; then
    caddy_preexisting=1
  fi
  if ! caddy_is_installed; then
    install_caddy_package
  fi

  if [ "$caddy_preexisting" -eq 1 ]; then
    # Never touch an existing operator's Caddyfile directly — write our own site block to a dedicated
    # conf.d file, and only reload if that file is already imported. This is a non-negotiable
    # requirement: this script must never destroy or silently overwrite an operator's existing Caddy
    # config.
    mkdir -p -- "$CADDY_CONFD_DIR"
    write_caddy_site_block "$hostname" "$CADDY_CONFD_FILE"
    if caddyfile_imports_confd; then
      # Security-review finding (T15 follow-up): reload only, never fall back to `restart` here. A
      # pre-existing Caddy install may be serving OTHER, unrelated sites — a failed reload falling back
      # to `restart` risks stopping a working process and then failing to start a new one from a config
      # this script does not fully control, taking down every site Caddy serves, not just ours.
      if ! systemctl reload caddy 2>/dev/null; then
        echo "WARNING: 'systemctl reload caddy' failed after writing ${CADDY_CONFD_FILE}. Not restarting automatically — a restart could interrupt this host's other, already-running Caddy sites. Inspect 'journalctl -u caddy' and validate ${CADDY_MAIN_FILE} yourself, then reload manually once fixed." >&2
        TLS_STATUS="SKIPPED (existing Caddy reload failed — manual step needed, see above; other Caddy sites were left running)"
        return 0
      fi
    else
      echo "Existing Caddy install found (${CADDY_MAIN_FILE} present) — this script never modifies an existing Caddyfile it did not create. The Chantivo site block has been written to ${CADDY_CONFD_FILE}; add ONE of the following to ${CADDY_MAIN_FILE} yourself, then run 'systemctl reload caddy':" >&2
      echo "    import ${CADDY_CONFD_DIR}/*.caddy" >&2
      echo "  ...or paste the contents of ${CADDY_CONFD_FILE} directly into ${CADDY_MAIN_FILE}." >&2
      TLS_STATUS="SKIPPED (existing Caddy config found — manual step needed, see above)"
      return 0
    fi
  else
    write_caddy_site_block "$hostname" "$CADDY_MAIN_FILE"
    systemctl enable --now caddy 2>/dev/null || systemctl restart caddy
  fi

  if wait_for_https_health "$hostname" 60; then
    TLS_STATUS="OK (https://${hostname}, wss://${hostname})"
  else
    TLS_STATUS="FAILED (a real WebSocket upgrade through https://${hostname}/ did not succeed within 60s) — see journalctl -u caddy; likely causes: DNS propagation delay, port 80/443 blocked by a firewall/router, or an ACME rate limit"
  fi
}

# print_endpoint_summary_block: the resolved Public Server Endpoint, the exact address a client types,
# and the exact TURN URL this deployment advertises — printed in the installer's own final output so a
# misconfiguration is visible immediately instead of being discovered later as "media just doesn't work
# for some people" (the real production incident that motivated this block).
#
# Prints only public, client-visible values: a hostname/IP, a wss:/ws: address, and a turn: URL. NEVER
# the TURN shared secret, a minted credential, or any private server identity material — the same
# discipline print_summary_native applies to the admin token (which is deliberately minted out-of-band
# and never routed through any log).
print_endpoint_summary_block() {
  # Every interpolated value is built as a plain variable first, never inline inside the heredoc.
  # A `${VAR:-default}` whose default text contains an apostrophe silently breaks bash's parameter
  # expansion ("bad substitution") — caught by this function's own test before it ever reached a
  # real install, and avoided structurally here rather than by carefully wording the text.
  local client_address endpoint_text turn_text scope_text
  if [ -n "$PUBLIC_ENDPOINT" ]; then
    endpoint_text="$PUBLIC_ENDPOINT"
    case "$TLS_STATUS" in
      OK*) client_address="wss://${PUBLIC_ENDPOINT}" ;;
      *) client_address="ws://${PUBLIC_ENDPOINT}:8090" ;;
    esac
  else
    endpoint_text="<none — local/LAN deployment; clients use this host address on the LAN>"
    client_address="ws://<this host address>:8090"
  fi

  if [ "$INSTALL_COTURN" -eq 1 ]; then
    turn_text="${TURN_URL} (${TURN_URL_SOURCE})"
  else
    turn_text="not installed (STUN/P2P only — rerun with --with-turn to add a relay)"
  fi

  if [ "$DEPLOYMENT_SCOPE" = public ]; then
    scope_text="public (remote/internet clients)"
  else
    scope_text="local (development/LAN-only — loopback/private TURN addresses are expected here)"
  fi

  cat <<EOF
Public server:
  ${endpoint_text}

Client address:
  ${client_address}

TURN:
  ${turn_text}

Deployment scope:
  ${scope_text}
EOF
}

# print_tls_summary_block: the shared "TLS/WSS: ..." section for print_summary_native/
# print_summary_docker. Never fabricates success — always reflects TLS_STATUS, which configure_tls_caddy
# (or its absence, when no --hostname was given) set to something that genuinely happened.
print_tls_summary_block() {
  if [ -z "$HOSTNAME_ARG" ]; then
    cat <<EOF
TLS/WSS:       SKIPPED (no hostname given — see rerun instructions below)

  Public CA-issued TLS requires a real public hostname; a bare IP address cannot get a
  publicly-trusted certificate. This server is reachable right now over plain ws://<this host>:8090.
  To add a hostname and automatic HTTPS/WSS later — WITHOUT touching /var/lib/chantivo, existing
  authorization state, chat, profiles, or the TURN secret — run:

    sudo ./install-chantivo.sh --mode ${MODE} --hostname <your-hostname> --tls-only --yes
EOF
  else
    echo "TLS/WSS:       $TLS_STATUS"
  fi
}

# print_summary_native: closure requirement — the installer's OWN final output must directly show the
# real address, a per-component status block, and the initial admin token. Security-review finding (T15
# TLS follow-up): this used to grep the systemd journal for a token the server's own supervised process
# had printed — which meant the raw token was ALSO sitting in journald, a real, confirmed leak. The
# Dedicated Server no longer prints its own bootstrap token at all; ADMIN_TOKEN_OUTPUT/ADMIN_TOKEN_STATUS
# (set by mint_initial_admin_token, called from native_install below) come from a direct, one-shot
# 'chantivo-server admin-token create' invocation instead — its stdout never touches journald/logs.
print_summary_native() {
  local status_chantivo status_coturn
  status_chantivo="$(systemctl is-active chantivo-server 2>/dev/null || echo unknown)"
  status_coturn="not installed"
  if [ "$INSTALL_COTURN" -eq 1 ]; then
    status_coturn="$(systemctl is-active coturn 2>/dev/null || echo unknown)"
  fi

  cat <<EOF

================================================================
Chantivo Dedicated Server: native (systemd) install complete.

  Version:       ${RELEASE_VERSION}
  Data dir:      /var/lib/chantivo
  Config:        /etc/chantivo/server.env
  Release dir:   /opt/chantivo/current -> /opt/chantivo/releases/${RELEASE_VERSION}
  Logs:          journalctl -u chantivo-server -f

$(print_endpoint_summary_block)

Status:
  chantivo-server:   ${status_chantivo}
  coturn:            ${status_coturn}
  admin token:       ${ADMIN_TOKEN_STATUS}

${ADMIN_TOKEN_OUTPUT}

This token was minted by a direct, one-shot 'chantivo-server admin-token create' invocation — it never
passed through the server's own logging (journald never sees it). Save it now; it is single-use. If you
ever lose it, run 'sudo chantivo-server admin-token create' again to mint a fresh one.

$(print_tls_summary_block)
================================================================
EOF
}

native_install() {
  require_root
  check_os_ubuntu
  preflight_native_or_exit

  [ -n "$RELEASE_SOURCE" ] \
    || die "No release source configured for --mode native. Pass --release-source explicitly (a URL or a local path/file:// for testing)."

  # VPS-tested real-fresh-host bug (T15): fetch_and_lay_out_native_release's `mv` into
  # /opt/chantivo/releases/<version> requires that directory to already exist —
  # layout_native_directories is what creates it (mkdir -p /opt/chantivo/releases). On a genuinely
  # fresh host (no prior /opt/chantivo at all), calling fetch before layout failed 100% of the time
  # with "mv: cannot move ... No such file or directory". create_chantivo_user/layout_native_directories
  # must run first.
  create_chantivo_user
  layout_native_directories
  fetch_and_lay_out_native_release
  write_server_env
  flip_current_symlink "/opt/chantivo/releases/${RELEASE_VERSION}"
  install_systemd_unit
  install_cli_dispatcher
  systemctl enable --now chantivo-server

  if [ "$INSTALL_COTURN" -eq 1 ]; then
    install_native_coturn
  fi

  if [ "$CONFIGURE_FIREWALL" -eq 1 ]; then
    configure_firewall
  fi

  local health_ok=1
  wait_for_health 127.0.0.1 8090 60 || {
    health_ok=0
    echo "Continuing despite the health-check warning above — check 'journalctl -u chantivo-server' for details." >&2
  }

  if [ "$INSTALL_TLS" -eq 1 ]; then
    configure_tls_caddy "$HOSTNAME_ARG"
  fi

  if [ "$health_ok" -eq 1 ]; then
    mint_initial_admin_token
  else
    ADMIN_TOKEN_STATUS="SKIPPED (health check did not pass — mint one by hand once the server is healthy: sudo chantivo-server admin-token create)"
  fi

  rm -f /etc/chantivo/.install-in-progress
  print_summary_native
}

# --- Docker mode -----------------------------------------------------------------------------------

docker_already_installed() {
  local project
  for project in chantivo-server chantivo-self-hosted; do
    if [ -n "$(docker ps -a --filter "label=com.docker.compose.project=${project}" -q 2>/dev/null)" ]; then
      return 0
    fi
  done
  return 1
}

preflight_docker_or_exit() {
  if docker_already_installed && [ "$FORCE_REINSTALL" -ne 1 ]; then
    die "Chantivo already appears installed via Docker Compose (a container labeled for the chantivo-server or chantivo-self-hosted project already exists) — use 'chantivo-server update' instead, or pass --force-reinstall. (Docker mode never destroys an existing named volume on 'up', so this is a lighter-weight guard than the native marker/data checks.)"
  fi
}

# generate_docker_turnserver_conf below is deliberately a SEPARATE code path from
# install_native_coturn above; the two run as different, fixed, non-interchangeable uids/gids and must
# never be unified into one "guess the right owner" helper. The pinned coturn/coturn:4.17.2-r0 image's
# turnserver process runs as the FIXED numeric uid=65534 gid=65534 (nobody/nogroup — confirmed in T14
# via `docker run --rm coturn/coturn:4.17.2-r0 id`). A config file permissioned the native/systemd way
# (root:turnserver, 640) is silently unreadable to that uid, and Coturn falls back to an
# unauthenticated, unbounded default configuration rather than failing loudly — a real, easy-to-miss
# trap, since the container still reports healthy either way (see infrastructure/docker/README.md).
# This file contains the real static-auth-secret in plaintext, so `644` (world-readable) is NOT an
# acceptable fix for that unreadability — it was tried and reverted once already during T14 for exactly
# this reason. The correct fix is `chown 65534:65534` + `chmod 400`, applied via `install` at file
# creation time (see generate_docker_turnserver_conf's own comment for why creation-time, not after).
generate_docker_turnserver_conf() {
  local secret="$1"
  local template="${SCRIPT_DIR}/../coturn/turnserver.conf.example"
  local conf_path="${SCRIPT_DIR}/../coturn/turnserver.conf"

  [ -f "$template" ] || die "Coturn template not found at $template"

  # Security review finding (T15): the file is created with its FINAL restrictive ownership/mode
  # (65534:65534, 400 — see chown_docker_coturn_conf's own comment for why) BEFORE any content,
  # including the secret, is ever written to it — never create-then-chown-later. Creating it first at
  # whatever the ambient umask happens to yield (commonly world-readable) and only locking it down
  # after the secret is already on disk left a real, evidence-backed window where another local user
  # on a shared host could read the TURN shared secret before the final chmod applied. `install -m
  # 400 -o 65534 -g 65534 /dev/null ...` mirrors the exact pattern install_native_coturn/
  # write_server_env already use for the same reason — one operation, correct from the first byte.
  [ -L "$conf_path" ] && rm -f -- "$conf_path"
  install -m 400 -o 65534 -g 65534 /dev/null "$conf_path"

  if [ -n "$PUBLIC_ENDPOINT" ]; then
    sed "s/^realm=.*/realm=${PUBLIC_ENDPOINT}/" -- "$template" >>"$conf_path"
  else
    cat -- "$template" >>"$conf_path"
  fi
  {
    printf '\n# Generated by install-chantivo.sh on %s\n' "$(date -u +%FT%TZ)"
    printf 'static-auth-secret=%s\n' "$secret"
  } >>"$conf_path"
}

# Records where this docker-mode deployment actually lives on disk, and its resolved Compose
# project/volume names, so `chantivo-server` (installed to /usr/local/bin, with no other anchor back
# to this checkout) can find the right `docker compose` invocation later — status/logs/restart/backup/
# doctor/admin-token all depend on this file.
write_docker_deployment_marker() {
  local docker_dir="$1" compose_file="$2" compose_project="$3"
  mkdir -p /etc/chantivo
  local data_volume marker_path="/etc/chantivo/docker-deployment.env"
  data_volume="$(docker volume ls --filter "label=com.docker.compose.project=${compose_project}" --format '{{.Name}}' | head -n1)"
  # Security review finding (T15): matches every other privileged write in this file — guard against
  # writing/chmod-ing through a pre-existing symlink at this path before the bare redirect below.
  [ -L "$marker_path" ] && rm -f -- "$marker_path"
  {
    printf 'CHANTIVO_DOCKER_DIR=%s\n' "$docker_dir"
    printf 'CHANTIVO_COMPOSE_FILE=%s\n' "$compose_file"
    printf 'CHANTIVO_COMPOSE_PROJECT=%s\n' "$compose_project"
    printf 'CHANTIVO_DATA_VOLUME=%s\n' "$data_volume"
  } >"$marker_path"
  chmod 644 "$marker_path"
}

# print_summary_docker: same closure requirement/rationale as print_summary_native above — see that
# function's own comment for why ADMIN_TOKEN_OUTPUT/ADMIN_TOKEN_STATUS (set by mint_initial_admin_token,
# which is mode-agnostic — the chantivo-server dispatcher auto-detects docker mode itself) replaced a
# `docker compose logs` grep that would otherwise have leaked the raw token into container logs. Called
# from docker_install(), which is why $docker_dir/$compose_args (both `local` there) are still in scope.
print_summary_docker() {
  local status_chantivo="unknown"
  if (cd "$docker_dir" && docker compose "${compose_args[@]}" ps chantivo-server 2>/dev/null) | grep -qi 'running\|up'; then
    status_chantivo="running"
  fi
  local status_coturn="not started"
  if [ "$INSTALL_COTURN" -eq 1 ]; then
    status_coturn="unknown"
    if (cd "$docker_dir" && docker compose "${compose_args[@]}" ps coturn 2>/dev/null) | grep -qi 'running\|up'; then
      status_coturn="running"
    fi
  fi

  cat <<EOF

================================================================
Chantivo Dedicated Server: Docker Compose install complete.

  Data volume:   Docker named volume (see 'docker volume ls')
  Logs:          chantivo-server logs -f

$(print_endpoint_summary_block)

Status:
  chantivo-server:   ${status_chantivo}
  coturn:            ${status_coturn}
  admin token:       ${ADMIN_TOKEN_STATUS}

${ADMIN_TOKEN_OUTPUT}

This token was minted by a direct, one-shot 'chantivo-server admin-token create' invocation (via
'docker compose exec') — it never passed through the container's own logs ('docker compose logs' never
sees it). Save it now; it is single-use. If you ever lose it, run 'sudo chantivo-server admin-token
create' again to mint a fresh one.

$(print_tls_summary_block)
================================================================
EOF
}

docker_install() {
  # Installing the operator CLI dispatcher to /usr/local/bin (below) needs root/write access there
  # regardless of deployment mode; Docker itself may be usable by a non-root `docker` group member,
  # but this script keeps one consistent, simple root requirement across both modes rather than
  # special-casing a partial-privilege docker-only path.
  require_root
  require_cmd docker
  docker compose version >/dev/null 2>&1 \
    || die "Docker Compose plugin not found. Install Docker Engine + the Compose plugin yourself: https://docs.docker.com/engine/install/ and https://docs.docker.com/compose/install/linux/ — this script does not install Docker (too privileged/out of scope)."

  preflight_docker_or_exit

  local docker_dir
  docker_dir="$(cd -- "${SCRIPT_DIR}/../docker" >/dev/null 2>&1 && pwd -P)" \
    || die "infrastructure/docker not found next to this script — run from a checkout of the Chantivo repository."

  local env_example="${docker_dir}/.env.example"
  local env_path="${docker_dir}/.env"
  [ -f "$env_example" ] || die "Missing $env_example"

  if [ -e "$env_path" ] && [ "$FORCE_REINSTALL" -ne 1 ]; then
    die "$env_path already exists — use 'chantivo-server update', or pass --force-reinstall to regenerate it."
  fi
  [ -L "$env_path" ] && rm -f -- "$env_path"
  cp -- "$env_example" "$env_path"
  chmod 600 "$env_path"

  if [ -n "$PUBLIC_ENDPOINT" ]; then
    printf '\nDISCO_VOADOR_SERVER_PUBLIC_HOST=%s\n' "$PUBLIC_ENDPOINT" >>"$env_path"
  fi
  printf 'DISCO_VOADOR_DEPLOYMENT_SCOPE=%s\n' "$DEPLOYMENT_SCOPE" >>"$env_path"

  local compose_project="chantivo-self-hosted"
  local compose_args=(-f compose.self-hosted.example.yaml -p "$compose_project")

  if [ "$INSTALL_COTURN" -eq 1 ]; then
    require_cmd openssl
    local turn_secret
    turn_secret="$(openssl rand -hex 32)"
    {
      printf 'DISCO_VOADOR_TURN_SHARED_SECRET=%s\n' "$turn_secret"
      # Same single source as native mode (resolve_turn_url): the address REMOTE CLIENTS are told,
      # which is never a Docker service name or bridge IP even though other containers may reach
      # Coturn by a completely different internal route. compose.turn.example.yaml uses
      # `network_mode: host`, so here there is no internal route at all — Coturn is on the host.
      printf 'DISCO_VOADOR_TURN_URLS=%s\n' "$TURN_URL"
    } >>"$env_path"
    generate_docker_turnserver_conf "$turn_secret"
    compose_args+=(--profile turn)
  fi

  (cd "$docker_dir" && docker compose "${compose_args[@]}" up -d --build)

  write_docker_deployment_marker "$docker_dir" "compose.self-hosted.example.yaml" "$compose_project"
  install_cli_dispatcher

  if [ "$CONFIGURE_FIREWALL" -eq 1 ]; then
    configure_firewall
  fi

  local health_ok=1
  wait_for_health 127.0.0.1 8090 60 || {
    health_ok=0
    echo "Continuing despite the health-check warning above — check 'chantivo-server logs' for details." >&2
  }

  if [ "$INSTALL_TLS" -eq 1 ]; then
    configure_tls_caddy "$HOSTNAME_ARG"
  fi

  if [ "$health_ok" -eq 1 ]; then
    mint_initial_admin_token
  else
    ADMIN_TOKEN_STATUS="SKIPPED (health check did not pass — mint one by hand once the server is healthy: sudo chantivo-server admin-token create)"
  fi

  print_summary_docker
}

# --- --tls-only mode -----------------------------------------------------------------------------------
#
# The safe "add/refresh a hostname + TLS on an already-installed Chantivo deployment" path required by
# this task's closure brief. Deliberately does NOT call any of native_install/docker_install's app/
# Coturn provisioning steps — never touches /var/lib/chantivo, /opt/chantivo/releases, or the Docker
# Compose stack. It only confirms the app is already installed for the given --mode (reusing the exact
# same detection functions the normal preflight checks use), then runs configure_tls_caddy against the
# app's existing 127.0.0.1:8090 listener.

confirm_tls_only() {
  echo
  echo "About to configure TLS/Caddy for an EXISTING Chantivo deployment (--tls-only — app/Coturn"
  echo "provisioning is skipped entirely; /var/lib/chantivo is never touched):"
  echo "  Mode:            $MODE"
  echo "  Hostname:        $HOSTNAME_ARG"
  echo "  Configure ufw:   $([ "$CONFIGURE_FIREWALL" -eq 1 ] && echo yes || echo no)"
  echo

  if [ "$ASSUME_YES" -eq 1 ]; then
    return 0
  fi
  if [ ! -t 0 ]; then
    die "Running non-interactively without --yes — pass --yes to proceed with the summary above, or run this script interactively."
  fi
  local answer
  read -r -p "Proceed? [y/N]: " answer
  case "$answer" in
    y | Y | yes | YES) return 0 ;;
    *)
      echo "Aborted — no changes made."
      exit 0
      ;;
  esac
}

print_summary_tls_only() {
  cat <<EOF

================================================================
Chantivo TLS/Caddy configuration (--tls-only) complete.

  Mode:          $MODE
  Hostname:      $HOSTNAME_ARG
  TLS/WSS:       $TLS_STATUS

This run never touched /var/lib/chantivo, /opt/chantivo/releases, or the Docker Compose stack — only
DNS validation, Caddy install/config, and a readiness check against the app's existing
127.0.0.1:8090 listener.
================================================================
EOF
}

tls_only_install() {
  require_root
  [ -n "$HOSTNAME_ARG" ] \
    || die "--tls-only requires --hostname <host> (public TLS needs a real public hostname — a bare IP cannot get a publicly-trusted certificate)."

  case "$MODE" in
    native)
      native_already_installed \
        || die "No existing native Chantivo install detected (checked /opt/chantivo/current and 'systemctl is-enabled chantivo-server') — run a normal 'install-chantivo.sh --mode native ...' install first, then rerun with --tls-only."
      ;;
    docker)
      docker_already_installed \
        || die "No existing Docker Compose Chantivo install detected (checked for a container labeled com.docker.compose.project=chantivo-server or chantivo-self-hosted) — run a normal 'install-chantivo.sh --mode docker ...' install first, then rerun with --tls-only."
      ;;
  esac

  confirm_tls_only

  if [ "$CONFIGURE_FIREWALL" -eq 1 ]; then
    configure_firewall
  fi

  configure_tls_caddy "$HOSTNAME_ARG"

  print_summary_tls_only
}

# --- Main ------------------------------------------------------------------------------------------

main() {
  parse_args "$@"

  if [ "$TLS_ONLY" -eq 1 ]; then
    [ -z "$TURN_URL_ARG" ] \
      || die "--turn-url is not meaningful with --tls-only (that mode never touches Coturn or the server's environment file). Change DISCO_VOADOR_TURN_URLS in the deployment's own env file and restart instead."
    resolve_mode
    if [ -n "$HOSTNAME_ARG" ]; then
      validate_hostname_arg "$HOSTNAME_ARG" \
        || die "Invalid --hostname value (printable ASCII only, no shell/sed/Caddyfile metacharacters — '{', '}', '#' included — <=253 chars)."
    fi
    # --tls-only always means "yes, configure TLS" by definition — no separate --with-tls needed, and
    # this also feeds configure_firewall's 80/443 gating (see configure_firewall's own comment).
    INSTALL_TLS=1
    tls_only_install
    return 0
  fi

  resolve_mode
  resolve_turn_decision

  if [ -n "$HOSTNAME_ARG" ]; then
    validate_hostname_arg "$HOSTNAME_ARG" \
      || die "Invalid --hostname value (printable ASCII only, no shell/sed/Caddyfile metacharacters — '{', '}', '#' included — <=253 chars)."
  fi
  if [ -n "$TURN_URL_ARG" ]; then
    [ "$INSTALL_COTURN" -eq 1 ] \
      || die "--turn-url was given but TURN is not being configured. Pass --with-turn as well, or drop --turn-url."
    validate_turn_url_arg "$TURN_URL_ARG" \
      || die "Invalid --turn-url value: must be a turn: or turns: URI with a host (e.g. turn:voice.example.com:3478), printable ASCII only, no shell/sed metacharacters, <=300 chars."
  fi

  # Resolve the Public Server Endpoint and the TURN URL BEFORE the confirmation prompt, so the
  # operator sees (and can abort on) the exact address remote clients will be told to use.
  resolve_public_endpoint
  resolve_turn_url

  resolve_tls_decision

  confirm_and_summarize

  case "$MODE" in
    native) native_install ;;
    docker) docker_install ;;
  esac
}

# Executing this file runs an install, exactly as before. `source`-ing it (what
# tests/repository/installer-turn-endpoint.test.mjs does, to exercise host_is_non_public/
# turn_url_host/resolve_public_endpoint/resolve_turn_url against the REAL script rather than a
# transcription of it) defines the functions and returns without touching the host. Same entry-point
# discipline as services/dedicated-server/src/cli-doctor.ts's own isEntryPoint guard.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
