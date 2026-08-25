import { describe, expect, it } from 'vitest';

import { isValidVersion } from '../../scripts/bump-version.mjs';

describe('bump-version validation', () => {
  it.each(['0.1.0', '1.0.0', '10.20.30'])('accepts plain MAJOR.MINOR.PATCH %s', (version) => {
    expect(isValidVersion(version)).toBe(true);
  });

  it.each(['0.1', '0.1.0-beta', 'v0.1.0', '0.1.0.0', 'latest', ''])(
    'rejects non-plain-semver input %s',
    (version) => {
      expect(isValidVersion(version)).toBe(false);
    },
  );
});
