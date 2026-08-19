# Local cryptographic client identity (T7)

## Scope

How a Disco Voador client proves who it is to a realtime server, without any central account
system. Covers: the Ed25519 keypair and its on-disk storage, the Main/Preload/Renderer trust
boundary around the private key, the wire handshake (`client:hello` →
`server:identity-challenge` → `client:identity-proof` → `server:hello`), nickname-vs-identity, and
server-side identity state. See [`REALTIME_PROTOCOL.md`](REALTIME_PROTOCOL.md) for how this fits
into the wider T2 handshake envelope, and
[`adr/0011-local-cryptographic-identity-without-central-accounts.md`](../adr/0011-local-cryptographic-identity-without-central-accounts.md)
for the product-direction decision this task implements.

## Product model

The user experience is old-school TeamSpeak, not a modern SaaS account: choose a nickname, connect
to a server, the client already knows who it is cryptographically. There is **no** central account,
no email, no password, no phone number, no social login, and no global user database anywhere in
this project. Identity originates and remains on the client.

```text
Disco Voador Client                    Disco Voador Dedicated Server (future, T8)
  local identity (Ed25519 keypair)  →    verifies proof, derives identityId
  nickname (editable preference)         holds only per-connection-lifetime state
```

The same local identity is technically reusable against multiple independent servers (exactly like
a TeamSpeak identity), but there is no service anywhere correlating a client's activity _across_
servers — each server only ever learns the `identityId` and `nickname` a client presents to _it_.

### Data split

| Data                                        | Lives where                                              | Lifetime                                                  |
| ------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------- |
| Private key                                 | Client, OS-encrypted (`safeStorage`)                     | Until regenerated                                         |
| Public key, `identityId`                    | Client (source of truth); server (per-connection)        | Client: persistent. Server: connection lifetime           |
| Nickname                                    | Client preference; sent to each server                   | Client: persistent, editable. Server: connection lifetime |
| Email / phone / real name / password        | Nowhere                                                  | —                                                         |
| Hardware fingerprint / MAC / machine serial | Nowhere (identity is pure random cryptographic material) | —                                                         |
| Cross-server identity-correlation data      | Nowhere — no such service exists                         | —                                                         |

## Cryptography

