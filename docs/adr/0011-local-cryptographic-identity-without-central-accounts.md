# ADR 0011: Local cryptographic identity without central accounts

## Status

Accepted and implemented (T7).

## Context

ADR 0010 established the product-direction guardrail that Disco Voador must never require a central
account system, central user database, or mandatory Disco Voador–operated cloud service. T7 is the
first task to actually implement client identity under that guardrail: a realtime server needs some
way to recognize the same client across reconnects (for future server-local permissions, T9) without
that recognition depending on a central authority anywhere.

The two realistic designs were:

1. **Local cryptographic identity** (TeamSpeak-style): each client generates its own keypair; a
   server recognizes a client by proving possession of the matching private key via a challenge/
   response, and derives a stable id from the public key. No account, no central registry.
2. **Central account service**: email/password or similar, a central user database, sessions issued
   by a Disco Voador–operated (or self-hosted-but-shared) auth service.

Option 2 directly contradicts ADR 0010 and the self-hosted-first product principle
(`docs/PRODUCT.md`) — it would require either a mandatory Disco Voador cloud service or every
independent server operator to run their own duplicate account system with no interoperability
benefit, and would create exactly the "just add login" erosion ADR 0010 was written to prevent.

## Decision

**Accepted and implemented:** every Disco Voador client generates and owns a local Ed25519 keypair
at first run. A server never issues, stores, or manages this identity — it only _verifies_ it, via a
challenge the client must sign with its private key before a connection is allowed to do anything.
The server derives a stable `identityId` itself from the client's verified public key
(`dv1_<base64url(SHA-256(publicKey))>`) — never a value the client claims.

Explicitly decided as part of this ADR:

- **No account, ever.** No email, phone number, real name, password, or social login anywhere in
  this design. See `docs/architecture/CLIENT_IDENTITY.md` for the full technical design.
- **Nickname is not identity** (see that document's "Nickname is not identity" section) — a
  client-local, freely-editable preference, never a database key or authentication signal.
- **The private key never leaves the client's Main process.** The Renderer can request a signature
  over a _specific, domain-separated, structurally-bounded_ payload (an identity-auth challenge) but
  can never extract the key itself or use the signing API as a generic oracle.
- **The server holds no identity state beyond one connection's lifetime.** T7 introduces no
  users/accounts/profile database. Server-_local_ authorization state (permissions, groups, bans)
  keyed by `identityId` is deliberately deferred to T9 — T7 only answers "is this the same
  cryptographic identity as before," never "what is this identity allowed to do."
- **The same identity is portable across independent servers** (by design, like a TeamSpeak
  identity) but there is no service anywhere correlating a client's activity _across_ servers — each
  server only ever learns what a client presents directly to _it_.

## Consequences

- `packages/identity` (new): a Node-only package for Ed25519 keygen/sign/verify/identityId
  derivation, importable only by the Electron Main process and `services/realtime` — never by
  Renderer/Preload code or the environment-neutral packages. Enforced by
  `scripts/verify-architecture.mjs`.
- `packages/protocol` gained wire schemas and a pure canonical-payload builder for the identity
  handshake, but deliberately stayed crypto-free (see `CLIENT_IDENTITY.md`'s "Package boundary"
  section) so it remains safe for the sandboxed Renderer to import.
- The realtime protocol version bumped 1 → 2 (`client:hello` gained required `nickname`/`publicKey`;
  a new mandatory identity-challenge/proof step was inserted before `server:hello` can ever be sent).
  This is a breaking change; v1 support was dropped rather than kept as a parallel unauthenticated
  codepath.
- Every existing media capability (voice, camera, screen-video, screen-audio) now authenticates via
  this handshake before doing anything — re-verified via all four pre-existing E2E smoke tests
  passing unmodified against the new mandatory identity gate.
- This ADR does not implement T8 (Dedicated Server product boundary) or T9 (server-local
  permissions/groups/tokens/bans) — both remain future tasks that will build _on top of_ the
  `identityId` this task establishes, per ADR 0010's anticipated sequencing.
- Regenerating an identity (an explicit, confirmation-gated, destructive user action — never
  automatic) means a server will treat the client as an entirely new, unrecognized identity and any
  future server-local reputation/permissions tied to the old `identityId` are lost. This is an
  accepted, documented trade-off of client-owned identity: there is no central authority to appeal
  to for recovery, by design.

## Alternatives

- **Central account service:** rejected — directly contradicts ADR 0010; see Context above.
- **Hardware-derived identity (MAC address, machine serial, Windows username):** rejected — T7's own
  requirement is that identity must be pure random cryptographic material, never hardware-derived,
  since hardware identifiers are neither portable (reinstalling Windows would silently change
  identity) nor private (some are queryable by other software) nor a client's actual choice.
  Ed25519 keys generated by the client's own CSPRNG have none of these problems.
- **A single shared "device identity" instead of per-profile identity:** rejected — a per-`userData`-
  directory identity (proven by the T7 identity-persistence E2E) allows multiple independent local
  profiles on the same machine, which a single machine-wide identity would preclude, at no extra
  implementation cost.
- **Skip the challenge/response and just send the public key + a static signature:** rejected — a
  static signature is copyable and replayable by anyone who observes it once; the whole point of
  proving _possession_ of the private key is a fresh, connection-bound, single-use, expiring
  challenge (see `CLIENT_IDENTITY.md`'s "Challenge security" section).
