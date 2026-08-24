/**
 * T14 — the narrow, synchronous seam `services/realtime` depends on for minting TURN credentials,
 * mirroring exactly how T9 injected `AuthorizationPort`/T10 injected `ChatPort`: this package
 * defines the contract and a permissive (always-absent) no-op default; `services/dedicated-server`
 * provides the real implementation (`mintTurnCredentials`, backed by its own loaded `TurnConfig`)
 * via composition. `services/realtime` itself never knows about `node:crypto`/HMAC/Coturn
 * conventions as *implementation* — it only calls `mint()` at the one point a fresh credential set
 * is due (the `handleIdentityProof` success actions, alongside `server:hello` et al.), and only
 * ever passes through whatever the port returns.
 *
 * `mint()` is synchronous for the same reason every other `*Port`'s methods are: `Connection`/
 * `routeClientMessage` are a fully synchronous hot path, and HMAC computation has no async boundary
 * to bridge.
 */

export interface TurnCredentialIceServer {
  readonly urls: string;
  readonly username?: string;
  readonly credential?: string;
}

export interface MintedTurnCredentials {
  readonly iceServers: readonly TurnCredentialIceServer[];
  readonly expiresAt: string;
}

export interface TurnCredentialPort {
  /** Returns a freshly minted credential set, or `undefined` when TURN is not configured at all —
   * never an empty `iceServers` array (see `server:turn-credentials`'s own doc comment in
   * `packages/protocol`). */
  mint(): MintedTurnCredentials | undefined;
}

/** The default for any `@disco-voador/realtime` consumer that doesn't compose its own (direct
 * library consumers, and every test that doesn't specifically exercise TURN) — always reports "no
 * TURN configured", so `handleIdentityProof` never sends `server:turn-credentials` at all. */
export function createNoopTurnCredentialPort(): TurnCredentialPort {
  return { mint: () => undefined };
}
