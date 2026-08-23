# ADR 0020: Server-local profile/avatar/presence storage and its privacy boundary

## Status

Accepted and implemented (T13.3).

## Context

T13.3 added the first genuinely personal, per-identity visual/social state this product has ever
persisted: a static avatar image, one bounded custom-status string, and a manual presence
preference (Online/Away/Do Not Disturb), plus a redesigned Member Panel that needs to show this for
every currently-online member, grouped by a safe notion of role. None of this existed before —
`identity_id` (T7) previously carried no visual/status attributes at all, and `MemberPanel` only
ever showed voice-channel-scoped participants (T13.1), never a server-wide member list.

This is also the first feature in this codebase to accept binary image data over the wire, and the
first to let one member's action (a moderator's) visibly affect what another member's client
renders. Both raise real trust-boundary questions a `software-architect` review resolved before
implementation: where does this state live, how is it kept from correlating across servers or
leaking a member's hidden-channel location, how is an uploaded image validated without an
image-processing dependency, and how does a moderator's "clear" action stay structurally incapable
of becoming a "set arbitrary content on someone else's behalf" action.

## Decision

**A fourth, independent SQLite file — `profiles.sqlite` — never merged into `authorization.sqlite`/
`chat.sqlite`/`channels.sqlite`.** Three tables: `avatar_assets` (asset_id/format/byte_length/
sha256_hex/image_bytes BLOB/created_at), `identity_profiles` (identity_id PK/presence_preference/
custom_status/avatar_asset_id FK/avatar_revision/updated_at), and a singleton `server_profile`
(avatar_asset_id FK/avatar_revision/updated_at). This continues T9/T10/T13.2's established pattern
of one physically separate file per persistence domain, with zero foreign keys crossing files —
`identity_id` is a bare string everywhere, exactly like every other cross-file reference in this
codebase. Avatar bytes are stored as a `BLOB` column, not a file on disk, for the same
atomic-crash-safety and existing-backup-model reasons T10 already established for chat message
bodies — an operator's existing "back up the data directory" story extends to avatars for free.

**Deliberately no nickname column, anywhere.** Nickname stays purely a live, per-connection value
(sourced from `PresenceRegistry`, itself sourced from `client:hello`'s existing nickname field —
unchanged since T7), never persisted as a durable profile attribute. `ProfilePort` (below) has no
method that could write or read one. This preserves T7's existing "nickname is not identity"
invariant and avoids a second, competing source of truth for display names.

**`PresenceRegistry` is a plain in-memory class in `services/realtime`, not a port.** Every other
piece of profile-adjacent state (`services/realtime/src/presence/registry.ts`) is ephemeral
live-connection membership — which identities are currently online, and the random session-scoped
`memberRef` token each one is given — that is always correctly reconstructed from zero on a
process restart, exactly like the pre-existing `VoiceRegistry`. Only the genuinely _persistent_ half
(avatar bytes/format/hash/revision, custom status text, presence _preference_) goes through a real
port. This mirrors the same ephemeral/persistent split T9 already drew between `VoiceRegistry` and
`AuthorizationStore`, applied to a new domain rather than inventing a new pattern.

**`ProfilePort` (new, in `services/realtime`) is the persistence seam**, composed the same way
`AuthorizationPort`/`ChatPort`/`ChannelPort` already are: an interface plus a permissive, non-
persistent default (`createNoopProfilePort()`) defined in `services/realtime`; the real
`SqliteProfileStore` lives in `services/dedicated-server` and is injected in. It never knows a
`memberRef`, a nickname, or which identities are currently online — those questions belong to
`PresenceRegistry` alone. Image validation (format sniffing, animated-format rejection, dimension
ceilings) is entirely the store implementation's concern; `services/realtime` decodes a client's
base64 payload into raw bytes and passes them straight through, never inspecting image content
itself.

**A fresh, random, session-scoped `memberRef` (`randomUUID()`) replaces `identityId` on every
presence-shaped message — never `identityId` itself, and never anything derived from it.**
`identityId` is a cross-server-stable value derived once from a client's Ed25519 keypair (ADR 0011) — the same value on every Dedicated Server that identity ever connects to. Every prior
protocol message that could reach another client already withheld it; a new server-wide presence
feature, unlike voice-channel-scoped `participantId`s (already freshly random per join), risked
reintroducing that correlation by exposing a server-wide identifier for the first time. `memberRef`
is minted once per identity on its first live connection (0→1 transition), shared across that
identity's simultaneous connections, and retired permanently the moment the last one closes — never
reused, never a function of `identityId`.

