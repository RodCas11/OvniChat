# ADR 0023: TURN REST credential-minting architecture

## Status

Accepted and implemented (T14 — Production Self-Hosting). Amended by T15.2, which implemented the
periodic credential refresh this ADR originally deferred; see "T15.2 amendment" below.

## Context

`docs/architecture/WEBRTC_VOICE.md` and `docs/SECURITY.md` had already named the target shape of
this decision before any of it existed: Coturn as the self-hosted TURN implementation (ADR 0004),
short-lived credentials minted server-side rather than a durable shared secret ever reaching a
client, and no mandatory central Chantivo-operated TURN service (ADR 0010). T14 needed to turn that
target into a real mechanism: how credentials are minted, how they reach the client, whether they
require a new client-initiated request, and whether the protocol needs a version bump to carry them.

## Decision

**Minting**: `services/dedicated-server/src/turn/mint-turn-credentials.ts` implements Coturn's
standard `use-auth-secret` TURN REST convention exactly — `username = <unix-epoch-seconds expiry>`,
`credential = base64(HMAC-SHA1(sharedSecret, username))`. This is a pure, synchronous,
no-I/O function; minting a credential requires no database access and no network call, so it adds no
new failure mode to the connection path beyond the existing identity-proof flow.

**Delivery**: credentials are pushed unconditionally, once, as part of the existing set of messages
`handleIdentityProof` already sends on every successful `ready` transition (`server:hello`,
`server:authorization-state`, the voice catalog, presence snapshot, profile-self-updated). A new,
additive `server:turn-credentials` message (`packages/protocol/src/messages/turn.ts`) joins that same
array — the connection has already been authenticated by the time it's sent, so credentials are
never handed to an unauthenticated socket. There is no separate `client:turn-credentials-request`
message: since minting is free (no I/O, microseconds of CPU), a request/response round trip would
only add a second piece of state to track for no benefit over always including it in the burst of
state a client already receives at the same moment.

The message is sent only when the operator has configured `turn` (both
`DISCO_VOADOR_TURN_SHARED_SECRET` and `DISCO_VOADOR_TURN_URLS` present — see
`docs/CONFIGURATION.md`); a server with TURN unconfigured never emits it, and the client's behavior
is unchanged from before this ADR (STUN/host-only `iceServers`).

**No protocol version bump**: `packages/protocol/src/version.ts`'s own history shows this repo has
twice before added a new message type to an existing `server:*`/`client:*` discriminated union
(T9's authorization messages, T13.3's profile/presence messages) without bumping
`CURRENT_PROTOCOL_VERSION` — every actual bump in this repo's history was triggered by a required
field added to an _existing, already-shipped_ message, never by a new message type. `server:turn-
credentials` follows the established, additive precedent; protocol stays v5.

**Secret handling**: the shared secret is environment-variable-only
(`DISCO_VOADOR_TURN_SHARED_SECRET`) and deliberately excluded from the hand-edited, versionable
`server-config-file.ts` schema — `docs/SECURITY.md`'s existing rule ("[the config file] never
contains credentials... only display/network/channel configuration") already establishes this line
for other cases; TURN's shared secret is exactly that kind of value. It is never logged, never
returned in any client-visible message (only the derived, expiring `username`/`credential` pair is),
and never baked into the Docker image (supplied only at container-run time via env/Compose secrets).

**Credential lifetime**: default TTL is 21600 seconds (6 hours), operator-overridable via
`DISCO_VOADOR_TURN_CREDENTIAL_TTL_SECONDS`. A TURN credential gates new _allocations_ only — an
already-established relay does not drop when its minting credential later expires — so this default
is intentionally generous relative to any realistic single voice session.

### T15.2 amendment — periodic credential refresh (implemented)

