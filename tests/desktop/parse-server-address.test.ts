import { describe, expect, it } from 'vitest';

import { parseServerAddress } from '../../apps/desktop/src/renderer/connection/parse-server-address.js';

describe('parseServerAddress', () => {
  it('parses a hostname with an explicit port', () => {
    const result = parseServerAddress('voice.example.com:8090');
    expect(result).toEqual({
      ok: true,
      address: { host: 'voice.example.com', port: 8090, url: 'ws://voice.example.com:8090' },
    });
  });

  it('parses a hostname with no port, defaulting to 8090', () => {
    const result = parseServerAddress('voice.example.com');
    expect(result).toEqual({
      ok: true,
      address: { host: 'voice.example.com', port: 8090, url: 'ws://voice.example.com:8090' },
    });
  });

  it('parses an IPv4 address with a port', () => {
    const result = parseServerAddress('192.168.1.20:8090');
    expect(result).toEqual({
      ok: true,
      address: { host: '192.168.1.20', port: 8090, url: 'ws://192.168.1.20:8090' },
    });
  });

  it('parses a LAN IPv4 address with no port', () => {
    const result = parseServerAddress('10.0.0.4');
    expect(result).toEqual({
      ok: true,
      address: { host: '10.0.0.4', port: 8090, url: 'ws://10.0.0.4:8090' },
    });
  });

  it('parses localhost with a port', () => {
    const result = parseServerAddress('localhost:8090');
    expect(result).toEqual({
      ok: true,
      address: { host: 'localhost', port: 8090, url: 'ws://localhost:8090' },
    });
  });

  it('parses a bracketed IPv6 address with a port', () => {
    const result = parseServerAddress('[::1]:8090');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.address.host).toBe('::1');
    expect(result.address.port).toBe(8090);
    expect(result.address.url).toBe('ws://[::1]:8090');
  });

  it('parses a bracketed IPv6 address with no port', () => {
    const result = parseServerAddress('[2001:db8::1]');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.address.host).toBe('2001:db8::1');
    expect(result.address.port).toBe(8090);
  });

  it('trims surrounding whitespace', () => {
    const result = parseServerAddress('  127.0.0.1:8090  ');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.address.host).toBe('127.0.0.1');
  });

  it('rejects a blank address', () => {
    expect(parseServerAddress('').ok).toBe(false);
    expect(parseServerAddress('   ').ok).toBe(false);
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

  it('defaults a bare host (no scheme) to ws:// on port 8090 — unchanged behavior', () => {
    const result = parseServerAddress('example.com');
    expect(result).toEqual({
      ok: true,
      address: { host: 'example.com', port: 8090, url: 'ws://example.com:8090' },
    });
  });

  it('treats an explicit ws:// scheme identically to a bare host', () => {
    const result = parseServerAddress('ws://example.com');
    expect(result).toEqual({
      ok: true,
      address: { host: 'example.com', port: 8090, url: 'ws://example.com:8090' },
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
});
