# Server-local authorization (T9, permission registry extended by T10 and T13.2)

Canonical contracts live in code at
[`services/dedicated-server/src/authorization/`](../../services/dedicated-server/src/authorization/),
[`services/realtime/src/authorization-port.ts`](../../services/realtime/src/authorization-port.ts),
and [`packages/protocol/src/authorization.ts`](../../packages/protocol/src/authorization.ts); this
document explains the design and is not itself authoritative. See
[`REALTIME_PROTOCOL.md`](REALTIME_PROTOCOL.md) for the connection handshake this integrates into,
[`CLIENT_IDENTITY.md`](CLIENT_IDENTITY.md) for the T7 identity proof authorization is layered on top
of, [`DEDICATED_SERVER.md`](DEDICATED_SERVER.md) for the T8 product boundary this task extends,
[`PERSISTENT_TEXT_CHAT.md`](PERSISTENT_TEXT_CHAT.md) for T10's persistent chat, which reuses this
groups/permissions model rather than inventing its own, and
[`../adr/0013-server-authorization-storage-and-rbac.md`](../adr/0013-server-authorization-storage-and-rbac.md)
for the storage/RBAC decision this document elaborates.

## Core product rule

Authentication (T7) answers "which cryptographic identity is connecting?" Authorization (this task)
answers "what is that identity allowed to do on _this_ server?" The two are layered, never merged —
nothing in T9 weakens or bypasses the T7 identity proof; admission is evaluated strictly _after_ it
succeeds.

```text
Ed25519 identity -> identityId -> Dedicated Server A: Guest | Member | Moderator | Server Admin
                                -> Dedicated Server B: Guest (no relationship to A's memberships)
```

