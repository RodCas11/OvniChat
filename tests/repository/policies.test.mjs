import { describe, expect, it } from 'vitest';

import { architectureViolationsForSource } from '../../scripts/verify-architecture.mjs';
import { containsPotentialSecret, isCandidateTextPath } from '../../scripts/verify-secrets.mjs';

describe('architecture policy behavior', () => {
  it.each(['renderer', 'preload'])(
    'rejects windows-media imports from desktop %s',
    (processName) => {
      const source = "import '@disco-voador/windows-media';";
      const violations = architectureViolationsForSource(
        `apps/desktop/src/${processName}/unsafe.ts`,
        source,
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('Windows media implementation');
    },
  );

  it.each(['renderer', 'preload'])('rejects identity imports from desktop %s', (processName) => {
    const source = "import '@disco-voador/identity';";
    const violations = architectureViolationsForSource(
      `apps/desktop/src/${processName}/unsafe.ts`,
      source,
    );

    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('identity private-key implementation');
  });

  it('allows identity imports from the desktop main process', () => {
    const source = "import '@disco-voador/identity';";
    const violations = architectureViolationsForSource(
      'apps/desktop/src/main/identity/service.ts',
      source,
    );

    expect(violations).toHaveLength(0);
  });

  it('allows identity imports from services/realtime', () => {
    const source = "import '@disco-voador/identity';";
    const violations = architectureViolationsForSource(
      'services/realtime/src/protocol-handlers.ts',
      source,
    );

    expect(violations).toHaveLength(0);
  });

  it.each(['protocol', 'rtc-core', 'media-core', 'shared'])(
    'rejects identity imports from generic package %s',
    (packageName) => {
      const source = "import '@disco-voador/identity';";
      const violations = architectureViolationsForSource(
        `packages/${packageName}/src/unsafe.ts`,
        source,
      );

      expect(violations).toHaveLength(1);
      expect(violations[0]).toContain('generic package imports platform module');
    },
  );

  it('does not flag an unrelated relative import merely named "identity"', () => {
    const source = "import { useIdentity } from './identity/useIdentity';";
    const violations = architectureViolationsForSource(
      'apps/desktop/src/renderer/settings/Profile.tsx',
      source,
    );

    expect(violations).toHaveLength(0);
  });
});

describe('secret policy behavior', () => {
  it.each(['.env', 'apps/desktop/.env.production', 'services/realtime/.env.development.local'])(
    'includes environment file %s in the candidate scan',
    (candidate) => {
      expect(isCandidateTextPath(candidate)).toBe(true);
    },
  );

  it.each([
    ['TURN shared secret', ['TURN_SHARED', '_SECRET=real-secret-value'].join('')],
    ['Coturn shared secret', ['static-auth', '-secret=real-secret-value'].join('')],
  ])('detects a populated %s', (_label, candidate) => {
    expect(containsPotentialSecret(candidate)).toBe(true);
  });

  it.each([
    ['TURN_SHARED', '_SECRET='].join(''),
    ['TURN_SHARED', '_SECRET=REPLACE_WITH_RANDOM'].join(''),
    ['static-auth', '-secret=<runtime-only>'].join(''),
  ])('allows a blank or unmistakable placeholder', (candidate) => {
    expect(containsPotentialSecret(candidate)).toBe(false);
  });
});
