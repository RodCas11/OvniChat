# T13.3 — Profiles / Avatars / Members / Presence

## Goal

Give every identity a real, server-local visual and social presentation: a static avatar image, one
bounded custom-status string, and a manual presence state (Online/Away/Do Not Disturb, plus a
server-derived Offline) — surfaced through a redesigned, privacy-safe Member Panel and a member
profile popover, with self-service editing and a moderation action that can clear (never rewrite)
another member's own presentation data.

## Context

T13.1/T13.1.1 built the visual foundation; T13.2/T13.2.1 gave the Dedicated Server a real,
dynamically administered channel hierarchy. Neither touched identity presentation at all —
`MemberPanel` only ever showed voice-channel-scoped participants, and no client had any avatar,
status, or presence concept beyond a live nickname. A `software-architect` review was conducted
before implementation (see Handoff notes and
[`architecture/SERVER_LOCAL_PROFILES_AND_PRESENCE.md`](../architecture/SERVER_LOCAL_PROFILES_AND_PRESENCE.md))
covering storage boundary, the ephemeral/persistent split, avatar delivery, privacy-safe member
grouping, and the moderation-clear design — this task implements that design.

## In scope

- A new server-local `profiles.sqlite` store (avatar assets, per-identity profile, singleton server
  profile), composed into `services/dedicated-server` alongside the existing three stores.
- Real server-local user avatars (static PNG/JPEG/WebP only — animated formats of any kind
  structurally rejected) and a real, admin-managed server avatar.
- Manual presence only: Online/Away/Do Not Disturb, plus a server-derived Offline — no Invisible, no
  automatic idle/away detection, no game/Rich-Presence detection of any kind.
- One bounded custom-status string (128 chars, plain text, no rich-presence fields).
- A redesigned Member Panel: real avatars/presence/status, widened from "in this voice channel" to
  "connected to this server at all," grouped into two safe, closed buckets (Admins/Moderators) plus
  a flat Members list — never a raw ACL group name.
- A member profile popover with **no DM/friend/message affordance of any kind** — a hard product
  boundary, not an oversight.
- Self-service profile management (avatar/status/presence) requiring no admin permission.
- A moderation action (`moderation.profile.clear`) that can _clear_ — never rewrite or
  impersonate — another member's avatar or custom status.
- A new `selectAvatarImageFile` Main-process IPC (never exposing a raw file path) and client-side
  re-validation of server-supplied avatar bytes before caching/rendering.
- A non-authoritative local server-avatar cache tied to bookmarks, invalidated by the server's own
  `avatarRef` revision/hash.
- New E2E scripts (`e2e:profile-avatar-smoke`, `e2e:server-avatar-smoke`,
  `e2e:profile-server-isolation-smoke`) and the full pre-existing regression suite.

## Out of scope (deferred to later T13.x tasks)

Speaking/mute indicators, voice-activity UX, push-to-talk, per-user volume, join/leave sounds, and
any game/Rich-Presence detection (T13.4); stream theatre, detached windows, PiP, new camera-grid
architecture (T13.5). **No DM/friend/social-graph system was added or implied anywhere** — OvniChat
has none, and this task's own member popover deliberately has zero such affordance.

## Architecture constraints

- `identityId` (cryptographic identity, T7/ADR 0011) must never be conflated with or changed by any
  visual-profile mutation (avatar/status/presence) — enforced structurally (no message in this
  feature carries or accepts an `identityId`).
- No profile/avatar/status/presence data is ever global or cross-server — each Dedicated Server owns
  its own `profiles.sqlite` entirely, with zero foreign keys into any other store and zero shared
  state between two independently configured server instances.
- A server-wide presence identifier (`memberRef`) must never be, or be derivable from, `identityId`
  — the cross-server correlation privacy property ADR 0011 established must not be reintroduced by
  this feature.
