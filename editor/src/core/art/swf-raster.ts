// A small software rasteriser for one SWF character's FRAME 1, for thumbnails (the Room editor's tileset art). Pure:
// it reads parsed tags (swf-reader.ts) through a lookup and returns straight-alpha RGBA, which png.ts encodes.
//
// It follows the engine behaviours the preview renderer follows (src/core/art/engine-behaviour.ts, OBSERVED): fills
// use the even-odd rule per fill style; a nested sprite shows its own frame 1 (its own clock); every gradient pads;
// the PlaceObject cxform multiplies then adds. Strokes are polygons from stroke.ts (round caps and joins, Flash's
// default), filled nonzero. Clip layers (PlaceObject clipDepth) mask the depths they cover. Bitmap fills sample the
// nearest texel (the game samples LINEAR: close enough at thumbnail size). Not drawn, with a note: text, morph shapes,
// JPEG bitmaps, filters and blend modes; no palette remap (enemies have no palette row, OBSERVED; cats are not
// rendered here). Anti-aliasing is supersampling (ss x ss samples per pixel).

import { multiply, invert, IDENTITY } from "./geometry.ts";
import type { Mat } from "./geometry.ts";
import { strokePolys } from "./stroke.ts";
import type { Tag, ParsedShape, FillStyle, ParsedBitmap } from "./swf-reader.ts";

export interface RasterSource {
  get(id: number): Tag | undefined;
}

export interface RasterOptions {
  /** output px per clip px (default 0.5) */
  scale?: number;
  /** draw mirrored about the registration point (enemy clips) */
  mirror?: boolean;
  /** transparent border in output px (default 1) */
  pad?: number;
  /** the larger side is capped here by lowering the scale (default 512) */
  maxSize?: number;
  /** supersampling per axis (default 4, 2 for large outputs) */
  ss?: number;
}

export interface RasterResult {
  width: number;
  height: number;
  /** straight (not premultiplied) RGBA */
  rgba: Uint8Array;
  /** where the clip's registration point (0,0) lands, in output px */
  originX: number;
  originY: number;
  /** the scale actually used (output px per clip px) */
  scale: number;
  notes: string[];
}

interface Cx {
  mul: [number, number, number, number];
  add: [number, number, number, number];
}
const CX_ID: Cx = { mul: [1, 1, 1, 1], add: [0, 0, 0, 0] };

type Item = { t: "shape"; shape: ParsedShape; m: Mat; cx: Cx } | { t: "clip"; mask: Item[]; content: Item[] };

function composeCx(parent: Cx, raw: { mul: number[]; add: number[] } | undefined): Cx {
  if (!raw) return parent;
  const mul = [0, 1, 2, 3].map((i) => parent.mul[i]! * (raw.mul[i]! / 256)) as Cx["mul"];
  const add = [0, 1, 2, 3].map((i) => parent.mul[i]! * raw.add[i]! + parent.add[i]!) as Cx["add"];
  return { mul, add };
}

interface Entry {
  depth: number;
  id: number;
  m: Mat;
  cx?: { mul: number[]; add: number[] };
  clipDepth?: number;
}

/** The frame-1 display list of a sprite, depth-sorted. */
function frame1(tag: Tag): Entry[] {
  const byDepth = new Map<number, Entry>();
  for (const t of tag.tags ?? []) {
    if (t.name === "ShowFrame") break;
    if (t.name === "RemoveObject" || t.name === "RemoveObject2") {
      if (t.depth !== undefined) byDepth.delete(t.depth);
      continue;
    }
    const p = t.place;
    if (!p) continue;
    const prev = byDepth.get(p.depth);
    if (p.characterId !== undefined && !(p.move && prev && prev.id === p.characterId)) {
      byDepth.set(p.depth, { depth: p.depth, id: p.characterId, m: p.matrix ?? IDENTITY, cx: p.cxform, clipDepth: p.clipDepth });
    } else if (prev) {
      if (p.matrix) prev.m = p.matrix;
      if (p.cxform) prev.cx = p.cxform;
      if (p.clipDepth !== undefined) prev.clipDepth = p.clipDepth;
    }
  }
  return [...byDepth.values()].sort((a, b) => a.depth - b.depth);
}

