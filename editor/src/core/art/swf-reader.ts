// Verification-only SWF reader: header + tag walk with decoded payloads for the tag
// subset the engine uses (docs/swf-tooling-options.md §1). Used by tests to round-trip
// the emitter's output and to confirm vanilla files parse; later by vanilla import.
// Unknown tags pass through as raw bytes. Node import is limited to `node:zlib` for the
// DefineBitsLossless pixel data.

import { inflateSync } from "node:zlib";
import { TAG, tagName } from "./swf-bits.ts";

/** @typedef {import('./geometry.ts').Mat} Mat */
/** @typedef {import('./swf-bits.ts').Rect} Rect */
/** @typedef {import('./swf-bits.ts').Rgba} Rgba */

/**
 * @typedef {Object} SwfHeader
 * @property {string} signature   "FWS" | "CWS" | "ZWS"
 * @property {number} version
 * @property {number} fileLength
 * @property {Rect} rect          twips
 * @property {number} frameRate   fps (8.8 decoded)
 * @property {number} frameCount
 */

/**
 * @typedef {Object} FillStyle
 * @property {number} type        0x00 solid, 0x10/0x12/0x13 gradient, 0x40..0x43 bitmap
 * @property {Rgba} [color]
 * @property {Mat} [matrix]       gradient/bitmap matrix (raw SWF units: translate in twips)
 * @property {number} [bitmapId]
 * @property {Array<{ ratio: number, color: Rgba }>} [gradient]
 * @property {number} [focalPoint]
 */

/**
 * @typedef {Object} LineStyle
 * @property {number} width       twips
 * @property {Rgba} [color]
 * @property {number} [flags]     LINESTYLE2 flag word (DefineShape4)
 * @property {FillStyle} [fill]   LINESTYLE2 with HasFill
 * @property {number} [miterLimit]
 */

/**
 * @typedef {{ type: 'style', x: number, y: number, moveTo: boolean, fill0: number | null, fill1: number | null, line: number | null, newStyles: boolean }
 *   | { type: 'straight', x0: number, y0: number, x1: number, y1: number }
 *   | { type: 'curve', x0: number, y0: number, cx: number, cy: number, x1: number, y1: number }} ShapeRecord
 */

/**
 * @typedef {Object} ParsedShape
 * @property {number} id
 * @property {Rect} bounds
 * @property {Rect} [edgeBounds]
 * @property {number} [flags]
 * @property {FillStyle[]} fillStyles   1-based indices in records point here (index-1); NewStyles append
 * @property {LineStyle[]} lineStyles
 * @property {ShapeRecord[]} records    positions are absolute twips
 */

/**
 * @typedef {Object} ParsedPlace
 * @property {number} flags
 * @property {boolean} move
 * @property {number} depth
 * @property {number} [characterId]
 * @property {Mat} [matrix]           raw SWF: scale/rotate as numbers, translate in twips
 * @property {{ mul: number[], add: number[] }} [cxform]  mul in 8.8 raw, add in -255..255 raw
 * @property {number} [ratio]
 * @property {string} [name]
 * @property {number} [clipDepth]
 * @property {Uint8Array} [clipActions]
 */

/**
 * @typedef {Object} Tag
 * @property {number} code
 * @property {string} name
 * @property {number} offset      byte offset of the tag header within its container
 * @property {number} length      body length
 * @property {Uint8Array} [raw]   body bytes for tags without a dedicated parser
 * @property {number} [flags]
 * @property {{ r: number, g: number, b: number }} [rgb]
 * @property {Array<{ offset: number, name: string }>} [scenes]
 * @property {Array<{ frame: number, name: string }>} [frameLabels]
 * @property {ParsedShape} [shape]
 * @property {number} [id]
 * @property {number} [frameCount]
 * @property {Tag[]} [tags]
 * @property {ParsedPlace} [place]
 * @property {number} [depth]
 * @property {string} [label]
 * @property {boolean} [anchor]
 * @property {string} [abcName]
 * @property {Uint8Array} [abcBytes]
 * @property {Array<{ id: number, name: string }>} [entries]
 * @property {{ id: number, format: number, width: number, height: number, colorTableSize: number, pixels: Uint8Array }} [bitmap]
 * @property {string} [error]
 */

// ---- bit reader --------------------------------------------------------------