- No message in this entire family may ever carry a channel-shaped field — a member's hidden-channel
  location (T13.2's own invariant) must never leak through presence/profile data.
- Private T9 custom ACL group names/existence must never leak through member-grouping — only the
  two closed, server-derived buckets (`'admin'`/`'moderator'`) may ever be sent.
- Image validation is header/magic-byte/chunk-structure sniffing only — never a full pixel decode,
  never extension/MIME trust — and must reject SVG (script/XSS vector), animated formats, and any
  oversized/decompression-bomb-shaped input before expensive work.
- No fabricated data, no client-side-only security control: every mutation is server-authorized;
  hiding an admin/moderation affordance in the UI is a courtesy, never the real boundary.

## Relevant packages

`packages/protocol`, `packages/shared` (new real consumer — image validation), `services/realtime`,
`services/dedicated-server`, `apps/desktop`.

## Relevant agents

`realtime-backend-engineer` (primary, backend — protocol/presence/storage), `electron-desktop-engineer`
(Renderer/Main UI, file-picker IPC, avatar caching), `software-architect` (pre-implementation design
review — complete, see Handoff notes), `qa-engineer` and `security-reviewer` (final gates).

## Relevant skills

`project-orientation`, `planning-feature`, `realtime-protocol`, `electron-development`,
`security-review`, `testing-quality`.

## Acceptance criteria

See the task's own Definition of Done checklist below, summarized with real evidence in the Handoff
notes.

## Definition of Done

Complete only when: avatar/status/presence are genuinely server-persisted and correctly isolated
per Dedicated Server; image validation structurally rejects non-static/non-allowlisted formats
before any expensive work; `memberRef` carries zero relationship to `identityId`; the Member Panel
never leaks a private ACL group name or a member's hidden-channel location; the member popover has
no DM/friend/message affordance; a moderator can clear but never set another member's presentation
data; the Main-process file picker never returns a raw file path; server-supplied avatar bytes are
re-validated before being cached/rendered; the new E2E scenarios and the full existing regression
suite pass; security and QA review findings are addressed; and documentation reflects the actual
final system. Otherwise: IN PROGRESS.

## Handoff notes

### What is real and verified

**Backend**: `profiles.sqlite` (v1 schema), `PresenceRegistry` (ephemeral, in-memory,
`memberRef` minted via `randomUUID()` with zero derivation from `identityId` — personally verified
by direct code reading, not just the doc comment), `ProfilePort`/`SqliteProfileStore`, the shared
`validateAvatarImage` sniffer (moved into `packages/shared` once a second real consumer — the
Renderer/Main side — needed byte-identical behavior), the six new `client:profile-*` handlers, two
new per-connection rate limiters (profile mutation, avatar fetch), and privacy-safe role-bucket
derivation are all implemented in `services/realtime`/`services/dedicated-server`/`packages/protocol`/
`packages/shared` and covered by `tests/{dedicated-server,realtime,shared}/*.test.ts`.

**Renderer/Electron**: `UserAvatar`/`ServerAvatar` (built on the existing `Avatar` primitive's
dormant `imageUrl` slot), the redesigned `MemberPanel`/`MemberRow` (real avatars/presence/status,
Admins/Moderators/Members grouping), `ProfileEditor`, `MemberProfilePopover` (zero DM affordance,
verified directly against rendered DOM), `ServerProfileSection` (hidden entirely without
`server.manage`), the `selectAvatarImageFile`/`validateAvatarImageBytes` Main-process IPC pair (never
returning a raw file path), and the content-addressed local avatar cache are all implemented and
reuse the T13.1/T13.1.1 design system throughout. 1373 Vitest tests pass repo-wide; `tsc`/`eslint`/
`prettier`/`tsc -b` are clean.

**Live-verified via real Electron + real Dedicated Server E2E** (all re-run against final code,
after every fix below landed): `e2e:profile-avatar-smoke` (real file-picker upload, live cross-client
update, removal, restart persistence, and — after the second hardening fix — correct same-session
restoration of a user's own avatar/status/presence with no fresh mutation); `e2e:server-avatar-smoke`
(admin upload via the real Server Settings UI, visible on a fresh reconnect, "Server Profile" absent
entirely for a non-admin holding other admin-adjacent permissions); `e2e:profile-server-isolation-smoke`
(the same identity across two independently-running Dedicated Server instances, zero cross-
contamination in either direction across repeated reconnects, proven via independent third-party
observers on each server). The full pre-existing E2E suite (`product-shell-smoke`,
`channel-admin-smoke`, `channel-hidden-smoke`, `channel-temporary-smoke`, `reconnect-channel-smoke`,
`authorization`, `identity-auth`, `identity-persistence`, `text-chat-persistence`, `reconnect-smoke`,
`settings-persistence`, `connection-smoke`, `voice-smoke`, `camera-smoke`, `screen-smoke`,
`screen-audio-smoke`, `process-audio-smoke`) was re-run against the final, combined, repackaged
build with no regression — `process-audio-smoke`'s known environmental flakiness class did not
reproduce this run (all 4 sub-scenarios passed, 77-99 dB isolation margins).

Nine real screenshots from an actual packaged Electron instance (checked into
[`screenshots/t13-3/`](screenshots/t13-3/): the Profile editor; the presence selector; an
avatar-upload-rejected error state; the redesigned Member Panel; a member popover as a plain member
and as a moderator; the Server Profile admin section; the current-user bottom bar; and Server
Settings with "Server Profile" hidden for a non-admin) were captured and personally visually
reviewed, twice. The first pass found what looked like a broken/malformed large-avatar rendering in
four of the nine screenshots; live DevTools-equivalent inspection (`img.complete`/`naturalWidth`/
`naturalHeight`) traced it to the QA pass's own synthetic PNG test fixture (arbitrary non-zlib
`IDAT` bytes and zero-filled chunk CRCs — passed this feature's own deliberately header-only
sniffer correctly, since it never validates compressed-data integrity, but a real Chromium decoder
correctly refused to render it), not a product defect — confirmed by rewriting the fixture with a
real compressed, correctly-checksummed raster and recapturing, which resolved cleanly. Recorded here
because it is exactly the kind of finding a personal visual review is for, even though the resolution
was in test tooling, not product code.

### Security and QA review

**Security review** found no release-blocking issues. Every explicitly-named invariant (no
`identityId` correlation leak, no raw file path to the Renderer, server-supplied avatar bytes
re-validated before caching, header-sniffing-only image validation with real APNG/animated-WebP
structural detection, no decompression-bomb-shaped work, no unsafe rendering of custom-status/
display-name text, clear-only moderation authorization, no impersonation, member-grouping and
hidden-channel privacy, per-server isolation, rate limiting actually wired into every handler, no
`blob:` CSP widening, no DM/social-graph surface, correct multi-connection behavior) was
independently checked against real code paths, not doc comments, and confirmed holding. One medium,
non-exploitable finding was fixed anyway: a Renderer cross-server-isolation reset branch was wired
to a listener detached before it could ever fire on a real teardown path, masked only by an
unrelated remount mechanism that happened to already guarantee the same isolation — fixed so the
documented guarantee is genuinely delivered by the code that claims it. Two informational notes
required no action (per-connection rate-limit scoping matches an already-accepted precedent;
`avatarRef.hash` has no cryptographic binding to server-returned bytes, inherent to the self-hosted
trust model). See
[`architecture/SERVER_LOCAL_PROFILES_AND_PRESENCE.md`](../architecture/SERVER_LOCAL_PROFILES_AND_PRESENCE.md)'s
"Security review outcome" section and [`SECURITY.md`](../SECURITY.md)'s T13.3 section for the full
record.

**QA review** exercised every product scenario live (avatar upload/removal/rejection with the
correct `AVATAR_ANIMATED_NOT_ALLOWED` copy, custom status and its 128-char boundary, the presence
selector, member popovers in both plain and moderator form, the Server Profile admin section's
permission-gated visibility, Member Panel grouping) via real, non-mocked multi-instance Electron E2E
scenarios, and found two real product defects, both fixed:

1. **Duplicate self-row on any self-service mutation** — `pushPresenceUpdate` was broadcasting a
   self-service mutation's `server:presence-updated` back to the acting connection itself,
   contradicting the message's own doc comment and the Member Panel's "never includes the local
   user's own entry" invariant. Every user who changed their own status/avatar/presence saw a
   phantom duplicate of themselves. Root-caused via live reproduction, fixed by excluding the acting
   connection specifically for self-targeted mutations (never for a moderator acting on a different
   member, which still needs the broadcast), with a new regression test proving it server-side.
2. **A user's own avatar/status/presence was not restored after reconnect** — there was no
   "get my current profile" read path, so a returning connection's own view fell back to defaults
   until a fresh mutation. Fixed by having the server proactively push the identity's real persisted
   profile as part of its normal connection-ready burst; also closed a related, narrower instance of
   finding 1 (a moderator clearing a _different_ member's own data could produce the same duplicate
   for that target, since no connection could recognize an update was about its own identity) with a
   new `selfMemberRef` field on the connection-ready snapshot.

QA also found and fixed one real bug in a _pre-existing_ E2E script (`e2e-authorization.mjs`),
exposed as fallout from the connection-burst message count changing from four to five messages: its
own fragile, fixed-count inline message draining broke, and was replaced with this repository's
shared, content-matching buffered protocol-client helpers — eliminating a fragility class its own
comment already named, not just patching the immediate symptom. See
[`architecture/SERVER_LOCAL_PROFILES_AND_PRESENCE.md`](../architecture/SERVER_LOCAL_PROFILES_AND_PRESENCE.md)'s
"Two hardening fixes" and "QA review outcome" sections for the full record.

### Privacy confirmation

- No central account, no DM system, no server discovery, no cloud sync, no new analytics, no
  mandatory OvniChat-operated service. Avatar/status/presence data is entirely server-local, never
  shared between independently operated Dedicated Servers, never uploaded anywhere beyond the one
  Dedicated Server a client explicitly connects to.
- No nickname persistence, no offline-member directory, no raw ACL group names ever exposed through
  member data.

### Next task

**T13.4 — Gamer voice experience.** Not implemented as part of T13.3.
