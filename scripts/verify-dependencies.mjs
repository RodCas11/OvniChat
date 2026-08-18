import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const approvedExoticUrl =
  'https://codeload.github.com/electron/node-gyp/tar.gz/06b29aafb7708acef8b3669835c8a7857ebc92d2';

async function findManifests(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const manifests = [];

  for (const entry of entries) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist') continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      manifests.push(...(await findManifests(absolutePath)));
    } else if (entry.name === 'package.json') {
      manifests.push(absolutePath);
    }
  }

  return manifests;
}

function dependencyEntries(manifest) {
  const sections = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
  return sections.flatMap((section) => Object.entries(manifest[section] ?? {}));
}

export async function findDependencyPolicyViolations() {
  const violations = [];
  const manifests = await findManifests(repositoryRoot);

  for (const manifestPath of manifests) {
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    for (const [name, specifier] of dependencyEntries(manifest)) {
      if (typeof specifier === 'string' && /^(?:git\+|github:|https?:)/u.test(specifier)) {
        const relativePath = path.relative(repositoryRoot, manifestPath).replaceAll('\\', '/');
        violations.push(
          `${relativePath}: direct dependency ${name} uses exotic source ${specifier}`,
        );
      }
    }
  }

  const lockfile = await readFile(path.join(repositoryRoot, 'pnpm-lock.yaml'), 'utf8');
  const exoticUrls = [
    ...new Set(
      [...lockfile.matchAll(/resolution:\s*\{[^}\n]*tarball:\s*([^,}\s]+)/gu)].map((match) =>
        (match[1] ?? '').replace(/^['"]|['"]$/gu, ''),
      ),
    ),
  ];

  for (const url of exoticUrls) {
    if (url !== approvedExoticUrl) {
      violations.push(`pnpm-lock.yaml: unapproved exotic dependency URL ${url}`);
    }
  }

  if (!exoticUrls.includes(approvedExoticUrl)) {
    violations.push('pnpm-lock.yaml: expected pinned Electron node-gyp exception is missing');
  }

  const workflowDirectory = path.join(repositoryRoot, '.github/workflows');
  const workflowFiles = await readdir(workflowDirectory).catch(() => []);
  for (const filename of workflowFiles.filter((file) => /\.ya?ml$/u.test(file))) {
    const workflow = await readFile(path.join(workflowDirectory, filename), 'utf8');
    for (const match of workflow.matchAll(/^\s*-?\s*uses:\s*['"]?([^\s#'"]+)/gmu)) {
      const action = match[1] ?? '';
      if (action.startsWith('./')) continue;
      const revision = action.slice(action.lastIndexOf('@') + 1);
      if (!/^[a-f0-9]{40}$/u.test(revision)) {
        violations.push(`${filename}: external action must use a full commit SHA (${action})`);
      }
    }
  }

  return violations;
}

export async function verifyDependencies() {
  const violations = await findDependencyPolicyViolations();
  if (violations.length > 0) {
    throw new Error(`Dependency policy violations:\n- ${violations.join('\n- ')}`);
  }
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  await verifyDependencies();
  console.info('Dependency source and lockfile policy verified.');
}
