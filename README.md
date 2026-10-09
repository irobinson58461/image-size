# image-size

Read the width and height of an image from its first bytes, without decoding the pixel data. Supports PNG, GIF, BMP, and JPEG.

```js
import { imageSize, SUPPORTED_FORMATS } from 'image-size';

const { width, height } = imageSize(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x01, 0x40, 0x00, 0x00, 0x00, 0xf0));
```

## Why this exists

You have a stream of bytes (an upload, a cache entry, a directory scan) and you want to know the pixel dimensions without paying for a full decode. This library reads only the header region for formats whose dimensions sit at a fixed offset, and walks the JPEG marker chain until it hits the first SOFn frame marker. No native bindings, no install step, no third-party packages — it runs anywhere a standard JS engine does.

The trade-off: only formats with a deterministic, bounded header are supported. WebP and TIFF keep their dimensions behind a pointer table that can live anywhere in the file, which would require loading arbitrary offsets; rather than guess, this library refuses them. Call `SUPPORTED_FORMATS` to see the exact list this build handles.

## The awkward edge

For PNG, GIF, and BMP the header is small and at a fixed offset, so a buffer of a few dozen bytes always suffices. JPEG is different: the frame marker that carries the dimensions can sit after an arbitrary run of APP/COM segments, so a buffer that holds the whole file for some inputs may be too short for others. When `imageSize` cannot find dimensions in a JPEG, the thrown `Error` carries a `bytesNeeded` property — load at least that many bytes from the start of the file and retry. The same property appears on the "too short to sniff" error, where it is always 8.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

