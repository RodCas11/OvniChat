import { desktopCapturer } from 'electron';
import type { DesktopCapturerSource, NativeImage, Session, Streams } from 'electron';

import type { DesktopScreenSource } from '../shared/ipc-contract.js';
import { isAllowedOrigin } from './origins.js';

/** Not full-resolution — a source picker only ever needs a recognizable preview, never the actual
 * capture content, and a bounded size keeps the sanitized IPC payload small. */
const THUMBNAIL_SIZE = { width: 320, height: 180 };

/**
 * The most recently enumerated native sources for the one trusted window this app ever has (see
 * `ipc.ts`'s `currentMainWebContents` for the same single-window simplification). Used two ways:
 * validating a `selectScreenShareSource` id against "the set this same trusted sender most
 * recently enumerated", and re-resolving an approved id back to its real `DesktopCapturerSource`
 * inside `setDisplayMediaRequestHandler` — the callback there must receive a real native object,
 * never one reconstructed from the sanitized data `listScreenShareSources` returned to the
 * Renderer.
 */
let lastEnumeratedSources: readonly DesktopCapturerSource[] = [];

/**
 * Single-use pending selection armed by `selectScreenShareSource` and consumed by exactly the
 * next `setDisplayMediaRequestHandler` invocation for this session — never more than once, and
 * never left over for a later, unrelated `getDisplayMedia()` call. A new `selectScreenShareSource`
 * call always overwrites (not appends to) this, so an old approved-but-unused selection can never
 * combine with a later one; `chooseDisplayMediaSource` below clears it synchronously and
 * unconditionally as the very first thing it does, before any other work, so a second concurrent
 * `getDisplayMedia()` call can never observe (and reuse) the same pending selection the first one
 * is already consuming.
 */
let pendingSourceId: string | undefined;

let installedAllowedOrigins: readonly string[] = [];

function nativeImageToDataUrl(image: NativeImage | undefined): string | undefined {
  if (!image || image.isEmpty()) return undefined;
  return image.toDataURL();
}

/**
 * `DesktopCapturerSource.id` has a documented, stable format — `window:XX:YY` or `screen:ZZ:0`
 * (see Electron's `desktop-capturer-source.md`) — so the prefix reliably discriminates type
 * without a second per-type `getSources()` call.
 */
function sourceType(id: string): 'screen' | 'window' {
  return id.startsWith('screen:') ? 'screen' : 'window';
}

function sanitizeSource(source: DesktopCapturerSource): DesktopScreenSource {
  const displayId = source.display_id;
  return {
    id: source.id,
    name: source.name,
    type: sourceType(source.id),
    thumbnailDataUrl: nativeImageToDataUrl(source.thumbnail) ?? '',
    appIconDataUrl: nativeImageToDataUrl(source.appIcon),
    displayId: displayId && displayId.length > 0 ? displayId : undefined,
  };
}

/**
 * Enumerates current screen/window capture candidates and remembers them (native, unsanitized) as
 * `lastEnumeratedSources` for `selectScreenShareSource`/`chooseDisplayMediaSource` to validate
 * against, while returning only the sanitized, bounded-thumbnail plain data to the Renderer.
 */
export async function listScreenShareSources(): Promise<readonly DesktopScreenSource[]> {
  const sources = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: THUMBNAIL_SIZE,
    fetchWindowIcons: true,
  });
  lastEnumeratedSources = sources;
  return sources.map(sanitizeSource);
}

/**
 * Arms a single-use pending selection for `sourceId` if and only if it is present in the most
 * recently enumerated set (`lastEnumeratedSources`) — an id from a stale enumeration, or one that
 * was never returned by `listScreenShareSources` at all, is rejected by returning `false`, never
 * by throwing (so a confused/compromised Renderer never learns anything beyond "not usable" from
 * the response shape).
 */
export function selectScreenShareSource(sourceId: string): boolean {
  const match = lastEnumeratedSources.some((source) => source.id === sourceId);
  if (!match) return false;
  pendingSourceId = sourceId;
  return true;
}

/**
 * Read-only — deliberately never consumes `pendingSourceId` (only
 * `installScreenShareHandlers`'s `setDisplayMediaRequestHandler` callback does that). Lets
 * `permissions.ts`'s media-permission grant additionally require a real armed selection to be
 * present (see that file's `isDisplayCaptureRequest` doc comment for why: a security review found
 * that granting the empty-`mediaTypes` permission `getDisplayMedia()` needs also incidentally
 * re-enables a legacy, undocumented `getUserMedia({ video: { mandatory: { chromeMediaSource:
 * 'screen' } } })` constraint form that bypasses this module's source-selection flow entirely).
 * This narrows, but does not fully close, that residual risk — a narrow window still exists
 * between arming a selection and a legacy-path call racing it — see the security review's
 * suggested follow-up for the remaining gap.
 */
export function hasPendingScreenShareSelection(): boolean {
  return pendingSourceId !== undefined;
}

/**
 * Installs the actual `getDisplayMedia()` fulfillment handler. This — not `selectScreenShareSource`
 * — is the real security decision point: it fires for *every* `getDisplayMedia()` call from this
 * session's origin, and resolves with no source (deny) unless a matching single-use pending
 * selection is currently armed. `useSystemPicker` is deliberately not passed: it is an
 * experimental macOS-15+-only option (see Electron's `session.md`) with no effect on this
 * Windows-only target.
 */
export function installScreenShareHandlers(
  session: Session,
  allowedOrigins: readonly string[],
): void {
  installedAllowedOrigins = allowedOrigins;

  session.setDisplayMediaRequestHandler((request, callback) => {
    // Electron's Main-process implementation of this callback
    // (`ElectronBrowserContext::DisplayMediaDeviceChosen`) treats invoking it with no
    // argument/`null`/`undefined` as the clean "deny" path — `getDisplayMedia()` simply rejects on
    // the Renderer side. The `Streams` callback parameter type does not reflect this (every field
    // on `Streams` is independently optional, but the type itself is not `| undefined`), so the
    // cast below is deliberate: it invokes Electron's own documented deny mechanism, not a
    // fabricated bypass of it.
    const deny = (): void => {
      callback(undefined as unknown as Streams);
    };

    const selectedSourceId = pendingSourceId;
    pendingSourceId = undefined;

    if (!selectedSourceId || !isAllowedOrigin(request.securityOrigin, installedAllowedOrigins)) {
      deny();
      return;
    }

    // Re-resolve the id against Main's own cached native source list — never reconstruct a
    // `DesktopCapturerSource`-shaped object from the sanitized IPC data the Renderer holds.
    const source = lastEnumeratedSources.find((candidate) => candidate.id === selectedSourceId);
    if (!source) {
      deny();
      return;
    }

    // Screen-video only. System/game audio capture is explicitly out of scope for this task (see
    // docs/tasks/T5_SCREEN_SHARE.md's "Out of scope") — `audio` is never passed here, not even
    // `undefined`-with-a-key, so this call can never grant an audio stream.
    callback({ video: { id: source.id, name: source.name } });
  });
}
