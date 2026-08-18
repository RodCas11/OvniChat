import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const repositoryRoot = process.cwd();
const verificationScripts = [
  'scripts/verify-architecture.mjs',
  'scripts/verify-dependencies.mjs',
  'scripts/verify-harness.mjs',
  'scripts/verify-infrastructure.mjs',
  'scripts/verify-links.mjs',
  'scripts/verify-secrets.mjs',
];

describe('repository guardrails', () => {
  for (const script of verificationScripts) {
    it(`passes ${script}`, () => {
      expect(() =>
        execFileSync(process.execPath, [path.join(repositoryRoot, script)], {
          cwd: repositoryRoot,
          encoding: 'utf8',
          stdio: 'pipe',
        }),
      ).not.toThrow();
    });
  }
});
