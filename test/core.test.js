import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageSize, SUPPORTED_FORMATS } from '../src/index.js';

// Build minimal byte buffers that exercise the real parser paths.

function pngHeader(width, height) {
  // 8-byte signature + IHDR chunk (length=13, type, payload, crc placeholder).
  const b = new Uint8Array(24);
  b[0] = 0x89; b[1] = 0x50; b[2] = 0x4e; b[3] = 0x47;
  b[4] = 0x0d; b[5] = 0x0a; b[6] = 0x1a; b[7] = 0x0a;
  // IHDR length = 13 (big-endian u32).
  b[8] = 0; b[9] = 0; b[10] = 0; b[11] = 13;
  b[12] = 0x49; b[13] = 0x48; b[14] = 0x44; b[15] = 0x52;
  b[16] = (width >>> 24) & 0xff;
  b[17] = (width >>> 16) & 0xff;
  b[18] = (width >>> 8) & 0xff;
  b[19] = width & 0xff;
  b[20] = (height >>> 24) & 0xff;
  b[21] = (height >>> 16) & 0xff;
  b[22] = (height >>> 8) & 0xff;
  b[23] = height & 0xff;
  return b;
}

function gifHeader(width, height, version = 0x39) {
  const b = new Uint8Array(13);
  b[0] = 0x47; b[1] = 0x49; b[2] = 0x46; b[3] = 0x38;
  b[4] = version; b[5] = 0x61; // GIF8(7|9)a
  b[6] = width & 0xff;
  b[7] = (width >> 8) & 0xff;
  b[8] = height & 0xff;
  b[9] = (height >> 8) & 0xff;
  return b;
}

function bmpHeader(width, heightSigned) {
  const b = new Uint8Array(26);
  b[0] = 0x42; b[1] = 0x4d; // "BM"
  // width at offset 18 (little-endian u32).
  b[18] = width & 0xff;
  b[19] = (width >> 8) & 0xff;
  b[20] = (width >> 16) & 0xff;
  b[21] = (width >> 24) & 0xff;
  // height at offset 22 (little-endian u32; may be negative).
  const h = heightSigned >>> 0;
  b[22] = h & 0xff;
  b[23] = (h >> 8) & 0xff;
  b[24] = (h >> 16) & 0xff;
  b[25] = (h >> 24) & 0xff;
  return b;
}

/**
 * Build a tiny JPEG with a single APP0 segment then SOF0 carrying dimensions.
 * Marker layout: SOI | APP0(len=16) | SOF0(len=17, precision, h, w, ...) | EOI.
 */
function jpegHeader(width, height, extraSegmentsBefore = []) {
  const parts = [];
  function push(marker, payload) {
    parts.push(0xff, marker);
    if (payload !== null) {
      const segLen = payload.length + 2;
      parts.push((segLen >> 8) & 0xff, segLen & 0xff);
      for (const byte of payload) parts.push(byte);
    }
  }
  parts.push(0xff, 0xd8); // SOI
  for (const seg of extraSegmentsBefore) push(seg.marker, seg.payload);
  // APP0: JFIF marker, minimal payload of 14 bytes -> segment length 16.
  const app0Payload = [
    0x4a, 0x46, 0x49, 0x46, 0x00, // "JFIF\0"
    0x01, 0x02, // version 1.02
    0x00, // units
    0x00, 0x01, 0x00, 0x01, // density
    0x00, 0x00, // thumbnail
  ];
  push(0xe0, app0Payload);
  // SOF0: precision(1), height(2 BE), width(2 BE), components(1), then dummy.
  const sofPayload = [
    0x08, // precision 8 bits
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    0x01, // 1 component
    0x01, 0x11, 0x00, // component spec placeholder
  ];
  push(0xc0, sofPayload);
  parts.push(0xff, 0xd9); // EOI
  return new Uint8Array(parts);
}

test('exports the documented names', () => {
  assert.equal(typeof imageSize, 'function');
  assert.deepEqual([...SUPPORTED_FORMATS], ['png', 'gif', 'bmp', 'jpeg']);
});

test('rejects non-Uint8Array input', () => {
  assert.throws(() => imageSize([]), TypeError);
  assert.throws(() => imageSize('not bytes'), TypeError);
  assert.throws(() => imageSize(null), TypeError);
});

test('rejects buffers too small to sniff', () => {
  assert.throws(
    () => imageSize(new Uint8Array(4)),
    /need at least 8 bytes/,
  );
});

test('rejects an unrecognised signature', () => {
  const buf = new Uint8Array(16); // all zero, not a known image
  assert.throws(() => imageSize(buf), /unsupported or unrecognised/);
});

test('parses a PNG header', () => {
  const buf = pngHeader(320, 240);
  const dims = imageSize(buf);
  assert.deepEqual(dims, { width: 320, height: 240 });
});

test('parses a wide PNG that exercises the high byte', () => {
  const buf = pngHeader(4096, 2160);
  assert.deepEqual(imageSize(buf), { width: 4096, height: 2160 });
});

test('PNG with a non-IHDR first chunk is refused', () => {
  const buf = pngHeader(10, 10);
  // Corrupt the IHDR type bytes.
  buf[12] = 0x58; buf[13] = 0x58; buf[14] = 0x58; buf[15] = 0x58;
  assert.throws(() => imageSize(buf), /could not locate dimensions/);
});

test('parses GIF87a', () => {
  const buf = gifHeader(800, 600, 0x37);
  assert.deepEqual(imageSize(buf), { width: 800, height: 600 });
});

test('parses GIF89a', () => {
  const buf = gifHeader(256, 256, 0x39);
  assert.deepEqual(imageSize(buf), { width: 256, height: 256 });
});

test('parses a BMP with a positive height', () => {
  const buf = bmpHeader(640, 480);
  assert.deepEqual(imageSize(buf), { width: 640, height: 480 });
});

test('BMP negative height is reported as positive', () => {
  // A top-down BMP stores height as the two's-complement negative value.
  // -100 as int32 is 0xffffff9c, which readU32LE returns as 4294967196.
  const buf = bmpHeader(200, -100);
  assert.deepEqual(imageSize(buf), { width: 200, height: 100 });
});

test('parses a JPEG with an APP0 segment before SOF0', () => {
  const buf = jpegHeader(1920, 1080);
  assert.deepEqual(imageSize(buf), { width: 1920, height: 1080 });
});

test('JPEG with only an SOI and no frame marker throws', () => {
  const buf = new Uint8Array([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x00, 0x00, 0x00]);
  assert.throws(() => imageSize(buf), /could not locate dimensions/);
});

test('JPEG marker walk skips APP segments it does not understand', () => {
  // Insert a large dummy APP1 segment before APP0 to force the walker to skip.
  const dummyPayload = new Array(200).fill(0x41);
  const buf = jpegHeader(640, 480, [{ marker: 0xe1, payload: dummyPayload }]);
  assert.deepEqual(imageSize(buf), { width: 640, height: 480 });
});
