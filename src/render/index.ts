/**
 * Headless software renderer + image utilities (pure TS, deterministic). OWNER: render agent.
 * raster/overlay/font/sheet/diff/draw/image/gif are browser-safe (see ./browser.ts);
 * png.ts uses node:zlib.
 */
export * from './browser.js';
export { encodePNG, decodePNG, crc32, pngChunk } from './png.js';
