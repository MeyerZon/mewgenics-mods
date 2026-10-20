// DefineBitsLossless2 (tag 36) encoder: format 5 (32-bit ARGB), premultiplied alpha,
// zlib-compressed. This is the only raster format the engine's gameplay files use
// (OBSERVED, docs/swf-tooling-options.md §1.2) and the premultiplication matches what
// `swf_lib.shader` un-premultiplies on sampling.

import { deflateSync } from "node:zlib";
import { BitWriter, TAG, tag } from "./swf-bits.ts";
import type { RgbaImage } from "./png.ts";

/**
 * Straight RGBA → SWF ARGB premultiplied bytes (a, r·a/255, g·a/255, b·a/255, rounded),
 * no row padding (format 5 rows are 4·width bytes).
 */
export function rgbaToPremultipliedArgb(rgba: Uint8Array): Uint8Array {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const a = rgba[i + 3];
    out[i] = a;
    out[i + 1] = Math.round((rgba[i] * a) / 255);
    out[i + 2] = Math.round((rgba[i + 1] * a) / 255);
    out[i + 3] = Math.round((rgba[i + 2] * a) / 255);
  }
  return out;
}

/**
 * Build a DefineBitsLossless2 tag (always long header, as Flash emits it).
 * @param image straight (non-premultiplied) RGBA
 * @returns framed tag bytes
 */
export function encodeDefineBitsLossless2(charId: number, image: RgbaImage): Uint8Array {
  const { width, height, rgba } = image;
  if (!(width > 0 && height > 0) || width > 0xffff || height > 0xffff) throw new Error(`encodeDefineBitsLossless2: bad size ${width}x${height}`);
  if (rgba.length !== width * height * 4) throw new Error(`encodeDefineBitsLossless2: rgba length ${rgba.length} != ${width}*${height}*4`);
  const w = new BitWriter(16 + rgba.length);
  w.u16(charId);
  w.u8(5);
  w.u16(width);
  w.u16(height);
  w.bytes(new Uint8Array(deflateSync(rgbaToPremultipliedArgb(rgba))));
  return tag(TAG.DefineBitsLossless2, w.finish(), true);
}