function collect(src: RasterSource, id: number, m: Mat, cx: Cx, notes: Set<string>, guard: number[]): Item[] {
  const t = src.get(id);
  if (!t) { notes.add(`character ${id} not found`); return []; }
  if (t.shape) return [{ t: "shape", shape: t.shape, m, cx }];
  if (t.name !== "DefineSprite") {
    notes.add(`${t.name} not drawn`);
    return [];
  }
  if (guard.includes(id) || guard.length > 32) return [];
  const entries = frame1(t);
  const expand = (list: Entry[]): Item[] => {
    const out: Item[] = [];
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      const items = collect(src, e.id, multiply(m, e.m), composeCx(cx, e.cx), notes, [...guard, id]);
      if (e.clipDepth !== undefined) {
        const covered: Entry[] = [];
        while (i + 1 < list.length && list[i + 1]!.depth <= e.clipDepth) covered.push(list[++i]!);
        out.push({ t: "clip", mask: items, content: expand(covered) });
      } else out.push(...items);
    }
    return out;
  };
  return expand(entries);
}

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

function itemBounds(items: Item[]): Box | null {
  let b: Box | null = null;
  const add = (o: Box | null) => {
    if (!o) return;
    b = b ? { x0: Math.min(b.x0, o.x0), y0: Math.min(b.y0, o.y0), x1: Math.max(b.x1, o.x1), y1: Math.max(b.y1, o.y1) } : o;
  };
  for (const it of items) {
    if (it.t === "shape") {
      const r = it.shape.bounds;
      if (r.xmax <= r.xmin && r.ymax <= r.ymin) continue;
      const pts = [[r.xmin, r.ymin], [r.xmax, r.ymin], [r.xmax, r.ymax], [r.xmin, r.ymax]].map(([x, y]) => [it.m[0] * x! + it.m[2] * y! + it.m[4], it.m[1] * x! + it.m[3] * y! + it.m[5]]);
      add({ x0: Math.min(...pts.map((p) => p[0]!)), y0: Math.min(...pts.map((p) => p[1]!)), x1: Math.max(...pts.map((p) => p[0]!)), y1: Math.max(...pts.map((p) => p[1]!)) });
    } else {
      const mb = itemBounds(it.mask);
      const cb = itemBounds(it.content);
      if (mb && cb) {
        const o = { x0: Math.max(mb.x0, cb.x0), y0: Math.max(mb.y0, cb.y0), x1: Math.min(mb.x1, cb.x1), y1: Math.min(mb.y1, cb.y1) };
        if (o.x1 > o.x0 && o.y1 > o.y0) add(o);
      }
    }
  }
  return b;
}

// ---- scanline fill ----

