// The PNG fixtures of the DLL's own decoder (native/framework/src/fw_png.c, 3D phase M3 embedded .glb textures):
// generated here from numbers with the editor's encoder (png.ts encodePng) and Node's zlib (stored, fixed-Huffman and
// dynamic-Huffman deflate), so the C suite (native/framework/test/test_png.c) decodes PNGs it did not make itself.
// editor/scripts/make-fw3d-assets.ts writes them to native/framework/test/fixtures/png/<name>.png (+ <name>.rgba, the
// expected straight RGBA8, for the good ones); editor/test/glb-texture-tests.ts re-generates and compares, and checks
// the editor's decodePng agrees with every expected .rgba. Hand-made, no game data.
import { deflateSync, constants as zc } from "node:zlib";
import { crc32, encodePng, decodePng } from "./png.ts";

export type PngExpect = "ok" | "not-png" | "corrupt" | "unsupported" | "size";
export interface PngFixture { name: string; png: Uint8Array; expect: PngExpect; rgba?: Uint8Array; w?: number; h?: number; note: string }

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
function be32(v: number): number[] { return [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; }
function chunk(type: string, data: Uint8Array | number[]): Uint8Array {
  const d = data instanceof Uint8Array ? data : Uint8Array.from(data);
  const out = new Uint8Array(12 + d.length);
  out.set(be32(d.length), 0);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(d, 8);
  out.set(be32(crc32(out, 4, 8 + d.length)), 8 + d.length);
  return out;
}
function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let q = 0;
  for (const p of parts) { out.set(p, q); q += p.length; }
  return out;
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
/** filter one row of raw samples with filter f (0..4) against the previous raw row */
function filterRow(f: number, row: Uint8Array, prev: Uint8Array, bpp: number): Uint8Array {
  const out = new Uint8Array(row.length);
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp]! : 0, b = prev[i]!, c = i >= bpp ? prev[i - bpp]! : 0;
    const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
    out[i] = (row[i]! - pred) & 255;
  }
  return out;
}

export interface RawPng {
  w: number; h: number; colorType: number; bitDepth?: number; interlace?: number;
  samples: Uint8Array;                 // h rows of w * channels bytes (8-bit)
  filters?: (y: number) => number;     // per-row filter, default 0
  zlib?: { level?: number; strategy?: number };
  idatParts?: number;                  // split the zlib stream into this many IDAT chunks
  plte?: number[]; trns?: number[];
  ancillary?: boolean;                 // add a tEXt chunk before the IDATs
}
/** a PNG from raw 8-bit samples with chosen filters / deflate settings / chunk layout */
export function encodeRawPng(o: RawPng): { png: Uint8Array; zdata: Uint8Array } {
  const bpp = CHANNELS[o.colorType]!;
  const stride = o.w * bpp;
  const raw = new Uint8Array((stride + 1) * o.h);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < o.h; y++) {
    const f = o.filters ? o.filters(y) : 0;
    const row = o.samples.subarray(y * stride, (y + 1) * stride);
    raw[y * (stride + 1)] = f;
    raw.set(filterRow(f, row, prev, bpp), y * (stride + 1) + 1);
    prev = new Uint8Array(row);
  }
  const zdata = new Uint8Array(deflateSync(raw, { level: o.zlib?.level ?? 9, strategy: o.zlib?.strategy ?? zc.Z_DEFAULT_STRATEGY }));
  const ihdr = [...be32(o.w), ...be32(o.h), o.bitDepth ?? 8, o.colorType, 0, 0, o.interlace ?? 0];
  const parts: Uint8Array[] = [Uint8Array.from(SIG), chunk("IHDR", ihdr)];
  if (o.ancillary) parts.push(chunk("tEXt", [...new TextEncoder().encode("Comment"), 0, ...new TextEncoder().encode("mewgenics-mods fixture")]));
  if (o.plte) parts.push(chunk("PLTE", o.plte));
  if (o.trns) parts.push(chunk("tRNS", o.trns));
  const n = Math.max(1, o.idatParts ?? 1), step = Math.ceil(zdata.length / n);
  for (let i = 0; i < n; i++) parts.push(chunk("IDAT", zdata.subarray(i * step, Math.min(zdata.length, (i + 1) * step))));
  parts.push(chunk("IEND", []));
  return { png: concat(parts), zdata };
}

