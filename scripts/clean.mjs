import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = [
  'apps/desktop/.vite',
  'apps/desktop/dist',
  'apps/desktop/out',
  'coverage',
  'packages/config/dist',
  'packages/media-core/dist',
  'packages/protocol/dist',
  'packages/rtc-core/dist',
  'packages/shared/dist',
  'packages/windows-media/dist',
  'services/realtime/dist',
];

for (const relativeTarget of targets) {
  const absoluteTarget = path.resolve(repositoryRoot, relativeTarget);
  const relativeCheck = path.relative(repositoryRoot, absoluteTarget);
  if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
    throw new Error(`Refusing to clean outside the repository: ${absoluteTarget}`);
  }
  await rm(absoluteTarget, { force: true, recursive: true });
}

console.info('Generated build and test output removed.');
