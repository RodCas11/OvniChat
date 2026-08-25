#!/usr/bin/env bash
# infrastructure/install/lib/fetch-verify.sh
#
# Shared, security-sensitive logic sourced by BOTH infrastructure/install/install-chantivo.sh (first
# install) and infrastructure/install/chantivo-server (the operator CLI's `update` subcommand). This
# file exists so the download -> checksum-verify -> extract sequence, and the input-validation
# helper, exist in exactly ONE place — never copy-pasted between the two callers.
#
# This file is meant to be `source`d, not executed directly. It intentionally does not set
# `set -Eeuo pipefail` itself — both callers already set their own shell options before sourcing this
# file; a sourced library re-asserting shell options is redundant at best and surprising at worst if a
# future caller ever needs different options for an unrelated reason.
#
# Every function in this file that "returns" a value does so either via stdout (captured with
# `x="$(fn ...)"`) or by setting a small number of clearly-documented global variables — never via a
# bash nameref, to stay compatible with the plain, widely-portable subset of bash 4/5 this repo
# targets (Ubuntu 24.04/22.04's stock /bin/bash).

# A process-wide list of paths (directories or files) created by this library that must be removed on
# exit. Each caller script is expected to register its OWN `trap` calling a `cleanup` function that
# iterates this array — this library only appends to it, it never installs a trap itself, since a
# sourced file installing a trap would silently override any trap the caller already set.
CLEANUP_PATHS=()

# --- Small generic helpers -------------------------------------------------------------------------

die() {
  printf 'ERROR: %s\n' "$1" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "Required command not found: $1"
}

# validate_safe_string <value> [max_length]
#
# A narrow allowlist for values that originate from an interactive `read -r` prompt or a CLI flag and
# later land in a generated config file, a systemd unit, or an argument to another command (e.g. a
# `sed` replacement) — NOT a general-purpose free-form-URL/path validator (release-source URLs and
# local paths legitimately contain '/' and ':' and are handled separately; see fetch_uri below, which
# always passes such values through as single, already-quoted arguments, never string-interpolates
# them into a constructed shell command, so the injection concern this function targets does not apply
# to them the same way).
#
# Rejects: empty, over-length, any non-printable-ASCII byte, and — spelled out explicitly for reviewer
# clarity even though the printable-ASCII allowlist below already excludes most of them — the specific
# shell/sed-metacharacter set most likely to matter if this value is ever interpolated into a generated
# file or a `sed` expression: '$' '`' '"' "'" ';' '&' '|' '<' '>' '\' '/' and newline/carriage-return.
validate_safe_string() {
  local value="$1"
  local max_length="${2:-256}"

  [ -n "$value" ] || return 1
  [ "${#value}" -le "$max_length" ] || return 1

  # shellcheck disable=SC1003  # the lone `'\'*` arm is a literal single-backslash glob check, not an
  # unterminated single-quote escape — shellcheck's heuristic misreads it in this exact position.
  case "$value" in
    *'$'* | *'`'* | *'"'* | *"'"* | *';'* | *'&'* | *'|'* | *'<'* | *'>'* | *'\'* | *'/'* | *$'\n'* | *$'\r'*)
      return 1
      ;;
  esac

  # Printable ASCII only (space through tilde), byte-wise (LC_ALL=C so this cannot be fooled by a
  # locale that reinterprets high-bit bytes as printable).
  local original_lc_all="${LC_ALL:-}"
  LC_ALL=C
  case "$value" in
    *[!\ -~]*)
      LC_ALL="$original_lc_all"
      return 1
      ;;
  esac
  LC_ALL="$original_lc_all"
  return 0
}

# --- Release download/verify/extract ----------------------------------------------------------------

# detect_arch: maps `uname -m` to the exact architecture token
# scripts/release/build-dedicated-server-artifact.mjs embeds in its own release filenames
# (`chantivo-dedicated-server-<version>-linux-<arch>.tar.gz`, where <arch> is Node's own
# `process.arch`: 'x64' or 'arm64' — never the kernel's `uname -m` spelling directly).
#
# T15 support matrix, honestly (not theoretically): the dedicated-server dependency closure has
# nothing requiring native compilation (packages/identity has zero deps, `ws` has no native optional
# deps, `node:sqlite` is a Node builtin), so an arm64 artifact is realistically buildable — but no
# arm64 artifact has actually been built and run on real arm64 hardware for this release, and no
# arm64 entry exists in any real release-manifest.json this installer would ever fetch. Silently
# constructing an arm64 download URL and letting it fail with a generic "download failed" would be a
# confusing, dishonest failure mode. Fail here, explicitly and actionably, instead — "not yet
# supported" is a truthful status this release can ship with; "supported" would not be.
detect_arch() {
  local machine
  machine="$(uname -m)"
  case "$machine" in
    x86_64) printf 'x64' ;;
    aarch64 | arm64)
      die "This host is arm64 ($machine). Chantivo ${RELEASE_VERSION:-this release} does not yet ship a verified arm64 Dedicated Server artifact — linux-x64 is the only currently supported architecture. Do not attempt to run an x64 artifact under emulation. Track arm64 support in a future release, or build from source on this host if you understand the risk (see docs/architecture/PRODUCTION_SELF_HOSTING.md)."
      ;;
    *) die "Unsupported architecture: $machine (Chantivo release artifacts exist only for linux-x64 in this release)." ;;
  esac
}

