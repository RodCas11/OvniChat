import { z } from 'zod';

import { displayNameSchema } from './identifiers.js';

/**
 * T13.3 — server-local profile/avatar/presence wire schemas: online-connected-members-only
 * presence (never an offline directory), a manual presence *preference*, a bounded custom status,
 * and small avatar images validated from header bytes only (never fully decoded — see
 * `services/dedicated-server/src/profile/image-validation.ts`). Deliberately crypto/Node-free,
 * matching every other file in this package — the actual persistent store (SQLite, migrations,
 * image-header validation) lives entirely in `services/dedicated-server/src/profile/`, never here.
 *
 * **Non-negotiable privacy rule**: nothing in this file (or `messages/profile.ts`) ever carries a
 * raw `identityId` to another client, and nothing here ever carries a channel-shaped field
 * (`channelId`/`currentChannelId`/anything similarly named) — see `memberRefSchema`'s own doc
 * comment and `services/realtime/src/presence/registry.ts` for why. This surface is a new,
 * cross-voice-channel, server-wide broadcast; reusing `identityId` directly here would silently
 * reopen the cross-Dedicated-Server correlation channel ADR 0011 closed (an `identityId` is the
 * same stable value across every independently-operated server the same local keypair connects
 * to — see `voiceParticipantSchema`'s own doc comment in `messages/voice.ts` for the precedent this
 * follows).
 */

// ASCII control characters (C0 controls 0x00-0x1F and DEL 0x7F) are rejected in custom status text
// — same reasoning as every other operator/user-facing display string in this package.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = new RegExp('^[^\\x00-\\x1F\\x7F]*$', 'u');

/** The manual Online/Away/Do Not Disturb preference a user explicitly chooses — independent of
 * whether they currently have any live connection at all. Persisted in `identity_profiles` /
 * `PresenceRegistry` is never consulted for this value. Contrast {@link effectivePresenceSchema},
 * which is what is actually shown to other members. */
export const presenceStatusSchema = z.enum(['online', 'away', 'dnd']);
export type PresenceStatus = z.infer<typeof presenceStatusSchema>;

/** What is actually rendered for a member: the manual preference above, collapsed to `'offline'`
 * whenever the identity has zero live connections (`PresenceRegistry`'s 0-connection state) —
 * computed server-side, never client-asserted. */
export const effectivePresenceSchema = z.enum(['online', 'away', 'dnd', 'offline']);
export type EffectivePresence = z.infer<typeof effectivePresenceSchema>;

export const CUSTOM_STATUS_MAX_LENGTH = 128;
/** Trimmed, bounded, control-character-free free text — an empty/omitted value clears it. Never a
 * trust or authorization signal, matching `displayNameSchema`'s own posture. */
export const customStatusSchema = z
  .string()
  .trim()
  .max(CUSTOM_STATUS_MAX_LENGTH)
  .regex(CONTROL_CHARACTER_PATTERN, 'control characters are not allowed');

/**
 * Both user and server avatars share this exact same decoded-byte budget (48 KiB) — a deliberate
 * architecture call: raising it for the server avatar specifically would require either widening
 * `REALTIME_MAX_MESSAGE_BYTES` for every message type or a chunked upload protocol, both
 * disproportionate for this task. `AVATAR_MAX_BASE64_LENGTH` is the exact 4/3 inflation of
 * {@link AVATAR_MAX_RAW_BYTES} (base64 encodes 3 raw bytes as 4 characters), rounded up to a clean
 * value. Decoded *pixel-dimension* ceilings differ by target (512x512 user, 1024x1024 server) —
 * that distinction is enforced server-side by `image-validation.ts`, not expressible in this
 * byte-length-only schema.
 */
export const AVATAR_MAX_RAW_BYTES = 49_152;
export const AVATAR_MAX_BASE64_LENGTH = 65_536;

/** A closed, three-format allowlist — anything else (SVG, GIF, BMP, TIFF, ...) is rejected
 * outright by `image-validation.ts`, never by a blocklist. */
export const avatarImageFormatSchema = z.enum(['png', 'jpeg', 'webp']);
export type AvatarImageFormat = z.infer<typeof avatarImageFormatSchema>;

export const avatarBase64Schema = z
  .string()
  .max(AVATAR_MAX_BASE64_LENGTH)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/u, 'must be base64');

/**
 * A fresh, random, **online-session-scoped** token minted by `PresenceRegistry` the moment an
 * identity's live-connection count goes 0->=1, and retired permanently (never reused) the moment
 * it goes back to 0 — never derived from `identityId` in any way (never a hash of it, never it
 * verbatim). This is the one identifier this entire presence surface exposes to other clients for
 * "who is this member" — see this file's own top doc comment for why that must never be
 * `identityId` itself.
 */
export const MEMBER_REF_MAX_LENGTH = 64;
export const memberRefSchema = z.string().min(1).max(MEMBER_REF_MAX_LENGTH);

