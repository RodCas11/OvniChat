import type {
  FilesystemPermissionRequest,
  MediaAccessPermissionRequest,
  OpenExternalPermissionRequest,
  PermissionRequest,
  Session,
} from 'electron';

import { isAllowedOrigin } from './origins.js';
import { hasPendingScreenShareSelection } from './screen-share.js';

type PermissionRequestDetails =
  | PermissionRequest
  | FilesystemPermissionRequest
  | MediaAccessPermissionRequest
  | OpenExternalPermissionRequest;

/**
 * T3 added exactly one permission beyond T1's default-deny-everything: microphone-only media
 * access (`getUserMedia({ audio: true })`). T4 adds exactly one more: camera-only media access
 * (`getUserMedia({ video: true })`) — never both in the same request, since microphone and camera
 * are always acquired as two independent `getUserMedia` calls (see
 * `docs/architecture/WEBRTC_VOICE.md`), never combined into one. Both stay origin-restricted to
 * this application's own origin. Geolocation, every other Electron permission kind, and any media
 * request mixing audio and video in the same call stay denied. Both the check and request handlers
 * must be installed for complete permission handling (Electron only fully enforces a policy when
 * both are present).
 *
 * T5 adds display-capture (`getDisplayMedia()`), origin-restricted the same way, but through a
 * narrower and more surprising path than microphone/camera — see `isDisplayCaptureRequest`'s
 * comment for the research this is based on. *Which* source gets captured is still decided in
 * `main/screen-share.ts`'s `session.setDisplayMediaRequestHandler` (installed separately), but
 * this handler is not merely a rubber stamp for it: a security review found that granting every
 * empty-`mediaTypes` request also incidentally re-enables a legacy, undocumented capture path that
 * bypasses `screen-share.ts` entirely (see `isDisplayCaptureRequest`), so this handler additionally
 * requires a currently-armed `screen-share.ts` selection before granting — see the request handler
 * below and `hasPendingScreenShareSelection`'s doc comment.
 * `setPermissionCheckHandler` is intentionally left untouched for display-capture: per Electron's
 * own docs ("Display capture requires ... its permission cannot be persisted"), a `getDisplayMedia`
 * call is never satisfied from a cached/checked grant — it always goes through the (now extended)
 * request handler below fresh, so extending the check handler would add surface without changing
 * behavior.
 */
export function installPermissionHandlers(
  session: Session,
  allowedOrigins: readonly string[],
): void {
  session.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (permission !== 'media' || !isSingleAllowedMediaType(details.mediaType)) return false;
    return isAllowedOrigin(requestingOrigin, allowedOrigins);
  });

  session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission !== 'media') {
      callback(false);
      return;
    }
    if (isSingleKindMediaRequest(details)) {
      callback(isAllowedOrigin(details.requestingUrl, allowedOrigins));
      return;
    }
    // Security-review follow-up (T5): also require a currently-armed `pendingSourceId` from
    // `screen-share.ts` before granting an empty-`mediaTypes` request — this app's own sanctioned
    // flow always calls `selectScreenShareSource` immediately before `getDisplayMedia()`
    // (`enableScreenShare`'s contract in `use-voice-channel.ts`), so a legitimate call always has
    // one armed; the legacy `chromeMediaSource: 'screen'` bypass this handler cannot otherwise
    // distinguish from a real `getDisplayMedia()` call (see `isDisplayCaptureRequest`'s doc
    // comment) essentially never does, since nothing arms a selection for it. Narrows, but does not
    // fully close, that residual risk — a narrow race window still exists between arming a
    // selection and a legacy-path call landing before it is consumed.
    if (isDisplayCaptureRequest(details) && hasPendingScreenShareSelection()) {
      callback(isAllowedOrigin(details.requestingUrl, allowedOrigins));
      return;
    }
    callback(false);
  });
}

function isSingleAllowedMediaType(mediaType: 'audio' | 'video' | 'unknown' | undefined): boolean {
  return mediaType === 'audio' || mediaType === 'video';
}

