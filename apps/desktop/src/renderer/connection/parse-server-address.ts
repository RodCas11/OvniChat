/**
 * Parses a user-entered "server address" string (T8 Section 26) — hostname, IPv4, bracketed IPv6,
 * or `localhost`, with an optional `:port` and an optional explicit `ws://`/`wss://` scheme — into
 * a `ws://` or `wss://` URL. Deliberately built on the platform's own `URL` parser rather than
 * hand-rolled string splitting: a naive `address.split(':')` breaks on IPv6 (which contains colons
 * throughout the address itself, not just before a port), while `new URL(...)` already implements
 * the full, correct scheme/host/port/bracketed-IPv6 grammar.
 *
 * A bare `host[:port]` (no scheme) now defaults to **`wss://`**, secure by default, defaulting to
 * the standard port `443` when no port is given — this covers a real production hostname (e.g.
 * typing `beta.chantivo.app` with no scheme) reaching a TLS-terminating reverse proxy such as Caddy,
 * which is only listening on 443. Bare input never guesses `ws://`, even for `localhost`/loopback
 * addresses — an explicitly-typed scheme is the only way to get a plain, insecure `ws://` result, no
 * exceptions. An explicit `ws://host[:port]` is preserved exactly as before, defaulting to port
 * `8090` when no port is given — this remains the deliberate path for local/dev use
 * (`ws://localhost:8090`, `ws://127.0.0.1:8090`) and for IP-only self-hosting without TLS. An
 * explicit `wss://host[:port]` behaves identically to the bare form, defaulting to `443`. Any other
 * explicit scheme (`http://`, `https://`, etc.) is rejected rather than silently reinterpreted, so a
 * user who pastes a full URL with the wrong scheme gets a clear error instead of a silent, possibly
 * wrong, reinterpretation.
 */

const DEFAULT_PORT = 8090;
const DEFAULT_WSS_PORT = 443;
/** Generous bound — a real hostname is capped at 253 characters by DNS itself; this exists only to
 * reject an absurd paste cheaply, not as a real expected length. */
const MAX_INPUT_LENGTH = 300;
/** Matches any explicit `<scheme>://` prefix so it can be distinguished from a bare host before
 * parsing — used only to decide whether to prepend a default `ws://` scheme or parse as-is, and to
 * reject a non-`ws`/`wss` scheme explicitly rather than silently reinterpreting it. */
const EXPLICIT_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:\/\//iu;

export interface ParsedServerAddress {
  readonly host: string;
  readonly port: number;
  /** `ws://...` or `wss://...`, matching whichever scheme the input resolved to. */
  readonly url: string;
}

export type ParseServerAddressResult =
  | { readonly ok: true; readonly address: ParsedServerAddress }
  | { readonly ok: false; readonly reason: string };

export function parseServerAddress(input: string): ParseServerAddressResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'Server address cannot be blank' };
  }
  if (trimmed.length > MAX_INPUT_LENGTH) {
    return { ok: false, reason: 'Server address is too long' };
  }
  if (/\s/u.test(trimmed)) {
    return { ok: false, reason: 'Server address cannot contain whitespace' };
  }

  const hasExplicitScheme = EXPLICIT_SCHEME_PATTERN.test(trimmed);

  // Bare input (no explicit scheme) defaults to `wss://` — secure by default. Only an explicitly
  // typed `ws://` ever produces a plain, insecure `ws://` result; see the module doc comment above.
  let url: URL;
  try {
    url = new URL(hasExplicitScheme ? trimmed : `wss://${trimmed}`);
  } catch {
    return { ok: false, reason: 'Not a valid server address' };
  }

  if (hasExplicitScheme && url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    return { ok: false, reason: 'Server address must use ws:// or wss://' };
  }

  // A bare "host:port" (or "host") must never carry a path/query/fragment/credentials — any of
  // those means the input was something other than a plain address (e.g. accidentally pasting a
  // full invite URL), and silently discarding them would connect somewhere the user didn't type.
  const hasExtraComponents =
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '' && url.pathname !== '/') ||
    url.search !== '' ||
    url.hash !== '';
  if (hasExtraComponents) {
    return { ok: false, reason: 'Server address must be just a host and optional port' };
  }

  // For a bracketed IPv6 literal, `URL.hostname` keeps the brackets (e.g. "[::1]"); every other
  // host form has none. Strip them only for the `host` field this function returns (a plain
  // address, matching what the user typed inside the brackets), while reusing the still-bracketed
  // form as-is for the outbound `ws://`/`wss://` URL, where the brackets are syntactically required
  // again.
  const hostname = url.hostname;
  if (!hostname) {
    return { ok: false, reason: 'Not a valid server address' };
  }
  const isBracketedIPv6 = hostname.startsWith('[') && hostname.endsWith(']');
  const host = isBracketedIPv6 ? hostname.slice(1, -1) : hostname;

  const defaultPort = url.protocol === 'wss:' ? DEFAULT_WSS_PORT : DEFAULT_PORT;
  const port = url.port ? Number(url.port) : defaultPort;
  const resolvedUrl = `${url.protocol}//${hostname}:${String(port)}`;

  return { ok: true, address: { host, port, url: resolvedUrl } };
}
