import { readFile } from 'node:fs/promises';

import { AVATAR_MAX_BASE64_LENGTH, AVATAR_MAX_RAW_BYTES } from '@disco-voador/protocol';
import type { AvatarImageFormat } from '@disco-voador/protocol';
import { validateAvatarImage } from '@disco-voador/shared';
import { dialog } from 'electron';
import type { BrowserWindow, OpenDialogOptions } from 'electron';

import type {
  AvatarMaxDimension,
  AvatarValidationFailure,
  DesktopAvatarPickResult,
  DesktopAvatarValidationResult,
} from '../shared/ipc-contract.js';

/**
 * T13.3 — Main-process avatar-image handling: a native file picker for a locally-chosen avatar, and
 * re-validation of avatar bytes received FROM a remote Dedicated Server before the Renderer ever
 * caches or renders them. Both paths funnel through `@disco-voador/shared`'s `validateAvatarImage` —
 * the one authoritative, header-bytes-only sniffer this whole feature relies on (see that module's
 * own doc comment) — so this file never re-implements format/dimension/animation detection itself.
 */

const CANDIDATE_FORMATS: readonly AvatarImageFormat[] = ['png', 'jpeg', 'webp'];

function tooLargeResult(byteLength: number): AvatarValidationFailure {
  return {
    ok: false,
    code: 'AVATAR_TOO_LARGE',
    message: `Image is ${String(byteLength)} bytes, exceeding the ${String(AVATAR_MAX_RAW_BYTES)}-byte limit.`,
  };
}

/**
 * Validates `rawBytes` against a *declared* format the caller already trusts (e.g. the `format`
 * field of an already-schema-validated `server:profile-avatar-data` message) — a mismatch between
 * the declared and actual sniffed format is a genuine `AVATAR_INVALID_FORMAT` failure here, unlike
 * {@link sniffAndValidate} below, which has no declared format to check against at all.
 */
function validateDeclaredFormat(
  rawBytes: Buffer,
  declaredFormat: AvatarImageFormat,
  maxDimension: number,
): DesktopAvatarValidationResult {
  if (rawBytes.length > AVATAR_MAX_RAW_BYTES) return tooLargeResult(rawBytes.length);
  return validateAvatarImage(rawBytes, declaredFormat, maxDimension);
}

/**
 * A locally-picked file has no caller-trusted declared format — only a file extension, which is
 * UX-only and never trusted (the file may have been renamed). `validateAvatarImage` requires a
 * declared format to compare the sniffed one against, so this tries each of the three allowlisted
 * formats in turn: a declared/sniffed *mismatch* (`AVATAR_INVALID_FORMAT`) simply means "try the next
 * candidate," while any other failure (animated, dimensions too large) means the real format was
 * already correctly identified and this is a genuine validation failure, not a mismatch artifact —
 * returned immediately rather than continuing to try more candidates.
 */
function sniffAndValidate(rawBytes: Buffer, maxDimension: number): DesktopAvatarValidationResult {
  if (rawBytes.length > AVATAR_MAX_RAW_BYTES) return tooLargeResult(rawBytes.length);

  let lastFailure: DesktopAvatarValidationResult | undefined;
  for (const candidate of CANDIDATE_FORMATS) {
    const result = validateAvatarImage(rawBytes, candidate, maxDimension);
    if (result.ok) return result;
    if (result.code !== 'AVATAR_INVALID_FORMAT') return result;
    lastFailure = result;
  }
  return (
    lastFailure ?? {
      ok: false,
      code: 'AVATAR_INVALID_FORMAT',
      message: 'Image data does not match any allowlisted format (PNG, JPEG, WebP)',
    }
  );
}

/**
 * Opens a native "choose an image" dialog, reads the picked file's real bytes (never trusting its
 * extension), and validates them. Returns `undefined` if the user dismissed the picker. Never
 * returns a raw file path to the caller — only sanitized, bounded, already-validated plain data (or
 * a validation failure), mirroring `screen-share.ts`'s "never hand back a raw native handle" rule,
 * deliberately stricter here since a real filesystem path is more sensitive than an opaque capture
 * source id.
 */
export async function selectAvatarImageFile(
  ownerWindow: BrowserWindow | undefined,
  maxDimension: AvatarMaxDimension,
): Promise<DesktopAvatarPickResult | undefined> {
  const dialogOptions: OpenDialogOptions = {
    title: 'Choose an avatar image',
    properties: ['openFile'],
    filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
  };
  const result = ownerWindow
    ? await dialog.showOpenDialog(ownerWindow, dialogOptions)
    : await dialog.showOpenDialog(dialogOptions);
  if (result.canceled) return undefined;
  const filePath = result.filePaths[0];
  if (!filePath) return undefined;

  let rawBytes: Buffer;
  try {
    rawBytes = await readFile(filePath);
  } catch (error) {
    console.error('avatar-images: failed to read the picked file', error);
    return {
      ok: false,
      code: 'AVATAR_INVALID_FORMAT',
      message: 'Could not read the selected file.',
    };
  }

  const validation = sniffAndValidate(rawBytes, maxDimension);
  if (!validation.ok) return validation;

  const base64 = rawBytes.toString('base64');
  if (base64.length > AVATAR_MAX_BASE64_LENGTH) return tooLargeResult(rawBytes.length);

  return { ok: true, format: validation.format, byteLength: rawBytes.length, base64 };
}

/**
 * Re-validates avatar bytes the Renderer received from a remote Dedicated Server before they are
 * ever cached or rendered — see this file's own top doc comment. `declaredFormat` here is the
 * server's own claimed format (already narrowed by `avatarImageFormatSchema` at the protocol
 * boundary), so a mismatch against the sniffed format is treated as a genuine failure, not tried
 * against other candidates the way a locally-picked file's unreliable extension is.
 */
export function validateAvatarImageBytes(
  base64: string,
  declaredFormat: AvatarImageFormat,
  maxDimension: AvatarMaxDimension,
): DesktopAvatarValidationResult {
  let rawBytes: Buffer;
  try {
    rawBytes = Buffer.from(base64, 'base64');
  } catch (error) {
    console.error('avatar-images: failed to decode avatar base64', error);
    return { ok: false, code: 'AVATAR_INVALID_FORMAT', message: 'Malformed image data.' };
  }
  return validateDeclaredFormat(rawBytes, declaredFormat, maxDimension);
}
