/**
 * T15 follow-up — the **Public Server Endpoint** model.
 *
 * One operator-facing concept: a single public hostname (or public IPv4) that both the client WSS
 * address and the advertised TURN URL normally derive from. This module owns the *classification*
 * half of that model — deciding whether a given TURN host is something a remote client on the
 * internet could plausibly reach, and whether this deployment even intends to serve remote clients.
 *
 * Why this exists: a real production incident. A Dedicated Server's `DISCO_VOADOR_TURN_URLS` was
 * `turn:127.0.0.1:3478` — the *client's own* loopback address, handed to every remote client
 * verbatim as their only ICE server (`turn/mint-turn-credentials.ts` passes `urls` through
 * unchanged). Every relay-dependent client failed. Nothing rejected or even noticed the value.
 *
 * The rule this module encodes is deliberately narrow: loopback/private/container-only TURN
 * addresses are **legitimate** for local development, integration tests, and genuine LAN-only
 * deployments. What is never acceptable is a deployment that clearly intends remote/internet
 * clients (`deploymentScope: 'public'`) advertising an address only reachable from the server
 * itself.
 *
 * The same classification is deliberately reimplemented in two other runtimes that cannot import
 * this module: `infrastructure/install/install-chantivo.sh` (`host_is_non_public`, a standalone
 * Bash installer that must work from a bare checkout with no Node build) and
 * `scripts/verify-infrastructure.mjs` (a plain-Node repository guard). The shared case table in
 * `tests/turn-host-classification-cases.json` is asserted against both this module and the Bash
 * implementation so the three cannot silently diverge.
 */

/** Why a host is not reachable by a remote client. `undefined` from {@link classifyTurnHost}
 * means "plausibly public" — never a positive claim that it *is* reachable, which no server can
 * determine about itself (see `cli-doctor.ts`'s external-reachability check). */
export type NonPublicHostReason =
  | 'loopback'
  | 'unspecified'
  | 'private-network'
  | 'carrier-nat'
  | 'link-local'
  | 'unique-local'
  | 'container-only-name';

const NON_PUBLIC_REASON_TEXT: Record<NonPublicHostReason, string> = {
  loopback: 'a loopback address',
  unspecified: 'an unspecified/bind-all address',
  'private-network': 'a private-network (RFC 1918) address',
  'carrier-nat': 'a carrier-grade-NAT (RFC 6598) address',
  'link-local': 'a link-local address',
  'unique-local': 'an IPv6 unique-local address',
  'container-only-name': 'a single-label name that is not publicly resolvable',
};

export function describeNonPublicReason(reason: NonPublicHostReason): string {
  return NON_PUBLIC_REASON_TEXT[reason];
}

/** `'public'` — this deployment serves remote clients over the internet. `'local'` — development,
 * integration testing, or a deliberate LAN-only deployment. */
export type DeploymentScope = 'public' | 'local';

const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u;

function classifyIpv4(host: string): NonPublicHostReason | undefined {
  const match = IPV4_PATTERN.exec(host);
  if (!match) return undefined;
  const octets = match.slice(1, 5).map((part) => Number(part));
  if (octets.some((octet) => octet > 255)) return undefined;
  const a = octets[0] ?? 0;
  const b = octets[1] ?? 0;
  if (a === 127) return 'loopback';
  if (a === 0) return 'unspecified';
  if (a === 10) return 'private-network';
  if (a === 172 && b >= 16 && b <= 31) return 'private-network';
  if (a === 192 && b === 168) return 'private-network';
  if (a === 100 && b >= 64 && b <= 127) return 'carrier-nat';
  if (a === 169 && b === 254) return 'link-local';
  return undefined;
}

/**
 * Classifies a TURN endpoint host. Returns the reason it cannot be reached by a remote client, or
 * `undefined` when the host is at least plausibly public.
 *
 * IPv6 literals are accepted either bare (`::1`) or bracketed (`[::1]`) — {@link turnUrlHost}
 * already strips brackets, but callers passing a raw host are tolerated too.
 */
