import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);
const productionConfig = 'infrastructure/coturn/turnserver.conf.example';
const developmentConfig = 'infrastructure/coturn/turnserver.dev.conf.example';
const reverseProxyTemplate = 'infrastructure/reverse-proxy/Caddyfile.example';

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

// caddyfileViolationsForSource: production finding (beta.chantivo.app served /healthz and /readyz
// publicly through Caddy — internal operational endpoints exposed to anyone on the internet). Asserts
// the reverse-proxy template blocks both paths BEFORE the reverse_proxy catch-all, in
// matcher -> respond -> reverse_proxy order, and that the catch-all itself stays unconditional (never
// wrapped by the blocking matcher) — the real WebSocket upgrade path this whole product depends on
// must keep reaching the backend for every path except exactly /healthz and /readyz. Operates on the
// same active-line (non-comment, non-blank) text used for the Coturn checks above, so a reviewer
// reading a plain-language explanatory comment never trips this check.
export function caddyfileViolationsForSource(content, source) {
  const violations = [];
  const lines = activeDirectives(content);

  const matcherIndex = lines.findIndex((line) =>
    /^@\S+\s+path\s+\/healthz\s+\/readyz$/u.test(line),
  );
  if (matcherIndex === -1) {
    violations.push(
      `${source}: missing a named matcher blocking /healthz and /readyz (expected "@<name> path /healthz /readyz")`,
    );
  }
  const matcherName = matcherIndex === -1 ? null : lines[matcherIndex].split(/\s+/u)[0];

  const respondIndex = matcherName
    ? lines.findIndex((line) => line === `respond ${matcherName} 404`)
    : -1;
  if (matcherName && respondIndex === -1) {
    violations.push(
      `${source}: missing "respond ${matcherName} 404" blocking the health-check matcher before it reaches the backend`,
    );
  }

  const reverseProxyIndex = lines.findIndex((line) => line === 'reverse_proxy 127.0.0.1:8090');
  if (reverseProxyIndex === -1) {
    violations.push(
      `${source}: missing the unconditional "reverse_proxy 127.0.0.1:8090" catch-all (must not be scoped to a matcher — every path except /healthz and /readyz, including the WebSocket upgrade path, must keep reaching the backend)`,
    );
  }

  if (
    matcherIndex !== -1 &&
    respondIndex !== -1 &&
    reverseProxyIndex !== -1 &&
    !(matcherIndex < respondIndex && respondIndex < reverseProxyIndex)
  ) {
    violations.push(
      `${source}: /healthz and /readyz must be blocked BEFORE the reverse_proxy catch-all (expected matcher -> respond 404 -> reverse_proxy order)`,
    );
  }

  return violations;
}

// --- Self-hosting sovereignty guards ----------------------------------------------------------------
//
// Chantivo has no central service. `beta.chantivo.app` is ONE operator's (Chantivo's own) beta
// Dedicated Server; Chantivo-operated infrastructure may serve the website, docs, and release
// downloads and NOTHING else. Every self-hosted install owns its own Dedicated Server, its own
// Coturn, and its own TURN traffic. These guards make that structural rather than cultural: a
// default, fallback, or template value pointing any other installation at Chantivo-operated
// infrastructure fails the repository gate.
//
// Deliberately permitted, because they are correct and expected: documentation (`docs/**`, any
// `*.md`), test fixtures that specifically exercise hostname/address parsing against that real host,
// and explanatory comments recording real verification history against it. What is forbidden is an
// EFFECTIVE value — an assignment, string literal, or template substitution that a running
// deployment could actually use.
const CENTRAL_OPERATOR_HOST = 'beta.chantivo.app';

// This guard's own implementation has to name the host it forbids, and verify-infrastructure.mjs is
// itself a scanned production path. Explicit, minimal, and the only entry allowed here.
const CENTRAL_HOST_SELF_REFERENCES = new Set(['scripts/verify-infrastructure.mjs']);

const SCANNED_PREFIXES = ['infrastructure/', 'scripts/', 'services/', 'packages/', 'apps/'];
const SCANNED_EXTENSIONS = new Set([
  '',
  '.cjs',
  '.conf',
  '.css',
  '.env',
  '.example',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.mjs',
  '.sh',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml',
]);

/**
 * A production runtime/default/template code path: something a real deployment executes or reads.
 * Documentation and tests are deliberately excluded — both legitimately reference real hosts and
 * real broken values, and neither is a value any deployment consumes.
 */