/** Fill the polygon soup `segs` ([x0,y0,x1,y1]*, device px) row by row; plot(y, xFrom, xToExclusive). */
function scanFill(segs: number[], nonzero: boolean, W: number, H: number, plot: (y: number, a: number, b: number) => void): void {
  const n = segs.length / 4;
  if (!n) return;
  const buckets: number[][] = [];
  let rowMin = H, rowMax = -1;
  const top = new Float64Array(n), dxdy = new Float64Array(n), x0s = new Float64Array(n), y0s = new Float64Array(n), endRow = new Int32Array(n), dir = new Int8Array(n);
  for (let i = 0; i < n; i++) {
    const ax = segs[4 * i]!, ay = segs[4 * i + 1]!, bx = segs[4 * i + 2]!, by = segs[4 * i + 3]!;
    if (ay === by) continue;
    const up = ay < by;
    const ty = up ? ay : by, byy = up ? by : ay;
    top[i] = ty;
    x0s[i] = up ? ax : bx;
    y0s[i] = ty;
    dxdy[i] = (up ? bx - ax : ax - bx) / (byy - ty);
    dir[i] = up ? 1 : -1;
    const r0 = Math.max(0, Math.ceil(ty - 0.5));
    const r1 = Math.min(H, Math.ceil(byy - 0.5));
    if (r1 <= r0) continue;
    endRow[i] = r1;
    (buckets[r0] ??= []).push(i);
    rowMin = Math.min(rowMin, r0);
    rowMax = Math.max(rowMax, r1);
  }
  let active: number[] = [];
  const xs: number[] = [];
  const ds: number[] = [];
  for (let y = rowMin; y < rowMax; y++) {
    const b = buckets[y];
    if (b) active.push(...b);
    active = active.filter((i) => endRow[i]! > y);
    if (!active.length) continue;
    const yc = y + 0.5;
    const order = active.map((i) => ({ x: x0s[i]! + (yc - y0s[i]!) * dxdy[i]!, d: dir[i]! })).sort((p, q) => p.x - q.x);
    xs.length = 0;
    ds.length = 0;
    for (const o of order) { xs.push(o.x); ds.push(o.d); }
    let w = 0;
    for (let k = 0; k < xs.length - 1; k++) {
      w = nonzero ? w + ds[k]! : w ^ 1;
      if (w === 0) continue;
      const a = Math.max(0, Math.ceil(xs[k]! - 0.5));
      const e = Math.min(W, Math.ceil(xs[k + 1]! - 0.5));
      if (e > a) plot(y, a, e);
    }
  }
}

// ---- paints ----

type Paint = (x: number, y: number, out: Float64Array) => boolean;

function cxApply(cx: Cx, r: number, g: number, b: number, a: number, out: Float64Array): void {
  const c = (v: number, i: number) => Math.max(0, Math.min(255, v * cx.mul[i]! + cx.add[i]!));
  const A = c(a, 3) / 255;
  out[0] = (c(r, 0) / 255) * A;
  out[1] = (c(g, 1) / 255) * A;
  out[2] = (c(b, 2) / 255) * A;
  out[3] = A;
}

const bitmapCache = new WeakMap<ParsedBitmap, Uint8Array>();

/** Straight RGBA texels of a DefineBitsLossless(2) bitmap (Lossless2 colour data is premultiplied: undone here). */
function bitmapTexels(bm: ParsedBitmap, alpha: boolean): Uint8Array | null {
  const hit = bitmapCache.get(bm);
  if (hit) return hit;
  const { width: w, height: h, pixels: px } = bm;
  const out = new Uint8Array(w * h * 4);
  const unpm = (i: number, r: number, g: number, b: number, a: number) => {
    const k = a > 0 && alpha ? 255 / a : 1;
    out[i] = Math.min(255, r * k);
    out[i + 1] = Math.min(255, g * k);
    out[i + 2] = Math.min(255, b * k);
    out[i + 3] = alpha ? a : 255;
  };
  if (bm.format === 5) {
    for (let i = 0; i < w * h; i++) unpm(i * 4, px[i * 4 + 1]!, px[i * 4 + 2]!, px[i * 4 + 3]!, px[i * 4]!);
  } else if (bm.format === 3) {
    const cs = alpha ? 4 : 3;
    const tableLen = bm.colorTableSize * cs;
    const stride = (w + 3) & ~3;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = px[tableLen + y * stride + x]!;
        const t = idx * cs;
        unpm((y * w + x) * 4, px[t]!, px[t + 1]!, px[t + 2]!, alpha ? px[t + 3]! : 255);
      }
    }
  } else return null;
  bitmapCache.set(bm, out);
  return out;
}

