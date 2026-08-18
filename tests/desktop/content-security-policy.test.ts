import { describe, expect, it } from 'vitest';

import { buildContentSecurityPolicy } from '../../apps/desktop/src/main/content-security-policy.js';

const REALTIME_ORIGIN = 'ws://127.0.0.1:8090';

describe('buildContentSecurityPolicy', () => {
  it('is fully restrictive with no script relaxation in production', () => {
    const csp = buildContentSecurityPolicy({ realtimeOrigin: REALTIME_ORIGIN });

    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('unsafe-eval');
  });

  it('allows connections to exactly the configured realtime origin, not a wildcard', () => {
    const csp = buildContentSecurityPolicy({ realtimeOrigin: REALTIME_ORIGIN });

    expect(csp).toContain(`connect-src 'self' ${REALTIME_ORIGIN}`);
    expect(csp).not.toContain('connect-src *');
  });

  it('only relaxes script-src for the documented Vite HMR exception in development', () => {
    const csp = buildContentSecurityPolicy({
      devServerOrigin: 'http://localhost:5173',
      realtimeOrigin: REALTIME_ORIGIN,
    });

    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("object-src 'none'");
  });
});