/** Byte/bit reader mirroring BitWriter. */
export class BitReader {
  /** @param {Uint8Array} buf @param {number} [pos] */
  constructor(buf, pos = 0) {
    this.buf = buf;
    this.pos = pos;
    this.bitPos = 0;
  }
  get remaining() {
    return this.buf.length - this.pos - (this.bitPos ? 1 : 0);
  }
  /** @param {number} n */
  readUB(n) {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.buf.length) throw new Error(`BitReader: read past end at byte ${this.pos}`);
      const bit = (this.buf[this.pos] >> (7 - this.bitPos)) & 1;
      v = v * 2 + bit;
      this.bitPos++;
      if (this.bitPos === 8) {
        this.bitPos = 0;
        this.pos++;
      }
    }
    return v;
  }
  /** @param {number} n */
  readSB(n) {
    if (n === 0) return 0;
    const v = this.readUB(n);
    return v >= 2 ** (n - 1) ? v - 2 ** n : v;
  }
  /** @param {number} n */
  readFB(n) {
    return this.readSB(n) / 65536;
  }
  align() {
    if (this.bitPos) {
      this.bitPos = 0;
      this.pos++;
    }
  }
  u8() {
    this.align();
    if (this.pos >= this.buf.length) throw new Error(`BitReader: read past end at byte ${this.pos}`);
    return this.buf[this.pos++];
  }
  u16() {
    const a = this.u8();
    return a | (this.u8() << 8);
  }
  u32() {
    const lo = this.u16();
    return lo + this.u16() * 0x10000;
  }
  s16() {
    const v = this.u16();
    return v >= 0x8000 ? v - 0x10000 : v;
  }
  encodedU32() {
    this.align();
    let r = 0;
    let shift = 1;
    for (let i = 0; i < 5; i++) {
      const b = this.u8();
      r += (b & 0x7f) * shift;
      if (!(b & 0x80)) break;
      shift *= 128;
    }
    return r;
  }
  string() {
    this.align();
    const start = this.pos;
    while (this.pos < this.buf.length && this.buf[this.pos] !== 0) this.pos++;
    const s = DEC.decode(this.buf.subarray(start, this.pos));
    this.pos++; // NUL
    return s;
  }
  /** @param {number} n */
  bytes(n) {
    this.align();
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  rect() {
    const n = this.readUB(5);
    const r = { xmin: this.readSB(n), xmax: this.readSB(n), ymin: this.readSB(n), ymax: this.readSB(n) };
    this.align();
    return r;
  }
  /** @returns {Mat} */
  matrix() {
    let a = 1;
    let d = 1;
    let b = 0;
    let c = 0;
    if (this.readUB(1)) {
      const n = this.readUB(5);
      a = this.readFB(n);
      d = this.readFB(n);
    }
    if (this.readUB(1)) {
      const n = this.readUB(5);
      b = this.readFB(n);
      c = this.readFB(n);
    }
    const n = this.readUB(5);
    const tx = this.readSB(n);
    const ty = this.readSB(n);
    this.align();
    return [a, b, c, d, tx, ty];
  }
  cxformWithAlpha() {
    const hasAdd = this.readUB(1);
    const hasMul = this.readUB(1);
    const n = this.readUB(4);
    const mul = [256, 256, 256, 256];
    const add = [0, 0, 0, 0];
    if (hasMul) for (let i = 0; i < 4; i++) mul[i] = this.readSB(n);
    if (hasAdd) for (let i = 0; i < 4; i++) add[i] = this.readSB(n);
    this.align();
    return { mul, add };
  }
  /** @param {boolean} alpha */
  color(alpha) {
    const r = this.u8();
    const g = this.u8();
    const b = this.u8();
    const a = alpha ? this.u8() : 255;
    return { r, g, b, a };
  }
}

const DEC = new TextDecoder();

// ---- file ------------------------------------------------------------------------

/**
 * Parse an SWF file. Only uncompressed (`FWS`) bodies are walked; `CWS`/`ZWS` return the
 * header with an empty tag list and an `error` on the first tag entry.
 * @param {Uint8Array} bytes
 * @returns {{ header: SwfHeader, tags: Tag[] }}
 */
export function readSwf(bytes) {
  if (bytes.length < 8) throw new Error("readSwf: file shorter than 8 bytes");
  const signature = String.fromCharCode(bytes[0], bytes[1], bytes[2]);
  if (!/^[FCZ]WS$/.test(signature)) throw new Error(`readSwf: bad signature ${JSON.stringify(signature)}`);
  const r = new BitReader(bytes, 3);
  const version = r.u8();
  const fileLength = r.u32();
  if (signature !== "FWS") {
    return {
      header: { signature, version, fileLength, rect: { xmin: 0, ymin: 0, xmax: 0, ymax: 0 }, frameRate: 0, frameCount: 0 },
      tags: [{ code: -1, name: "Unsupported", offset: 8, length: 0, error: `${signature} compression is not supported by the reader` }],
    };
  }
  const rect = r.rect();
  const frameRate = r.u16() / 256;
  const frameCount = r.u16();
  const tags = readTags(bytes, r.pos, bytes.length);
  return { header: { signature, version, fileLength, rect, frameRate, frameCount }, tags };
}

