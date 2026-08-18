import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoots = ['apps', 'packages', 'services'];
const sourceExtensions = new Set(['.ts', '.tsx', '.mts', '.cts']);

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === 'dist' || entry.name === 'node_modules' || entry.name === '.vite') {
      continue;
    }

    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walk(absolutePath)));
    } else if (sourceExtensions.has(path.extname(entry.name))) {
      files.push(absolutePath);
    }
  }

  return files;
}

function importsFrom(source) {
  const imports = [];
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/gu,
    /\bimport\s+['"]([^'"]+)['"]/gu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier) imports.push(specifier);
    }
  }

  return imports;
}

function isNodeCapability(specifier) {
  const packageName = specifier.replace(/^node:/u, '').split('/')[0];
  return (
    specifier.startsWith('node:') ||
    [
      'child_process',
      'cluster',
      'crypto',
      'dgram',
      'electron',
      'fs',
      'http',
      'https',
      'module',
      'net',
      'os',
      'path',
      'process',
      'stream',
      'tls',
      'worker_threads',
    ].includes(packageName)
  );
}

function isWindowsMedia(specifier) {
  return (
    specifier.startsWith('@disco-voador/windows-media') ||
    /(?:^|\/)windows-media(?:\/|$)/u.test(specifier)
  );
}

export function architectureViolationsForSource(relativePath, source) {
  const violations = [];

  for (const specifier of importsFrom(source)) {
    if (relativePath.startsWith('apps/desktop/src/renderer/') && isNodeCapability(specifier)) {
      violations.push(`${relativePath}: renderer imports privileged module "${specifier}"`);
    }

    if (
      /apps\/desktop\/src\/(?:preload|renderer)\//u.test(relativePath) &&
      isWindowsMedia(specifier)
    ) {
      violations.push(
        `${relativePath}: desktop bridge imports Windows media implementation "${specifier}"`,
      );
    }

    if (
      relativePath.startsWith('packages/rtc-core/') &&
      (specifier === 'electron' || specifier === 'react' || isWindowsMedia(specifier))
    ) {
      violations.push(`${relativePath}: rtc-core imports forbidden module "${specifier}"`);
    }

    if (
      /packages\/(media-core|protocol|shared)\//u.test(relativePath) &&
      (specifier === 'electron' || isWindowsMedia(specifier))
    ) {
      violations.push(`${relativePath}: generic package imports platform module "${specifier}"`);
    }
  }

  return violations;
}

export async function findArchitectureViolations() {
  const files = (
    await Promise.all(sourceRoots.map((root) => walk(path.join(repositoryRoot, root))))
  ).flat();
  const violations = [];

  for (const absolutePath of files) {
    const relativePath = path.relative(repositoryRoot, absolutePath).replaceAll('\\', '/');
    const source = await readFile(absolutePath, 'utf8');

    violations.push(...architectureViolationsForSource(relativePath, source));
  }

  return violations;
}

export async function verifyArchitecture() {
  const violations = await findArchitectureViolations();
  if (violations.length > 0) {
    throw new Error(`Architecture boundary violations:\n- ${violations.join('\n- ')}`);
  }
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  await verifyArchitecture();
  console.info('Architecture boundaries verified.');
}
