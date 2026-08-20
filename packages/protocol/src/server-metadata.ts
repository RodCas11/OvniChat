import { z } from 'zod';

/**
 * T8 — minimal server-identity metadata a client learns once, at `server:hello`, about the
 * Dedicated Server it just authenticated to. Deliberately small: a display name and a closed
 * capability set, nothing that could be mistaken for an admin/discovery API. See
 * `docs/architecture/DEDICATED_SERVER.md`.
 */

// ASCII control characters (C0 controls 0x00-0x1F and DEL 0x7F) are rejected in the server name for
// the same reason `identifiers.ts`'s CONTROL_CHARACTER_PATTERN rejects them in display names —
// this is untrusted-to-the-client operator input, rendered as UI text.
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTER_PATTERN = new RegExp('^[^\\x00-\\x1F\\x7F]*$', 'u');

/** Display metadata only — never an authentication or uniqueness signal (T8 Section 68: two
 * servers may share a name; nothing is built around names being unique). */
export const SERVER_NAME_MAX_LENGTH = 100;
export const serverNameSchema = z
  .string()
  .trim()
  .min(1, 'server name cannot be blank')
  .max(SERVER_NAME_MAX_LENGTH)
  .regex(CONTROL_CHARACTER_PATTERN, 'control characters are not allowed');

/**
 * A small, closed set of product features this server offers — lets a client avoid assuming every
 * future server supports every future feature without a general capability-negotiation protocol.
 * Adding a new capability is additive (no version bump needed, matching `version.ts`'s evolution
 * policy) as long as clients treat an unrecognized capability as simply absent, never fatal.
 */
export const serverCapabilitySchema = z.enum([
  'voice',
  'camera',
  'screen-video',
  'screen-audio',
  'text-chat',
]);
export type ServerCapability = z.infer<typeof serverCapabilitySchema>;

export const MAX_SERVER_CAPABILITIES = 16;
export const serverCapabilitiesSchema = z
  .array(serverCapabilitySchema)
  .max(MAX_SERVER_CAPABILITIES);