/**
 * Walk a tag stream between `start` and `end`.
 * @param {Uint8Array} buf @param {number} start @param {number} end
 * @returns {Tag[]}
 */
export function readTags(buf, start, end) {
  /** @type {Tag[]} */
  const tags = [];
  let p = start;
  while (p + 2 <= end) {
    const header = buf[p] | (buf[p + 1] << 8);
    const code = header >> 6;
    let length = header & 0x3f;
    let bodyStart = p + 2;
    if (length === 0x3f) {
      if (bodyStart + 4 > end) throw new Error(`readTags: truncated long header at ${p}`);
      length = (buf[bodyStart] | (buf[bodyStart + 1] << 8) | (buf[bodyStart + 2] << 16)) + buf[bodyStart + 3] * 0x1000000;
      bodyStart += 4;
    }
    if (bodyStart + length > end) throw new Error(`readTags: tag ${tagName(code)} at ${p} overruns its container (${bodyStart + length} > ${end})`);
    const body = buf.subarray(bodyStart, bodyStart + length);
    tags.push(parseTag(code, body, p));
    p = bodyStart + length;
    if (code === TAG.End) break;
  }
  return tags;
}

/**
 * @param {number} code @param {Uint8Array} body @param {number} offset
 * @returns {Tag}
 */
function parseTag(code, body, offset) {
  /** @type {Tag} */
  const t = { code, name: tagName(code), offset, length: body.length };
  const r = new BitReader(body);
  try {
    switch (code) {
      case TAG.End:
      case TAG.ShowFrame:
        break;
      case TAG.FileAttributes:
        t.flags = r.u32();
        break;
      case TAG.SetBackgroundColor:
        t.rgb = { r: r.u8(), g: r.u8(), b: r.u8() };
        break;
      case TAG.DefineSceneAndFrameLabelData: {
        const nScenes = r.encodedU32();
        t.scenes = [];
        for (let i = 0; i < nScenes; i++) t.scenes.push({ offset: r.encodedU32(), name: r.string() });
        const nLabels = r.encodedU32();
        t.frameLabels = [];
        for (let i = 0; i < nLabels; i++) t.frameLabels.push({ frame: r.encodedU32(), name: r.string() });
        break;
      }
      case TAG.DefineShape:
      case TAG.DefineShape2:
      case TAG.DefineShape3:
      case TAG.DefineShape4:
        t.shape = parseDefineShape(r, code);
        t.id = t.shape.id;
        break;
      case TAG.DefineSprite: {
        t.id = r.u16();
        t.frameCount = r.u16();
        t.tags = readTags(body, 4, body.length);
        break;
      }
      case TAG.PlaceObject2:
        t.place = parsePlaceObject2(r);
        t.depth = t.place.depth;
        break;
      case TAG.RemoveObject2:
        t.depth = r.u16();
        break;
      case TAG.FrameLabel:
        t.label = r.string();
        if (r.pos < body.length) t.anchor = r.u8() === 1;
        break;
      case TAG.DoABC:
        t.flags = r.u32();
        t.abcName = r.string();
        t.abcBytes = body.subarray(r.pos);
        break;
      case TAG.SymbolClass:
      case TAG.ExportAssets: {
        const n = r.u16();
        t.entries = [];
        for (let i = 0; i < n; i++) t.entries.push({ id: r.u16(), name: r.string() });
        break;
      }
      case TAG.DefineBitsLossless:
      case TAG.DefineBitsLossless2: {
        const id = r.u16();
        const format = r.u8();
        const width = r.u16();
        const height = r.u16();
        const colorTableSize = format === 3 ? r.u8() + 1 : 0;
        const z = body.subarray(r.pos);
        const pixels = new Uint8Array(inflateSync(z));
        t.id = id;
        t.bitmap = { id, format, width, height, colorTableSize, pixels };
        break;
      }
      default:
        t.raw = body;
    }
  } catch (e) {
    t.error = e instanceof Error ? e.message : String(e);
    t.raw = body;
  }
  return t;
}

// ---- shapes ----------------------------------------------------------------------

/**
 * @param {BitReader} r @param {number} code
 * @returns {ParsedShape}
 */