/** Allows a request for only audio or only video — never both in the same `getUserMedia` call. */
function isSingleKindMediaRequest(
  details: PermissionRequestDetails,
): details is MediaAccessPermissionRequest {
  if (!('mediaTypes' in details)) return false;
  const mediaTypes = details.mediaTypes ?? [];
  return (
    mediaTypes.length > 0 &&
    (mediaTypes.every((type) => type === 'audio') || mediaTypes.every((type) => type === 'video'))
  );
}

/**
 * Recognizes a `navigator.mediaDevices.getDisplayMedia()` request.
 *
 * Researched directly against this app's pinned Electron version (43.4.0) source
 * (`shell/browser/web_contents_permission_helper.cc`,
 * `WebContentsPermissionHelper::RequestMediaAccessPermission`): every `getUserMedia`/
 * `getDisplayMedia` call reaches this same `'media'` permission-request path before Chromium
 * decides *how* to fulfill it, and the C++ side only ever appends `'audio'`/`'video'` to the
 * `mediaTypes` array this handler receives when the underlying Chromium `MediaStreamType` is
 * exactly `DEVICE_AUDIO_CAPTURE`/`DEVICE_VIDEO_CAPTURE` (microphone/camera). A `getDisplayMedia()`
 * call's type is `DISPLAY_VIDEO_CAPTURE` (and friends) — distinct from those — so it always
 * arrives here with an *empty* `mediaTypes` array; Electron does not expose any other field to
 * this handler that would let it identify the request as display-capture more directly.
 *
 * Known, accepted residual risk (documented here rather than silently ignored, since this is
 * exactly the surface `docs/SECURITY.md` says needs explicit review): the same Chromium
 * `MediaStreamType` machinery also still recognizes the legacy, undocumented-in-current-Electron
 * `getUserMedia({ video: { mandatory: { chromeMediaSource: 'screen' } } })` constraint form
 * (`GUM_DESKTOP_VIDEO_CAPTURE`), which likewise produces an empty `mediaTypes` array and is
 * therefore indistinguishable from a real `getDisplayMedia()` call at this layer. Critically, that
 * legacy path does NOT route through `main/screen-share.ts`'s `setDisplayMediaRequestHandler` at
 * all — Electron's C++ (`WebContentsPermissionHelper`'s `HandleUserMediaRequest`) fulfills it
 * directly and, when no `chromeMediaSourceId` is supplied, defaults to the *entire primary screen*
 * with no further app-level check. Granting `permission === 'media'` requests with an empty
 * `mediaTypes` array (required to make legitimate `getDisplayMedia()` work at all) therefore also
 * re-enables that legacy escape hatch for a Renderer that already has arbitrary script execution.
 * This app's Renderer never invokes that legacy API itself, and is defended in depth against
 * reaching that state to begin with (`sandbox: true`, `contextIsolation: true`, a `script-src
 * 'self'` CSP with no `unsafe-eval` and no remote content, no filesystem/Node exposure through
 * Preload) — so exploiting this specifically requires an XSS bypassing all of that first, at which
 * point far more direct harm is already possible.
 *
 * Mitigated, not fully closed, per a security review's follow-up suggestion: the request handler
 * below additionally requires `screen-share.ts`'s `hasPendingScreenShareSelection()` before
 * granting an empty-`mediaTypes` request. This app's own sanctioned flow always arms a selection
 * (`selectScreenShareSource`) immediately before calling `getDisplayMedia()`, so a legitimate call
 * is unaffected; the legacy path (which never arms one) is denied unless it happens to race a
 * window where a real selection is already armed for an unrelated legitimate share — a narrow
 * residual window, not zero. Electron does not currently expose a way to disable the legacy
 * `chromeMediaSource` constraint independently of `getDisplayMedia()` support, which would close it
 * fully.
 */
function isDisplayCaptureRequest(details: PermissionRequestDetails): boolean {
  if (!('mediaTypes' in details)) return false;
  return (details.mediaTypes ?? []).length === 0;
}
