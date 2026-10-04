/**
 * Read the width and height of an image from its bytes, without decoding the
 * pixel data. Only enough of the file is inspected to satisfy the format's
 * header or directory layout.
 *
 * Interpretation choices (documented so callers know what to expect):
 *  - Only formats whose header is at a *fixed* offset relative to the start of
 *    the file are supported: PNG, GIF, BMP, and JPEG (where markers are walked).
 *    WebP and TIFF need a pointer table that can live far into the file; to keep
 *    the read bounded and deterministic we do not attempt them here.
 *  - The function takes a `Uint8Array`, not a stream. That keeps the API
 *    synchronous, dependency-free, and trivial to test. Callers are responsible
 *    for reading enough of the file to cover the header region; `bytesNeeded`
 *    in the thrown error tells them exactly how much more to load.
 */

/**
 * @typedef {{ width: number, height: number }} Dimensions
 */

export const SUPPORTED_FORMATS = Object.freeze([
  'png',
  'gif',
  'bmp',
  'jpeg',
]);

// Header sizes that the parser must see to have any chance of success.
// If a buffer is smaller than the magic length, we cannot even sniff the type.
const MAGIC_MIN = 8;

/**
 * Read a 32-bit big-endian unsigned integer from `buf` at `offset`.
 */
function readU32BE(buf, offset) {
  return (buf[offset] * 0x1000000) + ((buf[offset + 1] << 16) |
    (buf[offset + 2] << 8) | buf[offset + 3]);
}

/**
 * Read a 16-bit big-endian unsigned integer from `buf` at `offset`.
 */
function readU16BE(buf, offset) {
  return ((buf[offset] << 8) | buf[offset + 1]);
}

/**
 * Read a 16-bit little-endian unsigned integer from `buf` at `offset`.
 */
function readU16LE(buf, offset) {
  return (buf[offset] | (buf[offset + 1] << 8));
}

/**
 * Read a 32-bit little-endian unsigned integer from `buf` at `offset`.
 * Uses multiplication for the high byte to stay within 32-bit unsigned range
 * regardless of the sign of the low bytes.
 */
function readU32LE(buf, offset) {
  return (buf[offset] | (buf[offset + 1] << 8) |
    (buf[offset + 2] << 16)) + (buf[offset + 3] * 0x1000000);
}

/**
 * PNG: IHDR chunk sits at offset 16, width then height, both big-endian u32.
 * The PNG signature is 8 bytes; IHDR length + type is 8 more, so data lands at 16.
 */
function parsePng(buf) {
  // IHDR must be the first chunk, right after the 8-byte signature.
  if (buf.length < 24) return undefined;
  if (buf[12] !== 0x49 || buf[13] !== 0x48 ||
      buf[14] !== 0x44 || buf[15] !== 0x52) {
    // Not an IHDR where we expect it; refuse rather than guess.
    return undefined;
  }
  return {
    width: readU32BE(buf, 16),
    height: readU32BE(buf, 20),
  };
}

/**
 * GIF87a/89a: little-endian u16 width at offset 6, height at offset 8.
 * The logical screen descriptor always lives at the same place for both
 * versions, so we do not need to distinguish 87a from 89a.
 */
function parseGif(buf) {
  if (buf.length < 10) return undefined;
  return {
    width: readU16LE(buf, 6),
    height: readU16LE(buf, 8),
  };
}

/**
 * BMP: little-endian u32 width at offset 18, height at offset 22.
 * Height is signed for BMP (negative means top-down), but callers want a
 * positive pixel count, so we take the absolute value.
 */
function parseBmp(buf) {
  if (buf.length < 26) return undefined;
  const width = readU32LE(buf, 18);
  let height = readU32LE(buf, 22);
  if (height > 0x7fffffff) {
    // Two's-complement interpretation for the signed-height case.
    height = 0x100000000 - height;
  }
  return { width, height };
}

/**
 * JPEG: there is no fixed offset for dimensions, so we walk the marker chain.
 * Each marker is `FF xx` followed by a 2-byte big-endian length that *includes*
 * those two length bytes but not the marker itself. SOF0/SOF1/SOF2/SOF3/
 * SOF5/SOF6/SOF7/SOF9/SOF10/SOF11 carry width (u16 BE) and height (u16 BE)
 * immediately after precision in their payload.
 */
