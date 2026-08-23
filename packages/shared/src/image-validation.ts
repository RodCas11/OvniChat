import type { AvatarImageFormat } from '@disco-voador/protocol';

/**
 * T13.3 — the highest-risk, most security-relevant unit in the profile/avatar feature: sniffs an
 * avatar image's *header bytes only* (never fully decodes pixel data — no image-processing
 * dependency exists or should ever exist in this module) to determine its real format and pixel
 * dimensions, and rejects anything that doesn't match one of exactly three allowlisted formats
 * (PNG/JPEG/WebP) — SVG/GIF/BMP/TIFF/anything else is rejected outright by falling through every
 * signature check, never by a blocklist. Also rejects an animated format disguised as static
 * (APNG using ordinary PNG magic bytes; an animated WebP) — the product requirement this task
 * exists to enforce.
 *
 * Lives in `packages/shared` (not `services/dedicated-server`) because it has exactly two real
 * consumers that both need byte-identical behavior: `services/dedicated-server` (authoritative
 * server-side validation before persisting an uploaded avatar) and `apps/desktop`'s Main process
 * (validating a locally-picked file before upload, and re-validating avatar bytes received FROM a
 * remote Dedicated Server before caching/rendering them — a hostile/compromised server operator is
 * an untrusted input source into the local filesystem/renderer). Duplicating this logic in two
 * places would let the two copies silently drift apart, which is unacceptable for the riskiest
 * parsing code in the whole feature.
 *
 * Every function here is a pure, total function over a `Buffer` — never throws for a
 * hostile-but-well-formed-JS-call input (a too-short buffer, garbage bytes, a claimed 100000x100000
 * image); only a genuine programmer error (wrong argument type) would throw.
 */

export type ImageValidationFailureCode =
  'AVATAR_INVALID_FORMAT' | 'AVATAR_DIMENSIONS_TOO_LARGE' | 'AVATAR_ANIMATED_NOT_ALLOWED';

export type ImageValidationResult =
  | {
      readonly ok: true;
      readonly format: AvatarImageFormat;
      readonly width: number;
      readonly height: number;
    }
  | { readonly ok: false; readonly code: ImageValidationFailureCode; readonly message: string };

interface SniffedImage {
  readonly format: AvatarImageFormat;
  readonly width: number;
  readonly height: number;
  readonly animated: boolean;
}

// --- PNG -----------------------------------------------------------------------------------------

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function matchesPngSignature(buf: Buffer): boolean {
  if (buf.length < PNG_SIGNATURE.length) return false;
  return PNG_SIGNATURE.every((byte, index) => buf[index] === byte);
}

/**
 * Walks the PNG chunk structure (4-byte length, 4-byte type, `length` bytes of data, 4-byte CRC)
 * structurally — never a substring search for `acTL` (which could both false-positive on
 * unrelated image data bytes and miss a chunk boundary). `IHDR` must be the very first chunk
 * (required by the PNG spec); width/height are read directly from it. `acTL` appearing anywhere
 * before the first `IDAT` chunk marks this as APNG (animated PNG using ordinary PNG magic bytes).
 */
function sniffPng(buf: Buffer): SniffedImage | undefined {
  if (!matchesPngSignature(buf)) return undefined;

  const ihdrHeaderStart = 8;
  if (ihdrHeaderStart + 8 > buf.length) return undefined;
  const ihdrLength = buf.readUInt32BE(ihdrHeaderStart);
  const ihdrType = buf.toString('ascii', ihdrHeaderStart + 4, ihdrHeaderStart + 8);
  if (ihdrType !== 'IHDR' || ihdrLength !== 13) return undefined;

  const ihdrDataStart = ihdrHeaderStart + 8;
  if (ihdrDataStart + 13 + 4 > buf.length) return undefined;
  const width = buf.readUInt32BE(ihdrDataStart);
  const height = buf.readUInt32BE(ihdrDataStart + 4);
  if (width === 0 || height === 0) return undefined;

  let pos = ihdrDataStart + 13 + 4; // past IHDR's data + its CRC
  let sawIdat = false;
  let animated = false;
  // Bounded by the buffer's own length (never more than AVATAR_MAX_RAW_BYTES in practice, so this
  // loop is never unbounded work) — walks every remaining chunk once, stopping safely (never
  // throwing) the instant the structure looks truncated/malformed.
  while (pos + 8 <= buf.length) {
    const chunkLength = buf.readUInt32BE(pos);
    const chunkType = buf.toString('ascii', pos + 4, pos + 8);
    const chunkDataStart = pos + 8;
    if (chunkLength < 0 || chunkDataStart + chunkLength + 4 > buf.length) break;

    if (chunkType === 'acTL' && !sawIdat) animated = true;
    if (chunkType === 'IDAT') sawIdat = true;
    if (chunkType === 'IEND') break;

    pos = chunkDataStart + chunkLength + 4;
  }

  return { format: 'png', width, height, animated };
}