function makePaint(fill: FillStyle | undefined, M: Mat, cx: Cx, src: RasterSource, notes: Set<string>): Paint | null {
  if (!fill) return null;
  const tmp = new Float64Array(4);
  if (fill.type === 0x00) {
    const c = fill.color ?? { r: 0, g: 0, b: 0, a: 255 };
    cxApply(cx, c.r, c.g, c.b, c.a, tmp);
    const [r, g, b, a] = [tmp[0]!, tmp[1]!, tmp[2]!, tmp[3]!];
    return (_x, _y, out) => { out[0] = r; out[1] = g; out[2] = b; out[3] = a; return true; };
  }
  if (fill.type === 0x10 || fill.type === 0x12 || fill.type === 0x13) {
    const inv = invert(multiply(M, fill.matrix ?? IDENTITY));
    if (!inv) return null;
    const stops = fill.gradient ?? [];
    if (!stops.length) return null;
    const lut = new Float64Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      let k = 0;
      while (k < stops.length - 1 && stops[k + 1]!.ratio < i) k++;
      const s0 = stops[k]!, s1 = stops[Math.min(k + 1, stops.length - 1)]!;
      const span = s1.ratio - s0.ratio;
      const f = i <= s0.ratio ? 0 : i >= s1.ratio || span <= 0 ? 1 : (i - s0.ratio) / span;
      const mix = (a: number, b: number) => a + (b - a) * f;
      cxApply(cx, mix(s0.color.r, s1.color.r), mix(s0.color.g, s1.color.g), mix(s0.color.b, s1.color.b), mix(s0.color.a, s1.color.a), tmp);
      lut.set(tmp, i * 4);
    }
    const radial = fill.type !== 0x10;
    return (x, y, out) => {
      const gx = inv[0] * x + inv[2] * y + inv[4];
      const gy = inv[1] * x + inv[3] * y + inv[5];
      let t = radial ? Math.hypot(gx, gy) / 16384 : (gx + 16384) / 32768;
      t = Math.max(0, Math.min(1, t)); // every gradient pads (OBSERVED)
      const i = Math.round(t * 255) * 4;
      out[0] = lut[i]!; out[1] = lut[i + 1]!; out[2] = lut[i + 2]!; out[3] = lut[i + 3]!;
      return true;
    };
  }
  if (fill.type >= 0x40 && fill.type <= 0x43) {
    const bt = fill.bitmapId !== undefined ? src.get(fill.bitmapId) : undefined;
    if (!bt?.bitmap) { notes.add(bt ? `${bt.name} bitmap not drawn` : "bitmap fill without a bitmap"); return null; }
    const tex = bitmapTexels(bt.bitmap, bt.name === "DefineBitsLossless2");
    if (!tex) { notes.add(`bitmap format ${bt.bitmap.format} not drawn`); return null; }
    const inv = invert(multiply(M, fill.matrix ?? IDENTITY));
    if (!inv) return null;
    const w = bt.bitmap.width, h = bt.bitmap.height;
    const repeat = fill.type === 0x40 || fill.type === 0x42;
    return (x, y, out) => {
      let u = Math.floor(inv[0] * x + inv[2] * y + inv[4]);
      let v = Math.floor(inv[1] * x + inv[3] * y + inv[5]);
      if (repeat) { u = ((u % w) + w) % w; v = ((v % h) + h) % h; }
      else { u = Math.max(0, Math.min(w - 1, u)); v = Math.max(0, Math.min(h - 1, v)); }
      const i = (v * w + u) * 4;
      cxApply(cx, tex[i]!, tex[i + 1]!, tex[i + 2]!, tex[i + 3]!, out);
      return true;
    };
  }
  notes.add(`fill type 0x${fill.type.toString(16)} not drawn`);
  return null;
}

// ---- geometry of one shape in device space ----

function flattenQuad(out: number[], x0: number, y0: number, cx: number, cy: number, x1: number, y1: number): void {
  const dd = Math.hypot(x0 - 2 * cx + x1, y0 - 2 * cy + y1);
  const n = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(dd / 0.5))));
  let px = x0, py = y0;
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    const x = u * u * x0 + 2 * u * t * cx + t * t * x1;
    const y = u * u * y0 + 2 * u * t * cy + t * t * y1;
    out.push(px, py, x, y);
    px = x; py = y;
  }
}

