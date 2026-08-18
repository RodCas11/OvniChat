import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const textExtensions = new Set([
  '',
  '.cjs',
  '.conf',
  '.css',
  '.env',
  '.example',
  '.html',
  '.js',
  '.json',
  '.md',
  '.mjs',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

const secretPatterns = [
  /-----BEGIN (?:EC |DSA |OPENSSH |RSA )?PRIVATE KEY-----/u,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/u,
  /\b(?:github_pat_|ghp_|sk-ant-|sk-proj-)[A-Za-z0-9_-]{12,}\b/u,
  /^[ \t]*(?:ANTHROPIC_API_KEY|TURN_PASSWORD|TURN_SHARED_SECRET|TURN_STATIC_AUTH_SECRET)[ \t]*=[ \t]*(?!$|REPLACE_|CHANGEME|<)[^\s#]+/mu,
  /^[ \t]*static-auth-secret[ \t]*=[ \t]*(?!$|REPLACE_|CHANGEME|<)[^\s#]+/mu,
];

export function containsPotentialSecret(content) {
  return secretPatterns.some((pattern) => pattern.test(content));
}

export function isCandidateTextPath(relativePath) {
  const basename = path.basename(relativePath);
  return (
    basename === '.env' ||
    basename.startsWith('.env.') ||
    textExtensions.has(path.extname(relativePath))
  );
}

async function repositoryCandidateFiles() {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    {
      cwd: repositoryRoot,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
    },
  );

  return stdout
    .split('\0')
    .filter(Boolean)
    .filter(isCandidateTextPath)
    .map((relativePath) => path.resolve(repositoryRoot, relativePath));
}

export async function findPotentialSecrets() {
  const files = await repositoryCandidateFiles();
  const findings = [];

  for (const absolutePath of files) {
    const content = await readFile(absolutePath, 'utf8');
    if (containsPotentialSecret(content)) {
      findings.push(path.relative(repositoryRoot, absolutePath).replaceAll('\\', '/'));
    }
  }

  return findings;
}

export async function verifySecrets() {
  const findings = await findPotentialSecrets();
  if (findings.length > 0) {
    throw new Error(`Potential secrets detected in:\n- ${findings.join('\n- ')}`);
  }
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  await verifySecrets();
  console.info('No high-confidence committed secret patterns detected.');
}
