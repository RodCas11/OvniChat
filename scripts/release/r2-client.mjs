import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * T15.1 — the thinnest possible wrapper over the AWS CLI, pointed at Cloudflare R2's S3-compatible
 * endpoint. Deliberately NOT an S3 SDK and not a hand-written signer:
 *
 * - Adding an AWS SDK would pull a large dependency tree into a repository whose whole dependency
 *   discipline is "don't add a package for what a few lines already do," for a workflow that runs on
 *   GitHub-hosted runners where the AWS CLI is already installed and maintained.
 * - Hand-rolling SigV4 would be inventing crypto-adjacent code for a solved problem. Explicitly out.
 *
 * Credential handling: this module never reads, constructs, or prints a credential. The AWS CLI picks
 * up `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY` from the environment the workflow gives it, and the
 * endpoint URL (which embeds the R2 account id, itself a registered GitHub secret) arrives via
 * `R2_ENDPOINT_URL` and is passed straight through as a flag value. Nothing here echoes any of them,
 * and every error message below is built from the object key and the CLI's own stderr, never from the
 * argument list.
 */

export class R2Error extends Error {
  constructor(message) {
    super(message);
    this.name = 'R2Error';
  }
}

/** `aws s3api` reports a missing key as a 404 / "Not Found" on stderr with a non-zero exit code. Any
 * other failure (403, network, malformed bucket) must NOT be mistaken for "absent" — mistaking a
 * permissions failure for an empty release directory is exactly how an immutability check gets
 * silently bypassed. */
function isNotFound(stderr) {
  return /\b(404)\b|Not Found|NoSuchKey/iu.test(stderr ?? '');
}

export function createR2Client({ bucket, endpointUrl, awsBinary = 'aws', exec = execFileAsync }) {
  if (!bucket)
    throw new R2Error('No R2 bucket configured (expected the CLOUDFLARE_R2_BUCKET variable).');
  if (!endpointUrl) throw new R2Error('No R2 endpoint URL configured.');

  const baseArgs = ['--endpoint-url', endpointUrl];

  async function run(args, options = {}) {
    try {
      return await exec(awsBinary, [...args, ...baseArgs], {
        maxBuffer: 16 * 1024 * 1024,
        ...options,
      });
    } catch (error) {
      const stderr = typeof error?.stderr === 'string' ? error.stderr : '';
      if (options.allowNotFound && isNotFound(stderr)) return null;
      // `args[0]`/`args[1]` are the subcommand words only (e.g. "s3api head-object") — never a
      // credential and never the endpoint, which lives in baseArgs and is intentionally not echoed.
      throw new R2Error(
        `aws ${args.slice(0, 2).join(' ')} failed: ${stderr.trim() || error?.message || 'unknown error'}`,
      );
    }
  }

  return {
    /** @returns {Promise<{exists: boolean, sha256?: string, size?: number}>} */
    async headObject(key) {
      const result = await run(
        ['s3api', 'head-object', '--bucket', bucket, '--key', key, '--output', 'json'],
        {
          allowNotFound: true,
        },
      );
      if (result === null) return { exists: false };
      let parsed;
      try {
        parsed = JSON.parse(result.stdout);
      } catch {
        throw new R2Error(`Could not parse head-object output for ${key}.`);
      }
      return {
        exists: true,
        sha256: parsed?.Metadata?.sha256,
        size: typeof parsed?.ContentLength === 'number' ? parsed.ContentLength : undefined,
      };
    },

    async putObject({ key, bodyPath, cacheControl, contentType, sha256 }) {
      const args = [
        's3api',
        'put-object',
        '--bucket',
        bucket,
        '--key',
        key,
        '--body',
        bodyPath,
        '--cache-control',
        cacheControl,
        '--content-type',
        contentType,
      ];
      // The sha256 user metadata is what makes republication decidable: it is how a later run proves
      // an already-published object is byte-identical without downloading it. ETags are unreliable for
      // this (multipart uploads make them non-MD5) and R2 does not guarantee an S3-identical ETag.
      if (sha256) args.push('--metadata', `sha256=${sha256}`);
      await run(args);
    },

    async getObject({ key, destinationPath }) {
      const result = await run(
        [
          's3api',
          'get-object',
          '--bucket',
          bucket,
          '--key',
          key,
          destinationPath,
          '--output',
          'json',
        ],
        { allowNotFound: true },
      );
      return result !== null;
    },
  };
}

export function endpointUrlForAccount(accountId) {
  if (typeof accountId !== 'string' || accountId.trim().length === 0) {
    throw new R2Error('No Cloudflare R2 account id available to derive an endpoint URL from.');
  }
  return `https://${accountId.trim()}.r2.cloudflarestorage.com`;
}