interface Target {
  W: number;
  H: number;
  color?: Float32Array;
  mask?: Uint8Array;
}

function drawShape(it: Extract<Item, { t: "shape" }>, D: Mat, src: RasterSource, tgt: Target, clip: Uint8Array | null, notes: Set<string>): void {
  const M = multiply(D, it.m);
  const T = (x: number, y: number): [number, number] => [M[0] * x + M[2] * y + M[4], M[1] * x + M[3] * y + M[5]];
  const fillSegs = new Map<number, number[]>();
  const lineRuns = new Map<number, number[][]>();
  let f0 = 0, f1 = 0, ln = 0;
  let run: number[] | null = null;
  const seg = (k: number) => { let a = fillSegs.get(k); if (!a) fillSegs.set(k, (a = [])); return a; };
  for (const r of it.shape.records) {
    if (r.type === "style") {
      if (r.fill0 !== null) f0 = r.fill0;
      if (r.fill1 !== null) f1 = r.fill1;
      if (r.line !== null) ln = r.line;
      run = null;
      continue;
    }
    const pts: number[] = [];
    const [ax, ay] = T(r.x0, r.y0);
    const [bx, by] = T(r.x1, r.y1);
    if (r.type === "straight") pts.push(ax, ay, bx, by);
    else {
      const [qx, qy] = T(r.cx, r.cy);
      flattenQuad(pts, ax, ay, qx, qy, bx, by);
    }
    if (f0) seg(f0).push(...pts);
    if (f1) seg(f1).push(...pts);
    if (ln) {
      let runs = lineRuns.get(ln);
      if (!runs) lineRuns.set(ln, (runs = []));
      if (!run || run[run.length - 2] !== ax || run[run.length - 1] !== ay || runs[runs.length - 1] !== run) { run = [ax, ay]; runs.push(run); }
      for (let i = 2; i < pts.length; i += 4) run.push(pts[i]!, pts[i + 1]!);
    } else run = null;
  }
  const tmp = new Float64Array(4);
  const draw = (segs: number[], nonzero: boolean, paint: Paint) => {
    scanFill(segs, nonzero, tgt.W, tgt.H, (y, a, b) => {
      for (let x = a; x < b; x++) {
        const p = y * tgt.W + x;
        if (clip && !clip[p]) continue;
        if (tgt.mask) { tgt.mask[p] = 1; continue; }
        if (!paint(x + 0.5, y + 0.5, tmp)) continue;
        const c = tgt.color!;
        const sa = tmp[3]!;
        if (sa <= 0) continue;
        const k = 1 - sa, q = p * 4;
        c[q] = tmp[0]! + c[q]! * k;
        c[q + 1] = tmp[1]! + c[q + 1]! * k;
        c[q + 2] = tmp[2]! + c[q + 2]! * k;
        c[q + 3] = sa + c[q + 3]! * k;
      }
    });
  };
  const noPaint: Paint = () => true;
  for (const [k, segs] of [...fillSegs.entries()].sort((a, b) => a[0] - b[0])) {
    const paint = tgt.mask ? noPaint : makePaint(it.shape.fillStyles[k - 1], M, it.cx, src, notes);
    if (paint) draw(segs, false, paint);
  }
  const scaleDev = Math.sqrt(Math.abs(M[0] * M[3] - M[1] * M[2]));
  const ss = (D as Mat & { ss?: number }).ss ?? 1;
  for (const [k, runs] of lineRuns) {
    const ls = it.shape.lineStyles[k - 1];
    if (!ls) continue;
    const width = Math.max(ss, ls.width * scaleDev);
    const closed = runs.map((r) => r.length >= 6 && Math.abs(r[0]! - r[r.length - 2]!) < 1e-6 && Math.abs(r[1]! - r[r.length - 1]!) < 1e-6);
    const polys = strokePolys(runs, closed, width);
    const segs: number[] = [];
    for (const p of polys) for (let i = 0; i < p.length; i += 2) {
      const j = (i + 2) % p.length;
      segs.push(p[i]!, p[i + 1]!, p[j]!, p[j + 1]!);
    }
    const paint = tgt.mask ? noPaint : ls.fill ? makePaint(ls.fill, M, it.cx, src, notes) : makePaint({ type: 0, color: ls.color ?? { r: 0, g: 0, b: 0, a: 255 } }, M, it.cx, src, notes);
    if (paint) draw(segs, true, paint);
  }
}