export function classifyTurnHost(rawHost: string): NonPublicHostReason | undefined {
  const host = rawHost
    .trim()
    .replace(/^\[|\]$/gu, '')
    .toLowerCase();
  if (host.length === 0) return 'container-only-name';

  if (host.includes(':')) {
    // IPv6 literal.
    if (host === '::1') return 'loopback';
    if (host === '::' || host === '::0') return 'unspecified';
    if (/^f[cd][0-9a-f]{0,2}:/u.test(host)) return 'unique-local';
    if (/^fe[89ab][0-9a-f]?:/u.test(host)) return 'link-local';
    return undefined;
  }

  const ipv4Reason = classifyIpv4(host);
  if (ipv4Reason !== undefined) return ipv4Reason;
  if (IPV4_PATTERN.test(host)) return undefined; // a plausibly-public IPv4 literal

  if (host === 'localhost' || host.endsWith('.localhost')) return 'loopback';
  // `.local` is mDNS, `.internal`/`.localdomain` are private-use suffixes — none are publicly
  // resolvable, and a Docker/Compose service name (`coturn`) or container hostname has no dot at
  // all. A public deployment advertising any of these hands remote clients an address that can
  // only resolve inside the operator's own network or container.
  if (/\.(?:local|internal|localdomain|invalid|test|example)$/u.test(host)) {
    return 'container-only-name';
  }
  if (!host.includes('.')) return 'container-only-name';
  return undefined;
}

/**
 * Extracts the host from a `turn:`/`turns:` URI. RFC 7065 URIs have no `//` authority prefix
 * (`turn:host:3478?transport=udp`), but the `turn://host` spelling is tolerated because operators
 * write it and `new URL()` accepts it.
 */
export function turnUrlHost(url: string): string | undefined {
  const trimmed = url.trim();
  const schemeEnd = trimmed.indexOf(':');
  if (schemeEnd === -1) return undefined;
  const scheme = trimmed.slice(0, schemeEnd).toLowerCase();
  if (scheme !== 'turn' && scheme !== 'turns') return undefined;

  let rest = trimmed.slice(schemeEnd + 1);
  if (rest.startsWith('//')) rest = rest.slice(2);
  const queryStart = rest.indexOf('?');
  if (queryStart !== -1) rest = rest.slice(0, queryStart);
  if (rest.length === 0) return undefined;

  if (rest.startsWith('[')) {
    const close = rest.indexOf(']');
    if (close === -1) return undefined;
    return rest.slice(1, close);
  }
  const portStart = rest.indexOf(':');
  return portStart === -1 ? rest : rest.slice(0, portStart);
}

/** The default TURN listener port (`docs/references/COTURN.md`) when a URI omits one. */
export const DEFAULT_TURN_PORT = 3478;

/** Extracts the port from a `turn:`/`turns:` URI, falling back to {@link DEFAULT_TURN_PORT}. */
export function turnUrlPort(url: string): number {
  const trimmed = url.trim();
  const schemeEnd = trimmed.indexOf(':');
  if (schemeEnd === -1) return DEFAULT_TURN_PORT;

  let rest = trimmed.slice(schemeEnd + 1);
  if (rest.startsWith('//')) rest = rest.slice(2);
  const queryStart = rest.indexOf('?');
  if (queryStart !== -1) rest = rest.slice(0, queryStart);

  const afterHost = rest.startsWith('[') ? rest.slice(rest.indexOf(']') + 1) : rest;
  const portStart = afterHost.lastIndexOf(':');
  if (portStart === -1) return DEFAULT_TURN_PORT;
  const port = Number.parseInt(afterHost.slice(portStart + 1), 10);
  return Number.isInteger(port) && port > 0 && port <= 65_535 ? port : DEFAULT_TURN_PORT;
}

/**
 * Resolves this deployment's scope. An explicit `DISCO_VOADOR_DEPLOYMENT_SCOPE` always wins (an
 * operator running a deliberate LAN-only deployment can say so and never be nagged). Otherwise it
 * is inferred from the Public Server Endpoint the operator already configured
 * (`DISCO_VOADOR_SERVER_PUBLIC_HOST`): a public-looking one means remote clients are intended.
 *
 * Fails *safe*, not strict: an unset public host infers `'local'`, so an existing deployment that
 * never configured one is never newly failed by the endpoint-plausibility check. The installer
 * always writes the scope explicitly, so a fresh install never relies on this inference.
 */
export function inferDeploymentScope(
  explicitScope: DeploymentScope | undefined,
  publicHost: string | undefined,
): DeploymentScope {
  if (explicitScope !== undefined) return explicitScope;
  if (publicHost === undefined) return 'local';
  return classifyTurnHost(publicHost) === undefined ? 'public' : 'local';
}
