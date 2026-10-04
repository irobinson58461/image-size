/**
 * Public entry point for the image-size library.
 *
 * Re-exports the single `imageSize` function plus the supported-format list,
 * so callers can programmatically decide which file types this build handles.
 */
export { imageSize, SUPPORTED_FORMATS } from './core.js';