// --- JPEG ------------------------------------------------------------------------------------

const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];

function matchesJpegSignature(buf: Buffer): boolean {
  if (buf.length < JPEG_SIGNATURE.length) return false;
  return JPEG_SIGNATURE.every((byte, index) => buf[index] === byte);
}

/** Standalone markers carry no length field: TEM (0x01), RSTn (0xD0-0xD7). SOI/EOI are handled by
 * the caller's own loop control. */
function isStandaloneMarker(marker: number): boolean {
  return marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7);
}

/** A real Start-Of-Frame marker is 0xC0-0xCF, *excluding* 0xC4 (DHT, define Huffman table), 0xC8
 * (reserved/JPG extension, not a real SOF), and 0xCC (DAC, define arithmetic coding). */
function isStartOfFrameMarker(marker: number): boolean {
  return marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
}

/**
 * Scans JPEG segment markers (`FF xx` pairs, correctly skipping each segment's own length-prefixed
 * data) for a SOF marker, reading width/height from its fixed offsets: relative to the position of
 * the marker code byte itself, `+2..3` is the segment length, `+4` is the sample precision, `+5..6`
 * is height, `+7..8` is width (ITU-T T.81 section B.2.2, frame header syntax: `Lf`, `P`, `Y`, `X`).
 * No animation check exists for JPEG (no standard animated form).
 */
function sniffJpeg(buf: Buffer): SniffedImage | undefined {
  if (!matchesJpegSignature(buf)) return undefined;

  let pos = 2; // past the SOI marker (FF D8); `buf[2]` is the FF of the next marker.
  while (pos < buf.length) {
    if (buf[pos] !== 0xff) return undefined;
    while (pos < buf.length && buf[pos] === 0xff) pos++;
    if (pos >= buf.length) return undefined;

    const markerBytePos = pos;
    const marker = buf[markerBytePos] as number;
    pos++;

    if (marker === 0xd9) return undefined; // EOI reached, no SOF found
    if (isStandaloneMarker(marker)) continue;
    if (marker === 0xda) return undefined; // start-of-scan reached, no SOF found before it

    if (pos + 1 >= buf.length) return undefined;
    const segmentLength = buf.readUInt16BE(pos);
    if (segmentLength < 2) return undefined;

    if (isStartOfFrameMarker(marker)) {
      if (pos + 6 >= buf.length) return undefined;
      const height = buf.readUInt16BE(pos + 3);
      const width = buf.readUInt16BE(pos + 5);
      if (width === 0 || height === 0) return undefined;
      return { format: 'jpeg', width, height, animated: false };
    }

    pos += segmentLength;
  }
  return undefined;
}

// --- WebP ----------------------------------------------------------------------------------------

function read24LE(buf: Buffer, offset: number): number {
  return (buf[offset] ?? 0) | ((buf[offset + 1] ?? 0) << 8) | ((buf[offset + 2] ?? 0) << 16);
}

/**
 * `RIFF`/file-size/`WEBP` header, then branches on the first chunk's FourCC: `VP8X` (extended,
 * animation-capable), `VP8 ` (lossy key frame), or `VP8L` (lossless). For `VP8X`, animation is
 * detected via *two independent signals* — the flags byte's Animation bit, and a structural scan
 * of the remaining chunk list for `ANIM`/`ANMF` — rejecting if *either* indicates animation
 * (defense in depth against a crafted flags byte disagreeing with actual chunk content).
 */