/** deterministic samples: a smooth gradient with some noise (so filters and back-references both matter) */
function samples(w: number, h: number, ch: number, seed: number): Uint8Array {
  const s = new Uint8Array(w * h * ch);
  let r = seed >>> 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) for (let c = 0; c < ch; c++) {
    r = (r * 1103515245 + 12345) >>> 0;
    s[(y * w + x) * ch + c] = (x * 9 + y * 5 + c * 60 + ((r >>> 16) & 7)) & 255;
  }
  return s;
}
/** straight RGBA8 of 8-bit samples, the PNG rules (grey -> r=g=b, tRNS key colours / palette alpha) */
export function toRgba(o: RawPng): Uint8Array {
  const ch = CHANNELS[o.colorType]!;
  const out = new Uint8Array(o.w * o.h * 4);
  for (let i = 0; i < o.w * o.h; i++) {
    const s = o.samples.subarray(i * ch, i * ch + ch);
    let px: number[];
    if (o.colorType === 0) px = [s[0]!, s[0]!, s[0]!, o.trns && o.trns[1] === s[0] && o.trns[0] === 0 ? 0 : 255];
    else if (o.colorType === 2) px = [s[0]!, s[1]!, s[2]!, o.trns && o.trns[1] === s[0] && o.trns[3] === s[1] && o.trns[5] === s[2] ? 0 : 255];
    else if (o.colorType === 3) { const k = s[0]!; px = [o.plte![k * 3]!, o.plte![k * 3 + 1]!, o.plte![k * 3 + 2]!, o.trns && k < o.trns.length ? o.trns[k]! : 255]; }
    else if (o.colorType === 4) px = [s[0]!, s[0]!, s[0]!, s[1]!];
    else px = [s[0]!, s[1]!, s[2]!, s[3]!];
    out.set(px, i * 4);
  }
  return out;
}

function good(name: string, o: RawPng, note: string): PngFixture {
  return { name, png: encodeRawPng(o).png, expect: "ok", rgba: toRgba(o), w: o.w, h: o.h, note };
}
/** flip one byte at `at` (counted from the end when negative) and, when fixCrc, recompute the CRC of the chunk it is in */
function damage(png: Uint8Array, at: number, fixCrc: boolean): Uint8Array {
  const b = new Uint8Array(png);
  const i = at < 0 ? b.length + at : at;
  b[i] = b[i]! ^ 0x5a;
  if (fixCrc) {
    let p = 8;
    while (p + 12 <= b.length) {
      const len = ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0;
      if (i >= p + 8 && i < p + 8 + len) { b.set(be32(crc32(b, p + 4, p + 8 + len)), p + 8 + len); break; }
      p += 12 + len;
    }
  }
  return b;
}
function idatOffset(png: Uint8Array): number {   // first byte of the first IDAT's data
  let p = 8;
  while (p + 12 <= png.length) {
    const len = ((png[p]! << 24) | (png[p + 1]! << 16) | (png[p + 2]! << 8) | png[p + 3]!) >>> 0;
    if (String.fromCharCode(png[p + 4]!, png[p + 5]!, png[p + 6]!, png[p + 7]!) === "IDAT") return p + 8;
    p += 12 + len;
  }
  throw new Error("no IDAT");
}