function drawItems(items: Item[], D: Mat, src: RasterSource, tgt: Target, clip: Uint8Array | null, notes: Set<string>): void {
  for (const it of items) {
    if (it.t === "shape") { drawShape(it, D, src, tgt, clip, notes); continue; }
    const mask = new Uint8Array(tgt.W * tgt.H);
    drawItems(it.mask, D, src, { W: tgt.W, H: tgt.H, mask }, clip, notes);
    drawItems(it.content, D, src, tgt, mask, notes);
  }
}

/** Rasterise frame 1 of character `id`. An empty character gives a 1x1 transparent image. */
export function rasterizeCharacter(src: RasterSource, id: number, opts: RasterOptions = {}): RasterResult {
  const notes = new Set<string>();
  const items = collect(src, id, IDENTITY, CX_ID, notes, []);
  const pad = opts.pad ?? 1;
  const maxSize = opts.maxSize ?? 512;
  const sx = opts.mirror ? -1 : 1;
  let b = itemBounds(items);
  if (!b) return { width: 1, height: 1, rgba: new Uint8Array(4), originX: 0, originY: 0, scale: opts.scale ?? 0.5, notes: [...notes, "nothing to draw in frame 1"] };
  if (sx < 0) b = { x0: -b.x1, x1: -b.x0, y0: b.y0, y1: b.y1 };
  let scale = opts.scale ?? 0.5;
  const span = Math.max(b.x1 - b.x0, b.y1 - b.y0) / 20;
  if (span * scale + 2 * pad > maxSize) scale = Math.max(1e-3, (maxSize - 2 * pad) / span);
  const s = scale / 20; // output px per twip
  const W = Math.max(1, Math.ceil((b.x1 - b.x0) * s) + 2 * pad);
  const H = Math.max(1, Math.ceil((b.y1 - b.y0) * s) + 2 * pad);
  const ss = opts.ss ?? (Math.max(W, H) > 256 ? 2 : 4);
  const originX = -b.x0 * s + pad;
  const originY = -b.y0 * s + pad;
  const D = [sx * s * ss, 0, 0, s * ss, originX * ss, originY * ss] as Mat & { ss?: number };
  D.ss = ss;
  const Ws = W * ss, Hs = H * ss;
  const color = new Float32Array(Ws * Hs * 4);
  drawItems(items, D, src, { W: Ws, H: Hs, color }, null, notes);
  const rgba = new Uint8Array(W * H * 4);
  const n = ss * ss;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, bb = 0, a = 0;
      for (let j = 0; j < ss; j++) {
        let q = ((y * ss + j) * Ws + x * ss) * 4;
        for (let i = 0; i < ss; i++, q += 4) { r += color[q]!; g += color[q + 1]!; bb += color[q + 2]!; a += color[q + 3]!; }
      }
      const o = (y * W + x) * 4;
      if (a <= 0) continue;
      rgba[o] = Math.round(Math.min(1, r / a) * 255);
      rgba[o + 1] = Math.round(Math.min(1, g / a) * 255);
      rgba[o + 2] = Math.round(Math.min(1, bb / a) * 255);
      rgba[o + 3] = Math.round(Math.min(1, a / n) * 255);
    }
  }
  return { width: W, height: H, rgba, originX, originY, scale, notes: [...notes] };
}
