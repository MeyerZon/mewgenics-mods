// Minimal PNG codec on `node:zlib`. Decoder: 8-bit, non-interlaced, color types
// 0 (gray), 2 (rgb), 3 (palette + optional tRNS), 4 (gray+alpha), 6 (rgba), all five
// scanline filters; output is straight (non-premultiplied) RGBA. Encoder: RGBA, filter 0,
// one IDAT. Errors are thrown with a precise reason; callers that take user files turn
// them into findings.

import { deflateSync, inflateSync } from "node:zlib";

export interface RgbaImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

let crcTable: Uint32Array | null = null;
function table(): Uint32Array {
  if (crcTable) return crcTable;
  crcTable = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[n] = c >>> 0;
  }
  return crcTable;
}

/** CRC-32 (IEEE) as used by PNG chunks. */
export function crc32(bytes: Uint8Array, start = 0, end = bytes.length): number {
  const t = table();
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = t[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function be32(b: Uint8Array, p: number): number {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
}

/** Decode a PNG into RGBA. */
export function decodePng(bytes: Uint8Array): RgbaImage {
  if (bytes.length < 33 || SIGNATURE.some((v, i) => bytes[i] !== v)) throw new Error("png: not a PNG file (bad signature)");
  let p = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Uint8Array[] = [];
  let sawIhdr = false;
  while (p + 8 <= bytes.length) {
    const len = be32(bytes, p);
    const type = String.fromCharCode(bytes[p + 4], bytes[p + 5], bytes[p + 6], bytes[p + 7]);
    const dataStart = p + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) throw new Error(`png: truncated ${type} chunk`);
    const data = bytes.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      sawIhdr = true;
      width = be32(data, 0);
      height = be32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[10] !== 0) throw new Error(`png: compression method ${data[10]} is not supported`);
      if (data[11] !== 0) throw new Error(`png: filter method ${data[11]} is not supported`);
      if (data[12] !== 0) throw new Error("png: interlaced (Adam7) images are not supported; re-export without interlacing");
      if (bitDepth !== 8) throw new Error(`png: bit depth ${bitDepth} is not supported (only 8-bit); re-export as 8-bit`);
      if (![0, 2, 3, 4, 6].includes(colorType)) throw new Error(`png: color type ${colorType} is not supported`);
    } else if (type === "PLTE") palette = data;
    else if (type === "tRNS") trns = data;
    else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") break;
    p = dataEnd + 4; // skip CRC
  }
  if (!sawIhdr) throw new Error("png: missing IHDR");
  if (!idat.length) throw new Error("png: missing IDAT");
  if (colorType === 3 && !palette) throw new Error("png: palette image without PLTE");
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
  const bpp = channels; // bytes per pixel at 8 bits
  const stride = width * bpp;
  let total = 0;
  for (const c of idat) total += c.length;
  const z = new Uint8Array(total);
  let q = 0;
  for (const c of idat) {
    z.set(c, q);
    q += c.length;
  }
  const raw = new Uint8Array(inflateSync(z));
  if (raw.length < (stride + 1) * height) throw new Error(`png: image data too short (${raw.length} < ${(stride + 1) * height})`);
  const pixels = new Uint8Array(stride * height);
  let prev: Uint8Array = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const line = pixels.subarray(y * stride, (y + 1) * stride);
    unfilter(filter, src, prev, line, bpp);
    prev = line;
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0, o = 0; i < width * height; i++, o += 4) {
    switch (colorType) {
      case 0: {
        const v = pixels[i];
        rgba[o] = rgba[o + 1] = rgba[o + 2] = v;
        rgba[o + 3] = trns && trns.length >= 2 && ((trns[0] << 8) | trns[1]) === v ? 0 : 255;
        break;
      }
      case 2: {
        const r = pixels[i * 3];
        const g = pixels[i * 3 + 1];
        const b = pixels[i * 3 + 2];
        rgba[o] = r;
        rgba[o + 1] = g;
        rgba[o + 2] = b;
        const key = trns && trns.length >= 6 && ((trns[0] << 8) | trns[1]) === r && ((trns[2] << 8) | trns[3]) === g && ((trns[4] << 8) | trns[5]) === b;
        rgba[o + 3] = key ? 0 : 255;
        break;
      }
      case 3: {
        const idx = pixels[i];
        const pal = palette as Uint8Array;
        if (idx * 3 + 2 >= pal.length) throw new Error(`png: palette index ${idx} outside PLTE`);
        rgba[o] = pal[idx * 3];
        rgba[o + 1] = pal[idx * 3 + 1];
        rgba[o + 2] = pal[idx * 3 + 2];
        rgba[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
        break;
      }
      case 4:
        rgba[o] = rgba[o + 1] = rgba[o + 2] = pixels[i * 2];
        rgba[o + 3] = pixels[i * 2 + 1];
        break;
      default:
        rgba[o] = pixels[i * 4];
        rgba[o + 1] = pixels[i * 4 + 1];
        rgba[o + 2] = pixels[i * 4 + 2];
        rgba[o + 3] = pixels[i * 4 + 3];
    }
  }
  return { width, height, rgba };
}

function unfilter(filter: number, src: Uint8Array, prev: Uint8Array, out: Uint8Array, bpp: number): void {
  const n = src.length;
  switch (filter) {
    case 0:
      out.set(src);
      break;
    case 1:
      for (let i = 0; i < n; i++) out[i] = (src[i] + (i >= bpp ? out[i - bpp] : 0)) & 0xff;
      break;
    case 2:
      for (let i = 0; i < n; i++) out[i] = (src[i] + prev[i]) & 0xff;
      break;
    case 3:
      for (let i = 0; i < n; i++) out[i] = (src[i] + (((i >= bpp ? out[i - bpp] : 0) + prev[i]) >> 1)) & 0xff;
      break;
    case 4:
      for (let i = 0; i < n; i++) {
        const a = i >= bpp ? out[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const pa = Math.abs(b - c);
        const pb = Math.abs(a - c);
        const pc = Math.abs(a + b - 2 * c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        out[i] = (src[i] + pred) & 0xff;
      }
      break;
    default:
      throw new Error(`png: unknown scanline filter ${filter}`);
  }
}

/** Encode straight RGBA as an 8-bit RGBA PNG (filter 0 on every row). */
export function encodePng(width: number, height: number, rgba: Uint8Array): Uint8Array {
  if (rgba.length !== width * height * 4) throw new Error(`encodePng: rgba length ${rgba.length} != ${width}*${height}*4`);
  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = new Uint8Array(13);
  writeBe32(ihdr, 0, width);
  writeBe32(ihdr, 4, height);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const idat = new Uint8Array(deflateSync(raw));
  return concatChunks([Uint8Array.from(SIGNATURE), chunk("IHDR", ihdr), chunk("IDAT", idat), chunk("IEND", new Uint8Array(0))]);
}

function writeBe32(b: Uint8Array, p: number, v: number): void {
  b[p] = (v >>> 24) & 0xff;
  b[p + 1] = (v >>> 16) & 0xff;
  b[p + 2] = (v >>> 8) & 0xff;
  b[p + 3] = v & 0xff;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeBe32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  writeBe32(out, 8 + data.length, crc32(out, 4, 8 + data.length));
  return out;
}

function concatChunks(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let q = 0;
  for (const p of parts) {
    out.set(p, q);
    q += p.length;
  }
  return out;
}