The same identity can be Server Admin on one Dedicated Server and an ordinary Guest on another —
there is no global authorization state anywhere, by construction (see
[Cross-server isolation](#cross-server-isolation)).

## Data split

| Data                                | Lives where                        | Lifetime                                                              |
| ----------------------------------- | ---------------------------------- | --------------------------------------------------------------------- |
| Group definitions, permissions      | Dedicated Server's SQLite store    | Persistent, per-server                                                |
| Identity -> group memberships       | Dedicated Server's SQLite store    | Persistent, per-server (never for a non-persistent Guest — see below) |
| Token digests + metadata            | Dedicated Server's SQLite store    | Until consumed or deleted; raw token never stored                     |
| Bans                                | Dedicated Server's SQLite store    | Persistent (permanent) or until `expiresAt` (temporary)               |
| A connecting Guest's own membership | Nowhere                            | Not created — see [Data minimization](#data-minimization)             |
| Nickname, IP                        | Nowhere in the authorization store | Runtime connection state only, unrelated to authorization             |

## Built-in groups

Three reserved, protected groups, seeded once at first-ever database initialization:

| Group id       | Default permissions  | Deletable | Permissions editable |
| -------------- | -------------------- | --------- | -------------------- |
| `guest`        | `voice.channel.join` | No        | Yes                  |
| `member`       | `voice.channel.join` | No        | Yes                  |
| `server-admin` | every permission key | No        | **No**               |

`server-admin`'s permission set is a compile-time constant, never editable via
`client:authorization-update-group` (rejected with `PROTECTED_GROUP`) — this is what makes "the
admin group cannot be edited into uselessness" (T9 Section 32) structurally true rather than an
app-level check with its own race window. `guest`/`member` are protected only from _deletion_;
their permission sets remain operator-editable (T9 Section 65 explicitly expects a restrictive
custom server to be able to remove `voice.channel.join` from Guest).

An operator may create additional custom groups (e.g. "Moderator") via
`client:authorization-create-group` — deliberately **not** pre-seeded (unlike an earlier draft of
this design): T9's own spec frames Moderator as something an admin creates from scratch as a worked
example, and pre-seeding a fourth built-in group with no way to justify its exact permission set
would have been unforced scope growth.

## Permission registry

A small, closed set — never an open string, so an unrecognized key can never become "executable
behavior," and every key corresponds to something the Dedicated Server can actually,
authoritatively enforce itself:

```text
voice.channel.join                 — join a voice channel
moderation.kick                    — disconnect an online participant, no persistent record
moderation.ban                     — ban/unban/list bans
authorization.groups.manage        — create/update/delete groups
authorization.memberships.manage   — grant/revoke group membership
authorization.tokens.manage        — create privilege/invite tokens
server.manage                      — server-level administration; first real use is the server's own avatar (T13.3)
chat.server.send                   — send a message to Server Chat (T10)
chat.channel.send                  — send a message to a voice channel's chat (T10)
channels.create                    — create a root-level category/voice channel (T13.2)
channels.manage                    — global override of any node's Manage rights (T13.2)
channels.delete                    — global override of channel/category deletion (T13.2)
channels.password.bypass           — join a password-protected channel without the password (T13.2)
moderation.profile.clear           — clear (never set) another member's own avatar/custom status (T13.3)
```

`server.manage`'s doc comment previously read "reserved for future server-level administration" —
T13.3's server-avatar Change/Remove is its first real enforcement anywhere in this codebase.
`moderation.profile.clear` is deliberately its own key, not a reuse of `moderation.kick`/`-ban` or
`server.manage`: none of those cleanly names "clear-only power over another member's own
presentation data," and the two message shapes it gates
(`client:profile-clear-avatar{target:'member'}`, `client:profile-clear-member-status`) are
structurally incapable of setting arbitrary content on someone else's behalf — see
[`SERVER_LOCAL_PROFILES_AND_PRESENCE.md`](SERVER_LOCAL_PROFILES_AND_PRESENCE.md) for the full design.

Deliberately excludes anything the current P2P architecture cannot authoritatively enforce (e.g. a
"camera forbidden" permission — a malicious client could still place media into WebRTC directly).
Adding a new key is additive and needs no protocol version bump, provided a client treats an
unrecognized key as simply absent, never fatal — the two `chat.*` keys T10 added, and the four
`channels.*` keys T13.2 added, are real proof of this policy working as intended after the fact.
Reading chat history requires no permission at all (see
[`PERSISTENT_TEXT_CHAT.md`](PERSISTENT_TEXT_CHAT.md)) — only sending does. T13.2's own channel-ACL
system (Visibility/Join/Manage against these T9 groups, layered per-channel — see
[`CHANNELS_AND_SERVER_ADMINISTRATION.md`](CHANNELS_AND_SERVER_ADMINISTRATION.md)) is the same "exclude
what cannot be authoritatively enforced" discipline applied a second time: it deliberately has no
"who may speak" permission, for the identical P2P-media reasoning this paragraph's own "camera
forbidden" example already establishes.

## Admission flow

Evaluated once, synchronously, immediately after `client:identity-proof`'s signature verifies and
before the connection can ever reach `ready` (`protocol-handlers.ts`'s `handleIdentityProof`):

```text
identity proof verified -> identityId derived
        |
   banned? --------- yes ---> BANNED (fatal, close 4421)
        | no
   has persistent membership? --- yes ---> admitted with that membership's groups/permissions
        | no
   accessMode == open? --- yes ---> admitted as virtual Guest (no row written)
        | no (invite-only)
   serverToken present, unconsumed, unexpired, kind invite-or-bootstrap?
        | no ---> INVITE_REQUIRED (fatal, close 4420)
        | yes --> atomically consume token, grant its group, admitted
```

`server:hello` is unchanged by T9; a new `server:authorization-state` message (groups + permission
keys) is sent immediately after it, and again — targeted, never broadcast — whenever an
administrator's action changes that connection's own groups live.

### Data minimization

An admitted Guest on an `open` server writes **no row to the authorization store** —
`AuthorizationStore.admit()` returns the virtual `guest` baseline computed from the built-in group
definition, without ever touching `identity_group_memberships`. A persistent _authorization_ record
is created only when something concrete requires it: an invite is redeemed, a privilege token is
redeemed, or an administrator explicitly grants a group. Regression-tested directly against the real
SQLite file (`tests/dedicated-server/authorization-store.test.ts`'s "a Guest admitted on an open
server creates no persistent membership row" — inspects the file with a _separate_ raw connection,
independent of the store's own read path).

**T10 correction:** the claim above is specifically about the _authorization_ store
(`authorization.sqlite`) — it is still true, unchanged by T10. It is no longer accurate to say a
Guest connection writes "no row anywhere" without qualification: if that same Guest sends a chat
message, the Dedicated Server's _separate_ chat store (`chat.sqlite`) persists that message and its
minimal authorship metadata — this is intentional (the entire point of persistent chat, T10) and
does not create an authorization membership row. See
[`PERSISTENT_TEXT_CHAT.md`](PERSISTENT_TEXT_CHAT.md#data-minimization-change-from-t9) for the
precise, corrected statement and its own regression evidence.

### Bootstrap on an invite-only server

**Updated by T15's security fix — see "Server Admin bootstrap" below for the current mechanism; this
section's history is preserved because the underlying operator-lockout problem it solved is still
real and still solved, just by a different token kind.** A server started directly in `accessMode:
invite-only` must not permanently lock out its own operator — a fresh identity has no persistent
membership and no invite yet exists, so _something_ has to satisfy the pre-connection admission check
besides an `'invite'`-kind token, or the operator could never even connect to redeem their own admin
credential. Originally (T9) this was the one-time `'bootstrap'`-kind token described below; T15
removed that token kind entirely (see below) and the admission check now accepts a `'privilege'`-kind
row instead — the exact kind `chantivo-server admin-token create` mints. This grants no new
capability: `'privilege'` tokens are already admin-issued-or-explicitly-minted-by-an-operator-with-
shell-access, never self-servable by an ordinary participant. Regression-tested
(`authorization-store.test.ts`'s "T15 initial admin claim" block) and exercised end to end by the
real-socket integration suite and `tests/dedicated-server/token-leak-regression.test.ts`.

## Server Admin bootstrap

**Redesigned by T15's security fix.** The original design (a fresh authorization store automatically
generating a `DV-ADMIN-<43-char base64url>` token and having `cli.ts` print it in the server's own
startup banner) leaked the raw admin-equivalent secret into infrastructure log collectors: `cli.ts`
runs inside the same long-running, systemd/Docker-supervised process whose stdout is captured
wholesale into `journalctl -u chantivo-server` / `docker compose logs` — confirmed for real on the
validation VPS's own journal. A fresh authorization store now seeds only its three built-in groups and
claims no admin at all; the server's startup banner instead prints a safe, non-secret hint ("No
administrator has claimed this server yet. Run: sudo chantivo-server admin-token create") whenever
`AuthorizationStore.hasAnyServerAdmin()` reports false, gated so it never repeats once claimed. The
very first Server Admin credential a server ever has now comes exclusively from an explicit, one-shot
`chantivo-server admin-token create` invocation (`cli-admin-token.ts`) — a distinct process whose
stdout is never part of the supervised service's captured log stream — using the exact same
`createToken`/`'privilege'`-kind mechanism as every later recovery call. There is no longer a separate
"initial claim" mechanism distinct from "lost my token, recover" — they are now the same command, and
the disposable, always-repeatable one already had this safety property before T15.

## Tokens

Privilege keys, invite tokens, and the bootstrap token are all the same underlying mechanism: an
opaque, high-entropy bearer secret (`DV-<PRIV|INVITE|ADMIN>-<43-char base64url>`,
`token-crypto.ts`), stored only as a SHA-256 digest, with `kind`, target `groupId`, `createdAt`,
optional `expiresAt`, and `consumedAt`/`consumedByIdentityId` once redeemed. No password-hashing KDF
(bcrypt/scrypt/argon2) is used — deliberately: these are random 256-bit capabilities, not
low-entropy human-chosen secrets, so a single fast SHA-256 digest is already computationally
infeasible to reverse, the same reasoning `packages/identity` already applies to Ed25519 key
material (T9 Section 12's own explicit guidance).

**Privilege keys** target any group an administrator chooses (`authorization.tokens.manage`
required) and can be redeemed by an already-connected identity via `client:authorization-redeem-
token` (the "Use Privilege Key" UI action) regardless of `accessMode`.

**Invite tokens** are the same mechanism with one additional capability: they may also be presented
at admission time (`client:hello.serverToken`) on an `invite-only` server, per the [admission
flow](#admission-flow) above.

**Atomicity** (T9 Section 47/80, mandatory): a single SQL compare-and-swap —
`UPDATE tokens SET consumed_at = ? WHERE token_digest = ? AND consumed_at IS NULL` — wrapped in a
transaction with the membership grant, run inside one synchronous `AuthorizationStore` method call.
Because `node:sqlite`'s `DatabaseSync` is synchronous and Node's event loop is single-threaded, two
"simultaneous" redemption attempts from different connections are actually serialized by the
runtime itself — the second one's `UPDATE` always affects zero rows (`changes !== 1`), which the
store treats as a normal, expected loss, not an error. See
[ADR 0013](../adr/0013-server-authorization-storage-and-rbac.md) for why this was a correctness
requirement, not just an implementation convenience. Verified directly
(`authorization-store.test.ts`'s "a token is single-use: exactly one of two sequential redemption
attempts succeeds") and, more importantly, through the real product entrypoint via a genuine two-
Electron-instance race is not required for confidence here since the guarantee is structural, not
timing-dependent — the store-level test proves the invariant unconditionally.

## Bans

Identity-based only (T9 Section 21) — never IP, never a hardware fingerprint. A ban row is
`identityId`, `createdAt`, optional `expiresAt` (permanent if absent), optional operator-supplied
`reason` (never required or auto-collected). Evaluated at admission time and enforced live: an
administrator banning an _online_ participant (`client:authorization-ban`, targeting a
`participantId` the server resolves to a connection/identity itself — never a client-supplied
identity value) atomically persists the ban and forcibly closes that connection with `BANNED`
(close code 4421) in the same handler. `listBans()` filters to currently-active bans only
(`expires_at IS NULL OR expires_at > now`) — an expired temporary ban simply stops applying; there is
no cleanup cron requirement (T9 Section 22 explicitly allows lazy expiry).

## Last-admin protection

`revokeGroup(identityId, 'server-admin')` and any attempt to delete the `server-admin` group both
refuse to leave the server with zero identities holding it — checked inside the same transaction as
the mutation itself (`AuthorizationStore.revokeGroup`), not as a separate app-level guard with its
own race window. A _second_ Server Admin can always be revoked; only the _last_ one is protected.
Regression-tested directly, including the "grant a second admin, revoke the first, then the second
cannot also be revoked" sequence.

## Protocol messages

All additive to the existing discriminated unions — see
[`REALTIME_PROTOCOL.md`](REALTIME_PROTOCOL.md#versioning) for why this did not require a protocol
version bump. Full schemas: `packages/protocol/src/messages/authorization.ts`.

```text
client:authorization-redeem-token      -> server:authorization-token-redeemed
client:authorization-create-token      -> server:authorization-token-created  (raw token, shown once)
client:authorization-list-groups       -> server:authorization-groups
client:authorization-create-group      -> server:authorization-ack
client:authorization-update-group      -> server:authorization-ack
client:authorization-delete-group      -> server:authorization-ack
client:authorization-grant-group       -> server:authorization-ack (+ targeted server:authorization-state to the target, if online)
client:authorization-revoke-group      -> server:authorization-ack (+ targeted server:authorization-state, or a forced close if no longer admitted)
client:authorization-kick              -> server:authorization-ack (+ forced close of the target, KICKED)
client:authorization-ban               -> server:authorization-ack (+ forced close of the target, BANNED)
client:authorization-unban             -> server:authorization-ack
client:authorization-list-bans         -> server:authorization-bans
```

`client:authorization-unban` is the one message that legitimately carries a raw `identityId` from
client to server — an administrator managing bans has no online `participantId` to target, and T9
Section 25 explicitly expects a ban-management view to show identity ids. Every other moderation
message targets a `participantId`, which the server resolves to `identityId` itself
(`VoiceRegistry.findByParticipantId`) — never trusting a client-supplied identity value for
anything else.

### Error codes

Two new **fatal** (connection-closing) codes join T7's `IDENTITY_*` family: `BANNED` (4421),
`INVITE_REQUIRED` (4420); `KICKED` (4422) is fatal but only ever closes an already-`ready`
connection, never an admission-time rejection. Everything else —
`AUTHORIZATION_DENIED`, `GROUP_NOT_FOUND`, `PROTECTED_GROUP`, `LAST_ADMIN`, `TOKEN_INVALID`,
`TOKEN_EXPIRED`, `TOKEN_ALREADY_USED`, `PARTICIPANT_NOT_FOUND` — is **non-fatal**, matching T3's own
precedent for ordinary, expected admin-UI conditions: the connection stays open. See
`packages/protocol/src/errors.ts`'s doc comment for the full reasoning per code.

## Server-side enforcement

Every privileged mutation is checked once, centrally, in `services/realtime/src/protocol-
handlers.ts`, via `ctx.authorization.can(identityId, <permission>)` — before the corresponding
`AuthorizationStore` method is ever called. Client UI (the "Authorization" panel — see
[Client UX](#client-ux) below) hides sections a connection's own `myPermissions` don't include, but
that is a presentation courtesy, never the actual boundary: a Guest that hand-crafts
`client:authorization-create-group` is rejected server-side with `AUTHORIZATION_DENIED` regardless
of what its own UI happened to show, proven by a real-socket integration test
("a Guest cannot perform an admin-only action") that never goes through the Renderer at all.

## Cross-server isolation

Each `AuthorizationStore` instance owns its own SQLite connection with no module-level shared
state — two `createDedicatedServer(...)` calls in the same process (as
`tests/dedicated-server/integration.test.ts` does to prove isolation) share nothing. A bootstrap
token, privilege key, or invite token created by Server A digests to a value Server B's own store
has never seen, so it is simply `TOKEN_INVALID` there — proven directly
(`integration.test.ts`'s "a bootstrap token from Server A is invalid on Server B"). A ban on Server
A has no row in Server B's `bans` table. The same local identity independently authenticating to
both servers gets two completely independent authorization outcomes — this is not a special case
the code has to handle, it falls directly out of each server owning a private, unrelated database.

## Client UX

- **`ConnectionScreen`** gained an optional "Server Token" field (T9 Section 17) — a `type=password`
  input, cleared from component state immediately after one connect attempt, never persisted to
  bookmarks/settings, never logged. Only meaningful against an `invite-only` server; harmless
  (ignored server-side) against an `open` one.
- **`AuthorizationPanel`** (`apps/desktop/src/renderer/voice/AuthorizationPanel.tsx`) — a minimal,
  functional (not polished, per T9 Section 83) panel: a "Use Privilege Key" redemption box always
  available to any connected user, and admin sections (Tokens, Groups, Bans, per-participant Grant/
  Kick/Ban) that render only when `state.myPermissions` includes the relevant key — presentation
  convenience only, per [Server-side enforcement](#server-side-enforcement) above.
- **Participant badges**: `VoiceParticipant.groups` (wire) is a snapshot taken at join time,
  rendered next to a participant's display name in both the plain participant list and the admin
  panel. Deliberately **not** live-updated in other viewers if that participant's groups change
  mid-session — see [Known limitations](#known-limitations).
- **Connection-failure UX**: `server:error` (including `BANNED`/`INVITE_REQUIRED` at admission time)
  already surfaces through the pre-existing `onServerError` -> `state.lastError` path
  (`use-voice-channel.ts`, unchanged since T3) — `VoiceChannelView` renders it as plain text, never
  raw protocol JSON. `ConnectionScreen`'s own `connectionError` prop remains always `undefined` (a
  known T8 limitation, not widened by T9 — see below).

## E2E evidence

- **`services/dedicated-server/scripts/smoke.mjs`**: extended to capture the real one-time bootstrap
  token from the server's own stdout banner and redeem it over a real socket, proving the bootstrap
  flow through the actual product CLI entrypoint.
- **`apps/desktop/scripts/e2e-authorization.mjs`** (new, T9 Section 78): a real Electron client's
  full journey — connect, redeem an invite to become Member, get banned live by an administrator
  (a lightweight raw-socket driver, not a second Electron instance — justified by the task's own
  "does not need to exercise every admin UI path if integration tests cover protocol deeply"),
  fail to reconnect while banned, get unbanned, and successfully reconnect — using the _same_
  `--user-data-dir` relaunched three times, confirming the identity never changes across the whole
  cycle. Found and fixed a real Windows-specific bug while building it: relaunching the same
  profile immediately after externally `kill()`-ing the previous instance produced a reproducible
  `safeStorage`/DPAPI decrypt failure on `identity.json` — fixed by having each instance exit via
  Electron's own `app.exit()` instead, the same technique `e2e-identity-persistence.mjs` already
  relied on. Two consecutive clean runs.
- **`tests/dedicated-server/authorization-store.test.ts`** (88 assertions across bootstrap, data
  minimization, admission, bans, groups, grant/revoke/last-admin, tokens, restart persistence,
  permission evaluation) and **`tests/dedicated-server/integration.test.ts`**'s new "T9 authorization
  (real network)" suite (bootstrap-over-the-wire, invite-only admission, live ban and disconnection,
  server-side enforcement, cross-server token isolation) — all against real sockets and, for restart
  persistence, a real file on disk, never `:memory:` alone.

## Known limitations

- Participant group badges are a join-time snapshot, not live-updated to other viewers if an
  admin changes that participant's groups mid-session — only the affected identity's own
  `server:authorization-state` (and thus its own permission gating) updates live.
- `ConnectionScreen`'s `connectionError` prop is still always `undefined` (a T8-recorded limitation)
  — a failed connection attempt (wrong address, `INVITE_REQUIRED`, `BANNED`) is visible once the
  Renderer has already mounted `VoiceChannelView` (via `state.lastError`), not on the connection
  screen itself before that transition. Not widened by T9; a good target for a future UX task.
- No group-permission-change live re-evaluation broadcast beyond the directly affected identity's
  own state — matches T9's own scope (Section 61 asked for the affected identity's authority to
  update promptly, not a full presence-wide re-sync).
- No admin UI for editing an _existing_ token's expiry, or for browsing consumed/expired tokens —
  out of scope; T9 only requires creation, redemption, and listing bans.
