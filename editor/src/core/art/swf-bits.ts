// SWF primitive encoding: bit-packed fields, RECT / MATRIX / CXFORMWITHALPHA, tag
// framing. Pure (no node imports). Everything here follows the SWF file format
// specification's bit-level layouts; the emitter (`swf-emitter.ts`) and the shape
// encoder (`shape.ts`) are its consumers, the verification reader (`swf-reader.ts`)
// is its inverse.
//
// Units at this boundary: RECT and MOVE/EDGE deltas are already twips (integers);
// `writeMatrix` takes the scene's px matrix and scales the translate ×20 itself so
// that every MATRIX in the file goes through one conversion.

import type { Mat } from "./geometry.ts";
import type { Cxform } from "./timeline.ts";

export interface Rect {
  xmin: number;
  ymin: number;
  xmax: number;
  ymax: number;
}
export interface Rgb {
  r: number;
  g: number;
  b: number;
}
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** SWF tag codes used by the emitter / reader. */
export const TAG = {
  End: 0,
  ShowFrame: 1,
  DefineShape: 2,
  PlaceObject: 4,
  RemoveObject: 5,
  DefineBits: 6,
  JPEGTables: 8,
  SetBackgroundColor: 9,
  DefineFont: 10,
  DefineText: 11,
  DoAction: 12,
  DefineBitsLossless: 20,
  DefineBitsJPEG2: 21,
  DefineShape2: 22,
  PlaceObject2: 26,
  RemoveObject2: 28,
  DefineShape3: 32,
  DefineText2: 33,
  DefineBitsJPEG3: 35,
  DefineBitsLossless2: 36,
  DefineEditText: 37,
  DefineSprite: 39,
  FrameLabel: 43,
  DefineMorphShape: 46,
  DefineFont2: 48,
  ExportAssets: 56,
  ImportAssets: 57,
  DoInitAction: 59,
  FileAttributes: 69,
  PlaceObject3: 70,
  ImportAssets2: 71,
  DefineFontAlignZones: 73,
  CSMTextSettings: 74,
  DefineFont3: 75,
  SymbolClass: 76,
  Metadata: 77,
  DefineScalingGrid: 78,
  DoABC: 82,
  DefineShape4: 83,
  DefineMorphShape2: 84,
  DefineSceneAndFrameLabelData: 86,
  DefineBinaryData: 87,
  DefineFontName: 88,
  DefineBitsJPEG4: 90,
} as const;

export const TAG_NAMES: Record<number, string> = Object.fromEntries(Object.entries(TAG).map(([k, v]) => [v, k]));

export function tagName(code: number): string {
  return TAG_NAMES[code] || `Tag${code}`;
}

// ---- bit counting --------------------------------------------------------------

/** @param v integer */
function signedBits(v: number): number {
  if (v === 0) return 0;
  const a = v < 0 ? -v - 1 : v; // magnitude of the two's-complement payload
  if (a === 0) return 1; // -1
  if (a < 0x100000000) return 32 - Math.clz32(a) + 1;
  return Math.floor(Math.log2(a)) + 2;
}

/**
 * Bits needed to hold every value as an SB (two's complement). 0 when all values are 0.
 * @param values integers
 */
export function nbitsForSigned(values: number[]): number {
  let n = 0;
  for (const v of values) {
    const b = signedBits(Math.trunc(v));
    if (b > n) n = b;
  }
  return n;
}

/**
 * Bits needed to hold every value as a UB. 0 when all values are 0.
 * @param values non-negative integers
 */
export function nbitsForUnsigned(values: number[] | number): number {
  const list = typeof values === "number" ? [values] : values;
  let n = 0;
  for (const v of list) {
    const t = Math.trunc(v);
    if (t < 0) throw new Error(`nbitsForUnsigned: negative value ${v}`);
    const b = t < 0x100000000 ? (t === 0 ? 0 : 32 - Math.clz32(t)) : Math.floor(Math.log2(t)) + 1;
    if (b > n) n = b;
  }
  return n;
}

// ---- writer ---------------------------------------------------------------------

/** Growable little-endian byte/bit writer following SWF bit-field conventions. */
export class BitWriter {
  buf: Uint8Array;
  /** byte position of the byte currently receiving bits */
  pos: number;
  /** bits already used in buf[pos] (0..7) */
  bitPos: number;

