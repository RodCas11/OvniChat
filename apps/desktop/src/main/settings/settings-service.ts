import { randomUUID } from 'node:crypto';

import {
  DEFAULT_CLIENT_SETTINGS,
  MAX_VOICE_PREFERENCE_ENTRIES,
  readClientSettingsFile,
  writeClientSettingsFile,
  type StoredBookmark,
  type StoredClientSettings,
  type StoredPttBinding,
  type StoredVoicePreferenceEntry,
} from './settings-file.js';

/**
 * Main-process settings service: an in-memory cache backed by `settings-file.ts`, following
 * `identity-service.ts`'s caching shape (load once, serve from memory, write-through on mutation).
 * Unlike identity, there is no create-race to guard against — reading a not-yet-existing settings
 * file just resolves to defaults, and two concurrent first reads converging on the same defaults
 * has no observable inconsistency the way two independently generated keypairs would.
 */

// Every field, at every nesting level, is `X | undefined` explicitly, not just optional (`?:`), to
// stay assignable from a `zod` `.partial()`/`.optional()`-inferred type under this repo's
// `exactOptionalPropertyTypes: true` — `zod` represents an optional field as `X | undefined` at the
// *value* type, not merely an omittable key, so a plain `Partial<{...}>` mapped type (which permits
// only key omission, never an explicit `undefined` value) is not assignable from it.
export interface ClientSettingsPatch {
  audio?:
    | {
        inputDeviceId?: string | null | undefined;
        outputDeviceId?: string | null | undefined;
      }
    | undefined;
  video?: { cameraDeviceId?: string | null | undefined } | undefined;
  screenShare?:
    | { qualityPreset?: StoredClientSettings['screenShare']['qualityPreset'] | undefined }
    | undefined;
  voice?:
    | {
        startMuted?: boolean | undefined;
        startDeafened?: boolean | undefined;
        inputMode?: StoredClientSettings['voice']['inputMode'] | undefined;
        pttBinding?: StoredPttBinding | null | undefined;
        voiceActivitySensitivity?: number | undefined;
        joinLeaveSoundsEnabled?: boolean | undefined;
      }
    | undefined;
  lastServerAddress?: string | null | undefined;
  connectOnStartup?: boolean | undefined;
}

export interface BookmarkInput {
  readonly displayName: string;
  readonly serverAddress: string;
}

let cachedSettings: StoredClientSettings | undefined;
let loadPromise: Promise<StoredClientSettings> | undefined;

async function loadSettings(): Promise<StoredClientSettings> {
  const stored = await readClientSettingsFile();
  return stored ?? DEFAULT_CLIENT_SETTINGS;
}

async function getOrLoadSettings(): Promise<StoredClientSettings> {
  if (cachedSettings) return cachedSettings;
  loadPromise ??= loadSettings()
    .then((settings) => {
      cachedSettings = settings;
      return settings;
    })
    .finally(() => {
      loadPromise = undefined;
    });
  return loadPromise;
}

async function persist(next: StoredClientSettings): Promise<StoredClientSettings> {
  await writeClientSettingsFile(next);
  cachedSettings = next;
  return next;
}

export async function getClientSettings(): Promise<StoredClientSettings> {
  return getOrLoadSettings();
}

/**
 * Merges a deliberate, narrow patch into the current settings and persists the result. Never
 * accepts a whole replacement object from the caller — every field a Renderer can set is named
 * explicitly here, matching this codebase's "expose only narrow, validated capabilities" IPC
 * discipline one level up in `main/ipc.ts`.
 *
 * Deliberately merges field-by-field via {@link resolve} rather than object-spreading `patch.audio`
 * etc. into `current.audio`, and deliberately checks `!== undefined` rather than using `??`: IPC
 * arguments cross via Electron's structured-clone algorithm, not `JSON.parse`, so a caller can send
 * a field *explicitly* set to `undefined` (not merely omitted) — spreading that in would silently
 * poison a field the storage schema requires to always be `string | null`, never `undefined`.
 * `??` would be wrong here too: `null` is itself a meaningful, valid value for a device-id field
 * ("use the system default"), and `??` treats `null` and `undefined` identically, which would make
 * it impossible to ever patch a device preference back to "default" once a specific device had been
 * selected. Only an *explicit* `undefined` means "not provided, keep the current value."
 */
function resolve<T>(patchValue: T | undefined, currentValue: T): T {
  return patchValue === undefined ? currentValue : patchValue;
}

export async function updateClientSettings(
  patch: ClientSettingsPatch,
): Promise<StoredClientSettings> {
  const current = await getOrLoadSettings();
  const next: StoredClientSettings = {
    ...current,
    audio: {
      inputDeviceId: resolve(patch.audio?.inputDeviceId, current.audio.inputDeviceId),
      outputDeviceId: resolve(patch.audio?.outputDeviceId, current.audio.outputDeviceId),
    },
    video: {
      cameraDeviceId: resolve(patch.video?.cameraDeviceId, current.video.cameraDeviceId),
    },
    screenShare: {
      qualityPreset: resolve(patch.screenShare?.qualityPreset, current.screenShare.qualityPreset),
    },
    voice: {
      startMuted: resolve(patch.voice?.startMuted, current.voice.startMuted),
      startDeafened: resolve(patch.voice?.startDeafened, current.voice.startDeafened),
      inputMode: resolve(patch.voice?.inputMode, current.voice.inputMode),
      pttBinding: resolve(patch.voice?.pttBinding, current.voice.pttBinding),
      voiceActivitySensitivity: resolve(
        patch.voice?.voiceActivitySensitivity,
        current.voice.voiceActivitySensitivity,
      ),
      joinLeaveSoundsEnabled: resolve(
        patch.voice?.joinLeaveSoundsEnabled,
        current.voice.joinLeaveSoundsEnabled,
      ),
    },
    lastServerAddress: resolve(patch.lastServerAddress, current.lastServerAddress),
    connectOnStartup: resolve(patch.connectOnStartup, current.connectOnStartup),
  };
  return persist(next);
}

