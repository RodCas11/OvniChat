import { spawn, type ChildProcessByStdio } from 'node:child_process';
import http from 'node:http';
import { createServer } from 'node:net';
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

/** Reserves a real, currently-free TCP port on loopback by binding a throwaway probe socket to
 * port 0 (the OS picks one and guarantees it's free at the moment of binding — the only way to
 * learn one without a race against the OS's own port allocator), reading back what it bound to,
 * then closing it immediately so the real server process can bind the same number itself.
 *
 * CI-flake root cause (T15.1): the previous readiness check learned the server's port by parsing
 * it out of the child's own piped stdout — which meant readiness detection was ALWAYS gated on
 * that stdout data actually arriving in this process's readable-stream buffer, a step with no
 * bound of its own. Reserving the port here up front means readiness can be checked with a real
 * HTTP request to a known address, completely independent of the child's stdout pipe timing. */
function reserveEphemeralPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (address === null || typeof address === 'string') {
        probe.close(() => {
          reject(new Error('Could not determine an ephemeral port from a bound probe socket'));
        });
        return;
      }
      const { port } = address;
      probe.close((closeErr) => {
        if (closeErr) reject(closeErr);
        else resolve(port);
      });
    });
  });
}

/** Polls the Dedicated Server's own real `/readyz` HTTP endpoint — the same endpoint
 * `chantivo-server doctor`/Docker health checks/the installer's own readiness wait already treat
 * as the authoritative "is this server actually serving requests" signal (T14/T15) — instead of
 * waiting for a specific line of banner text to show up in captured stdout. A real HTTP 200
 * response can only happen once the server's own HTTP/WebSocket listener is genuinely bound and
 * answering, which is a strictly stronger readiness claim than "some bytes arrived on a pipe." */
function pollReadyz(host: string, port: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let lastFailureReason = 'no attempt made yet';

    const attempt = (): void => {
      const req = http.get({ host, port, path: '/readyz', timeout: 2000 }, (res) => {
        res.resume(); // drain the body — we only care about the status code here
        res.on('end', () => {
          if (res.statusCode === 200) {
            resolve();
          } else {
            lastFailureReason = `HTTP ${String(res.statusCode)}`;
            scheduleRetry();
          }
        });
      });
      req.on('error', (err: Error) => {
        // ECONNREFUSED is the expected, normal case while the server hasn't bound the port yet —
        // not a real failure, just "not ready yet."
        lastFailureReason = err.message;
        scheduleRetry();
      });
      req.on('timeout', () => {
        req.destroy();
        lastFailureReason = 'request timed out';
        scheduleRetry();
      });
    };

    const scheduleRetry = (): void => {
      if (Date.now() >= deadline) {
        reject(
          new Error(
            `Timed out waiting for http://${host}:${String(port)}/readyz to respond 200 ` +
              `within ${String(timeoutMs)}ms (last failure: ${lastFailureReason})`,
          ),
        );
        return;
      }
      setTimeout(attempt, 100);
    };

    attempt();
  });
}

/** Strips anything token-shaped before it can ever reach a test failure message — this file's own
 * job is proving tokens never leak, so its OWN diagnostics must never become a second leak path if
 * a real regression ever put one in the captured output right as a readiness timeout occurred. */
function redactTokens(text: string): string {
  return text.replace(TOKEN_SHAPE_PATTERN, '[REDACTED-TOKEN-SHAPED-VALUE]');
}

const DIAGNOSTIC_TAIL_LENGTH = 2000;

/** Safe, bounded failure diagnostics for a readiness timeout — exit status, liveness, and a
 * redacted tail of each stream, never the raw captured output and never a credential. */
function describeProcessForDiagnostics(server: CapturedProcess): string {
  const child = server.child;
  const alive = child.exitCode === null && child.signalCode === null;
  const stdoutTail = redactTokens(server.stdout()).slice(-DIAGNOSTIC_TAIL_LENGTH);
  const stderrTail = redactTokens(server.stderr()).slice(-DIAGNOSTIC_TAIL_LENGTH);
  return [
    `process alive: ${String(alive)}`,
    `exit code: ${child.exitCode === null ? 'n/a (still running or killed by signal)' : String(child.exitCode)}`,
    `signal: ${child.signalCode ?? 'n/a'}`,
    `--- stdout tail (last ${String(DIAGNOSTIC_TAIL_LENGTH)} chars, token-shaped values redacted) ---`,
    stdoutTail.length > 0 ? stdoutTail : '(empty)',
    `--- stderr tail (last ${String(DIAGNOSTIC_TAIL_LENGTH)} chars, token-shaped values redacted) ---`,
    stderrTail.length > 0 ? stderrTail : '(empty)',
  ].join('\n');
}