  constructor(initialCapacity = 256) {
    this.buf = new Uint8Array(Math.max(16, initialCapacity));
    this.pos = 0;
    this.bitPos = 0;
  }

  ensure(extraBytes: number): void {
    const need = this.pos + extraBytes + 1;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf);
    this.buf = next;
  }

  /** Bytes written so far (a partial byte counts). */
  get length(): number {
    return this.pos + (this.bitPos > 0 ? 1 : 0);
  }

  /**
   * Unsigned bit field, MSB first.
   * @param nbits 0..32
   */
  writeUB(nbits: number, value: number): void {
    if (nbits === 0) return;
    if (nbits < 0 || nbits > 32) throw new Error(`writeUB: nbits ${nbits} out of range`);
    let v = Math.trunc(value);
    if (v < 0 || v >= 2 ** nbits) throw new Error(`writeUB: value ${value} does not fit in ${nbits} bits`);
    let remaining = nbits;
    while (remaining > 0) {
      this.ensure(1);
      const free = 8 - this.bitPos;
      const take = Math.min(free, remaining);
      const shift = remaining - take;
      const chunk = Math.floor(v / 2 ** shift) % 2 ** take;
      this.buf[this.pos] |= chunk << (free - take);
      v -= chunk * 2 ** shift;
      remaining -= take;
      this.bitPos += take;
      if (this.bitPos === 8) {
        this.bitPos = 0;
        this.pos++;
      }
    }
  }

  /**
   * Signed (two's complement) bit field.
   * @param value integer
   */
  writeSB(nbits: number, value: number): void {
    if (nbits === 0) {
      if (Math.trunc(value) !== 0) throw new Error(`writeSB: value ${value} with 0 bits`);
      return;
    }
    const v = Math.trunc(value);
    const min = -(2 ** (nbits - 1));
    const max = 2 ** (nbits - 1) - 1;
    if (v < min || v > max) throw new Error(`writeSB: value ${value} does not fit in ${nbits} bits`);
    this.writeUB(nbits, v < 0 ? v + 2 ** nbits : v);
  }

  /** 16.16 fixed-point bit field (FB). */
  writeFB(nbits: number, value: number): void {
    this.writeSB(nbits, fixed16(value));
  }

  /** Advance to the next byte boundary (no-op when already aligned). */
  align(): void {
    if (this.bitPos > 0) {
      this.bitPos = 0;
      this.pos++;
    }
  }

  u8(v: number): void {
    this.align();
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }

  u16(v: number): void {
    this.align();
    this.ensure(2);
    this.buf[this.pos++] = v & 0xff;
    this.buf[this.pos++] = (v >>> 8) & 0xff;
  }

  u32(v: number): void {
    this.align();
    this.ensure(4);
    this.buf[this.pos++] = v & 0xff;
    this.buf[this.pos++] = (v >>> 8) & 0xff;
    this.buf[this.pos++] = (v >>> 16) & 0xff;
    this.buf[this.pos++] = (v >>> 24) & 0xff;
  }

  s16(v: number): void {
    this.u16(v < 0 ? v + 0x10000 : v);
  }

  /** Variable-length unsigned integer (EncodedU32 / ABC u30 style: 7 bits per byte, LSB first). */
  encodedU32(v: number): void {
    this.align();
    let x = v >>> 0;
    do {
      let b = x & 0x7f;
      x >>>= 7;
      if (x) b |= 0x80;
      this.ensure(1);
      this.buf[this.pos++] = b;
    } while (x);
  }

  bytes(bytes: Uint8Array): void {
    this.align();
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  /** UTF-8 string with a terminating NUL (SWF STRING). */
  string(s: string): void {
    this.bytes(utf8(s));
    this.u8(0);
  }

  /** The bytes written so far, as a fresh Uint8Array. */
  finish(): Uint8Array {
    this.align();
    return this.buf.slice(0, this.pos);
  }
}

const ENC = new TextEncoder();
export function utf8(s: string): Uint8Array {
  return ENC.encode(s);
}

export function fixed16(v: number): number {
  return Math.round(v * 65536);
}

// ---- structured fields ---------------------------------------------------------