The "Alternatives" section below deferred a server-initiated refresh on the reasoning that a 6-hour
TTL was generous enough. That reasoning does not survive contact with the failure it was meant to
cover: the risk was never "one voice call lasts longer than the TTL", it was "a _connection_ outlives
the TTL and then needs a _new peer connection_" — a friend joining the channel hours later, or a peer
connection rebuilt by T15.2's own ICE-failure recovery. Both present an expired `use-auth-secret`
username to Coturn, which answers `401 Unauthorized` and yields no relay candidate at all
(reproduced against real Coturn during T15.1, not inferred).

The implemented mechanism deliberately touches nothing this ADR decided. `Connection` arms a
per-connection timer at **half the current credential's remaining lifetime** and re-pushes the same
`server:turn-credentials` message with a freshly minted set; the timer is cancelled on every teardown
path. There is no new message type, no client-initiated request, no protocol version change, and no
client-side change whatsoever — the existing handler already treats an Nth push exactly like the
first. Halving the remaining lifetime rather than using a fixed lead time keeps the margin scale-free
for any operator-configured TTL (a client is never holding a credential more than half-expired),
with a floor and a ceiling to bound the message rate and to stay inside what `setTimeout` can
represent. Applying a _replacement_ credential never disturbs a peer whose transport is already
established; it is only recorded, so that peer recovers against current credentials if it later
fails. See `services/realtime/src/turn-credential-refresh.ts`.

**Client wiring**: `packages/rtc-core`'s `P2PMeshTransport` gained `setIceServers()` (REPLACE, not
merge, semantics — the caller is responsible for combining STUN and TURN servers before calling it).
This method is deliberately _not_ added to the shared `MediaTransport` interface, to avoid obligating
a future SFU-backed transport to support the same dynamic-update mechanism (see ADR 0006). This does
not fully preserve ADR 0006's zero-caller-change property, however: `use-voice-channel.ts` holds its
transport as a concrete `P2PMeshTransport` (not the `MediaTransport` interface) specifically so it can
call `setIceServers`, so a future SFU-transport swap will need to touch this one call site (e.g. guard
it with a capability check or an `instanceof` narrowing) rather than being a no-op migration. This is
accepted as a small, contained, and already-named cost — not treated as costless.

## Consequences

- Self-hosted TURN is fully optional and fully functional without any Chantivo-operated service.
- The realtime protocol did not need a breaking or even a minor version change to add TURN support.
- ~~A very long-lived connection (beyond the TTL) that later needs a _new_ peer connection — e.g. a
  new participant joining the same voice channel well after the original credential's `expiresAt` —
  receives a stale/expired TURN credential for that specific new peer.~~ **Resolved by T15.2's
  periodic refresh** (see the amendment above). What is left is a boundary case this project has not
  measured: Coturn's behavior for an already-established relay allocation whose original minting
  credential has since expired. The refresh means a client always holds a valid credential for any
  _new_ allocation, which is the case that was actually reproduced as broken.
- A future SFU-backed `MediaTransport` implementation will need to touch `use-voice-channel.ts`'s one
  TURN-wiring call site, not zero call sites, when it lands.

## Alternatives

- **Client-requested credentials (`client:turn-credentials-request`/`server:turn-credentials-response`
  round trip):** rejected — minting is free and synchronous, so a request adds state-tracking
  complexity (did we already respond to this connection? do we allow re-requesting?) for no benefit
  over an unconditional push at the one moment every other post-auth state is already pushed.
- **Durable, non-expiring TURN credentials shipped to every client:** rejected outright —
  contradicts `docs/SECURITY.md`'s explicit "never embed durable TURN credentials in the desktop
  application" rule and the standard TURN REST threat model this ADR follows.
- **Periodic server-initiated credential refresh before expiry:** deferred at T14 on the grounds that
  the 6-hour default TTL was generous enough — **reversed and implemented in T15.2** once the real
  failure mode ("join hours into an existing connection", the exact pattern this bullet said would
  justify revisiting) was reproduced against real Coturn. See the T15.2 amendment above.
- **Adding `setIceServers` to the shared `MediaTransport` interface:** rejected — would obligate
  every future transport implementation (including a not-yet-designed SFU transport, whose relay path
  typically isn't a per-peer TURN server applied this way at all) to support an identical mechanism
  it may not need.
