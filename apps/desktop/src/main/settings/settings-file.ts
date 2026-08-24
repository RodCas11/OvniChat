import { mkdir, readFile, rename } from 'node:fs/promises';
import path from 'node:path';

import { app } from 'electron';
import { z } from 'zod';

import { writeFileAtomic } from '../identity/atomic-write.js';

export { deriveServerScopeKey } from '../../shared/voice-preference-scope.js';

/**
 * T11 local client settings — device preferences, bookmarks, and other deliberate UI choices the
 * Client owns for itself (see `docs/architecture/CLIENT_SETTINGS_AND_RECONNECT.md`). Deliberately
 * separate from `identity-file.ts` (fail-closed, security-sensitive) and modeled instead on
 * `nickname-store.ts`'s fail-open discipline: losing a device preference or bookmark has no
 * security implication and is annoying, not dangerous, so a corrupted settings file must never
 * block the application from starting. Unlike `nickname-store.ts`'s whole-file fail-open reset,
 * a corrupt file here is (a) never overwritten or deleted in place — it is renamed aside so the
 * original bytes survive for manual inspection/recovery — and (b) recovered section-by-section
 * (see `salvageSections`) rather than reset wholesale, since a single malformed field must not
 * also discard an otherwise-valid bookmark list. This satisfies T11 Section 7's "do not silently
 * overwrite corrupt settings with an empty file before giving the application a chance to recover
 * safely."
 */

const SETTINGS_FILE_VERSION = 1;

const MAX_BOOKMARKS = 100;
const MAX_BOOKMARK_NAME_LENGTH = 100;
/** Matches `parse-server-address.ts`'s own `MAX_INPUT_LENGTH` — a bookmark's address is exactly the
 * same free-text a user could type directly into `ConnectionScreen`. */
const MAX_SERVER_ADDRESS_LENGTH = 300;
/** `crypto.randomUUID()` output length (36 chars) — bounded generously, not hardcoded to exactly
 * 36, so a future id scheme change doesn't require a settings-file migration by itself. */
const MAX_BOOKMARK_ID_LENGTH = 64;

const deviceIdSchema = z.string().min(1).max(256).nullable();

const bookmarkSchema = z
  .object({
    bookmarkId: z.string().min(1).max(MAX_BOOKMARK_ID_LENGTH),
    displayName: z.string().min(1).max(MAX_BOOKMARK_NAME_LENGTH),
    serverAddress: z.string().min(1).max(MAX_SERVER_ADDRESS_LENGTH),
  })
  .strict();

export type StoredBookmark = z.infer<typeof bookmarkSchema>;

/**
 * T13.4 — mirrors `@disco-voador/windows-media`'s `PttModifierState`/`PttBinding` shapes exactly
 * (see `ptt-binding.ts`) so a value this schema accepts is always one that module's matching logic
 * can consume unchanged. Deliberately re-declared here (not imported) — this file has no runtime
 * dependency on `@disco-voador/windows-media` today, and a `zod` schema needs its own literal shape
 * regardless of where the TypeScript type comes from; `ptt-hotkey.ts` (Main) is responsible for
 * keeping the two in sync (a type-only cross-check, enforced at compile time — see that file).
 */
const pttModifierStateSchema = z
  .object({ ctrl: z.boolean(), alt: z.boolean(), shift: z.boolean(), meta: z.boolean() })
  .strict();

const pttBindingSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('keyboard'),
      keycode: z.number().int().nonnegative(),
      modifiers: pttModifierStateSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('mouseButton'),
      button: z.number().int().nonnegative(),
      modifiers: pttModifierStateSchema,
    })
    .strict(),
]);

export type StoredPttBinding = z.infer<typeof pttBindingSchema>;

// Each top-level section has its own schema, kept separate from `settingsFileSchema` below, so a
// corrupted file can be salvaged section-by-section (see `salvageSections`) instead of one bad
// field forcing every section — including the bookmark list, the most painful one to lose — back
// to defaults.
const audioSchema = z
  .object({ inputDeviceId: deviceIdSchema, outputDeviceId: deviceIdSchema })
  .strict();
const videoSchema = z.object({ cameraDeviceId: deviceIdSchema }).strict();
const screenShareSchema = z
  .object({ qualityPreset: z.enum(['standard', 'high', 'smooth', 'smooth720']) })
  .strict();
