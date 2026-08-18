import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const productionConfig = 'infrastructure/coturn/turnserver.conf.example';
const developmentConfig = 'infrastructure/coturn/turnserver.dev.conf.example';

function activeDirectives(content) {
  return content
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

function requireDirective(directives, directive, source, violations) {
  if (!directives.includes(directive)) {
    violations.push(`${source}: required directive missing (${directive})`);
  }
}

export async function findInfrastructureViolations() {
  const violations = [];
  const configurations = await Promise.all(
    [productionConfig, developmentConfig].map(async (relativePath) => ({
      directives: activeDirectives(await readFile(path.join(repositoryRoot, relativePath), 'utf8')),
      relativePath,
    })),
  );

  for (const { directives, relativePath } of configurations) {
    for (const directive of [
      'use-auth-secret',
      'unauthorized-ratelimit',
      'unauthorized-ratelimit-rps=10',
      'no-cli',
      'no-multicast-peers',
    ]) {
      requireDirective(directives, directive, relativePath, violations);
    }
    if (directives.includes('lt-cred-mech')) {
      violations.push(`${relativePath}: lt-cred-mech conflicts with use-auth-secret`);
    }
    if (directives.some((directive) => directive.startsWith('static-auth-secret='))) {
      violations.push(`${relativePath}: committed example must not contain a usable secret field`);
    }
  }

  const production = configurations[0]?.directives ?? [];
  for (const range of [
    '10.0.0.0-10.255.255.255',
    '100.64.0.0-100.127.255.255',
    '169.254.0.0-169.254.255.255',
    '172.16.0.0-172.31.255.255',
    '192.168.0.0-192.168.255.255',
    'fc00::-fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
    'fe80::-febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff',
  ]) {
    requireDirective(production, `denied-peer-ip=${range}`, productionConfig, violations);
  }

  const composeFiles = [
    'infrastructure/docker/compose.turn.example.yaml',
    'infrastructure/docker/compose.turn-bridge.example.yaml',
  ];
  for (const relativePath of composeFiles) {
    const compose = await readFile(path.join(repositoryRoot, relativePath), 'utf8');
    if (!compose.includes('image: coturn/coturn:4.17.2-r0')) {
      violations.push(`${relativePath}: immutable Coturn image pin is missing`);
    }
  }

  return violations;
}

export async function verifyInfrastructure() {
  const violations = await findInfrastructureViolations();
  if (violations.length > 0) {
    throw new Error(`Infrastructure template violations:\n- ${violations.join('\n- ')}`);
  }
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  await verifyInfrastructure();
  console.info('Infrastructure templates verified.');
}
