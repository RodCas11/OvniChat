/**
 * T15.2 — when a connection's next TURN credential push is due.
 *
 * T14 minted a credential exactly once per connection, in the post-authentication burst, and never
 * again. That is fine for a short session and quietly broken for a long one: a credential gates new
 * TURN *allocations*, so a peer connection created after `expiresAt` — a friend joining the channel
 * hours later, or a peer connection rebuilt by T15.2's own ICE-failure recovery — presents an
 * expired `use-auth-secret` username to Coturn, is answered with `401 Unauthorized`, and gathers no
 * relay candidate at all. That failure was reproduced against real Coturn, not inferred.
 *
 * The fix needs no protocol change whatsoever: the server simply pushes `server:turn-credentials`
 * again, with the same message shape, before the previous one expires. A client's existing handler
 * already does exactly the right thing with an Nth push (merge with its own STUN list, hand the
 * combined list to `P2PMeshTransport.setIceServers`, which applies it only to peers that have not
 * established a working transport and merely records it for the ones that have).
 *
 * ## Why half the remaining lifetime
 *
 * Refreshing at a fixed lead time before expiry (say "five minutes before") makes the safety margin
 * depend entirely on an operator-tunable value and collapses to nothing for a short TTL. Halving the
 * remaining lifetime instead gives one scale-free guarantee that holds for any configured TTL: a
 * client is never holding a credential that is more than half-expired, so the worst case for a peer
 * connection created at the least convenient moment is still ~50% of the TTL of remaining validity.
 * At the 6-hour default that is a push every three hours — trivially cheap (one small JSON frame per
 * connection) and never near the expiry cliff.
 *
 * The floor keeps a misconfigured or absurdly short TTL from turning into a message flood; the
 * ceiling keeps the computed delay well inside the range `setTimeout` can actually represent
 * (delays above ~24.8 days overflow its 32-bit signed millisecond field and fire immediately, which
 * would be a silent, permanent busy-loop for an operator who set a multi-year TTL).
 */

export const TURN_CREDENTIAL_REFRESH_FRACTION = 0.5;
export const TURN_CREDENTIAL_REFRESH_MIN_DELAY_MS = 30_000;
export const TURN_CREDENTIAL_REFRESH_MAX_DELAY_MS = 12 * 60 * 60 * 1_000;

/**
 * How long to wait before pushing the next credential set, given the ISO-8601 `expiresAt` the
 * current one carries. Returns `undefined` only when `expiresAt` is not a parseable timestamp at
 * all — the one case where no honest schedule can be derived, so the caller schedules nothing
 * rather than guessing.
 *
 * An `expiresAt` already in the past (clock skew between the server and whatever minted the value,
 * or a pathological TTL) is not treated as unparseable: it clamps to the floor, so the connection
 * keeps receiving fresh credentials at a bounded rate instead of being stranded with a dead one.
 */
export function computeTurnCredentialRefreshDelayMs(
  expiresAt: string,
  nowMs: number,
): number | undefined {
  const expiresAtMs = Date.parse(expiresAt);
  if (!Number.isFinite(expiresAtMs)) return undefined;
  const remainingMs = expiresAtMs - nowMs;
  const target = remainingMs * TURN_CREDENTIAL_REFRESH_FRACTION;
  if (!(target > TURN_CREDENTIAL_REFRESH_MIN_DELAY_MS)) return TURN_CREDENTIAL_REFRESH_MIN_DELAY_MS;
  return Math.min(Math.floor(target), TURN_CREDENTIAL_REFRESH_MAX_DELAY_MS);
}
