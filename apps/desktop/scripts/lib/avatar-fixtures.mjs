// Real, structurally-valid (or deliberately invalid) minimal PNG fixtures for the T13.3 profile/
// avatar E2E scripts — mirrors `tests/dedicated-server/profile-integration.test.ts`'s own
// `pngChunk`/`buildPng` structural builders exactly (same chunk-walking format
// `packages/shared/src/image-validation.ts` parses), so these scripts exercise the identical real
// validation code path a hostile/legitimate upload would.
//
// `IDAT` carries a REAL, `zlib.deflateSync`-compressed, filter-type-0 raster (a solid RGBA fill) —
// NOT arbitrary bytes — and every chunk carries a REAL CRC32 (`zlib.crc32`, Node >= 22) over its own
// type+data, not a placeholder. An earlier version of this file used `Buffer.from([0, 0, 0, 0])` as
// the IDAT "shortcut" and a hardcoded all-zero CRC for every chunk, both of which happily passed
// `image-validation.ts`'s own header-only sniffer (real product code deliberately never fully
// decodes pixel data or checks chunk CRCs — see that module's own doc comment) but are not a valid
// PNG at all by the real format spec: the IDAT bytes are not valid zlib data at all (confirmed via
// `zlib.inflateSync` throwing "unknown compression method"), and even after fixing that alone, a
// REAL browser `<img>` decoder still correctly refused to render it on its CRC check alone —
// `complete: true`, `naturalWidth`/`naturalHeight: 0`, the standard "broken image" signature,
// confirmed live via `armE2EProfileSmoke`'s `read-avatar-image-state` diagnostic step both
// immediately and after a deliberate multi-second delay (ruling out a fetch-timing race), for BOTH
// the invalid-IDAT and (once fixed) the zero-CRC case. This was a real, screenshot-visible defect —
// in this QA-only fixture generator, never in product code — flagged and fixed as part of the T13.3
// QA pass; see `docs/tasks/screenshots/t13-3/`'s own recapture for the corrected renders.

import zlib from 'node:zlib';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(typeAndData) >>> 0, 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** A real, minimal, filter-type-0 (None) RGBA raster for a solid `[r, g, b, a]` fill — one leading
 * filter-type byte per scanline, exactly as PNG's own spec requires, then real `zlib`-deflated
 * (never raw/arbitrary bytes) so an actual browser `<img>` decoder renders it correctly. */
function solidRgbaRaster(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type: None
    for (let x = 0; x < width; x += 1) {
      const pixelStart = rowStart + 1 + x * 4;
      raw[pixelStart] = rgba[0];
      raw[pixelStart + 1] = rgba[1];
      raw[pixelStart + 2] = rgba[2];
      raw[pixelStart + 3] = rgba[3];
    }
  }
  return zlib.deflateSync(raw);
}

export function buildPng(width, height, options = {}) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0);
  ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8;
  ihdrData[9] = 6;
  const chunks = [signature, pngChunk('IHDR', ihdrData)];
  if (options.animated) chunks.push(pngChunk('acTL', Buffer.alloc(8)));
  const rgba = options.color ?? [88, 101, 164, 255]; // a real, visible, muted-blue fill
  chunks.push(
    pngChunk('IDAT', solidRgbaRaster(width, height, rgba)),
    pngChunk('IEND', Buffer.alloc(0)),
  );
  return Buffer.concat(chunks);
}

let fixtureDir;
function fixturePath(name) {
  fixtureDir ??= mkdtempSync(path.join(tmpdir(), 'disco-voador-e2e-avatar-fixtures-'));
  return path.join(fixtureDir, name);
}

/** A small (4x4), static, structurally-valid PNG — well under both the byte and dimension bounds. */
export function writeValidAvatarFixture(name = 'valid.png') {
  const filePath = fixturePath(name);
  writeFileSync(filePath, buildPng(4, 4));
  return filePath;
}

/** A structurally-valid PNG carrying a real `acTL` chunk before its first `IDAT` — real APNG
 * animation using ordinary PNG magic bytes (see `image-validation.ts`'s own doc comment on why this,
 * not a substring search, is what `AVATAR_ANIMATED_NOT_ALLOWED` actually detects). */
export function writeAnimatedAvatarFixture(name = 'animated.png') {
  const filePath = fixturePath(name);
  writeFileSync(filePath, buildPng(4, 4, { animated: true }));
  return filePath;
}

/** 600x600 exceeds the 512x512 self-avatar ceiling (`SELF_AVATAR_MAX_DIMENSION` in
 * `ProfileEditor.tsx`) while staying well under the byte-length limit. */
export function writeOversizedDimensionAvatarFixture(name = 'oversized-dimensions.png') {
  const filePath = fixturePath(name);
  writeFileSync(filePath, buildPng(600, 600));
  return filePath;
}

/** Real JPEG magic bytes with no further structure — a genuinely different, still-allowlisted format
 * than the `format: 'png'` a caller might declare, used to prove `AVATAR_INVALID_FORMAT` rather than
 * a confusing generic failure. */
export function writeWrongFormatAvatarFixture(name = 'wrong-format.jpg') {
  const filePath = fixturePath(name);
  writeFileSync(filePath, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0]));
  return filePath;
}

/** Neither PNG, JPEG, nor WebP — the genuinely-unallowlisted-format case (e.g. what an SVG/GIF/BMP
 * upload would hit): arbitrary bytes matching no signature at all. */
export function writeUnrecognizedFormatAvatarFixture(name = 'unrecognized.svg') {
  const filePath = fixturePath(name);
  writeFileSync(filePath, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>', 'utf8'));
  return filePath;
}

/** Exceeds `AVATAR_MAX_RAW_BYTES` (49,152) — real byte-length rejection, checked before any format
 * sniffing even happens (see `avatar-images.ts`'s `sniffAndValidate`). */
export function writeTooLargeAvatarFixture(name = 'too-large.png') {
  const filePath = fixturePath(name);
  writeFileSync(filePath, Buffer.alloc(60_000, 0x41));
  return filePath;
}