**Avatar delivery is a single bounded base64 field over the existing WebSocket/JSON transport — no
HTTP surface, no chunking.** `AVATAR_MAX_RAW_BYTES = 49_152` (48 KiB) and
`AVATAR_MAX_BASE64_LENGTH = 65_536` (64 KiB, the exact 4/3 base64 inflation of the raw bound) both
fit comfortably under `REALTIME_MAX_MESSAGE_BYTES` (81,920, raised by T6). User and server avatars
share this same byte budget; only their decoded pixel-dimension ceilings differ (512×512 user,
1024×1024 server) — deliberately not widening the shared transport limit or building this
codebase's first chunking mechanism just to give the server avatar more headroom.

**Image validation (`packages/shared/src/image-validation.ts`) is real header/magic-byte/chunk-
structure sniffing only — never a full pixel decode, and never extension/MIME trust.** PNG, JPEG,
and WebP are the only allowlisted formats (SVG/GIF/BMP/TIFF/anything else fails every signature
check and is rejected outright, an allowlist rather than a blocklist); an animated PNG (an `acTL`
chunk before the first `IDAT`, despite ordinary PNG magic bytes) and an animated WebP (its `VP8X`
flags byte's Animation bit _or_ a structural `ANIM`/`ANMF` chunk scan — either signal alone is
enough, defense in depth against a crafted flags byte disagreeing with real content) are both
rejected. This module was written once and moved into `packages/shared` (not left inside
`services/dedicated-server`) specifically because it has two real, independent consumers that must
never drift apart: the Dedicated Server's own authoritative validation before persisting an upload,
and the desktop Client's Main process, which must independently re-run the identical check on
avatar bytes _received from_ a remote Dedicated Server before ever caching or rendering them — a
malicious or compromised server operator is an untrusted input source into the local filesystem/
Renderer, a new trust direction this feature introduces that no prior task needed to consider.

**Member-grouping is exactly two closed, server-derived buckets — never a raw ACL group name.**
`memberRoleBucketSchema: 'admin' | 'moderator' | undefined`, computed fresh on every presence
broadcast from the viewer's actual effective permissions (`'admin'` for anyone holding a defined set
of broad server-management permissions or the built-in `server-admin` group; `'moderator'` for
anyone holding `moderation.kick`/`moderation.ban` via _any_ group). A Discord-style arbitrary role
list was considered and rejected — T9's custom groups are private, and their names/existence/count
must never leak merely to render a member list, exactly the kind of leak this ADR's own review was
tasked with preventing.

**No offline-member directory.** The Member Panel only ever shows currently-online members —
identical in spirit to `MemberPanel`'s pre-T13.3 "only currently-connected" scope, now widened from
"in this voice channel" to "connected to this server at all," not further. This sidesteps
persisting a nickname (see above) and avoids building an ever-growing anonymous "Guest directory"
this product has no other use for.