// T13.4 — `inputMode`/`pttBinding`/`voiceActivitySensitivity`/`joinLeaveSoundsEnabled` are new
// fields, each with its own `.default(...)` — under `zod`'s `.strict()`, a *missing* key with a
// default parses cleanly (only an *unrecognized* key is rejected), so a pre-T13.4 (v1-shaped)
// settings file that never wrote these fields still parses successfully here, picking up these
// defaults, with no `SETTINGS_FILE_VERSION` bump required (see
// `tests/desktop/settings-file.test.ts`'s dedicated old-file-fixture round-trip test).
const voiceSchema = z
  .object({
    startMuted: z.boolean(),
    startDeafened: z.boolean(),
    inputMode: z.enum(['voice-activity', 'push-to-talk']).default('voice-activity'),
    pttBinding: pttBindingSchema.nullable().default(null),
    voiceActivitySensitivity: z.number().min(0).max(1).default(0.5),
    joinLeaveSoundsEnabled: z.boolean().default(true),
  })
  .strict();
const bookmarksSchema = z.array(bookmarkSchema).max(MAX_BOOKMARKS);
const lastServerAddressSchema = z.string().max(MAX_SERVER_ADDRESS_LENGTH).nullable();
const connectOnStartupSchema = z.boolean();

/** T13.4 — one local, per-`(serverScopeKey, identityRef)` voice preference: a participant's
 * locally-adjusted playback volume and "Mute for Me" state. See `deriveServerScopeKey` for how the
 * outer key is derived, and this file's own module doc comment / `docs/architecture/
 * SERVER_LOCAL_PROFILES_AND_PRESENCE.md` for why the inner key is the durable, per-server
 * `identityRef` (`@disco-voador/protocol`'s `identityRefSchema`) — never the raw, portable
 * `identityId` (would reopen a cross-server correlation privacy hole), and never `memberRef` (a
 * session-scoped id reassigned every reconnect — persisting by it would silently orphan every saved
 * preference on the next reconnect). */
const voicePreferenceEntrySchema = z
  .object({ volumePercent: z.number().min(0).max(200), locallyMuted: z.boolean() })
  .strict();

export type StoredVoicePreferenceEntry = z.infer<typeof voicePreferenceEntrySchema>;

/** A single flat ceiling across every server scope and identity combined — mirrors
 * `MAX_BOOKMARKS`'s own simplicity rather than a separate per-server cap, since this data is exactly
 * as low-stakes (a local-only UI convenience, never security-relevant) and does not need finer
 * bookkeeping. */
export const MAX_VOICE_PREFERENCE_ENTRIES = 500;

function countVoicePreferenceLeaves(
  map: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): number {
  let total = 0;
  for (const inner of Object.values(map)) total += Object.keys(inner).length;
  return total;
}

const voicePreferencesSchema = z
  .record(z.string(), z.record(z.string(), voicePreferenceEntrySchema))
  .refine(
    (map) => countVoicePreferenceLeaves(map) <= MAX_VOICE_PREFERENCE_ENTRIES,
    `Too many voice preference entries (max ${String(MAX_VOICE_PREFERENCE_ENTRIES)})`,
  )
  .default({});

export type StoredVoicePreferences = z.infer<typeof voicePreferencesSchema>;

const settingsFileSchema = z
  .object({
    version: z.literal(SETTINGS_FILE_VERSION),
    audio: audioSchema,
    video: videoSchema,
    screenShare: screenShareSchema,
    voice: voiceSchema,
    bookmarks: bookmarksSchema,
    lastServerAddress: lastServerAddressSchema,
    connectOnStartup: connectOnStartupSchema,
    // T13.4 — new top-level section; `.default({})` on `voicePreferencesSchema` above means a
    // pre-T13.4 file (missing this key entirely) parses cleanly with an empty map, matching every
    // other newly-added field's backward-compatibility discipline in this same change.
    voicePreferences: voicePreferencesSchema,
  })
  .strict();

export type StoredClientSettings = z.infer<typeof settingsFileSchema>;

export const DEFAULT_CLIENT_SETTINGS: StoredClientSettings = {
  version: SETTINGS_FILE_VERSION,
  audio: { inputDeviceId: null, outputDeviceId: null },
  video: { cameraDeviceId: null },
  screenShare: { qualityPreset: 'high' },
  voice: {
    startMuted: false,
    startDeafened: false,
    inputMode: 'voice-activity',
    pttBinding: null,
    voiceActivitySensitivity: 0.5,
    joinLeaveSoundsEnabled: true,
  },
  bookmarks: [],
  lastServerAddress: null,
  connectOnStartup: false,
  voicePreferences: {},
};

function settingsFilePath(): string {
  return path.join(app.getPath('userData'), 'settings.json');
}

/**
 * Renames the unreadable/corrupted file aside instead of deleting or overwriting it in place, so a
 * later write of fresh (or salvaged) settings can never destroy whatever was actually on disk.
 * Best-effort: if even the rename fails (e.g. the file vanished between the failed read and this
 * call), that is not itself a reason to block startup — settings are not security-sensitive.
 */
async function preserveCorruptFile(): Promise<string | undefined> {
  const original = settingsFilePath();
  const preserved = `${original}.corrupted-${String(Date.now())}`;
  try {
    await rename(original, preserved);
    return preserved;
  } catch {
    return undefined;
  }
}

