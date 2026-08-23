# Profiles, avatars, members & presence (T13.3)

> This document describes the server-local profile/avatar/presence system T13.3 implemented. See
> [`tasks/T13_3_PROFILES_AVATARS_PRESENCE.md`](../tasks/T13_3_PROFILES_AVATARS_PRESENCE.md) for the
> task record and [`adr/0020-profile-presence-storage-and-privacy-boundary.md`](../adr/0020-profile-presence-storage-and-privacy-boundary.md)
> for the accepted decision. A `software-architect` review preceded implementation; this document
> reflects what was actually built and verified, not just what was designed.

## Why this exists

Through T13.2, no client had any visual or social presentation beyond a live nickname and voice-
channel participation. `MemberPanel` only ever showed who was in the _current voice channel_, never
who was connected to the server at all, and no client could set an avatar, a status message, or a
manual online/away/DND state. T13.3 adds all three, entirely server-local per Dedicated Server (no
global/cross-server profile of any kind), with a hard product boundary: no DM/friend/message system
exists or is implied anywhere in this feature.

## Storage: a fourth, separate SQLite file

`<dataDir>/profiles.sqlite`, opened via the same `openManagedDatabase`/`withTransaction` utilities
every other store shares, with its own independent migration sequence and zero foreign keys into
`authorization.sqlite`/`chat.sqlite`/`channels.sqlite` — see
[ADR 0020](../adr/0020-profile-presence-storage-and-privacy-boundary.md) for the full reasoning.

### Schema (version 1)

```sql
CREATE TABLE avatar_assets (
  asset_id     TEXT PRIMARY KEY,
  format       TEXT NOT NULL CHECK (format IN ('png','jpeg','webp')),
  byte_length  INTEGER NOT NULL,
  sha256_hex   TEXT NOT NULL,
  image_bytes  BLOB NOT NULL,
  created_at   INTEGER NOT NULL
);

CREATE TABLE identity_profiles (
  identity_id        TEXT PRIMARY KEY,
  presence_preference TEXT NOT NULL DEFAULT 'online' CHECK (presence_preference IN ('online','away','dnd')),
  custom_status      TEXT,
  avatar_asset_id    TEXT REFERENCES avatar_assets(asset_id),
  avatar_revision    INTEGER NOT NULL DEFAULT 0,
  updated_at         INTEGER NOT NULL
);

CREATE TABLE server_profile (
  singleton_id     INTEGER PRIMARY KEY CHECK (singleton_id = 1),
  avatar_asset_id  TEXT REFERENCES avatar_assets(asset_id),
  avatar_revision  INTEGER NOT NULL DEFAULT 0,
  updated_at       INTEGER NOT NULL
);
```

