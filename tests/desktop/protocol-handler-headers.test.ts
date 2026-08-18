import { describe, expect, it, vi } from 'vitest';

type ProtocolHandler = (request: Request) => Promise<Response> | Response;

let registeredHandler: ProtocolHandler | undefined;

vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: () => {},
    handle: (_scheme: string, handler: ProtocolHandler) => {
      registeredHandler = handler;
    },
  },
  net: {
    fetch: async () => new Response('<html></html>', { status: 200, headers: {} }),
  },
}));

const { registerAppProtocolHandler } = await import('../../apps/desktop/src/main/protocol.js');

describe('registerAppProtocolHandler', () => {
  it('stamps CSP and defense-in-depth headers on every served response', async () => {
    registerAppProtocolHandler('C:\\app\\.vite\\renderer\\main_window');

    expect(registeredHandler).toBeTypeOf('function');
    const response = await registeredHandler?.(new Request('app://renderer/index.html'));

    expect(response?.headers.get('Content-Security-Policy')).toContain("default-src 'self'");
    expect(response?.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response?.headers.get('Referrer-Policy')).toBe('no-referrer');
  });

  it('returns a plain 404 instead of serving a request to an unexpected host', async () => {
    registerAppProtocolHandler('C:\\app\\.vite\\renderer\\main_window');

    const response = await registeredHandler?.(new Request('app://other-host/index.html'));

    expect(response?.status).toBe(404);
  });
});
