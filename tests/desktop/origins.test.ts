import { describe, expect, it } from 'vitest';

import {
  allowedRendererOrigins,
  APP_ORIGIN,
  isAllowedOrigin,
} from '../../apps/desktop/src/main/origins.js';

describe('allowedRendererOrigins', () => {
  it('allows only the packaged app origin when there is no dev server', () => {
    expect(allowedRendererOrigins(undefined)).toEqual([APP_ORIGIN]);
  });

  it('allows only the Vite dev server origin in development', () => {
    expect(allowedRendererOrigins('http://localhost:5173')).toEqual(['http://localhost:5173']);
  });
});

describe('isAllowedOrigin', () => {
  const allowed = [APP_ORIGIN];

  it('allows a URL matching an allowlisted origin', () => {
    expect(isAllowedOrigin('app://renderer/index.html', allowed)).toBe(true);
  });

  it('denies an external origin', () => {
    expect(isAllowedOrigin('https://evil.example/phish', allowed)).toBe(false);
  });

  it('denies an unparsable URL instead of throwing', () => {
    expect(isAllowedOrigin('not a url', allowed)).toBe(false);
  });
});
