# ADR 0022: `identityRef` — a durable, per-server-only identity correlation token for local voice preferences

## Status

Accepted and implemented (T13.4 targeted fix).

## Context

T13.4 shipped per-participant local playback volume and "Mute for Me," but the implementing pass
persisted them keyed by `participantId` — the voice-channel session slot assigned fresh on every
`voice:join`. This meant the preference was forgotten the instant the remote user left/rejoined the
channel, the local client reconnected (T11), or either side relaunched the application — exactly the
real bug report this task fixes: "I lowered a peer's volume, but OvniChat forgets it."

The obvious-looking fix — persist by the remote user's `identityId` instead — is foreclosed by an
existing, hard invariant: `identityId` is derived once from a client's local Ed25519 keypair and is
the _same value_ on every independently-operated Dedicated Server that keypair ever connects to (ADR
0011). No wire message has ever sent it to another client for exactly this reason (see
`packages/protocol/src/profile.ts`'s own top doc comment, and ADR 0020's `memberRef` decision, which
faced the identical problem for server-wide presence). Reusing `identityId` here would let a
client that is present on two unrelated Dedicated Servers correlate "this person on Server A is the
same person as that person on Server B" — the exact cross-server deanonymization channel ADR 0011
closed.

`memberRef` (ADR 0020) does not solve this either: it is deliberately _online-session-scoped_,
minted fresh when an identity's live-connection count goes 0→1 and retired the moment it returns to 0. A local preference keyed by `memberRef` would survive a channel switch but not a disconnect, a
server restart, or an application relaunch — the three cases this task's own bug report centers on.

What is actually needed is a third kind of identifier: stable for a given real identity _on one
particular server_, for as long as that identity ever exists there, but — critically — bearing no
relationship to the value the same identity would get on a _different_ server, so it can never be
used to reopen the correlation channel `identityId`'s own withholding exists to prevent.

## Decision

