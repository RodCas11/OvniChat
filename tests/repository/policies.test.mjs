import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { architectureViolationsForSource } from '../../scripts/verify-architecture.mjs';
import {
  caddyfileViolationsForSource,
  centralEndpointViolationsForSource,
  isProductionCodePath,
  turnUrlDefaultViolationsForSource,
} from '../../scripts/verify-infrastructure.mjs';
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

describe('reverse-proxy Caddyfile policy behavior', () => {
  const source = 'infrastructure/reverse-proxy/Caddyfile.example';

  const validCaddyfile = `
{$CHANTIVO_PUBLIC_HOSTNAME} {
    @blocked_health path /healthz /readyz
    respond @blocked_health 404

    reverse_proxy 127.0.0.1:8090
}
`;

  it('allows a Caddyfile that blocks /healthz and /readyz before the reverse_proxy catch-all', () => {
    expect(caddyfileViolationsForSource(validCaddyfile, source)).toHaveLength(0);
  });

  it('rejects a Caddyfile with no matcher blocking /healthz and /readyz at all', () => {
    const content = `
{$CHANTIVO_PUBLIC_HOSTNAME} {
    reverse_proxy 127.0.0.1:8090
}
`;
    const violations = caddyfileViolationsForSource(content, source);
    expect(violations.some((v) => v.includes('missing a named matcher'))).toBe(true);
  });

  it('rejects a Caddyfile with the matcher defined but no respond 404 for it', () => {
    const content = `
{$CHANTIVO_PUBLIC_HOSTNAME} {
    @blocked_health path /healthz /readyz

    reverse_proxy 127.0.0.1:8090
}
`;
    const violations = caddyfileViolationsForSource(content, source);
    expect(violations.some((v) => v.includes('missing "respond @blocked_health 404"'))).toBe(true);
  });

  it('rejects a Caddyfile where the reverse_proxy catch-all is missing or scoped to a matcher', () => {
    const content = `
{$CHANTIVO_PUBLIC_HOSTNAME} {
    @blocked_health path /healthz /readyz
    respond @blocked_health 404

    reverse_proxy @blocked_health 127.0.0.1:8090
}
`;
    const violations = caddyfileViolationsForSource(content, source);
    expect(violations.some((v) => v.includes('unconditional "reverse_proxy 127.0.0.1:8090"'))).toBe(
      true,
    );
  });

  it('rejects a Caddyfile where the block comes AFTER the reverse_proxy catch-all', () => {
    const content = `
{$CHANTIVO_PUBLIC_HOSTNAME} {
    reverse_proxy 127.0.0.1:8090

    @blocked_health path /healthz /readyz
    respond @blocked_health 404
}
`;
    const violations = caddyfileViolationsForSource(content, source);
    expect(
      violations.some((v) => v.includes('must be blocked BEFORE the reverse_proxy catch-all')),
    ).toBe(true);
  });
});

/**
 * T15 follow-up — Chantivo has no central service. `beta.chantivo.app` is ONE operator's own beta
 * Dedicated Server; nothing in installer/config/template code may point another installation at it
 * (or any other Chantivo-operated address) for TURN, signaling, or anything else. Documentation,
 * test fixtures, and explanatory comments recording real verification history against that real
 * host are expected and allowed.
 */
