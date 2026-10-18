// SWF primitive encoding: bit-packed fields, RECT / MATRIX / CXFORMWITHALPHA, tag
// framing. Pure (no node imports). Everything here follows the SWF file format
// specification's bit-level layouts; the emitter (`swf-emitter.mjs`) and the shape
// encoder (`shape.mjs`) are its consumers, the verification reader (`swf-reader.mjs`)
// is its inverse.
//
// Units at this boundary: RECT and MOVE/EDGE deltas are already twips (integers);
// `writeMatrix` takes the scene's px matrix and scales the translate ×20 itself so
// that every MATRIX in the file goes through one conversion.

/** @typedef {import('./geometry.mjs').Mat} Mat */
/** @typedef {{ xmin: number, ymin: number, xmax: number, ymax: number }} Rect */
/** @typedef {{ r: number, g: number, b: number }} Rgb */
/** @typedef {{ r: number, g: number, b: number, a: number }} Rgba */

/** SWF tag codes used by the emitter / reader. */
export const TAG = /** @type {const} */ ({
  End: 0,
  ShowFrame: 1,
  DefineShape: 2,
  PlaceObject: 4,
  RemoveObject: 5,
  SetBackgroundColor: 9,
  DefineText: 11,
  DefineBitsLossless: 20,
  DefineShape2: 22,
  PlaceObject2: 26,
  RemoveObject2: 28,
  DefineShape3: 32,
  DefineBitsLossless2: 36,
  DefineEditText: 37,
  DefineSprite: 39,
  FrameLabel: 43,
  ExportAssets: 56,
  FileAttributes: 69,
  PlaceObject3: 70,
  ImportAssets2: 71,
  DefineFontAlignZones: 73,
  CSMTextSettings: 74,
  DefineFont3: 75,
  SymbolClass: 76,
  DefineScalingGrid: 78,
  DoABC: 82,
  DefineShape4: 83,
  DefineSceneAndFrameLabelData: 86,
  DefineFontName: 88,
});

/** @type {Record<number, string>} */
export const TAG_NAMES = Object.fromEntries(Object.entries(TAG).map(([k, v]) => [v, k]));

/** @param {number} code */
export function tagName(code) {
  return TAG_NAMES[code] || `Tag${code}`;
}

// ---- bit counting --------------------------------------------------------------

/** @param {number} v integer */
function signedBits(v) {
  if (v === 0) return 0;
  const a = v < 0 ? -v - 1 : v; // magnitude of the two's-complement payload
  if (a === 0) return 1; // -1
  if (a < 0x100000000) return 32 - Math.clz32(a) + 1;
  return Math.floor(Math.log2(a)) + 2;
}

/**
 * Bits needed to hold every value as an SB (two's complement). 0 when all values are 0.
 * @param {number[]} values integers
 */
export function nbitsForSigned(values) {
  let n = 0;
  for (const v of values) {
    const b = signedBits(Math.trunc(v));
    if (b > n) n = b;
  }
  return n;
}

/**
 * Bits needed to hold every value as a UB. 0 when all values are 0.
 * @param {number[] | number} values non-negative integers
 */
export function nbitsForUnsigned(values) {
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
  /** @param {number} [initialCapacity] */
  constructor(initialCapacity = 256) {
    /** @type {Uint8Array} */
    this.buf = new Uint8Array(Math.max(16, initialCapacity));
    /** byte position of the byte currently receiving bits */
    this.pos = 0;
    /** bits already used in buf[pos] (0..7) */
    this.bitPos = 0;
  }

  /** @param {number} extraBytes */
  ensure(extraBytes) {
    const need = this.pos + extraBytes + 1;
    if (need <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < need) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf);
    this.buf = next;
  }

  /** Bytes written so far (a partial byte counts). */
  get length() {
    return this.pos + (this.bitPos > 0 ? 1 : 0);
  }

  /**
   * Unsigned bit field, MSB first.
   * @param {number} nbits 0..32
   * @param {number} value
   */
  writeUB(nbits, value) {
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
   * @param {number} nbits
   * @param {number} value integer
   */
  writeSB(nbits, value) {
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

  /**
   * 16.16 fixed-point bit field (FB).
   * @param {number} nbits
   * @param {number} value
   */
  writeFB(nbits, value) {
    this.writeSB(nbits, fixed16(value));
  }

  /** Advance to the next byte boundary (no-op when already aligned). */
  align() {
    if (this.bitPos > 0) {
      this.bitPos = 0;
      this.pos++;
    }
  }

  /** @param {number} v */
  u8(v) {
    this.align();
    this.ensure(1);
    this.buf[this.pos++] = v & 0xff;
  }

  /** @param {number} v */
  u16(v) {
    this.align();
    this.ensure(2);
    this.buf[this.pos++] = v & 0xff;
    this.buf[this.pos++] = (v >>> 8) & 0xff;
  }

  /** @param {number} v */
  u32(v) {
    this.align();
    this.ensure(4);
    this.buf[this.pos++] = v & 0xff;
    this.buf[this.pos++] = (v >>> 8) & 0xff;
    this.buf[this.pos++] = (v >>> 16) & 0xff;
    this.buf[this.pos++] = (v >>> 24) & 0xff;
  }

  /** @param {number} v */
  s16(v) {
    this.u16(v < 0 ? v + 0x10000 : v);
  }

  /**
   * Variable-length unsigned integer (EncodedU32 / ABC u30 style: 7 bits per byte, LSB first).
   * @param {number} v
   */
  encodedU32(v) {
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

  /** @param {Uint8Array} bytes */
  bytes(bytes) {
    this.align();
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  /**
   * UTF-8 string with a terminating NUL (SWF STRING).
   * @param {string} s
   */
  string(s) {
    this.bytes(utf8(s));
    this.u8(0);
  }

  /** The bytes written so far, as a fresh Uint8Array. */
  finish() {
    this.align();
    return this.buf.slice(0, this.pos);
  }
}

const ENC = new TextEncoder();
/** @param {string} s */
export function utf8(s) {
  return ENC.encode(s);
}

/** @param {number} v */
export function fixed16(v) {
  return Math.round(v * 65536);
}

// ---- structured fields ---------------------------------------------------------

/**
 * RECT (twips). Byte-aligned at the end.
 * @param {BitWriter} w @param {Rect} r
 */
export function writeRect(w, r) {
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
 * @param {BitWriter} w @param {Mat} m
 */
export function writeMatrix(w, m) {
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
 * @param {BitWriter} w
 * @param {import('./timeline.mjs').Cxform} cx
 */
export function writeCxformWithAlpha(w, cx) {
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

/** @param {BitWriter} w @param {Rgb} c */
export function writeRgb(w, c) {
  w.u8(c.r);
  w.u8(c.g);
  w.u8(c.b);
}

/** @param {BitWriter} w @param {Rgba} c */
export function writeRgba(w, c) {
  w.u8(c.r);
  w.u8(c.g);
  w.u8(c.b);
  w.u8(c.a);
}

// ---- tags -----------------------------------------------------------------------

/**
 * Frame a tag body: RECORDHEADER (u16 code<<6|len, plus u32 length when len >= 63 or
 * `forceLong`). Flash always uses the long form for DefineBits* and DefineSprite.
 * @param {number} code @param {Uint8Array} body @param {boolean} [forceLong]
 */
export function tag(code, body, forceLong = false) {
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

/** @param {Uint8Array[]} chunks */
export function concat(chunks) {
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
