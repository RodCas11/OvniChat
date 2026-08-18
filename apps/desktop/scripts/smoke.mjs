import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exePath = path.join(
  desktopDir,
  'out',
  '@disco-voador-desktop-win32-x64',
  '@disco-voador-desktop.exe',
);
const timeoutMs = 20_000;

if (!existsSync(exePath)) {
  console.error(
    `Packaged executable not found at ${exePath}.\nRun "pnpm --filter @disco-voador/desktop run package" first.`,
  );
  process.exit(1);
}

const child = spawn(exePath, [], {
  env: { ...process.env, DISCO_VOADOR_SMOKE_TEST: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let stdout = '';
let settled = false;

const timer = setTimeout(() => {
  if (settled) return;
  settled = true;
  child.kill();
  console.error(`Smoke test timed out after ${timeoutMs}ms waiting for SMOKE_OK.`);
  process.exit(1);
}, timeoutMs);

child.stdout.on('data', (chunk) => {
  stdout += chunk.toString();
  process.stdout.write(chunk);
});

child.stderr.on('data', (chunk) => {
  process.stderr.write(chunk);
});

child.on('exit', (code) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);

  if (code === 0 && stdout.includes('SMOKE_OK')) {
    console.info('Electron smoke test passed: window created, renderer loaded, clean quit.');
    process.exit(0);
  } else {
    console.error(
      `Electron smoke test failed (exit code ${String(code)}, SMOKE_OK seen: ${stdout.includes('SMOKE_OK')}).`,
    );
    process.exit(1);
  }
});