export function pngFixtures(): PngFixture[] {
  const cyc = (y: number) => y % 5;
  const rgbaPix = samples(5, 4, 4, 1);
  const out: PngFixture[] = [
    { name: "rgba-encoder", png: encodePng(5, 4, rgbaPix), expect: "ok", rgba: rgbaPix, w: 5, h: 4, note: "png.ts encodePng: RGBA, filter 0, one IDAT" },
    good("rgb-filters", { w: 7, h: 6, colorType: 2, samples: samples(7, 6, 3, 2), filters: cyc }, "RGB, filters 0 1 2 3 4 0 by row, zlib level 9"),
    good("rgb-stored", { w: 7, h: 6, colorType: 2, samples: samples(7, 6, 3, 2), filters: cyc, zlib: { level: 0 } }, "RGB, stored deflate blocks (level 0)"),
    good("rgba-fixed", { w: 9, h: 5, colorType: 6, samples: samples(9, 5, 4, 3), filters: (y) => 4 - (y % 5), zlib: { strategy: zc.Z_FIXED } }, "RGBA, fixed-Huffman blocks (Z_FIXED), filters 4 3 2 1 0"),
    good("grey", { w: 6, h: 3, colorType: 0, samples: samples(6, 3, 1, 4), filters: (y) => (y * 2) % 5 }, "grey (colour type 0): r = g = b"),
    good("grey-trns", { w: 4, h: 2, colorType: 0, samples: Uint8Array.from([10, 20, 10, 30, 20, 10, 40, 10]), trns: [0, 10] }, "grey with a tRNS key value (10 -> alpha 0)"),
    good("rgb-trns", { w: 3, h: 2, colorType: 2, samples: Uint8Array.from([1, 2, 3, 9, 9, 9, 1, 2, 3, 4, 5, 6, 1, 2, 4, 1, 2, 3]), trns: [0, 1, 0, 2, 0, 3] }, "RGB with a tRNS key colour (1,2,3 -> alpha 0)"),
    good("grey-alpha", { w: 5, h: 3, colorType: 4, samples: samples(5, 3, 2, 5), filters: (y) => [1, 3, 4][y]! }, "grey + alpha (colour type 4), filters 1 3 4"),
    good("palette-trns", { w: 6, h: 4, colorType: 3, samples: Uint8Array.from(Array.from({ length: 24 }, (_, i) => (i * 7) % 4)), plte: [255, 0, 0, 0, 255, 0, 0, 0, 255, 200, 100, 50], trns: [0, 128], filters: cyc }, "palette (colour type 3), 4 entries, tRNS for 2"),
    good("multi-idat", { w: 8, h: 8, colorType: 6, samples: samples(8, 8, 4, 6), filters: cyc, idatParts: 3, ancillary: true }, "RGBA split across 3 IDATs, a tEXt chunk before them"),
    good("big-dynamic", { w: 64, h: 48, colorType: 6, samples: samples(64, 48, 4, 7), filters: (y) => (y * 3) % 5 }, "64 x 48 RGBA, dynamic-Huffman blocks with long back-references"),
  ];
  const base = out[0]!.png;
  const zOff = idatOffset(base);
  const zLen = ((base[zOff - 8]! << 24) | (base[zOff - 7]! << 16) | (base[zOff - 6]! << 8) | base[zOff - 5]!) >>> 0;
  out.push(
    { name: "bad-crc", png: damage(base, zOff + 3, false), expect: "corrupt", note: "a deflate byte changed without fixing the IDAT CRC" },
    { name: "bad-adler", png: damage(base, zOff + zLen - 1, true), expect: "corrupt", note: "the zlib Adler-32 changed (the CRC fixed): only the Adler check sees it" },
    { name: "bad-deflate", png: damage(base, zOff + 2, true), expect: "corrupt", note: "the first deflate byte changed (the CRC fixed)" },
    { name: "truncated", png: base.subarray(0, zOff + 6), expect: "corrupt", note: "the file ends inside the IDAT" },
    { name: "bad-filter", png: encodeRawPng({ w: 2, h: 2, colorType: 2, samples: samples(2, 2, 3, 8), filters: (y) => (y ? 7 : 0) }).png, expect: "corrupt", note: "a scanline with filter type 7" },
    { name: "interlaced", png: encodeRawPng({ w: 4, h: 4, colorType: 6, samples: samples(4, 4, 4, 9), interlace: 1 }).png, expect: "unsupported", note: "IHDR interlace 1 (Adam7)" },
    { name: "depth16", png: encodeRawPng({ w: 2, h: 2, colorType: 6, bitDepth: 16, samples: samples(4, 2, 4, 10) }).png, expect: "unsupported", note: "bit depth 16" },
    { name: "unknown-critical", png: concat([base.subarray(0, 33), chunk("QXYZ", [1, 2, 3]), base.subarray(33)]), expect: "unsupported", note: "an unknown critical chunk QXYZ after IHDR" },
    { name: "zero-size", png: encodeRawPng({ w: 0, h: 1, colorType: 6, samples: new Uint8Array(0) }).png, expect: "size", note: "width 0" },
    { name: "not-png", png: new TextEncoder().encode("GIF89a this is not a png at all, just some bytes"), expect: "not-png", note: "no PNG signature" },
  );
  return out;
}

/** self-check used by the tests: the editor's own decoder agrees with every good fixture's expected pixels */
export function editorDecodes(f: PngFixture): boolean {
  if (f.expect !== "ok" || !f.rgba) return false;
  const img = decodePng(f.png);
  return img.width === f.w && img.height === f.h && Buffer.compare(Buffer.from(img.rgba), Buffer.from(f.rgba)) === 0;
}

/** expected pixels as hex text: 16 RGBA pixels (128 hex digits) per line, LF line ends, a final LF */
export function rgbaHex(rgba: Uint8Array): string {
  const lines: string[] = [];
  for (let i = 0; i < rgba.length; i += 64) lines.push(Buffer.from(rgba.subarray(i, i + 64)).toString("hex"));
  return lines.join("\n") + "\n";
}
