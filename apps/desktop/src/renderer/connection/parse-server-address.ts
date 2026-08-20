/**
 * Parses a user-entered "server address" string (T8 Section 26) — hostname, IPv4, bracketed IPv6,
 * or `localhost`, with an optional `:port` — into a `ws://` URL. Deliberately built on the
 * platform's own `URL` parser rather than hand-rolled string splitting: a naive
 * `address.split(':')` breaks on IPv6 (which contains colons throughout the address itself, not
 * just before a port), while `new URL('ws://' + input)` already implements the full, correct
 * host/port/bracketed-IPv6 grammar. This module only ever produces a `ws://` URL — never `wss://`
 * (TLS/production addressing is T13's concern) — matching this app's current development/
 * self-hosted-LAN posture (`docs/architecture/DEDICATED_SERVER.md`).
 */

const DEFAULT_PORT = 8090;
/** Generous bound — a real hostname is capped at 253 characters by DNS itself; this exists only to
 * reject an absurd paste cheaply, not as a real expected length. */
const MAX_INPUT_LENGTH = 300;

export interface ParsedServerAddress {
  readonly host: string;
  readonly port: number;
  /** Always `ws://...` — see the module doc comment for why. */
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

  let url: URL;
  try {
    url = new URL(`ws://${trimmed}`);
  } catch {
    return { ok: false, reason: 'Not a valid server address' };
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
  // form as-is for the outbound `ws://` URL, where the brackets are syntactically required again.
  const hostname = url.hostname;
  if (!hostname) {
    return { ok: false, reason: 'Not a valid server address' };
  }
  const isBracketedIPv6 = hostname.startsWith('[') && hostname.endsWith(']');
  const host = isBracketedIPv6 ? hostname.slice(1, -1) : hostname;

  const port = url.port ? Number(url.port) : DEFAULT_PORT;
  const wsUrl = `ws://${hostname}:${String(port)}`;

  return { ok: true, address: { host, port, url: wsUrl } };
}
