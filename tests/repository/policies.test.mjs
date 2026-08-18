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