No nickname column exists anywhere in this schema — nickname stays a live, per-connection value
sourced from `client:hello`, exactly as it has been since T7. Replacing an avatar deletes the old
`avatar_assets` row in the same transaction as inserting the new one (one-way, write-only, no
history/rollback — mirrors T13.2's channel-password precedent). No email, phone, real name, IP,
device fingerprint, geo, game history, presence history, or `lastSeen` column exists — data
minimization matching every prior store's own discipline.

## Ephemeral vs. persistent: `PresenceRegistry` vs. `ProfilePort`

`services/realtime/src/presence/registry.ts`'s `PresenceRegistry` is a plain in-memory class,
**not** a port — it tracks which identities are currently online (a `Set<connectionId>` per
identity, supporting multiple simultaneous connections for the same identity) and mints/retires a
random `memberRef` per identity, correctly reconstructed from zero on every process restart, the
same way `VoiceRegistry` already is.

`ProfilePort` (`services/realtime/src/profile-port.ts`) is the persistence seam for the genuinely
durable half — avatar bytes/format/hash/revision, custom status, presence _preference_ — composed
the same way `AuthorizationPort`/`ChatPort`/`ChannelPort` already are: an interface plus
`createNoopProfilePort()` (a functional, non-persistent in-memory default, mirroring
`createNoopChannelPort`'s "permissive, not just error stubs" precedent) defined in
`services/realtime`; `SqliteProfileStore` (`services/dedicated-server/src/profile/store.ts`) is the
real implementation, injected in.

```ts
interface ProfilePort {
  getUserProfile(identityId: string): ProfileSnapshot;
  getServerProfile(): { readonly avatarRef: AvatarRef | undefined };
  setUserAvatar(identityId, format, rawBytes): SetAvatarResult;
  clearUserAvatar(identityId): void;
  setServerAvatar(format, rawBytes): SetAvatarResult;
  clearServerAvatar(): void;
  setCustomStatus(identityId, customStatus: string | undefined): void;
  setPresencePreference(identityId, preference: PresenceStatus): void;
  getUserAvatarData(identityId): AvatarData | undefined;
  getServerAvatarData(): AvatarData | undefined;
}
```

## Image validation: `@disco-voador/shared`'s `validateAvatarImage`

Originally written inside `services/dedicated-server`, then moved into `packages/shared` once the
Renderer/Main side needed the identical logic (see ADR 0020's own reasoning for why duplicating it
was unacceptable). Pure, synchronous, total over a `Buffer` — never throws for a hostile-but-
well-formed input, only for a genuine programmer error.

- **PNG**: exact 8-byte signature check, then a real structural chunk walk (never a substring
  search) — `IHDR` must be the first chunk (width/height read directly from it), and an `acTL`
  chunk appearing anywhere before the first `IDAT` marks it APNG (animated, despite ordinary PNG
  magic bytes).
- **JPEG**: 3-byte signature, then a real segment-marker scan for a genuine Start-Of-Frame marker
  (`0xC0`-`0xCF`, excluding `0xC4`/`0xC8`/`0xCC`, which are not real SOF markers), reading
  width/height from ITU-T T.81's fixed frame-header offsets. No animated form exists for JPEG.
- **WebP**: `RIFF`/`WEBP` container check, then branches on the first chunk's FourCC (`VP8X`
  extended/animation-capable, `VP8 ` lossy key frame, `VP8L` lossless). For `VP8X`, animation is
  detected via **two independent signals** — the flags byte's Animation bit, and a structural scan
  of the remaining chunk list for `ANIM`/`ANMF` — rejecting if _either_ indicates animation, defense
  in depth against a crafted flags byte disagreeing with real chunk content.
- Anything not matching one of these three signatures is rejected outright (an allowlist, not a
  blocklist) — this is what makes SVG/GIF/BMP/TIFF rejection structural, not a filename/MIME check.
- A format/content mismatch (declared vs. sniffed) is always rejected as `AVATAR_INVALID_FORMAT`,
  never silently corrected to the sniffed format.
- A correctly-sized _animated_ image gets its own dedicated failure code, `AVATAR_ANIMATED_NOT_
ALLOWED`, distinct from `AVATAR_DIMENSIONS_TOO_LARGE` — added during this task's own independent
  verification pass specifically so client-side copy can say "animated images aren't allowed"
  rather than the factually-wrong "dimensions too large" for a correctly-sized animated image.

Byte/dimension ceilings: `AVATAR_MAX_RAW_BYTES = 49_152` (48 KiB), `AVATAR_MAX_BASE64_LENGTH =
65_536` (64 KiB), 512×512 for a user avatar, 1024×1024 for the server avatar — both share the same
byte budget, only the dimension ceiling differs (see ADR 0020).

## Protocol

New message family in `packages/protocol/src/profile.ts` / `packages/protocol/src/messages/
profile.ts`. No protocol version bump — every change here is additive.

**Client → server** (all require `ready`; the server always derives the actor's identity from the
authenticated connection, never from a client-supplied field):

| Message                              | Shape                                              | Authorization                                                                              |
| ------------------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `client:profile-set-avatar`          | `{target: 'self'\|'server', format, imageBase64}`  | `'self'`: none. `'server'`: `server.manage`.                                               |
| `client:profile-clear-avatar`        | `{target: 'self'\|'server'\|'member', memberRef?}` | `'self'`: none. `'server'`: `server.manage`. `'member'`: `moderation.profile.clear`.       |
| `client:profile-set-status`          | `{customStatus?}`                                  | Self-service only.                                                                         |
| `client:profile-clear-member-status` | `{memberRef}`                                      | `moderation.profile.clear`.                                                                |
| `client:profile-set-presence`        | `{presence: 'online'\|'away'\|'dnd'}`              | Self-service only.                                                                         |
| `client:profile-request-avatar`      | `{target: 'self'\|'server'\|'member', memberRef?}` | None (pull-based fetch; unknown/offline `memberRef` returns non-fatal `MEMBER_NOT_FOUND`). |

The `target: 'member'` messages are structurally clear-only — there is no message shape anywhere in
this family that lets a caller set arbitrary content on another member's behalf, matching this
project's "honest limits over checkbox theatre" doctrine.

**Server → client:**

- `server:profile-self-updated` — confirms a successful self-service mutation to the actor, **and**
  is now also proactively pushed once by `handleIdentityProof` as part of a connection's initial
  burst (see "Two hardening fixes" below), carrying the identity's real persisted state rather than
  requiring a fresh mutation to see it.
- `server:profile-avatar-data` — reply to `client:profile-request-avatar`.
- `server:presence-snapshot` — sent once per connection at `ready`, the full online-member list
  (never the recipient's own entry) plus `selfMemberRef` (see below).
- `server:presence-updated` — pushed on any online member's presence-relevant change.
- `server:presence-removed` — pushed when an identity's last live connection closes.
- `server:hello` gained one new optional field, `serverAvatarRef`.

`MemberPresence`: `{memberRef, displayName, presence, customStatus?, avatarRef?, roleBucket?}` —
`roleBucket` is `'admin' | 'moderator' | undefined`, the only role-shaped information ever sent (see
ADR 0020's privacy reasoning). No field in this entire message family, anywhere, carries a
channel-shaped reference — structurally enforced (every schema was audited) and covered by a
dedicated hostile-client-style integration test.

## `memberRef` and multi-connection semantics

`memberRef` is minted (`randomUUID()`, zero relation to `identityId`) on an identity's first live
connection and shared across every simultaneous connection that identity has; it is retired
permanently the moment the last one closes. Presence _preference_ and nickname are identity-level,
last-write-wins across simultaneous connections (documented, deliberate) — disconnecting one of
several connections never flips the identity to Offline while another remains live. Covered by a
real two-socket integration test.

## Member-grouping and privacy

`services/realtime/src/presence/role-bucket.ts`'s `deriveMemberRoleBucket` computes `'admin'`
(holds a defined set of broad server-management permissions, or is a member of the built-in
`server-admin` group) or `'moderator'` (holds `moderation.kick` or `moderation.ban` via _any_
group) fresh on every broadcast — never a raw group name, never cached/stale like the pre-existing,
unrelated T9 `voiceParticipantSchema.groups` surface. The Renderer's `MemberPanel` buckets entries
into "Admins" / "Moderators" / "Members," skipping empty buckets and falling back to one flat list
when no member has a bucket at all.

## Renderer / Electron surface

- `UserAvatar`/`ServerAvatar` (`apps/desktop/src/renderer/ui/`) are thin wrappers over the existing
  `Avatar` primitive's dormant `imageUrl` prop (prepared since T13.1), resolving an `AvatarRef` to a
  `data:` URI via `use-avatar-url.ts` against `VoiceChannelState.avatarCache` — a non-authoritative,
  content-addressed (keyed by `AvatarRef.hash`) local cache, lazily populated at most once per
  distinct hash actually rendered.
- `ProfileEditor.tsx` — the current user's own avatar/status/presence editor, reachable from
  `UserControlBar`. Uses "Profile" terminology throughout (never "Account") and states the current
  server context explicitly ("Profile on {serverName}").
- `MemberProfilePopover.tsx` — read-mostly (avatar, name, presence, status, `roleBucket` badge),
  with **zero DM/friend/message affordance of any kind** — a hard, deliberate product boundary, not
  an oversight. A viewer holding `moderation.profile.clear` additionally sees clear-only "Clear
  avatar"/"Clear status" actions for that member.
- `ServerProfileSection.tsx` — server avatar Change/Remove inside Server Settings, gated on
  `server.manage`; the whole "Server Profile" nav entry is hidden entirely (not merely disabled) for
  a caller without it, matching T13.2's own honest-limits convention.
- `selectAvatarImageFile` (Main-process IPC, `apps/desktop/src/main/avatar-images.ts`) — a native
  file picker that reads the picked file's real bytes, validates them via `@disco-voador/shared`,
  and returns only `{format, byteLength, base64}` or a typed failure — **never a raw file path**, a
  deliberately stricter posture than the existing screen-share source picker.
- `validateAvatarImageBytes` (a second Main-process IPC channel) re-validates avatar bytes received
  from a remote Dedicated Server before the Renderer ever caches or renders them — a malicious or
  compromised server operator is treated as an untrusted input source into the local
  filesystem/Renderer, a new trust direction this feature introduces.
- Avatars render via `data:` URIs exclusively, reusing the CSP's pre-existing `img-src 'self' data:`
  directive — `blob:` was not added.

## Two hardening fixes found and closed after implementation

Neither was found by the formal security or QA reviews — both were found by the orchestrating
session's own post-implementation code reading and a live QA re-verification pass, and both are now
fixed, tested, and live-verified. See ADR 0020's "Consequences" section for the summary; full detail
here:

**1. Duplicate self-row on any self-service mutation.** `pushPresenceUpdate` broadcast every
self-service `server:presence-updated` to _every_ ready connection, including the acting one, which
already had the same information via its own `server:profile-self-updated` reply — contradicting
`serverPresenceUpdatedMessageSchema`'s own doc comment ("every _other_ ready connection") and
`VoiceChannelState.members`' own "never includes the local user's own entry" invariant. Every user
who changed their own status/avatar/presence saw a phantom duplicate of themselves. Fixed by giving
`pushPresenceUpdate` an explicit `excludeActingConnection` parameter — `true` for every `target:
'self'` call site, `false` for the two `target: 'member'` (moderator-clears-another-member) call
sites, where the acting moderator's own connection still needs the broadcast to update its own view
of the target. A regression test (`tests/dedicated-server/profile-integration.test.ts`) asserts the
actor's own socket never receives this broadcast for its own mutation.

**2. The same duplicate could recur for a moderation _target_, and separately, a returning user's
own profile was invisible until their next mutation.** When a moderator clears a _different_
member's own avatar/status, that target's own connection correctly still receives the broadcast
(it needs to learn its own status changed) — but no connection had any way to recognize "this
update is about me," since `memberRef` was never told to its own owner. Fixed by adding an optional
`selfMemberRef` field to `server:presence-snapshot` (populated from `PresenceRegistry.getMemberRef`
at the same ready-transition point the snapshot is already built); the Renderer now routes any
`presence-updated` naming its own `selfMemberRef` into `selfPresence`/`selfCustomStatus`/
`selfAvatarRef` instead of `members`. Separately, `handleIdentityProof` now also proactively pushes
one `server:profile-self-updated` — reusing the existing reply shape with a fresh id, not a reply to
anything — as part of the same initial burst as `server:hello`/`voice:catalog`/`server:presence-
snapshot`, closing the "no self-profile read endpoint" gap: a returning user's real persisted
avatar/status/presence is now accurate immediately on every connect/reconnect. **The initial
per-connection burst is five messages as of this task, not four** — every test helper that drains a
fixed count of initial messages was updated accordingly (`tests/dedicated-server/{profile-
integration,integration}.test.ts`, `tests/realtime/integration.test.ts`), since the server sends all
five back-to-back in one synchronous loop that can arrive as a single TCP burst.

## Security review outcome

No release-blocking findings. One medium, non-exploitable finding was fixed anyway: a Renderer
cross-server-isolation reset branch (clearing `members`/`avatarCache`/profile state on a connection's
terminal close) was wired to a `stateChange` listener detached _before_ `controller.disconnect()`
could fire it, so it silently never ran on any real teardown path — masked only by an unrelated
`AppShell` remount-by-connection-key mechanism that happened to already guarantee the same isolation
by fully discarding the hook instance. Fixed by reordering cleanup so `disconnect()` fires while the
listener is still attached, so the documented guarantee is now actually true rather than incidentally
covered by a different mechanism. Two informational notes required no action: profile/avatar-fetch
rate limiters are scoped per-connection (matching the already-accepted `channelPasswordRateLimiter`
precedent, not a new or weaker gap), and `avatarRef.hash` carries no cryptographic binding to the
bytes a server actually returns for it (inherent to the self-hosted, operator-controlled trust model
— an operator can already assert arbitrary presence data outright).

## QA review outcome

Exercised the full live product: avatar upload/removal/rejection (including the exact
`AVATAR_ANIMATED_NOT_ALLOWED` copy), custom status with its 128-char boundary, the Online/Away/DND
selector, member popovers (both plain and moderator views, confirming zero DM affordance), the
Server Profile admin section's permission-gated visibility, and Member Panel grouping — via real,
non-mocked two/three-instance Electron E2E scenarios (`e2e:profile-avatar-smoke`, `e2e:server-
avatar-smoke`, `e2e:profile-server-isolation-smoke`), plus the full pre-existing regression suite.
Found both hardening-fix defects above through live reproduction (not guessed), verified both fixes
end to end after they landed, and found one unrelated real bug in a _pre-existing_ E2E script
(`e2e-authorization.mjs`) exposed by the burst-size change — its own fragile fixed-count message
draining (a fragility class its own comment already named) was replaced with this repository's
shared, content-matching buffered protocol-client helpers, eliminating the fragility rather than
bumping another magic number.
