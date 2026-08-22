import { z } from 'zod';

/**
 * A stable, machine-readable voice-channel identifier — distinct from its human-readable display
 * name. Bounded and pattern-restricted so a garbage value fails schema validation
 * (`INVALID_MESSAGE`) before ever reaching the server's channel catalog lookup
 * (`CHANNEL_NOT_FOUND`), the same two-layer structural-vs-semantic split used for
 * `protocolVersion` in `messages/client.ts`.
 */
export const CHANNEL_ID_PATTERN = /^[a-z0-9-]{1,64}$/u;
export const channelIdSchema = z
  .string()
  .regex(CHANNEL_ID_PATTERN, 'channel id must be lowercase alphanumeric/hyphen, 1-64 chars');

/**
 * T13.2 — a category and a voice channel share one unified id space (`channel_nodes.node_id` in
 * `services/dedicated-server`'s `channels.sqlite`), so every wire field that carries a channel-tree
 * node id (`channelNodeSchema.nodeId`, `parentId`, etc. — see `channels.ts`) reuses
 * {@link channelIdSchema} directly. `categoryIdSchema` is the identical shape/regex kept as a
 * nominally distinct type for any future wire field that specifically wants to express "this must
 * be a category, not just any node" at the type level — not currently used to type a field, since
 * `channelNodeSchema` deliberately types every node reference generically (a category and a voice
 * channel are structurally interchangeable as *references*; only `kind` distinguishes them).
 */
export const categoryIdSchema = z
  .string()
  .regex(CHANNEL_ID_PATTERN, 'category id must be lowercase alphanumeric/hyphen, 1-64 chars');

/**
 * The one hard technical ceiling on voice-channel occupancy — also the wire-schema array-size bound
 * for a join snapshot (`voiceParticipantSchema` array in `messages/voice.ts`) and the upper bound a
 * channel-tree node's own configured `userLimit` (`channels.ts`) can never exceed. Defined here
 * (a dependency-free file) rather than in `messages/voice.ts` itself so `channels.ts` can reference
 * the exact same constant without an import cycle (`messages/voice.ts` <-> `channels.ts`) — see
 * `messages/voice.ts`'s re-export.
 */
export const MAX_CHANNEL_PARTICIPANTS = 64;

/**
 * Server-generated per-voice-session identity (see `docs/architecture/WEBRTC_VOICE.md` for the
 * `connectionId`/`participantId`/future-`userId` distinction). Clients only ever receive this
 * value from the server; they never mint or choose it.
 */
export const PARTICIPANT_ID_MAX_LENGTH = 64;
export const participantIdSchema = z.string().min(1).max(PARTICIPANT_ID_MAX_LENGTH);

// ASCII control characters (C0 controls 0x00-0x1F and DEL 0x7F) are rejected in display names.
// Intentional: this pattern's entire purpose is to detect and reject control characters in
// untrusted user input, not an accidental inclusion.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = new RegExp('^[^\\x00-\\x1F\\x7F]*$', 'u');

/**
 * A temporary, user-chosen display label — never an identity or trust signal. Trimmed, bounded,
 * and rejects control characters (T3 task requirement: "reject empty names, excessively long
 * names, control-character abuse"). Two participants may share a display name; identity comes
 * from `participantId`.
 */
export const DISPLAY_NAME_MAX_LENGTH = 32;
export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'display name cannot be blank')
  .max(DISPLAY_NAME_MAX_LENGTH)
  .regex(CONTROL_CHARACTER_PATTERN, 'control characters are not allowed');