export function parseDefineShape(r, code) {
  const version = code === TAG.DefineShape ? 1 : code === TAG.DefineShape2 ? 2 : code === TAG.DefineShape3 ? 3 : 4;
  const id = r.u16();
  const bounds = r.rect();
  /** @type {ParsedShape} */
  const shape = { id, bounds, fillStyles: [], lineStyles: [], records: [] };
  if (version === 4) {
    shape.edgeBounds = r.rect();
    shape.flags = r.u8();
  }
  readStyleArrays(r, version, shape);
  let numFillBits = r.readUB(4);
  let numLineBits = r.readUB(4);
  let fillBase = 0;
  let lineBase = 0;
  let x = 0;
  let y = 0;
  for (;;) {
    const typeFlag = r.readUB(1);
    if (typeFlag === 0) {
      const flags = r.readUB(5);
      if (flags === 0) break; // EndShapeRecord
      const newStyles = !!(flags & 0x10);
      const hasLine = !!(flags & 0x08);
      const hasFill1 = !!(flags & 0x04);
      const hasFill0 = !!(flags & 0x02);
      const moveTo = !!(flags & 0x01);
      if (moveTo) {
        const n = r.readUB(5);
        x = r.readSB(n);
        y = r.readSB(n);
      }
      const fill0 = hasFill0 ? r.readUB(numFillBits) : null;
      const fill1 = hasFill1 ? r.readUB(numFillBits) : null;
      const line = hasLine ? r.readUB(numLineBits) : null;
      /** @param {number | null} v @param {number} base */
      const abs = (v, base) => (v === null ? null : v === 0 ? 0 : v + base);
      /** @type {ShapeRecord} */
      const rec = { type: "style", x, y, moveTo, fill0: abs(fill0, fillBase), fill1: abs(fill1, fillBase), line: abs(line, lineBase), newStyles };
      if (newStyles) {
        fillBase = shape.fillStyles.length;
        lineBase = shape.lineStyles.length;
        readStyleArrays(r, version, shape);
        numFillBits = r.readUB(4);
        numLineBits = r.readUB(4);
      }
      shape.records.push(rec);
    } else {
      const straight = r.readUB(1);
      const n = r.readUB(4) + 2;
      if (straight) {
        let dx = 0;
        let dy = 0;
        if (r.readUB(1)) {
          dx = r.readSB(n);
          dy = r.readSB(n);
        } else if (r.readUB(1)) {
          dy = r.readSB(n);
        } else {
          dx = r.readSB(n);
        }
        shape.records.push({ type: "straight", x0: x, y0: y, x1: x + dx, y1: y + dy });
        x += dx;
        y += dy;
      } else {
        const cdx = r.readSB(n);
        const cdy = r.readSB(n);
        const adx = r.readSB(n);
        const ady = r.readSB(n);
        const cx = x + cdx;
        const cy = y + cdy;
        shape.records.push({ type: "curve", x0: x, y0: y, cx, cy, x1: cx + adx, y1: cy + ady });
        x = cx + adx;
        y = cy + ady;
      }
    }
  }
  r.align();
  return shape;
}

/**
 * FILLSTYLEARRAY + LINESTYLEARRAY appended to `shape`.
 * @param {BitReader} r @param {number} version @param {ParsedShape} shape
 */
function readStyleArrays(r, version, shape) {
  const alpha = version >= 3;
  let nFill = r.u8();
  if (nFill === 0xff && version >= 2) nFill = r.u16();
  for (let i = 0; i < nFill; i++) shape.fillStyles.push(readFillStyle(r, version, alpha));
  let nLine = r.u8();
  if (nLine === 0xff && version >= 2) nLine = r.u16();
  for (let i = 0; i < nLine; i++) {
    const width = r.u16();
    if (version === 4) {
      // LINESTYLE2 flags are bit fields, MSB first: StartCap(2) Join(2) HasFill(1) NoHScale(1)
      // NoVScale(1) PixelHinting(1) Reserved(5) NoClose(1) EndCap(2).
      const flags = r.readUB(16);
      /** @type {LineStyle} */
      const ls = { width, flags };
      const join = (flags >> 12) & 3;
      const hasFill = !!(flags & 0x0800);
      if (join === 2) ls.miterLimit = r.u16() / 256;
      if (hasFill) ls.fill = readFillStyle(r, version, true);
      else ls.color = r.color(true);
      shape.lineStyles.push(ls);
    } else {
      shape.lineStyles.push({ width, color: r.color(alpha) });
    }
  }
}

/**
 * @param {BitReader} r @param {number} version @param {boolean} alpha
 * @returns {FillStyle}
 */
