import { spawn, type ChildProcessByStdio } from 'node:child_process';
import type { Readable } from 'node:stream';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  generateIdentityKeyPair,
  signWithIdentityKey,
  type IdentityKeyPair,
} from '@disco-voador/identity';
import { buildIdentityAuthPayload, CURRENT_PROTOCOL_VERSION } from '@disco-voador/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

/**
 * T15 security-fix regression: proves the leak this task fixes is genuinely gone, at the level the
 * real vulnerability lived at — real OS-level process stdout/stderr, not an in-process mock. Every
 * other Dedicated Server test in this suite calls `createDedicatedServer` directly and injects a
 * `Logger`/omits one entirely (`createNoopLogger()`), which never exercises the actual `console.info`/
 * `console.error` call sites `cli.ts`'s `printStartupBanner` and `@disco-voador/realtime`'s
 * `createLogger` use — exactly the call sites systemd/Docker capture wholesale into
 * `journalctl -u chantivo-server` / `docker compose logs`. This file spawns the real, unmodified
 * product entrypoints (`services/dedicated-server/src/cli.ts` and `src/cli-admin-token.ts`) as real
 * child OS processes with piped stdio via `tsx` (already present in this monorepo's own
 * `node_modules`, no new dependency added) — running the exact current TypeScript source, not a
 * possibly-stale prebuilt `dist/` (this repo's own `pnpm check` runs `vitest run` *before* `tsc -b`,
 * so a stale/absent `dist` cannot be relied on here) — and inspects the exact bytes each process
 * wrote to fd 1/2, the same stream `journalctl`/`docker compose logs` would have captured.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const tsxCliEntry = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const dedicatedServerCliEntry = path.join(
  repoRoot,
  'services',
  'dedicated-server',
  'src',
  'cli.ts',
);
const adminTokenCliEntry = path.join(
  repoRoot,
  'services',
  'dedicated-server',
  'src',
  'cli-admin-token.ts',
);

if (!existsSync(tsxCliEntry)) {
  throw new Error(
    `tsx CLI entry not found at ${tsxCliEntry} — this repo's own node_modules is expected to ` +
      'already contain it (transitively). If this ever legitimately stops being true, this test ' +
      'needs a different real-process-spawn mechanism, not a skip.',
  );
}

/** Any bearer capability token this codebase's `token-crypto.ts` could ever generate —
 * `DV-<KIND>-<43-char base64url>` (privilege/invite; the leaked 'bootstrap' kind this task removes
 * is exactly this same shape too, so this pattern would have caught the original bug). Deliberately
 * broad (any `[A-Z]+` kind, not just `PRIV`) so this structurally proves "no bearer token of any
 * kind ever appears," not merely "the one specific kind this test happens to mint." */
const TOKEN_SHAPE_PATTERN = /DV-[A-Z]+-[A-Za-z0-9_-]{20,}/gu;

interface CapturedProcess {
  readonly child: ChildProcessByStdio<null, Readable, Readable>;
  stdout(): string;
  stderr(): string;
}

function spawnCapturing(scriptPath: string, env: NodeJS.ProcessEnv): CapturedProcess {
  const child = spawn(process.execPath, [tsxCliEntry, scriptPath], {
    cwd: path.dirname(scriptPath),
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString('utf8');
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString('utf8');
  });
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
  };
}

function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs = 15_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const timer = setInterval(() => {
      if (predicate()) {
        clearInterval(timer);
        resolve();
        return;
      }
      if (Date.now() - start > timeoutMs) {
        clearInterval(timer);
        reject(new Error(`Timed out waiting for: ${description}`));
      }
    }, 25);
  });
}

function waitForExit(
  child: ChildProcessByStdio<null, Readable, Readable>,
  timeoutMs = 15_000,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('Timed out waiting for process exit'));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

function baseEnv(dataDir: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    ...process.env,
    REALTIME_HOST: '127.0.0.1',
    REALTIME_PORT: '0',
    LOG_LEVEL: 'debug', // maximal logger chatter — the biggest possible surface for a leak to hide in
    DISCO_VOADOR_SERVER_CONFIG_PATH: path.join(repoRoot, 'does-not-exist.json'),
    DISCO_VOADOR_SERVER_DATA_DIR: dataDir,
    ...overrides,
  };
}

// --- Minimal real-protocol client (redeem-only) ---------------------------------------------------

function nextMessages(
  ws: WebSocket,
  count: number,
  timeoutMs = 5000,
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    const collected: Record<string, unknown>[] = [];
    const timer = setTimeout(() => {
      ws.off('message', handleMessage);
      reject(new Error(`Timed out waiting for ${String(count)} messages`));
    }, timeoutMs);

    function handleMessage(data: Buffer): void {
      collected.push(JSON.parse(data.toString('utf8')) as Record<string, unknown>);
      if (collected.length >= count) {
        clearTimeout(timer);
        ws.off('message', handleMessage);
        resolve(collected);
      }
    }

    ws.on('message', handleMessage);
  });
}