# join_release_uri <base> <name> — plain string concatenation with exactly one '/' between the two,
# regardless of whether <base> already ends in '/'. Works identically for an http(s) URL, a
# file://-prefixed URI, or a bare local directory path, since all three are just '/'-joined strings at
# this level.
join_release_uri() {
  local base="$1" name="$2"
  case "$base" in
    */) printf '%s%s' "$base" "$name" ;;
    *) printf '%s/%s' "$base" "$name" ;;
  esac
}

# fetch_uri <source_uri> <dest_path> — supports http(s):// (via curl), file://<path>, and a bare local
# filesystem path. Always fails loudly (via die) rather than leaving a partial/missing destination
# file silently unnoticed.
fetch_uri() {
  local source_uri="$1" dest_path="$2"
  case "$source_uri" in
    http://* | https://*)
      require_cmd curl
      curl --fail --silent --show-error --location --output "$dest_path" -- "$source_uri" \
        || die "Failed to download: $source_uri"
      ;;
    file://*)
      local local_path="${source_uri#file://}"
      [ -f "$local_path" ] || die "Release source file not found: $local_path"
      cp -- "$local_path" "$dest_path"
      ;;
    *)
      [ -f "$source_uri" ] || die "Release source file not found: $source_uri"
      cp -- "$source_uri" "$dest_path"
      ;;
  esac
}

# read_manifest_version <json_file> — extracts the top-level "version" string field.
#
# This is a narrow, single-purpose scalar extractor for this repository's own known, self-produced,
# flat JSON schema (scripts/release/build-manifest.mjs's release-manifest.json, and — reused, since it
# has the identical top-level "version" field — a deployed package.json) — it is NOT a general JSON
# parser and must never be used against untrusted/arbitrary JSON. It is safe to use here specifically
# because the extracted value is only ever used to construct a filename that is independently verified
# against SHA256SUMS immediately afterward (see download_and_verify_release) — a corrupted or hostile
# manifest that changes this field only changes which filename this script attempts to fetch next, it
# can never itself bypass the checksum verification of whatever actually gets fetched.
read_manifest_version() {
  local json_file="$1"
  [ -f "$json_file" ] || die "Cannot read version: $json_file not found."
  local version
  version="$(grep -o '"version"[[:space:]]*:[[:space:]]*"[^"]*"' "$json_file" | head -n1 \
    | sed -E 's/.*:[[:space:]]*"([^"]*)"/\1/')"
  [ -n "$version" ] || die "Could not find a \"version\" field in $json_file"
  validate_safe_string "$version" 64 || die "Version field in $json_file failed safety validation: $version"
  printf '%s' "$version"
}

