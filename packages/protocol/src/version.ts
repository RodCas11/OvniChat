/**
 * The realtime wire protocol version. A connection negotiates exactly one version during the
 * handshake (`client:hello` / `server:hello`); it is not repeated on every subsequent message,
 * since a WebSocket connection's protocol version cannot change mid-connection — there is nothing
 * for later messages to renegotiate.
 *
 * Evolution strategy: additive, backward-compatible changes (new message types, new optional
 * fields) do not require a version bump. A breaking change (removing/renaming a field, changing a
 * field's meaning, tightening a constraint an existing client relies on) requires incrementing
 * `CURRENT_PROTOCOL_VERSION` and adding the new value to `SUPPORTED_PROTOCOL_VERSIONS`. The server
 * may support more than one version at once during a migration window; a client that requests a
 * version outside `SUPPORTED_PROTOCOL_VERSIONS` receives `UNSUPPORTED_PROTOCOL` and the connection
 * is closed — this is a defined failure, not undefined behavior.
 *
 * Bumped to 2 for T7: `client:hello` gained required `nickname`/`publicKey` fields and the
 * handshake gained a mandatory identity-challenge/proof step before `server:hello`. This is a
 * breaking change (an old client's hello is no longer sufficient to reach `ready`), so v1 support
 * was dropped rather than kept as a parallel unauthenticated codepath — maintaining it would have
 * meant either bypassing identity verification for v1 clients (unacceptable) or having v1 always
 * fail (pointless to keep as "support").
 */
export const CURRENT_PROTOCOL_VERSION = 2;

export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [2];

export function isSupportedProtocolVersion(version: number): boolean {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(version);
}