function sniffWebp(buf: Buffer): SniffedImage | undefined {
  if (buf.length < 12) return undefined;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return undefined;
  if (buf.toString('ascii', 8, 12) !== 'WEBP') return undefined;

  const chunkStart = 12;
  if (chunkStart + 8 > buf.length) return undefined;
  const fourCc = buf.toString('ascii', chunkStart, chunkStart + 4);
  const chunkSize = buf.readUInt32LE(chunkStart + 4);
  const dataStart = chunkStart + 8;

  if (fourCc === 'VP8X') {
    if (dataStart + 10 > buf.length) return undefined;
    const flags = buf[dataStart] as number;
    const flagsAnimated = (flags & 0x02) !== 0;
    const width = read24LE(buf, dataStart + 4) + 1;
    const height = read24LE(buf, dataStart + 7) + 1;

    let chunkListAnimated = false;
    let scanPos = dataStart + chunkSize + (chunkSize % 2);
    while (scanPos + 8 <= buf.length) {
      const cc = buf.toString('ascii', scanPos, scanPos + 4);
      const size = buf.readUInt32LE(scanPos + 4);
      if (cc === 'ANIM' || cc === 'ANMF') {
        chunkListAnimated = true;
        break;
      }
      const advance = 8 + size + (size % 2);
      if (advance <= 8) break; // guards against a zero/garbage size looping forever
      scanPos += advance;
    }

    return { format: 'webp', width, height, animated: flagsAnimated || chunkListAnimated };
  }

  if (fourCc === 'VP8 ') {
    if (dataStart + 10 > buf.length) return undefined;
    // 3-byte frame tag, then the 3-byte start code 0x9D 0x01 0x2A.
    if (buf[dataStart + 3] !== 0x9d || buf[dataStart + 4] !== 0x01 || buf[dataStart + 5] !== 0x2a) {
      return undefined;
    }
    const widthCode = buf.readUInt16LE(dataStart + 6);
    const heightCode = buf.readUInt16LE(dataStart + 8);
    const width = widthCode & 0x3fff;
    const height = heightCode & 0x3fff;
    if (width === 0 || height === 0) return undefined;
    return { format: 'webp', width, height, animated: false };
  }

  if (fourCc === 'VP8L') {
    if (dataStart + 5 > buf.length) return undefined;
    if (buf[dataStart] !== 0x2f) return undefined;
    const bits = buf.readUInt32LE(dataStart + 1);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >>> 14) & 0x3fff) + 1;
    return { format: 'webp', width, height, animated: false };
  }

  return undefined;
}

// --- Entry point -----------------------------------------------------------------------------

function sniff(buf: Buffer): SniffedImage | undefined {
  return sniffPng(buf) ?? sniffJpeg(buf) ?? sniffWebp(buf);
}

/**
 * Validates `rawBytes` against `declaredFormat` (the caller's claimed `format` field) and
 * `maxDimension` (512 for a user avatar, 1024 for the server avatar — see
 * `packages/protocol/src/profile.ts`'s own doc comment on why these ceilings differ while the byte
 * budget does not). A format/content mismatch is rejected as `AVATAR_INVALID_FORMAT`, never
 * silently corrected to the sniffed format. Never throws.
 */
export function validateAvatarImage(
  rawBytes: Buffer,
  declaredFormat: AvatarImageFormat,
  maxDimension: number,
): ImageValidationResult {
  const sniffed = sniff(rawBytes);
  if (!sniffed) {
    return {
      ok: false,
      code: 'AVATAR_INVALID_FORMAT',
      message: 'Image data does not match any allowlisted format (PNG, JPEG, WebP)',
    };
  }
  if (sniffed.format !== declaredFormat) {
    return {
      ok: false,
      code: 'AVATAR_INVALID_FORMAT',
      message: `Declared format "${declaredFormat}" does not match the image's actual format "${sniffed.format}"`,
    };
  }
  if (sniffed.animated) {
    return {
      ok: false,
      code: 'AVATAR_ANIMATED_NOT_ALLOWED',
      message: 'Animated images are not allowed for an avatar',
    };
  }
  if (sniffed.width > maxDimension || sniffed.height > maxDimension) {
    return {
      ok: false,
      code: 'AVATAR_DIMENSIONS_TOO_LARGE',
      message: `Image dimensions ${String(sniffed.width)}x${String(sniffed.height)} exceed the maximum of ${String(maxDimension)}x${String(maxDimension)}`,
    };
  }
  return { ok: true, format: sniffed.format, width: sniffed.width, height: sniffed.height };
}
