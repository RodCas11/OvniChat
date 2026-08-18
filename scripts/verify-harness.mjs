import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const expectedAgents = [
  'electron-desktop-engineer',
  'infrastructure-engineer',
  'qa-engineer',
  'realtime-backend-engineer',
  'security-reviewer',
  'software-architect',
  'webrtc-media-engineer',
  'windows-media-engineer',
];

const expectedSkills = [
  'electron-development',
  'planning-feature',
  'project-orientation',
  'realtime-protocol',
  'security-review',
  'self-hosting',
  'testing-quality',
  'text-chat',
  'vdo-ninja-reference',
  'webrtc-development',
  'windows-media-capture',
];

const requiredFiles = [
  'AGENTS.md',
  'CLAUDE.md',
  'README.md',
  '.claude/settings.json',
  'docs/ARCHITECTURE.md',
  'docs/CONFIGURATION.md',
  'docs/DEFINITION_OF_DONE.md',
  'docs/DEVELOPMENT.md',
  'docs/HANDOFF.md',
  'docs/LICENSING.md',
  'docs/PRODUCT.md',
  'docs/ROADMAP.md',
  'docs/SECURITY.md',
  'docs/tasks/README.md',
  'docs/tasks/STATUS.md',
  'docs/tasks/T0_REPOSITORY_HARNESS.md',
  'docs/tasks/T1_ELECTRON_SHELL.md',
  'docs/references/VDO_NINJA.md',
];

function parseFrontmatter(content) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(content);
  if (!match?.[1]) return {};

  const entries = [];
  for (const line of match[1].split(/\r?\n/u)) {
    const separatorIndex = line.indexOf(':');
    if (separatorIndex > 0) {
      entries.push([line.slice(0, separatorIndex).trim(), line.slice(separatorIndex + 1).trim()]);
    }
  }
  return Object.fromEntries(entries);
}

async function assertExists(relativePath, errors) {
  try {
    await access(path.join(repositoryRoot, relativePath));
  } catch {
    errors.push(`Missing required path: ${relativePath}`);
  }
}

export async function findHarnessViolations() {
  const errors = [];

  await Promise.all(requiredFiles.map((file) => assertExists(file, errors)));

  try {
    const settings = JSON.parse(
      await readFile(path.join(repositoryRoot, '.claude/settings.json'), 'utf8'),
    );
    const permissions = settings.permissions ?? {};
    if (permissions.defaultMode !== 'default') {
      errors.push('.claude/settings.json: permissions.defaultMode must be default');
    }
    if (permissions.disableBypassPermissionsMode !== 'disable') {
      errors.push('.claude/settings.json: bypass-permissions mode must be disabled');
    }
    const denied = permissions.deny ?? [];
    for (const rule of [
      'Read(./.env)',
      'Read(./infrastructure/coturn/turnserver.conf)',
      'Read(./infrastructure/coturn/turnserver.dev.conf)',
      'Read(./**/*.key)',
      'Read(./**/*.pem)',
    ]) {
      if (!denied.includes(rule)) {
        errors.push(`.claude/settings.json: required deny rule missing (${rule})`);
      }
    }
  } catch {
    errors.push('.claude/settings.json: must contain valid JSON settings');
  }

  for (const name of expectedAgents) {
    const relativePath = `.claude/agents/${name}.md`;
    await assertExists(relativePath, errors);
    try {
      const content = await readFile(path.join(repositoryRoot, relativePath), 'utf8');
      const metadata = parseFrontmatter(content);
      if (metadata.name !== name) errors.push(`${relativePath}: frontmatter name must be ${name}`);
      if (!metadata.description) errors.push(`${relativePath}: description is required`);
      if (!metadata.tools) errors.push(`${relativePath}: tools are required`);
      if (!metadata.skills) errors.push(`${relativePath}: relevant skills are required`);
      if (metadata.model) errors.push(`${relativePath}: model must inherit from the orchestrator`);
      if (metadata.permissionMode === 'bypassPermissions') {
        errors.push(`${relativePath}: bypassPermissions is prohibited`);
      }
      if (!content.includes('docs/'))
        errors.push(`${relativePath}: canonical docs reference missing`);
      if (!content.includes('## Deliverable'))
        errors.push(`${relativePath}: Deliverable section missing`);
      if (
        ['security-reviewer', 'software-architect'].includes(name) &&
        /\b(?:Bash|Edit|Write)\b/u.test(metadata.tools ?? '')
      ) {
        errors.push(`${relativePath}: review agent must use read-only tools`);
      }
    } catch {
      // The missing-path error above is more useful.
    }
  }

  for (const name of expectedSkills) {
    const relativePath = `.claude/skills/${name}/SKILL.md`;
    await assertExists(relativePath, errors);
    try {
      const content = await readFile(path.join(repositoryRoot, relativePath), 'utf8');
      const metadata = parseFrontmatter(content);
      if (metadata.name !== name) errors.push(`${relativePath}: frontmatter name must be ${name}`);
      if (!metadata.description) errors.push(`${relativePath}: description is required`);
      if (!content.includes('docs/'))
        errors.push(`${relativePath}: canonical docs reference missing`);
      if (content.split(/\r?\n/u).length > 180)
        errors.push(`${relativePath}: skill exceeds 180 lines`);
    } catch {
      // The missing-path error above is more useful.
    }
  }

  const actualAgents = await readdir(path.join(repositoryRoot, '.claude/agents')).catch(() => []);
  const unexpectedAgents = actualAgents
    .filter((file) => file.endsWith('.md'))
    .map((file) => path.basename(file, '.md'))
    .filter((name) => !expectedAgents.includes(name));
  if (unexpectedAgents.length > 0) {
    errors.push(`Unexpected Claude agents: ${unexpectedAgents.join(', ')}`);
  }

  const actualSkills = await readdir(path.join(repositoryRoot, '.claude/skills'), {
    withFileTypes: true,
  }).catch(() => []);
  const unexpectedSkills = actualSkills
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !expectedSkills.includes(name));
  if (unexpectedSkills.length > 0) {
    errors.push(`Unexpected Claude skills: ${unexpectedSkills.join(', ')}`);
  }

  return errors;
}

export async function verifyHarness() {
  const violations = await findHarnessViolations();
  if (violations.length > 0) {
    throw new Error(`Claude harness violations:\n- ${violations.join('\n- ')}`);
  }
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  await verifyHarness();
  console.info('Claude harness and required documentation verified.');
}
