/**
 * `awaiting_hello` merges the prompt's conceptual `CONNECTED_SOCKET`/`AWAITING_HELLO` split: our
 * code only ever observes a connection once its WebSocket upgrade is already complete (there is
 * no independent action to take in between), so the first state our code can act on already is
 * "open, handshake not yet complete" — a distinct pre-handshake state would be unobservable.
 *
 * `awaiting_identity_proof` (T7) sits between `awaiting_hello` and `ready`: a structurally valid
 * `client:hello` moves a connection here and issues a `server:identity-challenge`, but the
 * connection is not `ready` — cannot join voice, signal, or do anything else — until a verified
 * `client:identity-proof` proves possession of the private key matching the public key `hello`
 * claimed. See `docs/architecture/CLIENT_IDENTITY.md`.
 *
 * There is deliberately no separate state per rejection reason (bad hello, unsupported version,
 * rate limited, ...). Every rejection is `awaiting_hello`/`awaiting_identity_proof`/`ready` ->
 * `closing` -> `closed`, with the reason recorded once as data (see `Connection.closeReason`),
 * not as a proliferation of failure states.
 */
export type ConnectionState =
  'awaiting_hello' | 'awaiting_identity_proof' | 'ready' | 'closing' | 'closed';
