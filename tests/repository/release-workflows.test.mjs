import { readFileSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';

/**
 * T15.1 — structural validation of the two release workflows, so a future edit cannot quietly remove
 * a safety gate. Every assertion here corresponds to a specific way a release pipeline can go wrong:
 * a tag push writing to production storage, a build job receiving publication credentials, a publish
 * running from an arbitrary branch, a promotion silently rebuilding the binaries it is supposed to
 * only point at, or a workflow gaining write access to the repository it does not need.
 *
 * Parsed with a real YAML parser rather than grepped, because "the gate is still present somewhere in
 * the file" and "the gate is still attached to the job it guards" are different claims, and only the
 * second one is worth asserting.
 */

const repositoryRoot = process.cwd();
const workflowsDir = path.join(repositoryRoot, '.github/workflows');

function loadWorkflow(filename) {
  return yaml.load(readFileSync(path.join(workflowsDir, filename), 'utf8'));
}

function rawWorkflow(filename) {
  return readFileSync(path.join(workflowsDir, filename), 'utf8');
}

/**
 * Strips `#` comments so a grep-style assertion sees only text the workflow runner would act on.
 * Necessary because these workflows deliberately EXPLAIN the things they must never do ("`contents:
 * write` would be an unjustified escalation", "no arm64 claim anywhere"), and a reviewer-facing
 * explanation must not be mistaken for the violation it warns against. Same rationale, and same
 * conservative direction, as `effectiveSource` in scripts/verify-infrastructure.mjs.
 */
function effectiveYaml(raw) {
  return raw
    .split(/\r?\n/u)
    .map((line) => (line.trimStart().startsWith('#') ? '' : line.replace(/\s#.*$/u, '')))
    .join('\n');
}

const release = loadWorkflow('release.yml');
const promote = loadWorkflow('promote-release.yml');
const releaseRaw = effectiveYaml(rawWorkflow('release.yml'));
const promoteRaw = effectiveYaml(rawWorkflow('promote-release.yml'));

// `on:` is YAML 1.1's boolean `true`. js-yaml's default schema resolves it as such, which is exactly
// what GitHub's own parser does NOT do — so read the key the way it actually lands in the object.
const triggersOf = (workflow) => workflow.on ?? workflow[true];

describe('release.yml — triggers', () => {
  it('builds on v* tag pushes and on manual dispatch, and on nothing else', () => {
    const on = triggersOf(release);
    expect(Object.keys(on).sort()).toEqual(['push', 'workflow_dispatch']);
    expect(on.push).toEqual({ tags: ['v*'] });
    expect(on.push.branches).toBeUndefined();
  });

  it('defaults the publish input to false', () => {
    const inputs = triggersOf(release).workflow_dispatch.inputs;
    expect(inputs.publish.type).toBe('boolean');
    expect(inputs.publish.default).toBe(false);
    expect(inputs.version.type).toBe('string');
    expect(inputs.version.required).toBe(true);
  });
});

describe('release.yml — job graph', () => {
  it('has exactly the expected jobs', () => {
    expect(Object.keys(release.jobs)).toEqual([
      'quality-gate',
      'resolve-metadata',
      'windows-build',
      'linux-build',
      'assemble',
      'publish',
    ]);
  });

  it('gates every build on the quality gate and on resolved metadata', () => {
    expect(release.jobs['windows-build'].needs).toEqual(['quality-gate', 'resolve-metadata']);
    expect(release.jobs['linux-build'].needs).toEqual(['quality-gate', 'resolve-metadata']);
  });

  it('assembles only after both platform builds', () => {
    expect(release.jobs.assemble.needs).toEqual([
      'resolve-metadata',
      'windows-build',
      'linux-build',
    ]);
  });

  it('publishes only after a complete candidate has been assembled', () => {
    expect(release.jobs.publish.needs).toEqual(['resolve-metadata', 'assemble']);
  });

  it('runs the full existing quality gate, not a reduced substitute', () => {
    const steps = release.jobs['quality-gate'].steps.map((step) => step.run ?? '');
    expect(steps.some((run) => /(^|\s)(corepack )?pnpm check(\s|$)/u.test(run))).toBe(true);
  });

  it('bounds every job with a timeout so a stuck build cannot hold a runner forever', () => {
    for (const [name, job] of Object.entries(release.jobs)) {
      expect(job['timeout-minutes'], `${name} has no timeout-minutes`).toBeGreaterThan(0);
    }
    // Long enough for a real Electron Forge/Squirrel packaging run, not an optimistic guess.
    expect(release.jobs['windows-build']['timeout-minutes']).toBeGreaterThanOrEqual(30);
    expect(release.jobs['windows-build']['timeout-minutes']).toBeLessThanOrEqual(60);
  });

  it('calls the canonical build and verification scripts rather than reimplementing them inline', () => {
    const runs = Object.values(release.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.run ?? '')
      .join('\n');
    for (const script of [
      'scripts/release/resolve-release-metadata.mjs',
      'scripts/release/build-windows-artifact.mjs',
      'scripts/release/build-dedicated-server-artifact.mjs',
      'scripts/release/verify-linux-server-artifact.mjs',
      'scripts/release/build-manifest.mjs',
      'scripts/release/verify-release-directory.mjs',
      'scripts/release/publish-release-to-r2.mjs',
    ]) {
      expect(runs, `${script} is not invoked by release.yml`).toContain(script);
    }
  });

  it('re-verifies the generated checksum file with sha256sum -c before trusting it', () => {
    const runs = release.jobs.assemble.steps.map((step) => step.run ?? '').join('\n');
    expect(runs).toMatch(/sha256sum -c SHA256SUMS/u);
  });
});

describe('release.yml — publication gate', () => {
  const condition = () => release.jobs.publish.if.replace(/\s+/gu, ' ').trim();

  it('requires workflow_dispatch', () => {
    expect(condition()).toContain("github.event_name == 'workflow_dispatch'");
  });

  it('requires publish == true explicitly', () => {
    expect(condition()).toContain('inputs.publish == true');
  });

  it('requires the workflow ref to be the exact matching tag', () => {
    expect(condition()).toContain("github.ref == format('refs/tags/v{0}', inputs.version)");
  });

  it('is the only job with an if: condition, so nothing else is conditionally skippable', () => {
    const conditional = Object.entries(release.jobs).filter(([, job]) => job.if !== undefined);
    expect(conditional.map(([name]) => name)).toEqual(['publish']);
  });

  it('serializes concurrent publishes of the same version without serializing other builds', () => {
    expect(release.jobs.publish.concurrency.group).toContain('release-publish-');
    expect(release.jobs.publish.concurrency['cancel-in-progress']).toBe(false);
    // A workflow-level concurrency group would also serialize unrelated candidate builds.
    expect(release.concurrency).toBeUndefined();
  });
});

describe('release.yml — credential isolation', () => {
  it('gives environment: production to the publish job only', () => {
    for (const [name, job] of Object.entries(release.jobs)) {
      if (name === 'publish') {
        expect(job.environment).toBe('production');
      } else {
        expect(job.environment, `${name} must not have an environment`).toBeUndefined();
      }
    }
  });

  it('references the R2 secrets and bucket variable only inside the publish job', () => {
    for (const [name, job] of Object.entries(release.jobs)) {
      const serialized = JSON.stringify(job);
      const usesSecrets =
        /secrets\.CLOUDFLARE_R2_/u.test(serialized) || /vars\.CLOUDFLARE_R2_/u.test(serialized);
      expect(usesSecrets, `${name} must not reference R2 credentials`).toBe(name === 'publish');
    }
  });

  it('uses the operator-configured secret and variable names, never inline values', () => {
    const publishEnv = release.jobs.publish.steps.at(-1).env;
    expect(publishEnv.AWS_ACCESS_KEY_ID).toBe('${{ secrets.CLOUDFLARE_R2_ACCESS_KEY_ID }}');
    expect(publishEnv.AWS_SECRET_ACCESS_KEY).toBe('${{ secrets.CLOUDFLARE_R2_SECRET_ACCESS_KEY }}');
    expect(publishEnv.CLOUDFLARE_R2_ACCOUNT_ID).toBe('${{ secrets.CLOUDFLARE_R2_ACCOUNT_ID }}');
    expect(publishEnv.CLOUDFLARE_R2_BUCKET).toBe('${{ vars.CLOUDFLARE_R2_BUCKET }}');
  });
});

describe('promote-release.yml', () => {
  it('is manual only — a push can never move the stable pointer', () => {
    expect(Object.keys(triggersOf(promote))).toEqual(['workflow_dispatch']);
    expect(triggersOf(promote).workflow_dispatch.inputs.version.required).toBe(true);
  });

  it('has one job, in the production environment', () => {
    expect(Object.keys(promote.jobs)).toEqual(['promote']);
    expect(promote.jobs.promote.environment).toBe('production');
  });

  it('serializes all promotions globally, since there is only one stable pointer', () => {
    expect(promote.concurrency.group).toBe('stable-promotion');
    expect(promote.concurrency['cancel-in-progress']).toBe(false);
    expect(promote.concurrency.group).not.toContain('${{');
  });

  it('contains no build step of any kind', () => {
    const runs = promote.jobs.promote.steps.map((step) => step.run ?? '').join('\n');
    for (const forbidden of [
      'pnpm build',
      'run make',
      'electron-forge',
      'build-windows-artifact',
      'build-dedicated-server-artifact',
      'build-manifest',
      'pnpm install',
    ]) {
      expect(runs, `promote-release.yml must not run ${forbidden}`).not.toContain(forbidden);
    }
  });

  it('runs the promotion script and nothing that produces artifacts', () => {
    const runs = promote.jobs.promote.steps.map((step) => step.run ?? '').join('\n');
    expect(runs).toContain('scripts/release/validate-promotion-input.mjs');
    expect(runs).toContain('scripts/release/promote-stable.mjs');
  });

  it('uploads and downloads no artifacts', () => {
    const uses = promote.jobs.promote.steps.map((step) => step.uses ?? '').join('\n');
    expect(uses).not.toContain('upload-artifact');
    expect(uses).not.toContain('download-artifact');
  });

  it('defaults the public base URL to the distribution host, never a Chantivo deployment', () => {
    const input = triggersOf(promote).workflow_dispatch.inputs.public_base_url;
    expect(input.default).toBe('https://downloads.chantivo.app');
    expect(input.default).not.toContain('beta.chantivo.app');
  });
});

describe('both workflows — least privilege and self-hosting invariants', () => {
  it.each([
    ['release.yml', release],
    ['promote-release.yml', promote],
  ])('%s requests contents: read only', (_name, workflow) => {
    expect(workflow.permissions).toEqual({ contents: 'read' });
    for (const job of Object.values(workflow.jobs)) {
      expect(job.permissions).toBeUndefined();
    }
  });

  it.each([
    ['release.yml', releaseRaw],
    ['promote-release.yml', promoteRaw],
  ])('%s never requests contents: write', (_name, raw) => {
    expect(raw).not.toMatch(/contents:\s*write/u);
    expect(raw).not.toMatch(/permissions:\s*write-all/u);
  });

  it.each([
    ['release.yml', releaseRaw],
    ['promote-release.yml', promoteRaw],
  ])('%s never touches a Chantivo-operated deployment or opens an SSH session', (_name, raw) => {
    // Chantivo runs no central service. Releasing software must never reach into anyone's running
    // deployment — not even Chantivo's own beta server.
    expect(raw).not.toMatch(/beta\.chantivo\.app/u);
    expect(raw).not.toMatch(/\bssh\b/iu);
    expect(raw).not.toMatch(/scp\b/iu);
    expect(raw).not.toMatch(/rsync\b/iu);
  });

  it.each([
    ['release.yml', releaseRaw],
    ['promote-release.yml', promoteRaw],
  ])('%s references no TURN, STUN, or signaling concept', (_name, raw) => {
    // A release pipeline distributes bytes. Relay and signaling are the operator's own infrastructure,
    // and nothing about publishing software may assume otherwise.
    expect(raw).not.toMatch(/\bturns?:/iu);
    expect(raw).not.toMatch(/\bstuns?:/iu);
    expect(raw).not.toMatch(/coturn/iu);
    expect(raw).not.toMatch(/\bwss?:\/\//iu);
    expect(raw).not.toMatch(/signaling server/iu);
  });

  it.each([
    ['release.yml', releaseRaw],
    ['promote-release.yml', promoteRaw],
  ])('%s claims no arm64 support', (_name, raw) => {
    expect(raw).not.toMatch(/arm64/iu);
  });

  it.each([
    ['release.yml', releaseRaw],
    ['promote-release.yml', promoteRaw],
  ])('%s contains no literal credential or account identifier', (_name, raw) => {
    // Every credential-shaped value must arrive through `secrets.`/`vars.`; nothing may be inlined.
    expect(raw).not.toMatch(/AWS_SECRET_ACCESS_KEY:[ \t]+(?!\$\{\{)/u);
    expect(raw).not.toMatch(/AWS_ACCESS_KEY_ID:[ \t]+(?!\$\{\{)/u);
    expect(raw).not.toMatch(/[0-9a-f]{32}\.r2\.cloudflarestorage\.com/u);
    expect(raw).not.toMatch(/\becho\b.*secrets\./u);
  });

  it.each([
    ['release.yml', release],
    ['promote-release.yml', promote],
  ])('%s pins every external action to a full commit SHA', (_name, workflow) => {
    const uses = Object.values(workflow.jobs)
      .flatMap((job) => job.steps ?? [])
      .map((step) => step.uses)
      .filter(Boolean);
    expect(uses.length).toBeGreaterThan(0);
    for (const action of uses) {
      expect(action, `${action} is not pinned to a commit SHA`).toMatch(/@[a-f0-9]{40}$/u);
    }
  });
});

describe('tag pushes never reach production storage', () => {
  it('leaves no path from a push event to any R2 write', () => {
    // Structural proof rather than a comment: the only job that can touch R2 is `publish`, and its
    // condition requires workflow_dispatch. A `push` event therefore cannot reach it, no matter what
    // the rest of the graph does.
    const r2Jobs = Object.entries(release.jobs).filter(([, job]) =>
      /CLOUDFLARE_R2_/u.test(JSON.stringify(job)),
    );
    expect(r2Jobs.map(([name]) => name)).toEqual(['publish']);
    expect(release.jobs.publish.if).toContain("github.event_name == 'workflow_dispatch'");
  });
});