/**
 * Validates each top-level section independently against its own schema, defaulting only the
 * sections that actually fail to validate, rather than discarding the whole file because one
 * section is malformed — the bookmark list in particular is the section most costly to a daily
 * user to lose, so a corrupted `audio`/`video` section must never take it down too. `parsedJson`
 * need not be an object at all (a fully garbled file still salvages to all-defaults via this same
 * path, just with every section falling back).
 */
function salvageSections(parsedJson: unknown): StoredClientSettings {
  const source: Record<string, unknown> =
    typeof parsedJson === 'object' && parsedJson !== null
      ? (parsedJson as Record<string, unknown>)
      : {};

  const audio = audioSchema.safeParse(source.audio);
  const video = videoSchema.safeParse(source.video);
  const screenShare = screenShareSchema.safeParse(source.screenShare);
  const voice = voiceSchema.safeParse(source.voice);
  const bookmarks = bookmarksSchema.safeParse(source.bookmarks);
  const lastServerAddress = lastServerAddressSchema.safeParse(source.lastServerAddress);
  const connectOnStartup = connectOnStartupSchema.safeParse(source.connectOnStartup);
  // T13.4 — its own independent salvage entry, matching every other section: a malformed
  // `voicePreferences` blob must never take down bookmarks (or any other section) and vice versa.
  const voicePreferences = voicePreferencesSchema.safeParse(source.voicePreferences);

  return {
    version: SETTINGS_FILE_VERSION,
    audio: audio.success ? audio.data : DEFAULT_CLIENT_SETTINGS.audio,
    video: video.success ? video.data : DEFAULT_CLIENT_SETTINGS.video,
    screenShare: screenShare.success ? screenShare.data : DEFAULT_CLIENT_SETTINGS.screenShare,
    voice: voice.success ? voice.data : DEFAULT_CLIENT_SETTINGS.voice,
    bookmarks: bookmarks.success ? bookmarks.data : DEFAULT_CLIENT_SETTINGS.bookmarks,
    lastServerAddress: lastServerAddress.success
      ? lastServerAddress.data
      : DEFAULT_CLIENT_SETTINGS.lastServerAddress,
    connectOnStartup: connectOnStartup.success
      ? connectOnStartup.data
      : DEFAULT_CLIENT_SETTINGS.connectOnStartup,
    voicePreferences: voicePreferences.success
      ? voicePreferences.data
      : DEFAULT_CLIENT_SETTINGS.voicePreferences,
  };
}

/**
 * Returns `undefined` only for "no settings file yet" (first run) — every other failure mode
 * (unreadable, not JSON, fails whole-file validation) is handled by preserving the original file
 * aside (never overwritten or deleted in place — see {@link preserveCorruptFile}) and returning a
 * best-effort, section-by-section salvage (see {@link salvageSections}) instead of resetting
 * everything to defaults. Unlike `identity-file.ts`, this never throws — a device preference or
 * bookmark list has no security implication and must never block the application from starting.
 * The salvaged result is immediately re-persisted as the new `settings.json` (by the caller, via
 * {@link writeClientSettingsFile}) so the recovery survives a second restart, not only the current
 * session.
 */
export async function readClientSettingsFile(): Promise<StoredClientSettings | undefined> {
  let raw: string;
  try {
    raw = await readFile(settingsFilePath(), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    // Unreadable for a reason other than "does not exist yet" (permissions, I/O error, etc.) —
    // there is nothing to parse or salvage; proceed on in-memory defaults for this session without
    // attempting to rename a file that could not even be read.
    return undefined;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch {
    const preserved = await preserveCorruptFile();
    const salvaged = salvageSections(undefined);
    warnSalvaged(preserved);
    await writeClientSettingsFile(salvaged);
    return salvaged;
  }

  const result = settingsFileSchema.safeParse(parsedJson);
  if (result.success) return result.data;

  const preserved = await preserveCorruptFile();
  const salvaged = salvageSections(parsedJson);
  warnSalvaged(preserved);
  await writeClientSettingsFile(salvaged);
  return salvaged;
}

function warnSalvaged(preservedPath: string | undefined): void {
  console.warn(
    preservedPath
      ? `[settings] Local settings file was invalid; the original was preserved at ` +
          `"${preservedPath}" and a recovered settings file (salvaging whatever sections were ` +
          'still valid) has replaced it.'
      : '[settings] Local settings file was invalid and could not be preserved; a recovered ' +
          'settings file (salvaging whatever sections were still valid) has replaced it.',
  );
}

export async function writeClientSettingsFile(settings: StoredClientSettings): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true });
  await writeFileAtomic(settingsFilePath(), JSON.stringify(settings));
}
