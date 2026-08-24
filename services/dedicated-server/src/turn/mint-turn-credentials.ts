import { createHmac } from 'node:crypto';

import type { TurnConfig } from '../config.js';

/**
 * T14 — mints short-lived Coturn `use-auth-secret` REST credentials (the standard
 * `TURN REST API` convention Coturn itself implements — see `docs/references/COTURN.md`): the
 * username is the credential's own expiry (`<unix-epoch-seconds>`), and the credential is
 * `base64(HMAC-SHA1(sharedSecret, username))`. Coturn independently recomputes this same HMAC from
 * the presented username and its own configured `static-auth-secret`, so nothing beyond the shared
 * secret and the epoch-seconds convention needs to be agreed out of band. Pure and synchronous, no
 * I/O — `sharedSecret` is `config.turn.sharedSecret`'s already-loaded value (never read from
 * `process.env` directly here, matching this module's own "parse once at the process boundary"
 * discipline). `now` is injectable the same way `authorization/store.ts`'s clock-dependent code is,
 * for deterministic tests.
 */

export interface MintedTurnCredentials {
  readonly iceServers: readonly {
    readonly urls: string;
    readonly username: string;
    readonly credential: string;
  }[];
  readonly expiresAt: string;
}

export function mintTurnCredentials(
  config: TurnConfig,
  now: () => Date = () => new Date(),
): MintedTurnCredentials {
  const expiryEpochSeconds = Math.floor(now().getTime() / 1000) + config.credentialTtlSeconds;
  const username = String(expiryEpochSeconds);
  const credential = createHmac('sha1', config.sharedSecret).update(username).digest('base64');

  return {
    iceServers: config.urls.map((urls) => ({ urls, username, credential })),
    expiresAt: new Date(expiryEpochSeconds * 1000).toISOString(),
  };
}