**A new wire field, `identityRef` (`packages/protocol/src/profile.ts`'s `identityRefSchema`), added
to `voiceParticipantSchema`** (`voice:joined.participants[]`, `voice:participant-joined.participant`).
Generated once, server-side, the first time anything asks for a given `identityId`'s ref
(`ProfilePort.getOrCreateIdentityRef`), and persisted forever after in the same `identity_profiles`
table ADR 0020 already established (`services/dedicated-server/src/profile/store.ts`, migration v2:
`identity_ref TEXT`, nullable, lazily backfilled — never eagerly migrated for every existing row, the
same "only ever gains a value once something actually needs one" discipline `avatar_asset_id` already
follows). A fresh `randomUUID()`, never a hash or other deterministic function of `identityId` — two
different Dedicated Servers seeing the exact same real identity mint two _unrelated_ values, so even
a client present on both can never prove they are the same person from `identityRef` alone. This is
`memberRef`'s own anti-correlation property, deliberately extended to survive a full disconnect
(unlike `memberRef`, this value is never retired).

**Scoped to `voiceParticipantSchema` only — not added to `memberPresenceSchema` (T13.3's server-wide
presence).** The only consumer that needs a durable per-identity handle today is per-participant
local voice preference; widening the server-wide presence surface as well is a larger, separate
decision (it would also resolve `MemberRow.tsx`'s own disclosed speaking-indicator gap — see
`docs/tasks/T13_4_GAMER_VOICE_EXPERIENCE.md`'s "Known limitations") deliberately left to a future task
rather than bundled in here under time/scope pressure.

**Consumed entirely client-side, entirely locally.** The Renderer (`use-voice-channel.ts`) maintains
a `participantId -> identityRef` map from these two messages and uses it only to key
`window.desktopApp.getVoicePreference`/`setVoicePreference` — Main-process IPC over the existing T11
settings file (`apps/desktop/src/main/settings/settings-file.ts`'s `voicePreferences`, already keyed
`(serverScopeKey, <inner key>)`; the inner key, previously loosely called "identityId" in that file's
own comments/parameter names — a leftover from before this correlation problem was solved — is now
consistently named `identityRef` throughout `settings-file.ts`/`settings-service.ts`/`ipc.ts`/
`preload/index.ts`/`ipc-contract.ts`). No new client-to-server message exists or is needed:
`identityRef` only ever flows server-to-client; nothing is ever written back.

**Multiple simultaneous sessions of the same identity share one preference.** T13.3 already supports
more than one live connection per identity; if two of that identity's sessions are in the same voice
channel, a volume/mute change made against either participant row applies to every `participantId`
currently mapped to that `identityRef` (`participantIdsForIdentityRef`, `use-voice-channel.ts`) and
persists exactly one entry, never one per session slot.

**Debounced writes, immediate for mute.** A live-dragged volume slider can fire many updates a
second; the actual `setVoicePreference` IPC call is debounced (400ms) per `identityRef`, while
"Mute for Me" (a discrete click) persists immediately and always re-sends the currently-known volume
unchanged, so muting can never reset it. Every pending debounced write is flushed synchronously on
genuine session teardown (disconnect, server switch, unmount) rather than left to a timer that might
never fire.

**Protocol version bumped, 4 → 5.** `identityRef` is a required field on an already-`.strict()`-
validated existing message shape (`voiceParticipantSchema`) — exactly the class of change
`packages/protocol/src/version.ts`'s own evolution policy (T7/T8/T13.2's precedent) treats as
breaking, not additive, regardless of whether a real pre-existing wire consumer happens to exist yet.
Deliberately _not_ made optional the way T9's `groups` field was: `identityRef` only has value if
every consumer can rely on it always being present, and the server has no scenario where it cannot
compute one — unlike `groups`, genuinely absent for a server with no authorization store. v4 support
was dropped rather than kept as a parallel codepath, matching T7/T8/T13.2's own precedent exactly.

## Consequences

- `ProfilePort` gained its fourth method (`getOrCreateIdentityRef`), implemented identically in
  `SqliteProfileStore` (real, persisted) and `createNoopProfilePort` (in-memory, process-lifetime
  only) — the same seam-plus-permissive-default shape every other port in this codebase already uses.
- `identity_profiles` gains a fifth column. Reviewed explicitly against `migrations.ts`'s own "data
  minimization is mandatory" rule (ADR 0020): unlike every column that rule already rejects
  (nickname, email, `lastSeen`, geo, history of any kind), `identity_ref` carries no behavioral or
  temporal signal whatsoever — a single opaque, per-server-unique pointer with no other meaning.
- A genuine, no-behavior-change rename accompanied this fix: every internal variable/parameter in the
  voice-preference persistence path that previously read `identityId` (a stale name from before this
  ADR's own problem was solved, since the value flowing through it was always meant to be a safe
  correlation handle, never the real portable identifier) is now named `identityRef` throughout, to
  prevent a future reader from assuming the local settings file ever holds a raw `identityId`.
- A real, live-verified regression in this task's own automated evidence: an E2E screenshot-capture
  helper's remote-speaking-ring proof used an _unscoped_ DOM query that happened to match the local
  user's own row rather than the intended remote peer — unrelated to `identityRef` itself, but found
  during this same hardening pass and recorded in
  `docs/architecture/GAMER_VOICE_EXPERIENCE.md`'s "Screenshots" section for completeness.

## Alternatives

- **Reuse `identityId` directly in `voiceParticipantSchema`:** rejected outright — the exact
  cross-server correlation channel ADR 0011/ADR 0020 already closed; this task must not become the
  first exception.
- **Reuse `memberRef`:** rejected — its online-session-scoped lifetime (retired at 0 live
  connections) does not survive a disconnect, server restart, or relaunch, which is precisely the
  scenario this fix targets.
- **A client-side-only pseudonym (e.g. hash of displayName + first-seen time), no server involvement
  at all:** rejected — trivially unstable (a nickname change, or the same identity appearing under a
  different transient label) and not authoritative (a malicious display-name collision could spoof
  another identity's local preference). A server-authoritative token tied to the verified `identityId`
  is the only source that is both stable and unspoofable.
- **Widening `memberPresenceSchema` (server-wide presence) to also carry `identityRef` in this same
  task:** deferred, not rejected — genuinely useful for `MemberRow.tsx`'s own disclosed gap, but a
  larger surface change than this targeted fix's own scope justifies; left for a future task to
  design deliberately rather than bundled in under time pressure.