# download_and_verify_release <release_source>
#
# Downloads release-manifest.json, SHA256SUMS, and the one platform-specific tarball this host needs
# from <release_source> into a FRESH mktemp -d directory (never a predictable/fixed path — a
# predictable download directory would let another local user race a symlink into place between
# download and verification), verifies the tarball's SHA-256 against SHA256SUMS, and hard-fails
# (via die) on: a missing/empty release source, a missing or unreadable SHA256SUMS, SHA256SUMS not
# listing the expected filename, or a hash mismatch.
#
# Truncated/partial downloads: this function does not separately check a Content-Length byte count.
# A truncated file will, with overwhelming probability, simply fail the SHA-256 comparison below —
# `sha256sum -c` is already the authoritative check for a truncated OR corrupted OR tampered download,
# so a second, weaker byte-count heuristic would not catch anything the checksum step doesn't already
# catch, while adding real complexity (parsing curl's response headers, which differ in availability
# and format between plain HTTP and a local file:// source that has no headers at all).
#
# Sets (does not return via echo): RELEASE_VERSION, RELEASE_ARCH, RELEASE_ARTIFACT_NAME,
# RELEASE_DOWNLOAD_DIR, RELEASE_TARBALL_PATH. Appends the download directory to CLEANUP_PATHS.
download_and_verify_release() {
  local release_source="$1"
  [ -n "$release_source" ] \
    || die "No release source configured. Pass --release-source explicitly (a URL or a local path/file:// for testing)."

  require_cmd sha256sum
  require_cmd tar

  local download_dir
  download_dir="$(mktemp -d "${TMPDIR:-/tmp}/chantivo-install-download.XXXXXX")" \
    || die "Failed to create a temporary download directory."
  CLEANUP_PATHS+=("$download_dir")

  local manifest_uri sums_uri
  manifest_uri="$(join_release_uri "$release_source" "release-manifest.json")"
  sums_uri="$(join_release_uri "$release_source" "SHA256SUMS")"

  fetch_uri "$manifest_uri" "${download_dir}/release-manifest.json"
  fetch_uri "$sums_uri" "${download_dir}/SHA256SUMS"
  [ -s "${download_dir}/SHA256SUMS" ] || die "Downloaded SHA256SUMS is empty — refusing to trust an unverifiable release source."

  local version arch artifact_name
  version="$(read_manifest_version "${download_dir}/release-manifest.json")"
  arch="$(detect_arch)"
  artifact_name="chantivo-dedicated-server-${version}-linux-${arch}.tar.gz"

  local artifact_uri artifact_path
  artifact_uri="$(join_release_uri "$release_source" "$artifact_name")"
  artifact_path="${download_dir}/${artifact_name}"
  fetch_uri "$artifact_uri" "$artifact_path"
  [ -s "$artifact_path" ] || die "Downloaded release artifact is empty or missing: $artifact_path"

  grep -q "  ${artifact_name}\$" "${download_dir}/SHA256SUMS" \
    || die "SHA256SUMS does not list $artifact_name — refusing to trust an unverifiable download."

  (
    cd "$download_dir" || exit 1
    grep "  ${artifact_name}\$" SHA256SUMS | sha256sum -c - >/dev/null
  ) || die "Checksum verification FAILED for $artifact_name — refusing to install a corrupted or tampered download."

  # These five globals are this function's real "return value" — read by install-chantivo.sh and
  # chantivo-server after calling download_and_verify_release, in a different sourcing script, so a
  # single-file lint pass of this library alone cannot see their use.
  # shellcheck disable=SC2034
  RELEASE_VERSION="$version"
  # shellcheck disable=SC2034
  RELEASE_ARCH="$arch"
  # shellcheck disable=SC2034
  RELEASE_ARTIFACT_NAME="$artifact_name"
  # shellcheck disable=SC2034
  RELEASE_DOWNLOAD_DIR="$download_dir"
  # shellcheck disable=SC2034
  RELEASE_TARBALL_PATH="$artifact_path"
}

# extract_release_tarball <tarball_path> <dest_parent_dir>
#
# Extracts a verified tarball so that <dest_parent_dir>/chantivo-dedicated-server/ contains the real
# deployed artifact (dist/, node_modules/, package.json — the exact `pnpm deploy --prod` output
# services/dedicated-server/Dockerfile's build stage also produces). `--one-top-level` is GNU tar's own
# guard against a hostile/malformed archive that does NOT have the expected single top-level directory
# (it refuses rather than scattering files directly into <dest_parent_dir>); `--no-same-owner` ensures
# extracted files are owned by whoever runs this script, never whatever uid/gid happened to be baked
# into the archive at build time — this script applies its own explicit ownership afterward.
extract_release_tarball() {
  local tarball_path="$1" dest_parent_dir="$2"
  require_cmd tar
  mkdir -p -- "$dest_parent_dir"
  tar -xzf "$tarball_path" -C "$dest_parent_dir" --no-same-owner --one-top-level=chantivo-dedicated-server
}

# wait_for_health <host> <port> [timeout_seconds]
#
# Polls GET /healthz (liveness) then GET /readyz (readiness) with a bounded timeout. Returns 0 only
# once /healthz responds 200; a non-200/non-responding /readyz is logged but does not fail this
# function on its own (a server at connection capacity legitimately returns 503 from /readyz while
# still being a fully healthy, successfully-installed server — see docs/SELF_HOSTING.md's "Health and
# diagnosing problems" section).
wait_for_health() {
  local host="${1:-127.0.0.1}" port="${2:-8090}" timeout_s="${3:-60}"
  require_cmd curl
  local waited=0
  echo "Waiting for http://${host}:${port}/healthz (timeout ${timeout_s}s)..."
  while [ "$waited" -lt "$timeout_s" ]; do
    if curl --fail --silent --show-error --output /dev/null "http://${host}:${port}/healthz" 2>/dev/null; then
      echo "healthz: OK"
      if curl --fail --silent --show-error --output /dev/null "http://${host}:${port}/readyz" 2>/dev/null; then
        echo "readyz:  OK (accepting new connections)"
      else
        echo "readyz:  not currently accepting new connections (503 or unreachable) — healthz is what matters for install success; see docs/SELF_HOSTING.md."
      fi
      return 0
    fi
    sleep 2
    waited=$((waited + 2))
  done
  echo "WARNING: server did not report healthy within ${timeout_s}s." >&2
  return 1
}
