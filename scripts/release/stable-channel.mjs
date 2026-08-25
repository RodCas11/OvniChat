import {
  INSTALLER_FILENAME,
  MANIFEST_FILENAME,
  isValidReleaseVersion,
} from './resolve-release-metadata.mjs';

/**
 * T15.1 — `channels/stable.json` is the ONLY mutable "which version should a new install get?" pointer
 * in the distribution bucket, and the only thing the promote workflow writes besides the canonical
 * bootstrap installer. It deliberately carries no download logic, no signature scheme, and no
 * server-side behavior: it names a version and where that version's immutable directory lives, and
 * nothing else. Everything a client actually trusts (the artifact checksums) lives in the immutable
 * `release-manifest.json`/`SHA256SUMS` it points at, which promotion has already verified.
 *
 * Distribution-only, by design: `downloads.chantivo.app` serves release bytes. It is never a
 * signaling server, never a relay, never a registry of deployments, and no Chantivo deployment
 * contacts it at runtime — a self-hosted server that never downloads an update never talks to it at
 * all. See docs/SECURITY.md and ADR 0010 for why that boundary is absolute.
 */

export const STABLE_CHANNEL_SCHEMA_VERSION = 1;

export class StableChannelError extends Error {
  constructor(message) {
    super(message);
    this.name = 'StableChannelError';
  }
}

/**
 * Exactly ONE Chantivo-operated hostname serves releases. Every other host under the project's own
 * domain is something else entirely — the website, documentation, or one operator's own running
 * Dedicated Server — and pointing the published stable channel at any of them would bake a wrong (and,
 * in the Dedicated Server case, sovereignty-violating) download location into every new install.
 *
 * Stated as "the distribution host, or not this project's domain at all" rather than as a denylist of
 * specific hosts: a denylist has to be kept in sync with reality forever, and it would also mean this
 * production code path literally contains the address of a Chantivo-operated deployment, which
 * `scripts/verify-infrastructure.mjs` correctly forbids repository-wide. Any hostname outside this
 * project's domain — an operator's own mirror, an internal artifact host, a test double — passes
 * freely, which is the point.
 */
const DISTRIBUTION_HOST = 'downloads.chantivo.app';
const PROJECT_DOMAIN = 'chantivo.app';

/**
 * A release base URL must be a plain, absolute, HTTPS origin+path with no query, no fragment, no
 * credentials, and no trailing slash. Anything else either cannot be safely string-joined with a
 * filename or is a sign someone pasted the wrong kind of URL (a GitHub raw link, a presigned URL with
 * an embedded token) into a value that gets published to the public internet.
 */
export function normalizePublicBaseUrl(candidate) {
  if (typeof candidate !== 'string' || candidate.trim().length === 0) {
    throw new StableChannelError(
      'A public base URL is required (e.g. https://downloads.chantivo.app).',
    );
  }
  const value = candidate.trim();
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new StableChannelError(`"${value}" is not a valid absolute URL.`);
  }
  if (url.protocol !== 'https:') {
    throw new StableChannelError(
      `Release base URL must be https, got "${url.protocol}//". Release bytes are verified by SHA-256 either way, but a plaintext base URL leaks which version an operator is installing and invites a downgrade-by-interception attempt on the pointer itself.`,
    );
  }
  if (url.username || url.password) {
    throw new StableChannelError('Release base URL must not embed credentials.');
  }
  if (url.search || url.hash) {
    throw new StableChannelError(
      'Release base URL must not carry a query string or fragment — it is joined with filenames, not used as-is.',
    );
  }
  const host = url.hostname.toLowerCase();
  const isProjectHost = host === PROJECT_DOMAIN || host.endsWith(`.${PROJECT_DOMAIN}`);
  if (isProjectHost && host !== DISTRIBUTION_HOST) {
    throw new StableChannelError(
      `${host} is Chantivo-operated infrastructure that is not the release distribution point. Only ${DISTRIBUTION_HOST} serves releases; any other host under ${PROJECT_DOMAIN} is the website or one operator's own Dedicated Server, and must never appear in a published channel pointer. A mirror on your own domain is fine.`,
    );
  }
  const normalizedPath = url.pathname.replace(/\/+$/u, '');
  return `${url.origin}${normalizedPath}`;
}

