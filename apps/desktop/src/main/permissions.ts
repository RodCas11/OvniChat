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
 * T3 needs exactly one permission beyond T1's default-deny-everything: microphone-only media
 * access (`getUserMedia({ audio: true })`), and only from this application's own origin. Camera,
 * display-capture, geolocation, every other Electron permission kind, and any media request that
 * asks for video (even alongside audio) or comes from an unexpected origin/frame stay denied —
 * see `docs/architecture/WEBRTC_VOICE.md`. Both the check and request handlers must be installed
 * for complete permission handling (Electron only fully enforces a policy when both are present).
 */
export function installPermissionHandlers(
  session: Session,
  allowedOrigins: readonly string[],
): void {
  session.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    if (permission !== 'media' || details.mediaType !== 'audio') return false;
    return isAllowedOrigin(requestingOrigin, allowedOrigins);
  });

  session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    if (permission !== 'media' || !isAudioOnlyMediaRequest(details)) {
      callback(false);
      return;
    }
    callback(isAllowedOrigin(details.requestingUrl, allowedOrigins));
  });
}

function isAudioOnlyMediaRequest(
  details: PermissionRequestDetails,
): details is MediaAccessPermissionRequest {
  if (!('mediaTypes' in details)) return false;
  const mediaTypes = details.mediaTypes ?? [];
  return mediaTypes.length > 0 && mediaTypes.every((type) => type === 'audio');
}