export function isProductionCodePath(relativePath) {
  const normalized = relativePath.replaceAll('\\', '/');
  if (normalized.startsWith('docs/') || normalized.startsWith('tests/')) return false;
  if (normalized.endsWith('.md')) return false;
  if (normalized.includes('node_modules/')) return false;
  if (normalized.startsWith('dist/') || normalized.includes('/dist/')) return false;
  if (!SCANNED_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return false;
  return SCANNED_EXTENSIONS.has(path.extname(normalized));
}

/** Strips comments so a guard sees only text a runtime would actually act on. Conservative by
 * design: an over-strip hides a violation (a false negative, caught by review) while an under-strip
 * would fail the gate on a perfectly legitimate explanatory comment. */
function effectiveSource(relativePath, content) {
  const extension = path.extname(relativePath.replaceAll('\\', '/'));
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    return content.replaceAll(/\/\*[\s\S]*?\*\//gu, ' ').replaceAll(/(^|[^:])\/\/.*$/gmu, '$1');
  }
  // Shell, YAML, env, conf, and extension-less scripts all use `#`. Anchored to line start or
  // whitespace so `${var#prefix}` and `$#` are not mistaken for comments.
  return content.replaceAll(/(^|\s)#.*$/gmu, '$1');
}

export function centralEndpointViolationsForSource(relativePath, content) {
  const normalized = relativePath.replaceAll('\\', '/');
  if (!isProductionCodePath(normalized)) return [];
  if (CENTRAL_HOST_SELF_REFERENCES.has(normalized)) return [];

  const violations = [];
  // A turn:/turns:/stun: URL for the Chantivo-operated host is never acceptable in a production
  // path — not even commented out, since a commented-out default is one uncomment away from being a
  // real one, and there is no legitimate reason to write that URL in installer/config/template code.
  if (
    new RegExp(
      `\\b(?:turns?|stuns?):(?://)?${CENTRAL_OPERATOR_HOST.replaceAll('.', '\\.')}\\b`,
      'iu',
    ).test(content)
  ) {
    violations.push(
      `${normalized}: contains a TURN/STUN URL for the Chantivo-operated host ${CENTRAL_OPERATOR_HOST}. Chantivo runs no central relay: every self-hosted install uses its own Coturn. Use voice.example.com in examples.`,
    );
  }
  if (effectiveSource(normalized, content).includes(CENTRAL_OPERATOR_HOST)) {
    violations.push(
      `${normalized}: uses ${CENTRAL_OPERATOR_HOST} as an effective value (default, fallback, or template) in a production code path. That host is one operator's own beta server, never a default for anyone else's deployment. Mentioning it in a comment or in docs/ is fine; using it is not.`,
    );
  }
  return violations;
}

/**
 * A `DISCO_VOADOR_TURN_URLS` default/template that hands remote clients an address only the server
 * itself can reach — the exact production incident this guard exists for (`turn:127.0.0.1:3478`
 * advertised to every client). Third copy of the classification in
 * `services/dedicated-server/src/turn/public-endpoint.ts` and `install-chantivo.sh`'s
 * `host_is_non_public`; the shared case table in `tests/turn-host-classification-cases.json` keeps
 * them aligned.
 */
export function nonPublicTurnHost(host) {
  const value = host
    .trim()
    .replaceAll(/^\[|\]$/gu, '')
    .toLowerCase();
  if (value.length === 0) return true;
  if (value.includes(':')) {
    return value === '::1' || value === '::' || /^f[cd]/u.test(value) || /^fe[89ab]/u.test(value);
  }
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(value);
  if (ipv4) {
    const a = Number(ipv4[1]);
    const b = Number(ipv4[2]);
    if (a === 127 || a === 0 || a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (value === 'localhost' || value.endsWith('.localhost')) return true;
  if (/\.(?:local|internal|localdomain|invalid|test|example)$/u.test(value)) return true;
  return !value.includes('.');
}

export function turnUrlDefaultViolationsForSource(relativePath, content) {
  const normalized = relativePath.replaceAll('\\', '/');
  if (!isProductionCodePath(normalized)) return [];

  const violations = [];
  const assignment = /DISCO_VOADOR_TURN_URLS\s*[=:]\s*['"]?(turns?:[^'"\s,;)]+)/giu;
  for (const match of effectiveSource(normalized, content).matchAll(assignment)) {
    const url = match[1];
    // A printf/shell/template placeholder (`turn:%s:3478`, `turn:${host}:3478`, `turn:<host>:3478`)
    // is not a value — the substituted result is what matters, and that is what the installer's own
    // resolve_turn_url and its tests cover.
    if (/[%${}<>]/u.test(url)) continue;
    const host = url
      .slice(url.indexOf(':') + 1)
      .replace(/^\/\//u, '')
      .split(/[?]/u)[0];
    const bare = host.startsWith('[')
      ? host.slice(1, host.indexOf(']'))
      : (host.split(':')[0] ?? '');
    if (nonPublicTurnHost(bare)) {
      violations.push(
        `${normalized}: sets DISCO_VOADOR_TURN_URLS to ${url}, which no remote client can reach ("${bare}" is loopback/private/container-only). This value is handed to every client verbatim. Use voice.example.com in examples; a real deployment's value comes from install-chantivo.sh's resolve_turn_url.`,
      );
    }
  }
  return violations;
}

async function scannedRepositoryFiles() {
  const { stdout } = await execFileAsync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: repositoryRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  return stdout
    .split('\0')
    .filter(Boolean)
    .map((entry) => entry.replaceAll('\\', '/'))
    .filter((entry) => isProductionCodePath(entry));
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

  const reverseProxyContent = await readFile(
    path.join(repositoryRoot, reverseProxyTemplate),
    'utf8',
  );
  violations.push(...caddyfileViolationsForSource(reverseProxyContent, reverseProxyTemplate));

  for (const relativePath of await scannedRepositoryFiles()) {
    let content;
    try {
      content = await readFile(path.join(repositoryRoot, relativePath), 'utf8');
    } catch {
      // Deleted-but-still-listed, or unreadable — nothing to scan, and not this guard's concern.
      continue;
    }
    // An extension-less binary file is the only kind that can reach here; not text to scan.
    if (content.includes(String.fromCharCode(0))) continue;
    violations.push(...centralEndpointViolationsForSource(relativePath, content));
    violations.push(...turnUrlDefaultViolationsForSource(relativePath, content));
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