function parseJpeg(buf) {
  // SOFn markers that carry frame dimensions.
  const SOF_MARKERS = new Set([
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf,
  ]);
  let i = 0;
  while (i + 1 < buf.length) {
    if (buf[i] !== 0xff) {
      // Not at a marker boundary. JPEG is structured so this should not happen
      // if we start correctly, but bail rather than resync blindly.
      return undefined;
    }
    // Skip fill bytes (0xff) before the real marker byte.
    let marker = buf[i + 1];
    while (marker === 0xff && i + 2 < buf.length) {
      i += 1;
      marker = buf[i + 1];
    }
    if (marker === 0x00) return undefined; // stuffed byte, not a marker
    i += 2;

    if (marker === 0xd8 || marker === 0xd9) {
      // SOI/EOI: standalone, no length field.
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      // TEM, RSTn: standalone markers with no payload.
      continue;
    }
    if (SOF_MARKERS.has(marker)) {
      // SOF payload: [length(2)] [precision(1)] [height(2)] [width(2)] ...
      // We already advanced past the marker, so payload starts at `i`.
      if (i + 7 > buf.length) return undefined;
      return {
        height: readU16BE(buf, i + 3),
        width: readU16BE(buf, i + 5),
      };
    }
    // All other markers have a 2-byte big-endian length following them.
    if (i + 2 > buf.length) return undefined;
    const segLen = readU16BE(buf, i);
    if (segLen < 2) return undefined;
    i += segLen;
  }
  return undefined;
}

/**
 * Sniff the image format from the first bytes. Returns one of the strings in
 * SUPPORTED_FORMATS, or null if the buffer does not match a known signature.
 */
function detectFormat(buf) {
  if (buf.length < MAGIC_MIN) return null;
  // PNG signature.
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e &&
      buf[3] === 0x47 && buf[4] === 0x0d && buf[5] === 0x0a &&
      buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'png';
  }
  // GIF87a / GIF89a.
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
      (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) {
    return 'gif';
  }
  // BMP.
  if (buf[0] === 0x42 && buf[1] === 0x4d) {
    return 'bmp';
  }
  // JPEG SOI.
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    return 'jpeg';
  }
  return null;
}

/**
 * Parse image dimensions from an in-memory buffer.
 *
 * The buffer must contain at least enough of the file to cover the header
 * region for the detected format. For PNG/GIF/BMP the header is small and at
 * a fixed offset; for JPEG the buffer must extend to wherever the first SOFn
 * marker lives, which in pathological files can be many kilobytes in.
 *
 * @param {Uint8Array} buf - raw bytes from the start of the image file.
 * @returns {Dimensions} `{ width, height }` in pixels.
 * @throws {Error} if the format is unsupported, the buffer is too short to
 *   even sniff, or no dimension-bearing frame marker was found (JPEG only).
 *   The thrown `Error` has a `bytesNeeded` property (number) when more bytes
 *   would plausibly resolve the issue; callers may load that much and retry.
 */
export function imageSize(buf) {
  if (!(buf instanceof Uint8Array)) {
    throw new TypeError('imageSize: expected a Uint8Array');
  }
  if (buf.length < MAGIC_MIN) {
    const err = new Error(
      `imageSize: need at least ${MAGIC_MIN} bytes to sniff the format, got ${buf.length}`,
    );
    err.bytesNeeded = MAGIC_MIN;
    throw err;
  }
  const format = detectFormat(buf);
  if (!format) {
    throw new Error('imageSize: unsupported or unrecognised image format');
  }
  let dims;
  if (format === 'png') dims = parsePng(buf);
  else if (format === 'gif') dims = parseGif(buf);
  else if (format === 'bmp') dims = parseBmp(buf);
  else dims = parseJpeg(buf);
  if (!dims) {
    // The only way this happens with a supported format is JPEG running out of
    // buffer before an SOFn marker appears. Tell the caller how far we got so
    // they can load more and retry deterministically.
    const err = new Error(
      `imageSize: could not locate dimensions in the provided ${format} buffer`,
    );
    err.format = format;
    err.bytesNeeded = Math.max(buf.length * 2, buf.length + 1024);
    throw err;
  }
  return dims;
}
