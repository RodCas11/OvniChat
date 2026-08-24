/**
 * T13.4 — the single source of truth for deriving a local voice-preference "server scope" key from a
 * raw server address, shared between Main (`main/settings/settings-file.ts`, which persists
 * `voicePreferences` keyed by this string) and the Renderer (`renderer/voice/use-voice-channel.ts`,
 * which must derive the *same* key for the server it is actually connected to right now, to read
 * back and write the preference it just persisted). Kept here — a plain, dependency-free module
 * already on both processes' import graph via `ipc-contract.ts`'s own precedent — specifically so
 * the two processes can never independently reimplement this normalization and drift apart, which
 * would silently make a saved preference unreachable (found live during the T13.4 persistence fix:
 * an earlier draft had the Renderer call this same logic itself, duplicated).
 *
 * Normalizes a raw `serverAddress` (host[:port], case-insensitive host, optional port) into a stable
 * key, used identically when reading and writing so the same server is always found under the same
 * key regardless of how the user typed/cased it this time, or whether it came from a bookmark's
 * `serverAddress` or a live connection's own resolved `ws://host:port` URL. The port is always made
 * explicit (defaulting to this app's own realtime port when omitted) so `"host"` and `"host:8090"` —
 * which mean the same connection — never split into two entries. Never keyed by `bookmarkId`: a
 * manually-typed, non-bookmarked connection has none, and a bookmark can be renamed/deleted
 * independently of the server it points at.
 */
export const DEFAULT_REALTIME_PORT = 8090;

export function deriveServerScopeKey(serverAddress: string): string {
  const trimmed = serverAddress.trim().toLowerCase();
  const lastColon = trimmed.lastIndexOf(':');
  // A bare IPv6-less host has no colon at all; a `host:port` shape's colon is never the first
  // character (a port-only string is not a valid server address this app ever produces).
  if (lastColon <= 0) return `${trimmed}:${String(DEFAULT_REALTIME_PORT)}`;
  const portPart = trimmed.slice(lastColon + 1);
  const port = /^\d+$/u.test(portPart) ? portPart : String(DEFAULT_REALTIME_PORT);
  const host = /^\d+$/u.test(portPart) ? trimmed.slice(0, lastColon) : trimmed;
  return `${host}:${port}`;
}