function readFillStyle(r, version, alpha) {
  const type = r.u8();
  if (type === 0x00) return { type, color: r.color(alpha) };
  if (type === 0x10 || type === 0x12 || type === 0x13) {
    const matrix = r.matrix();
    const head = r.u8();
    const n = head & 0x0f;
    const gradient = [];
    for (let i = 0; i < n; i++) gradient.push({ ratio: r.u8(), color: r.color(alpha) });
    /** @type {FillStyle} */
    const fs = { type, matrix, gradient };
    if (type === 0x13) fs.focalPoint = r.s16() / 256;
    return fs;
  }
  if (type >= 0x40 && type <= 0x43) {
    const bitmapId = r.u16();
    const matrix = r.matrix();
    return { type, bitmapId, matrix };
  }
  throw new Error(`fill style type 0x${type.toString(16)} (DefineShape v${version}) is not supported`);
}

/**
 * @typedef {Object} ReadSubpath
 * @property {number} fill0      style index (1-based) or 0
 * @property {number} fill1
 * @property {number} line
 * @property {number[]} points   flat [x0,y0, x1,y1, ...] anchor points (twips), start first
 * @property {Array<{ t: 'L', x: number, y: number } | { t: 'Q', cx: number, cy: number, x: number, y: number }>} edges
 */

/**
 * Group a parsed shape's edge records into runs that share one style state. Each run
 * starts at a StyleChange record (whether or not it moves) and ends at the next one.
 * `points` are the anchor points of the run (curves contribute their anchor; the control
 * point is kept in `edges`), suitable for `geometry.signedArea`.
 * @param {ParsedShape} shape
 * @returns {ReadSubpath[]}
 */
export function shapeToSubpaths(shape) {
  /** @type {ReadSubpath[]} */
  const out = [];
  /** @type {ReadSubpath | null} */
  let cur = null;
  let fill0 = 0;
  let fill1 = 0;
  let line = 0;
  for (const rec of shape.records) {
    if (rec.type === "style") {
      if (rec.fill0 !== null) fill0 = rec.fill0;
      if (rec.fill1 !== null) fill1 = rec.fill1;
      if (rec.line !== null) line = rec.line;
      cur = { fill0, fill1, line, points: [rec.x, rec.y], edges: [] };
      out.push(cur);
      continue;
    }
    if (!cur) {
      cur = { fill0, fill1, line, points: [rec.x0, rec.y0], edges: [] };
      out.push(cur);
    }
    if (rec.type === "straight") {
      cur.points.push(rec.x1, rec.y1);
      cur.edges.push({ t: "L", x: rec.x1, y: rec.y1 });
    } else {
      cur.points.push(rec.x1, rec.y1);
      cur.edges.push({ t: "Q", cx: rec.cx, cy: rec.cy, x: rec.x1, y: rec.y1 });
    }
  }
  return out.filter((s) => s.edges.length > 0);
}

// ---- PlaceObject2 -------------------------------------------------------------------

/**
 * @param {BitReader} r
 * @returns {ParsedPlace}
 */
function parsePlaceObject2(r) {
  const flags = r.u8();
  const depth = r.u16();
  /** @type {ParsedPlace} */
  const p = { flags, move: !!(flags & 0x01), depth };
  if (flags & 0x02) p.characterId = r.u16();
  if (flags & 0x04) p.matrix = r.matrix();
  if (flags & 0x08) p.cxform = r.cxformWithAlpha();
  if (flags & 0x10) p.ratio = r.u16();
  if (flags & 0x20) p.name = r.string();
  if (flags & 0x40) p.clipDepth = r.u16();
  if (flags & 0x80) p.clipActions = r.bytes(r.buf.length - r.pos);
  return p;
}

// ---- helpers for tests / reports ------------------------------------------------------

/**
 * Flatten a tag tree (DefineSprite children included) into one list.
 * @param {Tag[]} tags
 * @returns {Tag[]}
 */
export function flattenTags(tags) {
  /** @type {Tag[]} */
  const out = [];
  for (const t of tags) {
    out.push(t);
    if (t.tags) out.push(...flattenTags(t.tags));
  }
  return out;
}

/**
 * Count tags by name (top level only unless `deep`).
 * @param {Tag[]} tags @param {boolean} [deep]
 */
export function countTags(tags, deep = false) {
  /** @type {Record<string, number>} */
  const counts = {};
  for (const t of deep ? flattenTags(tags) : tags) counts[t.name] = (counts[t.name] || 0) + 1;
  return counts;
}
