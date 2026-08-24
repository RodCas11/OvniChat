import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const desktopDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// T13.5 — Electron Packager derives the packaged output directory/executable name from
// `package.json`'s `productName` (falling back to `name`) — never hardcoded here a second time, so
// a future rebrand cannot leave this script pointed at a stale path the way this one was found to be
// during the Chantivo rename (still referencing the pre-T13.5 `@disco-voador-desktop` name).
const { name, productName } = JSON.parse(
  readFileSync(path.join(desktopDir, 'package.json'), 'utf8'),
);
const packagedName = productName ?? name;
const exePath = path.join(desktopDir, 'out', `${packagedName}-win32-x64`, `${packagedName}.exe`);
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