export function buildStableChannel({ version, publicBaseUrl }) {
  if (!isValidReleaseVersion(version)) {
    throw new StableChannelError(
      `"${version}" is not a plain MAJOR.MINOR.PATCH version; refusing to point the stable channel at it.`,
    );
  }
  const base = normalizePublicBaseUrl(publicBaseUrl);
  const releaseBaseUrl = `${base}/releases/${version}`;
  // Explicit literal key order IS the serialization order — the pointer object is rewritten on every
  // promotion, so byte-stability for an unchanged promotion keeps reruns genuinely idempotent.
  return {
    schemaVersion: STABLE_CHANNEL_SCHEMA_VERSION,
    channel: 'stable',
    version,
    releaseBaseUrl,
    manifestUrl: `${releaseBaseUrl}/${MANIFEST_FILENAME}`,
  };
}

export function serializeStableChannel(channel) {
  return `${JSON.stringify(channel, null, 2)}\n`;
}

/** Reads back and fully re-validates a stable pointer — used to make a promotion rerun idempotent
 * (an already-correct pointer needs no write) and to fail loudly on a hand-edited one. */
export function validateStableChannel(text, { expectedVersion = undefined } = {}) {
  let channel;
  try {
    channel = JSON.parse(text);
  } catch (error) {
    throw new StableChannelError(
      `channels/stable.json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (channel?.schemaVersion !== STABLE_CHANNEL_SCHEMA_VERSION) {
    throw new StableChannelError(
      `channels/stable.json declares schemaVersion ${JSON.stringify(channel?.schemaVersion)}; this tool only understands ${STABLE_CHANNEL_SCHEMA_VERSION}.`,
    );
  }
  if (channel.channel !== 'stable') {
    throw new StableChannelError(
      `channels/stable.json declares channel ${JSON.stringify(channel.channel)}; expected "stable".`,
    );
  }
  if (!isValidReleaseVersion(channel.version)) {
    throw new StableChannelError(
      `channels/stable.json declares version ${JSON.stringify(channel.version)}, which is not a plain MAJOR.MINOR.PATCH value.`,
    );
  }
  if (expectedVersion !== undefined && channel.version !== expectedVersion) {
    throw new StableChannelError(
      `channels/stable.json points at ${channel.version}, not the requested ${expectedVersion}.`,
    );
  }
  const base = normalizePublicBaseUrl(channel.releaseBaseUrl);
  if (base !== channel.releaseBaseUrl) {
    throw new StableChannelError(
      `channels/stable.json's releaseBaseUrl ${JSON.stringify(channel.releaseBaseUrl)} is not in normalized form (${base}).`,
    );
  }
  if (!channel.releaseBaseUrl.endsWith(`/releases/${channel.version}`)) {
    throw new StableChannelError(
      `channels/stable.json's releaseBaseUrl ${JSON.stringify(channel.releaseBaseUrl)} does not resolve to releases/${channel.version}.`,
    );
  }
  if (channel.manifestUrl !== `${channel.releaseBaseUrl}/${MANIFEST_FILENAME}`) {
    throw new StableChannelError(
      `channels/stable.json's manifestUrl ${JSON.stringify(channel.manifestUrl)} does not match its own releaseBaseUrl.`,
    );
  }
  return channel;
}

/** The canonical bootstrap installer's public URL, for documentation and for the promote workflow's
 * own summary output. Never used as a fallback download source by anything at runtime. */
export function canonicalInstallerUrl(publicBaseUrl) {
  return `${normalizePublicBaseUrl(publicBaseUrl)}/installer/${INSTALLER_FILENAME}`;
}
