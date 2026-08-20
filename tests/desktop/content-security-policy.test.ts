import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy } from '../../apps/desktop/src/main/content-security-policy.js';

describe('buildContentSecurityPolicy', () => {
  it('is fully restrictive with no script relaxation in production', () => {
    const csp = buildContentSecurityPolicy();

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-eval');
  });

  it('allows WebSocket connections generically (T8: runtime-chosen server address), never a general wildcard', () => {
    const csp = buildContentSecurityPolicy();

    expect(csp).toContain("connect-src 'self' ws: wss:");
    expect(csp).not.toContain('connect-src *');
    expect(csp).not.toMatch(/connect-src[^;]*\bhttps:/u);
    expect(csp).not.toMatch(/connect-src[^;]*\bhttp:/u);
  });

  it('only relaxes script-src for the documented Vite HMR exception in development', () => {
    const csp = buildContentSecurityPolicy({
      devServerOrigin: 'http://localhost:5173',
    });

    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("object-src 'none'");
  });
});