/**
 * T13.4 — a durable, per-`(Dedicated Server, identity)` opaque correlation token, generated once
 * (`randomUUID()`, server-side) the first time that identity is ever referenced by anything needing
 * one, and persisted forever after — see `services/dedicated-server/src/profile/store.ts`'s
 * `getOrCreateIdentityRef`. Exists specifically so a client's own *local* per-participant voice
 * preferences (volume/"Mute for Me", T13.4) can survive that remote user's reconnect/relaunch without
 * ever exposing raw `identityId` to another client, which this file's own top doc comment already
 * forbids for a hard reason: `identityId` is the *same* value across every independently-operated
 * Dedicated Server the same local keypair connects to (ADR 0011), so broadcasting it here would
 * silently reopen the cross-server correlation channel that document closed.
 *
 * **Distinct from both `memberRef` and `identityId` — do not conflate the three:**
 * - `identityId`: portable, the same everywhere this keypair connects. Never sent to another client,
 *   anywhere, full stop.
 * - `memberRef` (above): online-session-scoped — minted fresh when an identity's live-connection
 *   count goes 0->1, retired the moment it returns to 0. Reused across multiple simultaneous
 *   connections for the same identity, but a *new* random value every time that identity comes back
 *   online after going fully offline.
 * - `identityRef`: durable and per-server, generated once and never regenerated (short of the
 *   identity itself being wiped, e.g. `AUTHORIZATION_BAN_PURGED`-style data removal — not a thing
 *   this codebase does today). Two different Dedicated Servers mint two *unrelated* random values for
 *   the very same real identity — there is no shared secret, hash, or deterministic function tying
 *   them together — so even a client present on both can never use `identityRef` to prove the two
 *   accounts are the same person, the same anti-correlation property `memberRef` already has, just
 *   extended to survive a reconnect.
 */
export const IDENTITY_REF_MAX_LENGTH = 64;
export const identityRefSchema = z.string().min(1).max(IDENTITY_REF_MAX_LENGTH);
export type IdentityRef = z.infer<typeof identityRefSchema>;

/** Identifies a specific avatar image without embedding its bytes — `revision` increments on every
 * replace (garbage-collecting the old `avatar_assets` row in the same transaction, no history), and
 * `hash` is the image's own sha256 hex digest, letting a client cache-key/skip a redundant
 * `client:profile-request-avatar` for content it already has. */
export const avatarRefSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    hash: z.string().regex(/^[a-f0-9]{64}$/u, 'must be a sha256 hex digest'),
  })
  .strict();
export type AvatarRef = z.infer<typeof avatarRefSchema>;

/**
 * A server-computed-only classification of a member's global permission holdings — **never** a raw
 * custom group name (which could reveal a custom group's existence/naming to every member, not
 * just those who can manage authorization). `'admin'` covers holding any of the closed set of
 * server-administration permission keys (or built-in `server-admin` group membership); `'moderator'`
 * covers holding `moderation.kick`/`moderation.ban` via *any* group, built-in or custom — deriving
 * from the permission a group grants, never from which group grants it. See
 * `services/realtime/src/presence/role-bucket.ts` for the exact derivation function. Absent means
 * "plain member," rendered with no badge at all.
 */
export const memberRoleBucketSchema = z.enum(['admin', 'moderator']);
export type MemberRoleBucket = z.infer<typeof memberRoleBucketSchema>;

/**
 * A member as seen by every other connected client — deliberately **never** includes `identityId`
 * or anything channel-shaped (see this file's own top doc comment). `roleBucket` is recomputed
 * fresh on every broadcast (never a join-time snapshot the way `voiceParticipantSchema.groups` is),
 * an intentional improvement over that earlier design's known staleness limitation.
 */
export const memberPresenceSchema = z
  .object({
    memberRef: memberRefSchema,
    displayName: displayNameSchema,
    presence: effectivePresenceSchema,
    customStatus: customStatusSchema.optional(),
    avatarRef: avatarRefSchema.optional(),
    roleBucket: memberRoleBucketSchema.optional(),
  })
  .strict();
export type MemberPresence = z.infer<typeof memberPresenceSchema>;

/**
 * Bounds `server:presence-snapshot.members` — presence tracks only currently-online identities
 * (`PresenceRegistry`, never an offline directory), so this is realistically bounded by how many
 * distinct identities could ever be simultaneously online, not an arbitrary large constant. Chosen
 * with headroom above `REALTIME_MAX_CONNECTIONS`'s own default (`services/realtime/src/config.ts`,
 * 1,000) since one identity can hold more than one live connection but still occupies only one
 * presence slot.
 */
export const MAX_PRESENCE_MEMBERS = 1_024;
export const memberPresenceListSchema = z.array(memberPresenceSchema).max(MAX_PRESENCE_MEMBERS);
