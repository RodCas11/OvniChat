import { access, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ignoredDirectories = new Set(['.git', 'dist', 'node_modules']);

async function findMarkdown(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolutePath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await findMarkdown(absolutePath)));
    } else if (entry.name.endsWith('.md')) {
      files.push(absolutePath);
    }
  }

  return files;
}

function localLinkTargets(markdown) {
  const targets = [];
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const rawTarget = match[1]?.trim().replace(/^<|>$/gu, '');
    if (!rawTarget || /^(?:#|https?:|mailto:)/u.test(rawTarget)) continue;
    targets.push(decodeURIComponent(rawTarget.split('#')[0] ?? ''));
  }
  return targets;
}

export async function findBrokenLinks() {
  const files = await findMarkdown(repositoryRoot);
  const broken = [];

  for (const markdownPath of files) {
    const content = await readFile(markdownPath, 'utf8');
    for (const target of localLinkTargets(content)) {
      const resolvedTarget = path.resolve(path.dirname(markdownPath), target);
      const relativeCheck = path.relative(repositoryRoot, resolvedTarget);
      const source = path.relative(repositoryRoot, markdownPath).replaceAll('\\', '/');

      if (relativeCheck.startsWith('..') || path.isAbsolute(relativeCheck)) {
        broken.push(`${source}: local link escapes repository (${target})`);
        continue;
      }

      try {
        await access(resolvedTarget);
      } catch {
        broken.push(`${source}: missing local link target (${target})`);
      }
    }
  }

  return broken;
}

export async function verifyLinks() {
  const broken = await findBrokenLinks();
  if (broken.length > 0) {
    throw new Error(`Broken Markdown links:\n- ${broken.join('\n- ')}`);
  }
}

const isEntryPoint =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  await verifyLinks();
  console.info('Local Markdown links verified.');
}
