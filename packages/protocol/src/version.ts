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
 *
 * Bumped to 3 for T8: `server:hello` gained required `serverName`/`serverCapabilities` fields (the
 * Dedicated Server product's minimal self-description — see
 * `docs/architecture/DEDICATED_SERVER.md`). Both `client:hello` and `server:hello` are validated
 * with `.strict()` schemas on the receiving side, so a new *required* field is a breaking shape
 * change for whichever side didn't expect it yet, even though nothing about identity verification
 * or existing fields' meaning changed — treated the same as T7's bump for consistency.
 *
 * **Not bumped for T9** (server-local authorization — see
 * `docs/architecture/SERVER_AUTHORIZATION.md`), deliberately: every T9 wire change is genuinely
 * additive under the policy above — `client:hello` gained only an *optional* `serverToken` field,
 * `voice:join`'s participant shape gained only an *optional* `groups` badge array, and every new
 * authorization concept (group/token/ban management, the authorization-state snapshot) is an
 * entirely new message type added to the existing discriminated unions, never a change to an
 * existing message's required shape. This is the first task to actually exercise the "new message
 * types, new optional fields" half of the evolution policy rather than the "required field" half
 * T7 and T8 both needed.
 */
export const CURRENT_PROTOCOL_VERSION = 3;

export const SUPPORTED_PROTOCOL_VERSIONS: readonly number[] = [3];

export function isSupportedProtocolVersion(version: number): boolean {
  return SUPPORTED_PROTOCOL_VERSIONS.includes(version);
}