/** Reserves a port, spawns the real Dedicated Server against it, and waits for genuine readiness
 * via a real `/readyz` poll — replacing the previous stdout-text-matching wait entirely. On
 * failure, throws with the safe diagnostic context this file's own leak-detection purpose requires
 * (never the raw un-redacted output, which could theoretically contain a leaked token during
 * exactly the failure this file exists to catch). */
async function spawnServerAndWaitUntilReady(
  dataDir: string,
  readyTimeoutMs = 25_000,
): Promise<{ server: CapturedProcess; port: number; url: string }> {
  const port = await reserveEphemeralPort();
  const server = spawnCapturing(
    dedicatedServerCliEntry,
    baseEnv(dataDir, { REALTIME_PORT: String(port) }),
  );
  try {
    await pollReadyz('127.0.0.1', port, readyTimeoutMs);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Dedicated Server never became ready on 127.0.0.1:${String(port)}: ${reason}\n` +
        describeProcessForDiagnostics(server),
      { cause: err },
    );
  }
  return { server, port, url: `ws://127.0.0.1:${String(port)}` };
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
      // Windows file-lock error — no custom retry loop needed. Even a generous retry window
      // (10x300ms, ~3s) has been observed to still occasionally lose this race specifically under
      // real full-suite parallel load (many vitest worker processes competing for disk/AV-scan time
      // at once — reproduced: 10/10 clean in isolation, still occasionally flaked as part of the
      // full `pnpm check` run). The child process itself is already confirmed gone by this point
      // (killed and awaited above) — what's left is best-effort deletion of this test's own
      // throwaway temp directory (unique per run via `mkdtempSync`, contains no real user data, and
      // the OS reclaims `%TEMP%` on its own regardless). Treat a cleanup failure here as a logged
      // warning, never a reason to fail the whole suite over an unrelated test's OS-level timing.
      try {
        rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch (err) {
        console.warn(
          `token-leak-regression.test.ts: best-effort cleanup of temp dir ${dir} failed ` +
            `(non-fatal — the OS will reclaim it): ${err instanceof Error ? err.message : String(err)}`,
        );
      }
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
      const { server, url } = await spawnServerAndWaitUntilReady(dataDir);
      children.push(server.child);

      // Real service readiness (the /readyz poll above) is a strictly stronger claim than "the
      // banner text arrived," but the banner is still expected to be there — `cli.ts`'s
      // `printStartupBanner` runs synchronously right after `server.start()` resolves, so by the
      // time /readyz is genuinely answering, this text should already be in the captured stdout.
      // Waiting here too (bounded, real-process timing can still lag stdout-pipe delivery by a
      // moment even after the port itself is live) turns "should already be there" into a real,
      // non-flaky assertion instead of an unbounded hope.
      await waitUntil(
        () => server.stdout().includes('No administrator has claimed this server yet.'),
        'the fresh server\'s startup banner to show the safe "unclaimed" hint',
      );
      expect(server.stdout()).toContain('chantivo-server admin-token create');

      // The core claim: no bearer-token-shaped string anywhere in this real process's own stdout or
      // stderr, at any point since it started, despite LOG_LEVEL=debug maximizing logger output.
      expect(server.stdout()).not.toMatch(TOKEN_SHAPE_PATTERN);
      expect(server.stderr()).not.toMatch(TOKEN_SHAPE_PATTERN);

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
    45_000,
  );

  it('a server restarted after its admin has already claimed it never repeats the "unclaimed" hint', async () => {
    const dataDir = trackTempDir();

    const first0 = await spawnServerAndWaitUntilReady(dataDir);
    const first = first0.server;
    const firstUrl = first0.url;
    children.push(first.child);
    await waitUntil(
      () => first.stdout().includes('No administrator has claimed this server yet.'),
      'the first boot\'s startup banner to show the safe "unclaimed" hint',
    );

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

    // A fresh reserved port for the restarted instance — simpler and safer than reusing the exact
    // same number immediately after a forceful kill (avoids any OS-level TIME_WAIT/socket-linger
    // ambiguity on that specific port, at the trivial cost of one more ephemeral-port reservation).
    const { server: second } = await spawnServerAndWaitUntilReady(dataDir);
    children.push(second.child);
    await waitUntil(
      () => second.stdout().includes('Ready.'),
      "the restarted, already-claimed server's startup banner to appear",
    );

    // The whole point of gating on `hasAnyServerAdmin`, not "is this the first-ever process
    // lifetime": an operator who already claimed their server must never see this hint again, on
    // any later restart.
    expect(second.stdout()).not.toContain('No administrator has claimed this server yet.');
    expect(second.stdout()).not.toMatch(TOKEN_SHAPE_PATTERN);
    expect(second.stderr()).not.toMatch(TOKEN_SHAPE_PATTERN);
  }, 45_000);
});