describe('central-endpoint policy behavior', () => {
  const CENTRAL_HOST = ['beta', '.chantivo', '.app'].join('');

  it.each([
    ['infrastructure/install/install-chantivo.sh', true],
    ['infrastructure/docker/.env.example', true],
    ['services/dedicated-server/src/config.ts', true],
    ['apps/desktop/src/main/index.ts', true],
    ['scripts/verify-links.mjs', true],
    ['docs/SELF_HOSTING.md', false],
    ['infrastructure/install/README.md', false],
    ['tests/desktop/parse-server-address.test.ts', false],
    ['apps/desktop/dist/renderer/parse-server-address.js', false],
  ])('treats %s as a production code path: %s', (relativePath, expected) => {
    expect(isProductionCodePath(relativePath)).toBe(expected);
  });

  it('rejects the Chantivo-operated host used as a shell fallback value', () => {
    const violations = centralEndpointViolationsForSource(
      'infrastructure/install/install-chantivo.sh',
      `TURN_URL="\${TURN_URL_ARG:-turn:${CENTRAL_HOST}:3478}"\n`,
    );
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join('\n')).toContain('own Coturn');
  });

  it('rejects the Chantivo-operated host used as a TypeScript default value', () => {
    const violations = centralEndpointViolationsForSource(
      'services/dedicated-server/src/config.ts',
      `const DEFAULT_PUBLIC_HOST = '${CENTRAL_HOST}';\n`,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('as an effective value');
  });

  it('rejects a turns: URL for the Chantivo-operated host even inside a comment', () => {
    const violations = centralEndpointViolationsForSource(
      'infrastructure/docker/.env.example',
      `# DISCO_VOADOR_TURN_URLS=turns:${CENTRAL_HOST}:5349\n`,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('TURN/STUN URL');
  });

  it('allows a shell comment recording real verification history against that host', () => {
    expect(
      centralEndpointViolationsForSource(
        'infrastructure/install/install-chantivo.sh',
        `# Security-review finding (production ${CENTRAL_HOST}, T15 follow-up): ...\n`,
      ),
    ).toHaveLength(0);
  });

  it('allows a TypeScript block comment naming that host as a real-world example', () => {
    expect(
      centralEndpointViolationsForSource(
        'apps/desktop/src/renderer/connection/parse-server-address.ts',
        `/**\n * e.g. typing \`${CENTRAL_HOST}\` with no scheme.\n */\nexport const x = 1;\n`,
      ),
    ).toHaveLength(0);
  });

  it.each([
    ['docs/tasks/T15_DISTRIBUTION_AND_EASY_INSTALL.md', `Verified against ${CENTRAL_HOST}.`],
    ['tests/desktop/parse-server-address.test.ts', `parse('${CENTRAL_HOST}')`],
  ])('allows %s to reference the host freely', (relativePath, content) => {
    expect(centralEndpointViolationsForSource(relativePath, content)).toHaveLength(0);
  });
});

/**
 * T15 follow-up — the generation half of the same incident: a `DISCO_VOADOR_TURN_URLS` template or
 * default that no remote client could ever reach. These values are handed to clients verbatim.
 */
describe('TURN URL default policy behavior', () => {
  it.each([
    'turn:127.0.0.1:3478',
    'turn:localhost:3478',
    'turn:10.0.0.5:3478',
    'turn:172.17.0.2:3478',
    'turn:coturn:3478',
    'turns:[::1]:5349',
  ])('rejects an unreachable default value %s', (url) => {
    const violations = turnUrlDefaultViolationsForSource(
      'infrastructure/docker/.env.example',
      `DISCO_VOADOR_TURN_URLS=${url}\n`,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('no remote client can reach');
  });

  it.each([
    'turn:voice.example.com:3478',
    'turns:voice.example.com:5349',
    'turn:203.0.113.10:3478',
  ])('allows a reachable example value %s', (url) => {
    expect(
      turnUrlDefaultViolationsForSource(
        'infrastructure/docker/.env.example',
        `DISCO_VOADOR_TURN_URLS=${url}\n`,
      ),
    ).toHaveLength(0);
  });

  it('ignores a template placeholder — the substituted result is what the installer tests cover', () => {
    expect(
      turnUrlDefaultViolationsForSource(
        'infrastructure/install/install-chantivo.sh',
        'printf \'DISCO_VOADOR_TURN_URLS=turn:%s:3478\\n\' "$PUBLIC_ENDPOINT"\n',
      ),
    ).toHaveLength(0);
  });

  it('allows a test fixture to use a loopback TURN URL deliberately', () => {
    expect(
      turnUrlDefaultViolationsForSource(
        'tests/dedicated-server/cli-doctor.test.ts',
        "DISCO_VOADOR_TURN_URLS: 'turn:127.0.0.1:3478',\n",
      ),
    ).toHaveLength(0);
  });
});

// T15.1 CI-blocker follow-up: on a genuinely fresh checkout, workspace packages' `main`/`types`
// fields (e.g. @disco-voador/config's `dist/index.js`) do not exist until a build step runs.
// `vitest run` was ordered before the full `tsc -b` in `check`, which is fine for tests that stay
// inside vitest's own resolution — but a test that spawns a REAL child process (via `tsx`) to run
// `services/dedicated-server/src/cli.ts` as a genuine, unmodified product entrypoint hits Node's
// own module resolution for every workspace package it imports, which requires `dist/` to already
// exist. This regressed exactly once, silently, on a real GitHub Actions clean runner (never
// locally, since a local checkout accumulates `dist/` output from every prior successful build).
// This test guards the ordering directly against the real root `package.json`, not a copy of it,
// so a future edit that reintroduces the wrong order fails here immediately instead of only ever
// being caught by a real clean-runner CI failure again.
describe('repository check pipeline ordering', () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const rootPackageJson = JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  const checkScript = rootPackageJson.scripts?.check ?? '';

  it('builds the Dedicated Server runtime workspace dependencies before running vitest', () => {
    const buildIndex = checkScript.indexOf('build:server-runtime');
    const vitestIndex = checkScript.indexOf('vitest run');
    expect(buildIndex, '"check" must reference the build:server-runtime script').toBeGreaterThan(
      -1,
    );
    expect(vitestIndex, '"check" must run vitest').toBeGreaterThan(-1);
    expect(
      buildIndex,
      '"build:server-runtime" must run BEFORE "vitest run" — real-process integration tests ' +
        '(e.g. tests/dedicated-server/token-leak-regression.test.ts) spawn workspace-package ' +
        'entrypoints that resolve through their real, built `dist/` output, which does not exist ' +
        'yet on a genuinely fresh checkout until this build step runs',
    ).toBeLessThan(vitestIndex);
  });

  it('"build:server-runtime" targets only the Dedicated Server\'s own composite project, not the full monorepo build', () => {
    const buildServerRuntimeScript = rootPackageJson.scripts?.['build:server-runtime'] ?? '';
    expect(buildServerRuntimeScript).toContain('tsc -b services/dedicated-server');
    // Deliberately narrower than the full `tsc -b` (which also builds apps/desktop and
    // packages/windows-media) — TypeScript's own project-reference graph already cascades this
    // one target to also build every real runtime dependency it needs (config/protocol/shared/
    // realtime/identity), without paying for an Electron/native-addon build just to run tests.
    expect(buildServerRuntimeScript).not.toContain('apps/desktop');
    expect(buildServerRuntimeScript).not.toContain('windows-media');
  });
});