/**
 * T13.4 — reads one `(serverScopeKey, identityRef)` voice preference entry, or `undefined` if none
 * has ever been saved for that pair (the caller treats this identically to `{ volumePercent: 100,
 * locallyMuted: false }`, the product default — never persisted as such just to be "read back",
 * mirroring `getClientSettings`'s own "absent means default" discipline). `identityRef` is the
 * durable, per-server correlation token from `@disco-voador/protocol`'s `identityRefSchema` — never
 * the raw, portable `identityId` (see `settings-file.ts`'s own doc comment on this schema).
 */
export async function getVoicePreference(
  serverScopeKey: string,
  identityRef: string,
): Promise<StoredVoicePreferenceEntry | undefined> {
  const current = await getOrLoadSettings();
  return current.voicePreferences[serverScopeKey]?.[identityRef];
}

/**
 * Writes (or overwrites) exactly one `(serverScopeKey, identityRef)` entry — never the whole map at
 * once, matching this feature's own "one entry at a time" IPC contract (see `main/ipc.ts`). Enforces
 * {@link MAX_VOICE_PREFERENCE_ENTRIES} itself (in addition to `settings-file.ts`'s own schema-level
 * `.refine()`, which only ever runs against bytes actually read back off disk) so a caller cannot
 * grow the in-memory map past the bound this service ever intentionally persists; once at the
 * ceiling, the *oldest inserted* entry (by `Map`/object key insertion order) is evicted first —
 * simple, and this data is a pure local UI convenience with no correctness requirement beyond a
 * bounded size.
 */
export async function setVoicePreference(
  serverScopeKey: string,
  identityRef: string,
  entry: StoredVoicePreferenceEntry,
): Promise<void> {
  const current = await getOrLoadSettings();
  // Built as nested `Map`s (never a dynamically-keyed plain object) purely so eviction below can use
  // `Map.delete` — a real method call, not the `delete obj[dynamicKey]` operator this codebase's own
  // lint rules forbid — then converted back to the plain-object shape `StoredClientSettings` requires
  // immediately before persisting.
  const nextOuter = new Map<string, Map<string, StoredVoicePreferenceEntry>>();
  for (const [scopeKey, inner] of Object.entries(current.voicePreferences)) {
    nextOuter.set(scopeKey, new Map(Object.entries(inner)));
  }
  let innerMap = nextOuter.get(serverScopeKey);
  if (!innerMap) {
    innerMap = new Map();
    nextOuter.set(serverScopeKey, innerMap);
  }
  const isNewEntry = !innerMap.has(identityRef);
  innerMap.set(identityRef, entry);

  if (isNewEntry) {
    let total = 0;
    for (const inner of nextOuter.values()) total += inner.size;
    while (total > MAX_VOICE_PREFERENCE_ENTRIES) {
      const oldestScopeKey = [...nextOuter.keys()][0];
      if (oldestScopeKey === undefined) break;
      const inner = nextOuter.get(oldestScopeKey);
      if (!inner) {
        nextOuter.delete(oldestScopeKey);
        continue;
      }
      const oldestIdentityRef = [...inner.keys()][0];
      if (oldestIdentityRef === undefined) {
        nextOuter.delete(oldestScopeKey);
        continue;
      }
      inner.delete(oldestIdentityRef);
      total -= 1;
      if (inner.size === 0) nextOuter.delete(oldestScopeKey);
    }
  }

  const voicePreferences: Record<string, Record<string, StoredVoicePreferenceEntry>> = {};
  for (const [scopeKey, inner] of nextOuter) {
    voicePreferences[scopeKey] = Object.fromEntries(inner);
  }
  await persist({ ...current, voicePreferences });
}

export async function addBookmark(input: BookmarkInput): Promise<StoredBookmark> {
  const current = await getOrLoadSettings();
  const bookmark: StoredBookmark = {
    bookmarkId: randomUUID(),
    displayName: input.displayName,
    serverAddress: input.serverAddress,
  };
  await persist({ ...current, bookmarks: [...current.bookmarks, bookmark] });
  return bookmark;
}

/** Returns `false` (never throws) if `bookmarkId` does not match any current bookmark. */
export async function updateBookmark(bookmark: StoredBookmark): Promise<boolean> {
  const current = await getOrLoadSettings();
  const index = current.bookmarks.findIndex(
    (existing) => existing.bookmarkId === bookmark.bookmarkId,
  );
  if (index === -1) return false;

  const bookmarks = [...current.bookmarks];
  bookmarks[index] = bookmark;
  await persist({ ...current, bookmarks });
  return true;
}

/** Returns `false` (never throws) if `bookmarkId` does not match any current bookmark. */
export async function removeBookmark(bookmarkId: string): Promise<boolean> {
  const current = await getOrLoadSettings();
  const bookmarks = current.bookmarks.filter((existing) => existing.bookmarkId !== bookmarkId);
  if (bookmarks.length === current.bookmarks.length) return false;

  await persist({ ...current, bookmarks });
  return true;
}