/** RECT (twips). Byte-aligned at the end. */
export function writeRect(w: BitWriter, r: Rect): void {
  const xmin = Math.round(r.xmin);
  const xmax = Math.round(r.xmax);
  const ymin = Math.round(r.ymin);
  const ymax = Math.round(r.ymax);
  const n = nbitsForSigned([xmin, xmax, ymin, ymax]);
  w.writeUB(5, n);
  w.writeSB(n, xmin);
  w.writeSB(n, xmax);
  w.writeSB(n, ymin);
  w.writeSB(n, ymax);
  w.align();
}

/**
 * MATRIX from a scene matrix in px: translate is scaled ×20 (twips) here; scale and
 * rotate/skew are written as 16.16 FB. HasScale is emitted only when a or d differ from 1,
 * HasRotate only when b or c differ from 0. Byte-aligned at the end.
 */
export function writeMatrix(w: BitWriter, m: Mat): void {
  const hasScale = m[0] !== 1 || m[3] !== 1;
  const hasRotate = m[1] !== 0 || m[2] !== 0;
  w.writeUB(1, hasScale ? 1 : 0);
  if (hasScale) {
    const a = fixed16(m[0]);
    const d = fixed16(m[3]);
    const n = nbitsForSigned([a, d]);
    w.writeUB(5, n);
    w.writeSB(n, a);
    w.writeSB(n, d);
  }
  w.writeUB(1, hasRotate ? 1 : 0);
  if (hasRotate) {
    const b = fixed16(m[1]);
    const c = fixed16(m[2]);
    const n = nbitsForSigned([b, c]);
    w.writeUB(5, n);
    w.writeSB(n, b);
    w.writeSB(n, c);
  }
  const tx = Math.round(m[4] * 20);
  const ty = Math.round(m[5] * 20);
  const n = nbitsForSigned([tx, ty]);
  w.writeUB(5, n);
  w.writeSB(n, tx);
  w.writeSB(n, ty);
  w.align();
}

/**
 * CXFORMWITHALPHA. `mul` is written as 8.8 fixed (256 = 1.0); `add` is in 0..1 units and
 * written as -255..255. Terms that are identity are omitted. Byte-aligned at the end.
 */
export function writeCxformWithAlpha(w: BitWriter, cx: Cxform): void {
  const mul = cx.mul.map((v) => Math.max(-32768, Math.min(32767, Math.round(v * 256))));
  const add = cx.add.map((v) => Math.max(-255, Math.min(255, Math.round(v * 255))));
  const hasMul = mul.some((v) => v !== 256);
  const hasAdd = add.some((v) => v !== 0);
  const n = nbitsForSigned([...(hasMul ? mul : []), ...(hasAdd ? add : [])]);
  w.writeUB(1, hasAdd ? 1 : 0);
  w.writeUB(1, hasMul ? 1 : 0);
  w.writeUB(4, n);
  if (hasMul) for (const v of mul) w.writeSB(n, v);
  if (hasAdd) for (const v of add) w.writeSB(n, v);
  w.align();
}

export function writeRgb(w: BitWriter, c: Rgb): void {
  w.u8(c.r);
  w.u8(c.g);
  w.u8(c.b);
}

export function writeRgba(w: BitWriter, c: Rgba): void {
  w.u8(c.r);
  w.u8(c.g);
  w.u8(c.b);
  w.u8(c.a);
}

// ---- tags -----------------------------------------------------------------------

/**
 * Frame a tag body: RECORDHEADER (u16 code<<6|len, plus u32 length when len >= 63 or
 * `forceLong`). Flash always uses the long form for DefineBits* and DefineSprite.
 */
export function tag(code: number, body: Uint8Array, forceLong = false): Uint8Array {
  const long = forceLong || body.length >= 63;
  const out = new Uint8Array((long ? 6 : 2) + body.length);
  const header = (code << 6) | (long ? 0x3f : body.length);
  out[0] = header & 0xff;
  out[1] = (header >>> 8) & 0xff;
  let p = 2;
  if (long) {
    const len = body.length;
    out[2] = len & 0xff;
    out[3] = (len >>> 8) & 0xff;
    out[4] = (len >>> 16) & 0xff;
    out[5] = (len >>> 24) & 0xff;
    p = 6;
  }
  out.set(body, p);
  return out;
}

export function concat(chunks: Uint8Array[]): Uint8Array {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let p = 0;
  for (const c of chunks) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}