function nextMessage(ws: WebSocket, timeoutMs = 5000): Promise<Record<string, unknown>> {
  return nextMessages(ws, 1, timeoutMs).then((messages) => messages[0] as Record<string, unknown>);
}

async function redeemTokenOverRealSocket(url: string, token: string): Promise<void> {
  const ws = new WebSocket(url);
  try {
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });

    const keyPair: IdentityKeyPair = generateIdentityKeyPair();
    const challengeReceived = nextMessage(ws);
    ws.send(
      JSON.stringify({
        type: 'client:hello',
        id: 'hello-1',
        protocolVersion: CURRENT_PROTOCOL_VERSION,
        client: { name: 'token-leak-regression-test', version: '0.0.0' },
        nickname: 'Redeemer',
        publicKey: keyPair.publicKey,
      }),
    );
    const challenge = await challengeReceived;

    const payload = buildIdentityAuthPayload({
      protocolVersion: CURRENT_PROTOCOL_VERSION,
      connectionId: challenge['connectionId'] as string,
      nonce: challenge['nonce'] as string,
      expiresAt: challenge['expiresAt'] as number,
      publicKey: keyPair.publicKey,
      nickname: 'Redeemer',
    });
    const signature = signWithIdentityKey(keyPair.privateKey, keyPair.publicKey, payload);

    // server:hello, server:authorization-state, voice:catalog, server:presence-snapshot,
    // server:profile-self-updated — the standard five-message post-`ready` burst, all sent
    // back-to-back in one synchronous server-side loop, so one persistent listener registered
    // *before* sending the proof is required (matching every other integration test in this suite).
    const readyBurst = nextMessages(ws, 5);
    ws.send(JSON.stringify({ type: 'client:identity-proof', id: 'proof-1', signature }));
    await readyBurst;

    const redeemed = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'client:authorization-redeem-token', id: 'redeem-1', token }));
    const result = await redeemed;
    expect(result).toMatchObject({ type: 'server:authorization-token-redeemed' });

    // One more deterministic round trip, so any logging the server does as a *result* of this
    // redemption (not just the redemption reply itself) has had a chance to actually happen before
    // this function returns and the caller inspects the server's captured output.
    const pong = nextMessage(ws);
    ws.send(JSON.stringify({ type: 'client:ping', id: 'flush-1' }));
    await pong;
  } finally {
    ws.close();
  }
}