**Algorithm: Ed25519**, via Node's built-in `node:crypto` (`generateKeyPairSync('ed25519')` /
`sign(null, data, privateKey)` / `verify(null, data, publicKey, signature)`) — no third-party crypto
dependency was added; the pinned Node runtime already provides a complete, stable implementation.
All key generation/signing/verification/derivation logic lives in `packages/identity` (Node-only —
see [Package boundary](#package-boundary-packagesidentity) below).

**Wire/storage encoding**: every key, signature, and nonce is the **raw** cryptographic material —
32 bytes for an Ed25519 public key or private-key seed, 64 bytes for a signature — as unpadded
base64url text, never a DER/SPKI/PKCS8-wrapped blob. This matches the JWK `OKP` `x`/`d` fields
Node's own `KeyObject.export({ format: 'jwk' })` already produces for Ed25519, so the module reads/
writes exactly those fields rather than inventing a bespoke encoding.

| Value            | Raw bytes | Base64url length | Wire/storage form                                      |
| ---------------- | --------: | ---------------: | ------------------------------------------------------ |
| Public key       |        32 |               43 | `identityPublicKeySchema`                              |
| Private-key seed |        32 |               43 | Encrypted before ever touching disk; never on the wire |
| Signature        |        64 |               86 | `identitySignatureSchema`                              |
| Challenge nonce  |        32 |               43 | `identityNonceSchema`                                  |

**`identityId` derivation**: `identityId = 'dv1_' + base64url(SHA-256(raw 32-byte public key))` —
deterministic, contains no private material, stable for the keypair's lifetime, unique per public
key. Hashes the **raw** public-key bytes, never a string serialization of it, so the same key always
derives the same id regardless of encoding variation. The `dv1_` prefix is bumped only if the
derivation algorithm itself ever changes, never for a routine key rotation (a rotation just produces
a new id under the same scheme). The server always derives `identityId` itself from the verified
public key — it never trusts a client-supplied value.

## Package boundary: `packages/identity`

The actual Ed25519 operations live in a new Node-only package, `packages/identity`, imported only by
the Electron Main process and `services/realtime` — **never** by Renderer/Preload code or by the
environment-neutral packages (`protocol`, `rtc-core`, `media-core`, `shared`). This is enforced by
`scripts/verify-architecture.mjs`'s `isIdentity()` check, mirroring the existing `isWindowsMedia()`
pattern.

This split exists because `packages/protocol` is imported directly by Vite-bundled Renderer code,
which runs in the sandboxed, `nodeIntegration: false` Electron Renderer with no Node builtins — a
`node:crypto` import there would either fail to bundle or (worse) silently pull in a browser
polyfill nobody asked for. `packages/protocol` instead stays crypto-free: it owns only the wire
_schemas_ and a pure, environment-neutral canonical-payload-builder function (`buildIdentityAuthPayload`,
built on `TextEncoder`, which exists in both Node and the browser-like Renderer). Every constant
that must stay numerically in sync between the two packages (raw-key/signature byte lengths, the
`dv1_` prefix) is deliberately duplicated rather than imported, so `packages/protocol`'s dependency
graph never pulls in Node capabilities.

## Private key storage

**Location**: `%APPDATA%/DiscoVoador/identity/identity.json` (`app.getPath('userData')/identity/identity.json`).

**Encryption**: Electron's `safeStorage` API (Windows DPAPI-backed) encrypts the private-key seed
before it is ever written to disk. `safeStorage.isEncryptionAvailable()` is checked before both
creating and loading an identity; if it returns `false`, identity load/create **fails closed** —
throws an actionable `IdentityStorageError`, never falls back to writing the key in plaintext.

**File format** (versioned, schema-validated on every read):

```json
{
  "version": 1,
  "publicKey": "<43-char base64url>",
  "encryptedPrivateKey": "<base64 of safeStorage.encryptString() output>",
  "identityId": "dv1_<43-char base64url>"
}
```

**Atomic writes**: every write goes through `apps/desktop/src/main/identity/atomic-write.ts` —
write to a `.tmp-<pid>-<timestamp>-<random>` file in the same directory, then `rename()` to the
final path. `rename` is atomic on the same filesystem, so a crash or power loss mid-write can never
leave a half-written `identity.json`; readers only ever see the old complete file or the new
complete file.

**Corruption handling**: the loader (`identity-service.ts`) distinguishes "no file yet" (first run —
silently creates one) from every other failure mode, which is treated as **corruption**, never
silently regenerated:

- File unreadable, not valid JSON, or fails schema validation (including an unrecognized `version`)
  → `IdentityStorageError` with an actionable message.
- `safeStorage.decryptString()` throws (e.g. the DPAPI-protected blob is unreadable, perhaps because
  it was copied to a different machine/user) → `IdentityStorageError`.
- **Public/private key mismatch**: the loader signs a fixed local self-check payload with the
  decrypted private key and the stored public key, then immediately verifies that signature against
  the same public key. A `publicKey`/`encryptedPrivateKey` pair that does not actually correspond
  (e.g. a hand-edited or corrupted file) fails this self-check and is rejected before it could ever
  produce a signature the server would reject anyway — the failure surfaces locally, immediately, and
  legibly instead of manifesting later as a mysterious `IDENTITY_INVALID_SIGNATURE` from the server.
- Stored `identityId` does not match `deriveIdentityId(storedPublicKey)` → `IdentityStorageError`.

None of these cases auto-regenerate. The Renderer surfaces the error (`App.tsx`'s identity error
state); the only way past it is the same explicit, confirmation-gated "Regenerate Identity" action a
user would use voluntarily (see [Regeneration](#regeneration)) — there is no silent recovery path,
by design, since silently minting a new identity after real corruption would be indistinguishable
from silently discarding a user's earned server reputation.

## Trust boundary: Renderer → Preload → Main → OS

```text
Renderer                Preload (typed bridge)        Main (identity-service.ts)      OS
  useIdentity() hook  →   desktopApp.getIdentity()  →   getOrCreateIdentity()      →  safeStorage /
  IdentitySigner      →   .signIdentityChallenge()  →   signIdentityChallenge()    →  filesystem
```

The private key **never** crosses into the Renderer, in any form — not as a raw value, not through
a "temporary" IPC round trip, not in a log line. The Renderer can only ever call two identity-shaped
IPC methods:

- `getIdentity()` → `{ identityId, publicKey }` (public data only).
- `signIdentityChallenge({ protocolVersion, connectionId, nonce, expiresAt, nickname })` → a
  signature string.

**Anti-oracle design**: `signIdentityChallenge` deliberately does **not** accept raw bytes to sign.
It accepts only structured, individually-bounded, schema-validated fields (`ipc.ts`'s
`identityChallengeSchema`, mirroring `packages/protocol`'s own wire bounds exactly); Main
reconstructs the exact canonical payload itself (`buildIdentityAuthPayload`) using **its own**
stored public key, never a value the Renderer supplied. A fully compromised Renderer can therefore
only ever get the identity to sign _this specific domain-separated message shape_ — it cannot turn
this API into a generic "sign anything" oracle for some other purpose the key might later be reused
for.

`regenerateIdentity()` and `getNickname()`/`setNickname()` are the remaining identity-shaped IPC
methods; all five (`getIdentity`, `signIdentityChallenge`, `regenerateIdentity`, `getNickname`,
`setNickname`) go through the same `assertTrustedSender` origin/sender check every other IPC channel
in this app uses (see `docs/ARCHITECTURE.md`'s Main/Preload/Renderer boundary).

## Handshake

See [`REALTIME_PROTOCOL.md`](REALTIME_PROTOCOL.md#handshake) for the full sequence diagram and
state machine. Summary:

1. `client:hello { protocolVersion, client, nickname, publicKey }` — the client's identity claim.
   Not trusted on its own.
2. `server:identity-challenge { connectionId, nonce, expiresAt }` — issued once per connection,
   immediately after a structurally valid hello. `nonce` is generated with `node:crypto`'s
   `randomBytes` (never `Date.now()`/`Math.random()`/a counter). The connection moves to
   `awaiting_identity_proof`, not `ready`.
3. `client:identity-proof { signature }` — the client asks its `IdentitySigner` (in practice, an IPC
   round trip to Main) to sign the canonical payload, then sends the signature back.
4. Server rebuilds the exact same canonical payload from what it remembers (the challenge it issued
   plus the hello it already received) and verifies. On success it derives `identityId` itself and
   replies `server:hello { connectionId, identityId, protocolVersion, heartbeat }` — this is the
   **only** message that can move a connection to `ready`.

### Canonical signing payload

```ts
'disco-voador:identity-auth:v1' +
  '\n' +
  protocolVersion +
  '\n' +
  connectionId +
  '\n' +
  nonce +
  '\n' +
  expiresAt +
  '\n' +
  publicKey +
  '\n' +
  nickname;
```

(`buildIdentityAuthPayload` in `packages/protocol/src/identity.ts`, encoded via `TextEncoder`.)

- **Domain separation**: the fixed `"disco-voador:identity-auth:v1"` prefix ensures a signature
  produced for this specific handshake purpose can never be replayed as if it were a signature over
  some other kind of message this project (or a future one reusing the same keypair) might ever ask
  the identity to sign.
- **Newline-delimited, not JSON**: avoids JSON key-ordering ambiguity between two independent
  implementations (client and server) reconstructing the same string.
- **Delimiter-injection safety**: every field is independently bounded/pattern-validated _before_
  this function is ever called, and none of them can contain a `\n` — `publicKey`/`nonce`/`signature`
  are base64url (`[A-Za-z0-9_-]` only), `connectionId` is restricted to alphanumeric/hyphen, and
  `nickname` reuses the wire's `displayNameSchema`, which already rejects all C0 control characters
  (including `\n`) for unrelated reasons (T3's display-name hardening). Two fields can therefore never
  be confused with each other regardless of their content.
- **Connection binding**: `connectionId` is embedded in the payload, so a valid proof for connection
  A can never verify for connection B, even from the same identity — the server always uses _its
  own_ per-connection `connectionId`, never a client-supplied one.
- **Nickname binding**: the server always rebuilds the payload from the nickname it received at
  `client:hello`, never from a later value — a signature computed over a different nickname than the
  one hello claimed fails verification.

### Challenge security

- **Randomness**: `generateIdentityChallengeNonce()` uses `node:crypto`'s `randomBytes(32)` — never
  a predictable source.
- **Single-use**: a connection has at most one outstanding challenge (`Connection`'s
  `pendingChallenge` field); a successful proof clears it and moves to `ready`, so the _same_
  connection can never answer twice. A second `client:identity-proof` on an already-`ready`
  connection has no outstanding challenge to match and is rejected (`IDENTITY_PROTOCOL_ERROR`).
- **Expiring**: `expiresAt` (default 10s from issuance, `REALTIME_IDENTITY_CHALLENGE_TTL_MS`) is
  checked against the server's own clock before verifying; an expired proof is rejected
  (`IDENTITY_CHALLENGE_EXPIRED`) without ever reaching signature verification.
- **Connection-bound**: see canonical payload above — a proof copied from one connection to another
  fails signature verification, since the embedded `connectionId` differs.
- **Handshake timeout still applies**: `Connection`'s existing handshake timer now also covers
  `awaiting_identity_proof`, not just `awaiting_hello` — a connection that sends hello but never
  answers the challenge is still closed with `HANDSHAKE_TIMEOUT` once `REALTIME_HANDSHAKE_TIMEOUT_MS`
  elapses.

### Error codes

Four new, deliberately coarse codes — see [`REALTIME_PROTOCOL.md`](REALTIME_PROTOCOL.md#errors) for
the full table and reasoning: `IDENTITY_INVALID_PUBLIC_KEY`, `IDENTITY_INVALID_SIGNATURE`,
`IDENTITY_CHALLENGE_EXPIRED`, `IDENTITY_PROTOCOL_ERROR`. All four are fatal (close the connection) —
an unauthenticated connection is never left retrying indefinitely.

## Nickname is not identity

Nickname is a client-local preference (`apps/desktop/src/main/identity/nickname-store.ts`, its own
`preferences.json`, entirely separate from `identity.json`), never a database primary key,
authentication secret, authorization identity, or stable user identifier. Changing it:

- never changes the cryptographic identity or `identityId`;
- never requires regenerating anything;
- is sent to each server fresh at `client:hello` — there is no central nickname registry, and no
  server can learn a nickname the client didn't just present to it.

`nickname` (identity-level, connection-scoped, sent once at `client:hello`) and `displayName`
(T3's existing per-channel-join field, validated by the same `displayNameSchema`) remain two
independent wire concepts, deliberately not merged — a channel join's display name and a
connection's identity nickname can, in principle, differ, even though the Renderer pre-fills the
join form with the current nickname as a pure UX convenience
(`VoiceChannelView`'s `defaultDisplayName` prop).

## Server identity state

`services/realtime` holds only **per-connection-lifetime** identity state: `connectionId`, the
verified `identityId`, and the current `nickname` — all discarded the moment the connection closes.
T7 introduces **no** users/accounts/profile database, no password hashes, and no global identity
registry. Remote participants never see another connection's raw `identityId` — the existing
`participantId`/`displayName` UI surface is untouched; `connectionId`, `participantId`, and
`identityId` remain three explicit, distinct concepts (see
[`REALTIME_PROTOCOL.md`](REALTIME_PROTOCOL.md#connection-identity) and
[`WEBRTC_VOICE.md`](WEBRTC_VOICE.md)). A future task (T9) will add server-_local_ authorization state
keyed by `identityId` (permissions, groups, invite/privilege tokens, bans) — deliberately not
implemented here; T7 only proves _who_ a connection is, never _what it's allowed to do_.

## Regeneration

`regenerateIdentity()` mints and persists a brand-new keypair, replacing the current one. This is
**destructive** and **only ever** triggered by an explicit, confirmation-gated user action in
`IdentityPanel.tsx` (a native `window.confirm()` dialog explaining that servers will treat the new
identity as unrecognized). It is never triggered automatically — not on nickname change, not on an
app update, not on a connection or WebRTC failure. It takes effect for **future** connections only:
`RealtimeClient`'s `IdentitySigner` is only ever consulted at `connect()` time, so an already-`ready`
connection keeps using the identity it authenticated with until it disconnects and reconnects — there
is no mechanism to hot-swap a live connection's identity mid-session.

## Concurrency / races

- **Identity-creation race**: two concurrent first-ever callers to `getOrCreateIdentity()` (e.g. the
  Renderer's identity hook and a simultaneous `RealtimeClient.connect()`) share one in-flight
  `loadPromise` rather than each independently generating and persisting a keypair — only one
  identity ever becomes canonical. Regression-covered by
  `tests/desktop/identity-service.test.ts`'s "two concurrent first-ever callers" test (asserts
  `encryptString` — the only place a freshly generated key gets written — was called exactly once).
- **File-write race**: covered by the atomic write scheme above — `writeFileAtomic` guarantees no
  reader ever observes a half-written file.
- **Regeneration race**: `regenerateIdentity()` immediately replaces the in-memory `cachedIdentity`,
  so any _subsequent_ `signIdentityChallenge` call uses the new identity — but, per
  [Regeneration](#regeneration) above, a connection already `ready` never re-derives its identity
  mid-session, so there is no window where one connection's proof mixes old and new key material.

## Automated end-to-end verification

Two dedicated real-Electron E2E scripts, each run to 3 consecutive clean passes against final code:

- **`e2e:identity-persistence`** (`apps/desktop/scripts/e2e-identity-persistence.mjs`): launches a
  real (unpackaged) Electron instance against a fresh `--user-data-dir`, captures its reported
  `identityId`; launches again against the _same_ directory and confirms the _same_ `identityId`;
  launches against a _different_ directory and confirms a _different_ `identityId`. No realtime
  service or media device involved — identity loads before the app ever reaches the voice UI.
- **`e2e:identity-auth`** (`apps/desktop/scripts/e2e-identity-auth.mjs`): reuses
  `e2e-voice-smoke.mjs`'s proven two-Electron-instance harness (real realtime service, real fake-
  media voice join) and additionally confirms each instance's locally-reported `identityId` matches
  the `identityId` the server reported back in `server:hello`, that the two instances (two distinct
  local profiles) get two distinct `identityId`s, and that voice/media still works end to end.

Both scripts observe identity via two small, unconditional, non-sensitive `console.info` markers —
`disco-voador:local-identity-ready:<id>` (`use-identity.ts`) and
`disco-voador:server-authenticated-identity:<id>` (`realtime-client.ts`) — public data only, never
key material.

All four pre-existing media E2Es (`e2e:voice-smoke`, `e2e:camera-smoke`, `e2e:screen-smoke`,
`e2e:screen-audio-smoke`) were re-run against the final code and pass cleanly, confirming the now-
mandatory identity handshake introduces no regression to voice, camera, or screen sharing.

Additional coverage below the Electron layer:

- **Nickname stability across reconnect**: `tests/realtime/integration.test.ts`'s "keeps the same
  identityId across a nickname change and reconnect" — a real WebSocket client completes the
  handshake once as `"Alice"`, reconnects (fresh `connectionId`) as `"Bob"` using the _same_ keypair,
  and asserts `identityId` is unchanged.
- **Invalid-signature rejection before `ready`**: both
  `tests/realtime/protocol-handlers.test.ts` (pure state-machine level) and
  `tests/realtime/integration.test.ts` (real socket, real server) prove a proof signed with the
  wrong private key is rejected (`IDENTITY_INVALID_SIGNATURE`, close code 4411) before the connection
  ever reaches `ready`.
- **Exhaustive replay-resistance matrix** (`protocol-handlers.test.ts`): valid proof succeeds; the
  same proof replayed on the same (now-`ready`) connection is rejected; a proof copied to a different
  connection is rejected; an expired challenge is rejected; a signature over a modified nickname is
  rejected; a signature from a different private key is rejected; a schema-shaped-but-degenerate
  (all-zero) public key is handled safely (returns `false`, never throws).

## Known limitations

- **No component-level Renderer test harness**: this repository has no jsdom/React-Testing-Library
  dependency, so `FirstRunPrompt`/`IdentityPanel`/`useIdentity`'s interactive behavior (nickname
  submission, Copy ID, the Regenerate confirmation flow) is verified by manual testing
  (`pnpm dev`) rather than an automated component test — a pre-existing repository limitation, not
  introduced by T7. `tests/desktop/renderer-shell.test.ts` covers only the SSR-reachable loading
  state (effects never run under `renderToStaticMarkup`).
- **No portable identity export/backup**: deferred, matching T7's explicit scope boundary. The
  identity file is machine/user-bound (encrypted via `safeStorage`, which on Windows is scoped to
  the current OS user profile) — copying `identity.json` to another machine or user account will
  fail to decrypt, by design (DPAPI protection is bound to the encrypting user/machine).
- **Single default identity**: the wire protocol and storage format do not hardcode a single global
  identity, but the current UI only ever manages one ("Default") — a future multiple-local-identity
  manager (Work/Gaming/etc. profiles) can be added without a protocol change.

## Not implemented in T7 (explicitly deferred)

Dedicated Server product packaging (T8); server persistence of identities/accounts; server-local
permissions, groups, invite/privilege tokens, or bans (T9); text chat (T10); bookmarks/device-
settings overhaul (T11); a mandatory Disco Voador cloud/control-plane service (never planned — see
ADR 0010 and 0011).
