import { describe, expect, it } from 'vitest';

import { parseServerAddress } from '../../apps/desktop/src/renderer/connection/parse-server-address.js';

describe('parseServerAddress', () => {
  it('parses a bare hostname with an explicit port, defaulting to wss://', () => {
    const result = parseServerAddress('voice.example.com:8090');
    expect(result).toEqual({
      ok: true,
      address: { host: 'voice.example.com', port: 8090, url: 'wss://voice.example.com:8090' },
    });
  });

  it('parses a bare hostname with no port, defaulting to wss:// on port 443', () => {
    const result = parseServerAddress('voice.example.com');
    expect(result).toEqual({
      ok: true,
      address: { host: 'voice.example.com', port: 443, url: 'wss://voice.example.com:443' },
    });
  });

  it('parses a bare IPv4 address with a port, defaulting to wss://', () => {
    const result = parseServerAddress('192.168.1.20:8090');
    expect(result).toEqual({
      ok: true,
      address: { host: '192.168.1.20', port: 8090, url: 'wss://192.168.1.20:8090' },
    });
  });

  it('parses a bare LAN IPv4 address with no port, defaulting to wss:// on port 443', () => {
    const result = parseServerAddress('10.0.0.4');
    expect(result).toEqual({
      ok: true,
      address: { host: '10.0.0.4', port: 443, url: 'wss://10.0.0.4:443' },
    });
  });

  it('parses a bare localhost with a port, defaulting to wss:// (no "looks like localhost" special-casing)', () => {
    const result = parseServerAddress('localhost:8090');
    expect(result).toEqual({
      ok: true,
      address: { host: 'localhost', port: 8090, url: 'wss://localhost:8090' },
    });
  });

  it('parses a bare bracketed IPv6 address with a port, defaulting to wss://', () => {
    const result = parseServerAddress('[::1]:8090');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.address.host).toBe('::1');
    expect(result.address.port).toBe(8090);
    expect(result.address.url).toBe('wss://[::1]:8090');
  });

  it('parses a bare bracketed IPv6 address with no port, defaulting to wss:// on port 443', () => {
    const result = parseServerAddress('[2001:db8::1]');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.address.host).toBe('2001:db8::1');
    expect(result.address.port).toBe(443);
  });

  it('trims surrounding whitespace', () => {
    const result = parseServerAddress('  127.0.0.1:8090  ');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.address.host).toBe('127.0.0.1');
  });

  it('rejects a blank address with a friendly message', () => {
    expect(parseServerAddress('')).toEqual({
      ok: false,
      reason: 'Server address cannot be blank',
    });
  });

  it('rejects a whitespace-only address with a friendly message', () => {
    expect(parseServerAddress('   ')).toEqual({
      ok: false,
      reason: 'Server address cannot be blank',
    });
  });

  it('rejects an address containing internal whitespace', () => {
    expect(parseServerAddress('voice example.com:8090').ok).toBe(false);
  });

  it('rejects an address that is too long', () => {
    expect(parseServerAddress(`${'a'.repeat(301)}:8090`).ok).toBe(false);
  });

  it('rejects an unbracketed IPv6-looking address as ambiguous', () => {
    // Without brackets, "::1:8090" cannot be unambiguously split into host/port — the URL parser
    // rejects it, exactly the "fragile string splitting breaks IPv6" case T8 calls out explicitly.
    expect(parseServerAddress('::1:8090').ok).toBe(false);
  });

  it('rejects an address carrying a path, query, or fragment', () => {
    expect(parseServerAddress('example.com:8090/path').ok).toBe(false);
    expect(parseServerAddress('example.com:8090?x=1').ok).toBe(false);
    expect(parseServerAddress('example.com:8090#frag').ok).toBe(false);
  });

  it('rejects an address carrying credentials', () => {
    expect(parseServerAddress('user:pass@example.com:8090').ok).toBe(false);
  });

  it('rejects a non-numeric or out-of-range port', () => {
    expect(parseServerAddress('example.com:notaport').ok).toBe(false);
    expect(parseServerAddress('example.com:99999').ok).toBe(false);
  });

  // Real-world regression: a bare production hostname (no scheme) previously defaulted to
  // insecure ws:// on port 8090, silently routing a real user typing `beta.chantivo.app` to the
  // wrong, unreachable port instead of the TLS-terminating reverse proxy on 443.
  it('defaults a bare host (no scheme) to wss:// on port 443 — secure by default', () => {
    const result = parseServerAddress('beta.chantivo.app');
    expect(result).toEqual({
      ok: true,
      address: { host: 'beta.chantivo.app', port: 443, url: 'wss://beta.chantivo.app:443' },
    });
  });

  it('explicit wss:// is unchanged by this fix', () => {
    const result = parseServerAddress('wss://beta.chantivo.app');
    expect(result).toEqual({
      ok: true,
      address: { host: 'beta.chantivo.app', port: 443, url: 'wss://beta.chantivo.app:443' },
    });
  });

  it('explicit ws:// still produces a plain ws:// result — the deliberately preserved local/dev path', () => {
    const result = parseServerAddress('ws://localhost:8090');
    expect(result).toEqual({
      ok: true,
      address: { host: 'localhost', port: 8090, url: 'ws://localhost:8090' },
    });
  });

  it('explicit ws://127.0.0.1:8090 still works, unchanged', () => {
    const result = parseServerAddress('ws://127.0.0.1:8090');
    expect(result).toEqual({
      ok: true,
      address: { host: '127.0.0.1', port: 8090, url: 'ws://127.0.0.1:8090' },
    });
  });

  // Deliberate: bare `localhost`/`127.0.0.1` (no scheme) get no special-case exemption — they
  // default to wss:// exactly like any other bare host. A developer who wants ws:// locally must
  // type it explicitly (covered by the two tests above).
  it('bare localhost (no scheme) defaults to wss:// like any other bare host — no special-casing', () => {
    const result = parseServerAddress('localhost');
    expect(result).toEqual({
      ok: true,
      address: { host: 'localhost', port: 443, url: 'wss://localhost:443' },
    });
  });

  it('bare 127.0.0.1 (no scheme) defaults to wss:// like any other bare host — no special-casing', () => {
    const result = parseServerAddress('127.0.0.1');
    expect(result).toEqual({
      ok: true,
      address: { host: '127.0.0.1', port: 443, url: 'wss://127.0.0.1:443' },
    });
  });

  it('accepts an explicit wss:// scheme, defaulting to port 443', () => {
    const result = parseServerAddress('wss://example.com');
    expect(result).toEqual({
      ok: true,
      address: { host: 'example.com', port: 443, url: 'wss://example.com:443' },
    });
  });

  it('an explicit port on a wss:// address always wins over the 443 default', () => {
    const result = parseServerAddress('wss://example.com:9000');
    expect(result).toEqual({
      ok: true,
      address: { host: 'example.com', port: 9000, url: 'wss://example.com:9000' },
    });
  });

  it('accepts a bracketed IPv6 address with an explicit wss:// scheme', () => {
    const result = parseServerAddress('wss://[::1]:9000');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.address.host).toBe('::1');
    expect(result.address.port).toBe(9000);
    expect(result.address.url).toBe('wss://[::1]:9000');
  });

  it('rejects a non-ws/wss explicit scheme such as https://', () => {
    const result = parseServerAddress('https://example.com');
    expect(result).toEqual({ ok: false, reason: 'Server address must use ws:// or wss://' });
  });

  // Deliberate decision (documented in the module doc comment): http:// and https:// are rejected
  // rather than silently reinterpreted as ws:// / wss:// — a user's explicitly typed scheme is
  // never second-guessed, and this also catches an accidentally-pasted full HTTP(S) URL.
  it('rejects an explicit http:// scheme with the same friendly message as https://', () => {
    const result = parseServerAddress('http://example.com');
    expect(result).toEqual({ ok: false, reason: 'Server address must use ws:// or wss://' });
  });

  it('rejects an arbitrary unrelated explicit scheme', () => {
    const result = parseServerAddress('ftp://example.com');
    expect(result).toEqual({ ok: false, reason: 'Server address must use ws:// or wss://' });
  });
});