describe('T15 token-leak regression — real spawned processes, real stdio capture', () => {
  const tempDirs: string[] = [];
  const children: ChildProcessByStdio<null, Readable, Readable>[] = [];

  afterEach(async () => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await waitForExit(child, 5000).catch(() => undefined);
      }
    }
    for (const dir of tempDirs.splice(0)) {
      // Windows-observed flake: a just-killed child process can hold its data-directory handle open
      // for a brief moment after `exit` fires, racing a bare `rmSync` with `EPERM`. `maxRetries`/
      // `retryDelay` are `fs.rmSync`'s own documented mechanism for exactly this class of transient
      // Windows file-lock error — no custom retry loop needed. A first attempt at 5x100ms still
      // flaked under real load (multiple vitest worker processes competing for disk/AV scan time),
      // so this widens the total retry window to ~3s (10x300ms) rather than reaching for a custom
      // backoff scheme on top of the platform's own documented retry mechanism.
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    }
  });

  function trackTempDir(): string {
    const dir = mkdtempSync(path.join(tmpdir(), 'dv-token-leak-'));
    tempDirs.push(dir);
    return dir;
  }

  it(
    "a fresh server's real stdout/stderr never contain a bearer token, and the admin token minted " +
      "by a separate 'admin-token create' process is genuinely absent from the running server's own " +
      'captured output even after it is redeemed against that same server',
    async () => {
      const dataDir = trackTempDir();
      const server = spawnCapturing(dedicatedServerCliEntry, baseEnv(dataDir));
      children.push(server.child);

      await waitUntil(
        () => server.stdout().includes('Ready.'),
        'the fresh server to report "Ready."',
      );

      // The safe, non-secret hint block — proves `hasAnyServerAdmin` correctly reports "unclaimed"
      // on a genuinely fresh store, and that the operator is told what to run instead of being
      // handed a raw credential.
      expect(server.stdout()).toContain('No administrator has claimed this server yet.');
      expect(server.stdout()).toContain('chantivo-server admin-token create');

      // The core claim: no bearer-token-shaped string anywhere in this real process's own stdout or
      // stderr, at any point since it started, despite LOG_LEVEL=debug maximizing logger output.
      expect(server.stdout()).not.toMatch(TOKEN_SHAPE_PATTERN);
      expect(server.stderr()).not.toMatch(TOKEN_SHAPE_PATTERN);

      const listeningMatch = /Listening:\s+([\d.]+):(\d+)/u.exec(server.stdout());
      if (!listeningMatch) throw new Error("could not parse the server's Listening: line");
      const url = `ws://${listeningMatch[1]}:${listeningMatch[2]}`;

      // A genuinely separate, one-shot OS process — the ONLY place a raw admin credential is ever
      // allowed to be printed post-T15 — targeting the exact same data directory as the still-running
      // server above.
      const minter = spawnCapturing(adminTokenCliEntry, baseEnv(dataDir));
      children.push(minter.child);
      const minterExitCode = await waitForExit(minter.child);
      expect(minterExitCode).toBe(0);

      const mintedMatch = /DV-PRIV-[A-Za-z0-9_-]+/u.exec(minter.stdout());
      if (!mintedMatch) {
        throw new Error(
          `'admin-token create' produced no token on its own stdout:\n${minter.stdout()}`,
        );
      }
      const mintedToken = mintedMatch[0];
      // Positive proof this mechanism DOES work — the CLI's own stdout genuinely receives the raw
      // token exactly once, as designed.
      expect(minter.stdout()).toContain(mintedToken);

      // Redeem the exact minted token over the real protocol against the still-running server.
      await redeemTokenOverRealSocket(url, mintedToken);

      // The critical cross-process assertion: this exact, known token value — proven above to have
      // been minted and to have been successfully redeemed against this very server — must be
      // genuinely absent from the running server's own accumulated stdout AND stderr. Not "the word
      // token is absent" — the literal secret value itself.
      expect(server.stdout()).not.toContain(mintedToken);
      expect(server.stderr()).not.toContain(mintedToken);
      // Re-assert the structural (shape-based) claim too, now that a real redemption has actually
      // happened against this server — proves the redemption path itself (not just startup) never
      // echoes a token back into this process's own output either.
      expect(server.stdout()).not.toMatch(TOKEN_SHAPE_PATTERN);
      expect(server.stderr()).not.toMatch(TOKEN_SHAPE_PATTERN);
    },
    30_000,
  );

  it('a server restarted after its admin has already claimed it never repeats the "unclaimed" hint', async () => {
    const dataDir = trackTempDir();

    const first = spawnCapturing(dedicatedServerCliEntry, baseEnv(dataDir));
    children.push(first.child);
    await waitUntil(() => first.stdout().includes('Ready.'), 'the first boot to report "Ready."');
    expect(first.stdout()).toContain('No administrator has claimed this server yet.');

    const firstListening = /Listening:\s+([\d.]+):(\d+)/u.exec(first.stdout());
    if (!firstListening) throw new Error("could not parse the first server's Listening: line");
    const firstUrl = `ws://${firstListening[1]}:${firstListening[2]}`;

    const minter = spawnCapturing(adminTokenCliEntry, baseEnv(dataDir));
    children.push(minter.child);
    await waitForExit(minter.child);
    const mintedMatch = /DV-PRIV-[A-Za-z0-9_-]+/u.exec(minter.stdout());
    if (!mintedMatch) throw new Error('admin-token create produced no token');
    await redeemTokenOverRealSocket(firstUrl, mintedMatch[0]);

    first.child.kill();
    await waitForExit(first.child);
    // Node documents that Windows has no real POSIX signal delivery: a cross-process
    // `child.kill()` unconditionally force-terminates the child rather than letting its own
    // `process.on('SIGTERM', ...)` graceful-shutdown handler run — the same limitation this repo's
    // own `services/dedicated-server/scripts/smoke.mjs` already documents. `cli.ts`'s graceful lock
    // release is directly verified elsewhere in this suite by calling `stop()` in-process, without
    // going through OS signal delivery at all; this test only cares whether the persisted admin
    // claim survives a restart, so a stale lock file (a forced-kill artifact, not a T15 concern) is
    // removed explicitly here rather than depended on to have been released gracefully.
    rmSync(path.join(dataDir, '.lock'), { force: true });

    const second = spawnCapturing(dedicatedServerCliEntry, baseEnv(dataDir));
    children.push(second.child);
    await waitUntil(
      () => second.stdout().includes('Ready.'),
      'the restarted, already-claimed server to report "Ready."',
    );

    // The whole point of gating on `hasAnyServerAdmin`, not "is this the first-ever process
    // lifetime": an operator who already claimed their server must never see this hint again, on
    // any later restart.
    expect(second.stdout()).not.toContain('No administrator has claimed this server yet.');
    expect(second.stdout()).not.toMatch(TOKEN_SHAPE_PATTERN);
    expect(second.stderr()).not.toMatch(TOKEN_SHAPE_PATTERN);
  }, 30_000);
});