**A dedicated `moderation.profile.clear` permission, not a reuse of `moderation.kick`/`-ban`/
`server.manage`.** None of the existing keys cleanly names "clear-only power over another member's
own presentation data," and every message shape gated by it (`client:profile-clear-avatar{target:
'member'}`, `client:profile-clear-member-status`) is structurally incapable of setting arbitrary
content on someone else's behalf — there is no message shape that would let a caller do so, matching
this project's established "honest limits over checkbox theatre" posture (ADR-adjacent precedent:
`CHANNELS_AND_SERVER_ADMINISTRATION.md`'s deliberate omission of an unenforceable "who may speak"
control).

**`server.manage` is reused, unmodified, for the server's own avatar** — its first real enforcement
anywhere in this codebase (previously reserved, unused). A server-level, singleton avatar mutation
does not warrant a new permission key the way a per-member moderation action does.

**No protocol version bump.** Every wire change (the new `client:profile-*`/`server:profile-*`/
`server:presence-*` message family, `server:hello`'s new optional `serverAvatarRef` field,
`server:presence-snapshot`'s later-added optional `selfMemberRef` field — see "Consequences" below)
is additive, following T9's own "additive doesn't need a bump" precedent exactly.
`CURRENT_PROTOCOL_VERSION` stays 4.

## Consequences

- `packages/shared` gained its first real export. Its own placeholder doc comment ("add exports
  only when two real consumers justify them") is exactly the situation `validateAvatarImage`
  created — this is a genuine package-boundary change, recorded here rather than done casually.
- `apps/desktop` gained a new, stricter-than-precedent IPC pattern for its file picker
  (`selectAvatarImageFile`): unlike the existing screen-share source picker (which does return an
  opaque source id), this channel never returns a raw file path at all — only already-validated
  `{format, byteLength, base64}` or a typed failure — because a real filesystem path is more
  sensitive than an opaque capture-source id.
- Avatar rendering uses `data:` URIs exclusively, reusing the CSP's pre-existing `img-src 'self'
data:` directive (`nativeImageToDataUrl()` in `screen-share.ts` is the existing precedent) —
  `blob:` was deliberately not added to the CSP, since nothing here needs it.
- A real, if narrow, bug was found and fixed during this task's own post-implementation hardening,
  not by the formal reviews: `pushPresenceUpdate`'s self-service broadcasts were not excluding the
  acting connection, producing a duplicate self-row in every user's own Member Panel the instant
  they changed their own avatar/status/presence; and the closely related case of a moderator
  clearing a _different_ member's own avatar/status could produce the same duplicate for that
  target, since no connection had any way to recognize a `presence-updated` was about its own
  identity. Fixed by (a) giving `pushPresenceUpdate` an explicit `excludeActingConnection` parameter,
  `true` for every self-service call site and `false` for the two moderator-targets-another-member
  call sites, and (b) adding an optional `selfMemberRef` field to `server:presence-snapshot` so a
  connection can recognize and route out any later update naming its own identity. Both fixes are
  additive wire changes needing no version bump, per the policy above.
- A second, related gap found during the same hardening pass — a returning user's own previously-
  persisted presence/status/avatar was invisible in their own UI until they made a fresh mutation
  from that Client (there was no "get my current profile" read path) — was closed by having
  `handleIdentityProof` proactively push one `server:profile-self-updated` (reusing the existing
  reply shape, with a fresh id, not a reply to anything) as part of the same initial burst as
  `server:hello`/`voice:catalog`/`server:presence-snapshot`. The initial per-connection message
  burst is therefore five messages, not four, as of this task.
- `server:profile-set-avatar`/`-clear-avatar` targeting `'server'` reply only with the actor's own
  snapshot — there is no live broadcast of a server-avatar change to already-connected clients, only
  a future reconnect's `server:hello.serverAvatarRef`. The Renderer's `ServerProfileSection` covers
  this gap with an explicitly-labeled, non-persisted local optimistic preview rather than pretending
  a live sync exists; recorded here as a known, accepted limitation, not silently worked around.

## Alternatives

- **Store avatar bytes as files on disk, keyed by hash, instead of a `BLOB` column:** rejected —
  loses the atomic single-transaction crash-safety a `BLOB` write gets for free inside the same
  transaction as the row it belongs to, and introduces a second data-location an operator's backup
  procedure would need to know about, unlike every other persisted domain in this codebase.
- **Reuse `identityId` directly in presence/member messages instead of minting `memberRef`:**
  rejected outright — this is exactly the cross-server correlation ADR 0011 exists to prevent; every
  prior protocol surface already withholds `identityId` from other clients, and this feature must
  not become the first exception.
- **A Discord-style arbitrary custom-role list in the Member Panel:** rejected — T9's custom ACL
  groups are private; exposing their names/existence to build a role list would be a direct privacy
  regression this task's own review was explicitly tasked with avoiding.
- **A full image-decoding library (e.g. `sharp`) for avatar validation:** rejected — this codebase
  has no image-processing dependency today and this feature does not need pixel-level decoding to
  answer "is this a static PNG/JPEG/WebP under N×N," only header/chunk structure, which a small,
  dependency-free, directly-auditable module can answer correctly and fast.
