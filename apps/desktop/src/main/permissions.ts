import type {
  FilesystemPermissionRequest,
  MediaAccessPermissionRequest,
  OpenExternalPermissionRequest,
  PermissionRequest,
  Session,
} from 'electron';

import { isAllowedOrigin } from './origins.js';

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
 * this application's own origin. Display-capture, geolocation, every other Electron permission
 * kind, and any media request mixing audio and video in the same call stay denied. Both the check
 * and request handlers must be installed for complete permission handling (Electron only fully
 * enforces a policy when both are present).
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
    if (permission !== 'media' || !isSingleKindMediaRequest(details)) {
      callback(false);
      return;
    }
    callback(isAllowedOrigin(details.requestingUrl, allowedOrigins));
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
