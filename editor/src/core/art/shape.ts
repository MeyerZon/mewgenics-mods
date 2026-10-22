// DefineShape3 encoding from a scene shape. Owns the SHAPEWITHSTYLE / SHAPERECORD
// layout; path geometry comes from `geometry.normalizePath` (never re-parsed here) and
// fills from `scene.parseFill`. Units: scene paths are px; this module converts to twips
// (×20, rounded to integers) once, at its boundary.
//
// Fill side rule (OBSERVED on vanilla minecarts.swf, see docs/art-preview-plan.md):
// Flash puts the fill on the RIGHT of a sub-path that runs clockwise on screen (positive
// `geometry.signedArea` in y-down space) → FillStyle1; counter-clockwise → FillStyle0.
// Vanilla single-fill shapes (ids 13/16/17/18) are all clockwise with FillStyle1 and none
// of the 17 clockwise single-side sub-paths used FillStyle0.
//
// Which side gets the fill is decided per sub-path from its own winding AND its nesting
// inside the other sub-paths of the same path (`assignFillSides`): the filled region is
// put on the side where the path's fill rule (nonzero or evenodd) says the paint is, so an
// "O" (outer + hole, either winding) renders as a ring under both a nonzero and an
// even-odd rasterizer. Sub-paths with paint on both sides (interior seams of overlapping
// nonzero sub-paths) or neither side are dropped unless stroked. Limitation: a single
// self-intersecting sub-path cannot be fixed by orientation and keeps its own winding.

import { IDENTITY, normalizePath, flattenSubpath, signedArea, subpathBounds } from "./geometry.ts";
import type { Mat, SubPath, Edge } from "./geometry.ts";
import { parseFill, fillToRgba } from "./scene.ts";
import type { SceneShape, SceneGradient, Finding } from "./scene.ts";
import { gradientMatrix, gradientFocal, gradientProblems, gradientNeedsShape4, resolveStops, swfSpread, MAX_STOPS_SHAPE3 } from "./gradient.ts";
import type { ResolvedStop } from "./gradient.ts";
import { BitWriter, TAG, nbitsForSigned, nbitsForUnsigned, writeRect, writeMatrix, writeRgba, tag } from "./swf-bits.ts";
import type { Rect, Rgba } from "./swf-bits.ts";

export interface ShapeContext {
  /** scene bitmap id → character id of its DefineBitsLossless2 */
  bitmapIds?: Map<string, number>;
  /** scene bitmap id → its fill type (raster.ts bitmapFillType: 0x40 / 0x41 / 0x42 / 0x43); default 0x41 */
  bitmapTypes?: Map<string, number>;
  /** scene id, used in finding paths */
  shapeName?: string;
  /** quadratics per cubic (geometry default 4) */
  cubicSplits?: number;
  /** scene.gradients, for "gradient:<id>" fills */
  gradients?: Record<string, SceneGradient>;
}

export interface EncodedShape {
  /** framed DefineShape3 / DefineShape4 tag */
  bytes: Uint8Array;
  /** the DefineShape version written */
  version?: 3 | 4;
  /** twips */
  bounds: Rect;
  fillCount: number;
  lineCount: number;
  /** edge records written */
  edgeCount: number;
  findings: Finding[];
}

type FillDef =
  | { kind: "solid"; color: Rgba }
  | { kind: "bitmap"; id: number; matrix: Mat; type: number }
  | { kind: "gradient"; type: 0x10 | 0x12 | 0x13; matrix: Mat; stops: ResolvedStop[]; spread: 0 | 1 | 2; focal: number };
interface LineDef {
  /** twips */
  width: number;
  color: Rgba | null;
  /** LINESTYLE2 fill (DefineShape4 only) */
  fill: FillDef | null;
  /** SWF cap / join codes: 0 round, 1 none(butt) / bevel, 2 square / miter */
  cap: 0 | 1 | 2;
  join: 0 | 1 | 2;
  miter: number;
  noScale: boolean;
}

const CAP_CODE: Record<string, 0 | 1 | 2> = { round: 0, butt: 1, square: 2 };
const JOIN_CODE: Record<string, 0 | 1 | 2> = { round: 0, bevel: 1, miter: 2 };

/** True when a path's stroke needs LINESTYLE2 (a cap/join other than round, a miter limit, a non-scaling stroke). */
function strokeNeedsShape4(p: { strokeCap?: string; strokeJoin?: string; strokeScale?: string }): boolean {
  return (!!p.strokeCap && p.strokeCap !== "round") || (!!p.strokeJoin && p.strokeJoin !== "round") || p.strokeScale === "none";
}

/**
 * The DefineShape version a scene shape needs: 4 for LINESTYLE2 strokes (caps, joins, non-scaling, gradient strokes)
 * and DefineShape4-only gradients (>8 stops, focal, reflect/repeat); otherwise 3, so plain art stays byte-identical.
 */
export function shapeVersion(shape: SceneShape, gradients: Record<string, SceneGradient> = {}): 3 | 4 {
  const g4 = (fill: string | null | undefined): boolean => {
    const f = parseFill(fill).fill;
    return f.kind === "gradient" && !!gradients[f.id] && gradientNeedsShape4(gradients[f.id]!);
  };
  for (const p of shape.paths || []) {
    if (g4(p.fill)) return 4;
    if (p.stroke && (p.strokeWidth ?? 0) > 0) {
      if (strokeNeedsShape4(p)) return 4;
      if (parseFill(p.stroke).fill.kind === "gradient") return 4;
    }
  }
  return 3;
}
interface Run {
  fill0: number;
  fill1: number;
  line: number;
  start: [number, number];
  edges: Edge[];
}

export type FillSide = "left" | "right" | "none";

const MAX_EDGE_BITS = 17; // NumBits (4 bits) + 2

/** Encode one scene shape as a DefineShape3 tag (LINESTYLE2 / DefineShape4-only features dropped with a warning). */
export function encodeDefineShape3(shapeId: number, shape: SceneShape, ctx: ShapeContext = {}): EncodedShape {
  return encodeDefineShape(shapeId, shape, { ...ctx, version: 3 });
}

/**
 * Encode one scene shape as DefineShape3 or DefineShape4 (`ctx.version`, default: shapeVersion()).
 * @param shapeId character id
 */
export function encodeDefineShape(shapeId: number, shape: SceneShape, ctx: ShapeContext & { version?: 3 | 4 } = {}): EncodedShape {
  const version = ctx.version ?? shapeVersion(shape, ctx.gradients || {});
  const findings: Finding[] = [];
  const at = `shapes.${ctx.shapeName ?? shapeId}`;
  const fillStyles: FillDef[] = [];
  const lineStyles: LineDef[] = [];
  const runs: Run[] = [];

  (shape.paths || []).forEach((p, pi) => {
    const pat = `${at}.paths[${pi}]`;
    let subs: SubPath[];
    try {
      subs = normalizePath(p.d, { matrix: p.transform, cubicSplits: ctx.cubicSplits });
    } catch (e) {
      findings.push({ severity: "error", code: "path-parse", message: e instanceof Error ? e.message : String(e), path: `${pat}.d` });
      return;
    }
    // fill style
    let fillIdx = 0;
    const pf = parseFill(p.fill);
    if (pf.fill.kind === "gray" || pf.fill.kind === "rgba") {
      const color = fillToRgba(pf.fill);
      if (color) {
        fillStyles.push({ kind: "solid", color });
        fillIdx = fillStyles.length;
      }
    } else if (pf.fill.kind === "bitmap") {
      const cid = ctx.bitmapIds ? ctx.bitmapIds.get(pf.fill.id) : undefined;
      if (cid === undefined) {
        findings.push({ severity: "error", code: "bitmap-missing", message: `fill references bitmap "${pf.fill.id}" which has no DefineBitsLossless2`, path: `${pat}.fill` });
      } else {
        const t = p.transform || IDENTITY;
        // bitmap px → shape twips: scale 20 after the path transform; translate stays px (writeMatrix ×20)
        const type = (ctx.bitmapTypes && ctx.bitmapTypes.get(pf.fill.id)) ?? 0x41;
        fillStyles.push({ kind: "bitmap", id: cid, matrix: [20 * t[0], 20 * t[1], 20 * t[2], 20 * t[3], t[4], t[5]], type });
        fillIdx = fillStyles.length;
      }
    } else if (pf.fill.kind === "gradient") {
      const gf = gradientFill(pf.fill.id, p.transform || IDENTITY, `${pat}.fill`);
      if (gf) {
        fillStyles.push(gf);
        fillIdx = fillStyles.length;
      }
    } else if (pf.error) {
      findings.push({ severity: "error", code: "fill", message: pf.error, path: `${pat}.fill` });
    }
    // line style
    let lineIdx = 0;
    if (p.stroke) {
      const sw = p.strokeWidth ?? 0;
      const sf = parseFill(p.stroke).fill;
      const color = fillToRgba(sf);
      const lineFill = version === 4 && sf.kind === "gradient" && sw > 0 ? gradientFill(sf.id, p.transform || IDENTITY, `${pat}.stroke`) : null;
      if (!(sw > 0) || (!color && !lineFill)) {
        findings.push({ severity: "warning", code: "stroke-dropped", message: !(sw > 0) ? "stroke has no width; dropped" : `stroke ${p.stroke} is not a solid colour${version === 3 ? " (gradient strokes need DefineShape4)" : ""}; dropped`, path: `${pat}.stroke` });
      } else {
        const v4 = version === 4;
        if (!v4 && (strokeNeedsShape4(p) || p.miterLimit !== undefined)) findings.push({ severity: "warning", code: "stroke-style-dropped", message: "caps / joins / miter limit / non-scaling need DefineShape4; drawn with round caps and joins", path: `${pat}.stroke` });
        const join = v4 ? JOIN_CODE[p.strokeJoin || "round"] ?? 0 : 0;
        lineStyles.push({
          width: Math.max(1, Math.round(sw * 20)),
          color: lineFill ? null : color,
          fill: lineFill,
          cap: v4 ? CAP_CODE[p.strokeCap || "round"] ?? 0 : 0,
          join,
          miter: join === 2 ? p.miterLimit ?? 4 : 0,
          noScale: v4 && p.strokeScale === "none",
        });
        lineIdx = lineStyles.length;
      }
    }
    if (!fillIdx && !lineIdx) {
      findings.push({ severity: "info", code: "path-invisible", message: "path has neither fill nor stroke; skipped", path: pat });
      return;
    }
    const sides: FillSide[] = fillIdx ? assignFillSides(subs, p.fillRule === "evenodd") : subs.map(() => "none" as const);
    let dropped = 0;
    subs.forEach((sub, si) => {
      const tw = toTwips(sub);
      const side = sides[si];
      const fill0 = fillIdx && side === "left" ? fillIdx : 0;
      const fill1 = fillIdx && side === "right" ? fillIdx : 0;
      if (!fill0 && !fill1 && !lineIdx) {
        dropped++;
        return;
      }
      const edges = tw.edges.slice();
      if (fill0 || fill1 || sub.closed) {
        const last = edges[edges.length - 1];
        if (last.x !== tw.start[0] || last.y !== tw.start[1]) edges.push({ t: "L", x: tw.start[0], y: tw.start[1] });
      }
      runs.push({ fill0, fill1, line: lineIdx, start: tw.start, edges });
    });
    if (dropped) findings.push({ severity: "info", code: "subpath-dropped", message: `${dropped} sub-path(s) lie entirely inside/outside the fill and were dropped`, path: pat });
  });

  // bounds in twips (+ half the widest stroke); EdgeBounds (DefineShape4) is the geometry alone
  const pseudo: SubPath[] = runs.map((r) => ({ start: r.start, edges: r.edges, closed: true }));
  let bounds = subpathBounds(pseudo);
  const edgeBounds = bounds ? { ...bounds } : { xmin: 0, ymin: 0, xmax: 0, ymax: 0 };
  if (!bounds) {
    bounds = { xmin: 0, ymin: 0, xmax: 0, ymax: 0 };
    findings.push({ severity: "warning", code: "shape-no-edges", message: "shape has no drawable edges", path: at });
  } else if (lineStyles.length) {
    // half the widest stroke, times how far a miter (its limit) or a square cap (√2 at a corner) reaches past it
    const half = Math.ceil(Math.max(...lineStyles.map((l) => (l.width / 2) * (l.join === 2 ? Math.max(l.miter, Math.SQRT2) : l.cap === 2 ? Math.SQRT2 : 1))));
    bounds = { xmin: bounds.xmin - half, ymin: bounds.ymin - half, xmax: bounds.xmax + half, ymax: bounds.ymax + half };
  }

  const w = new BitWriter(1024);
  w.u16(shapeId);
  writeRect(w, bounds);
  if (version === 4) {
    writeRect(w, edgeBounds);
    // Reserved(5) UsesFillWindingRule(1) UsesNonScalingStrokes(1) UsesScalingStrokes(1)
    w.u8((lineStyles.some((l) => l.noScale) ? 0x02 : 0) | (lineStyles.some((l) => !l.noScale) ? 0x01 : 0));
  }
  writeStyleCount(w, fillStyles.length);
  for (const f of fillStyles) writeFillStyle(w, f);
  writeStyleCount(w, lineStyles.length);
  for (const l of lineStyles) {
    w.u16(l.width);
    if (version === 4) {
      // LINESTYLE2: StartCap(2) Join(2) HasFill(1) NoHScale(1) NoVScale(1) PixelHinting(1) Reserved(5) NoClose(1) EndCap(2)
      const ns = l.noScale ? 1 : 0;
      w.writeUB(2, l.cap);
      w.writeUB(2, l.join);
      w.writeUB(1, l.fill ? 1 : 0);
      w.writeUB(1, ns);
      w.writeUB(1, ns);
      w.writeUB(1, 0);
      w.writeUB(5, 0);
      w.writeUB(1, 0);
      w.writeUB(2, l.cap);
      if (l.join === 2) w.u16(Math.round(Math.max(1, l.miter) * 256) & 0xffff); // FIXED8 MiterLimitFactor
      if (l.fill) writeFillStyle(w, l.fill);
      else writeRgba(w, l.color as Rgba);
    } else writeRgba(w, l.color as Rgba);
  }
  const numFillBits = nbitsForUnsigned(fillStyles.length);
  const numLineBits = nbitsForUnsigned(lineStyles.length);
  w.writeUB(4, numFillBits);
  w.writeUB(4, numLineBits);
  let edgeCount = 0;
  for (const run of runs) {
    // StyleChangeRecord: TypeFlag 0, NewStyles 0, LineStyle, FillStyle1, FillStyle0, MoveTo
    w.writeUB(1, 0);
    w.writeUB(1, 0);
    w.writeUB(1, numLineBits ? 1 : 0);
    w.writeUB(1, numFillBits ? 1 : 0);
    w.writeUB(1, numFillBits ? 1 : 0);
    w.writeUB(1, 1);
    const mb = nbitsForSigned([run.start[0], run.start[1]]);
    w.writeUB(5, mb);
    w.writeSB(mb, run.start[0]);
    w.writeSB(mb, run.start[1]);
    if (numFillBits) {
      w.writeUB(numFillBits, run.fill0);
      w.writeUB(numFillBits, run.fill1);
    }
    if (numLineBits) w.writeUB(numLineBits, run.line);
    let px = run.start[0];
    let py = run.start[1];
    for (const e of run.edges) {
      if (e.t === "L") edgeCount += writeStraight(w, e.x - px, e.y - py);
      else edgeCount += writeCurve(w, px, py, e.cx, e.cy, e.x, e.y);
      px = e.x;
      py = e.y;
    }
  }
  w.writeUB(6, 0); // EndShapeRecord
  w.align();
  return { bytes: tag(version === 4 ? TAG.DefineShape4 : TAG.DefineShape3, w.finish()), bounds, version, fillCount: fillStyles.length, lineCount: lineStyles.length, edgeCount, findings };

  /** A gradient fill style for scene gradient `id` (null + a finding when it cannot be written in this version). */
  function gradientFill(id: string, transform: Mat, where: string): FillDef | null {
    const g = ctx.gradients ? ctx.gradients[id] : undefined;
    const problems = g ? gradientProblems(g) : [];
    if (!g) {
      findings.push({ severity: "error", code: "gradient-missing", message: `references gradient "${id}" which is not in scene.gradients`, path: where });
      return null;
    }
    if (problems.length) {
      findings.push({ severity: "error", code: problems[0]!.code, message: `gradient "${id}": ${problems[0]!.message}`, path: where });
      return null;
    }
    if (version === 3 && g.stops.length > MAX_STOPS_SHAPE3) {
      findings.push({ severity: "error", code: "gradient-stops", message: `gradient "${id}" has ${g.stops.length} stops; DefineShape3 allows ${MAX_STOPS_SHAPE3}`, path: where });
      return null;
    }
    let focal = gradientFocal(g);
    let spread = swfSpread(g.spread);
    if (version === 3 && (focal !== 0 || spread !== 0)) {
      findings.push({ severity: "warning", code: "gradient-shape4-dropped", message: `gradient "${id}": a focus / reflect / repeat needs DefineShape4; written as a plain pad gradient`, path: where });
      focal = 0;
      spread = 0;
    }
    const type = g.kind === "linear" ? 0x10 : focal !== 0 ? 0x13 : 0x12;
    return { kind: "gradient", type, matrix: gradientMatrix(g, transform), stops: resolveStops(g.stops), spread, focal };
  }
}

function writeFillStyle(w: BitWriter, f: FillDef): void {
  if (f.kind === "solid") {
    w.u8(0x00);
    writeRgba(w, f.color);
  } else if (f.kind === "gradient") {
    w.u8(f.type);
    writeMatrix(w, f.matrix);
    // GRADIENT: SpreadMode(2) InterpolationMode(2, 0 = normal RGB) NumGradients(4), then RATIO + RGBA per stop
    w.u8((f.spread << 6) | (f.stops.length & 0x0f));
    for (const s of f.stops) {
      w.u8(s.ratio);
      writeRgba(w, s.color);
    }
    if (f.type === 0x13) w.u16(Math.round(f.focal * 256) & 0xffff); // FIXED8 focal point
  } else {
    w.u8(f.type); // 0x40 repeat / 0x41 clipped (smoothed), 0x42 / 0x43 pixel-snapped
    w.u16(f.id);
    writeMatrix(w, f.matrix);
  }
}

function writeStyleCount(w: BitWriter, n: number): void {
  if (n >= 0xff) {
    w.u8(0xff);
    w.u16(n);
  } else w.u8(n);
}

/** px sub-path → integer twips. */
function toTwips(sub: SubPath): { start: [number, number]; edges: Edge[] } {
  const T = (v: number) => Math.round(v * 20);
  return {
    start: [T(sub.start[0]), T(sub.start[1])],
    edges: sub.edges.map((e): Edge => (e.t === "L" ? { t: "L", x: T(e.x), y: T(e.y) } : { t: "Q", cx: T(e.cx), cy: T(e.cy), x: T(e.x), y: T(e.y) })),
  };
}

/** StraightEdgeRecord(s) for a delta; splits deltas wider than 17 bits. Returns records written. */
export function writeStraight(w: BitWriter, dx: number, dy: number): number {
  if (dx === 0 && dy === 0) return 0;
  const nbits = Math.max(2, nbitsForSigned([dx, dy]));
  if (nbits > MAX_EDGE_BITS) {
    const hx = Math.trunc(dx / 2);
    const hy = Math.trunc(dy / 2);
    return writeStraight(w, hx, hy) + writeStraight(w, dx - hx, dy - hy);
  }
  w.writeUB(1, 1);
  w.writeUB(1, 1);
  w.writeUB(4, nbits - 2);
  if (dx !== 0 && dy !== 0) {
    w.writeUB(1, 1); // general line
    w.writeSB(nbits, dx);
    w.writeSB(nbits, dy);
  } else {
    w.writeUB(1, 0);
    w.writeUB(1, dx === 0 ? 1 : 0); // vertical
    w.writeSB(nbits, dx === 0 ? dy : dx);
  }
  return 1;
}

/** CurvedEdgeRecord(s); splits (de Casteljau) when a delta needs more than 17 bits. */
export function writeCurve(w: BitWriter, x0: number, y0: number, cx: number, cy: number, x1: number, y1: number): number {
  const cdx = cx - x0;
  const cdy = cy - y0;
  const adx = x1 - cx;
  const ady = y1 - cy;
  if (cdx === 0 && cdy === 0 && adx === 0 && ady === 0) return 0;
  const nbits = Math.max(2, nbitsForSigned([cdx, cdy, adx, ady]));
  if (nbits > MAX_EDGE_BITS) {
    const m01x = Math.round((x0 + cx) / 2);
    const m01y = Math.round((y0 + cy) / 2);
    const m12x = Math.round((cx + x1) / 2);
    const m12y = Math.round((cy + y1) / 2);
    const mx = Math.round((m01x + m12x) / 2);
    const my = Math.round((m01y + m12y) / 2);
    return writeCurve(w, x0, y0, m01x, m01y, mx, my) + writeCurve(w, mx, my, m12x, m12y, x1, y1);
  }
  w.writeUB(1, 1);
  w.writeUB(1, 0);
  w.writeUB(4, nbits - 2);
  w.writeSB(nbits, cdx);
  w.writeSB(nbits, cdy);
  w.writeSB(nbits, adx);
  w.writeSB(nbits, ady);
  return 1;
}

// ---- fill side assignment -----------------------------------------------------------

/**
 * For each sub-path decide where its fill goes: "right" (FillStyle1), "left" (FillStyle0)
 * or "none" (no paint boundary). See the module header for the rule.
 * @param subs px (any consistent unit)
 */
export function assignFillSides(subs: SubPath[], evenodd: boolean): FillSide[] {
  const polys = subs.map((s) => flattenSubpath(s, 0.25));
  const areas = polys.map(signedArea);
  return subs.map((_, i): FillSide => {
    const sign = areas[i] > 1e-9 ? 1 : areas[i] < -1e-9 ? -1 : 0;
    if (sign === 0) return "none";
    const rep = representativePoint(polys[i]);
    let outside = 0;
    for (let j = 0; j < polys.length; j++) if (j !== i) outside += windingNumber(rep[0], rep[1], polys[j]);
    const inside = outside + sign;
    const filledOut = evenodd ? (outside & 1) !== 0 : outside !== 0;
    const filledIn = evenodd ? (inside & 1) !== 0 : inside !== 0;
    if (filledIn && !filledOut) return sign > 0 ? "right" : "left";
    if (!filledIn && filledOut) return sign > 0 ? "left" : "right";
    return "none";
  });
}

/**
 * A point on the polygon's boundary (midpoint of its first non-degenerate segment).
 * @param poly flat
 */
function representativePoint(poly: number[]): [number, number] {
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const x0 = poly[2 * i];
    const y0 = poly[2 * i + 1];
    const x1 = poly[2 * j];
    const y1 = poly[2 * j + 1];
    if (x0 !== x1 || y0 !== y1) return [(x0 + x1) / 2, (y0 + y1) / 2];
  }
  return [poly[0], poly[1]];
}

/**
 * For the preview: which sub-paths of a path carry its fill in the emitted SWF (the ones `assignFillSides` gives a
 * side). The engine then fills them EVEN-ODD as one contour set per fill style (ENGINE_DRAWING.fillRule), so the
 * preview draws exactly these polygons with the even-odd stencil rule, whatever the authored `fillRule` was.
 */
export function fillSubpathMask(subs: SubPath[], fillRule: "nonzero" | "evenodd" | undefined): boolean[] {
  return assignFillSides(subs, fillRule === "evenodd").map((s) => s !== "none");
}

/** Above this many flattened points per sub-path the O(n²) self-crossing scan is skipped (the overlap scan still runs). */
export const FILL_RULE_SCAN_LIMIT = 1500;

/**
 * Where a `nonzero` path draws differently in-game. The engine fills each style even-odd over the sub-paths the
 * emitter keeps, so two kept sub-paths whose outlines cross (a partial overlap: nonzero paints the union, even-odd
 * leaves the overlap empty) or a sub-path that crosses itself (its doubly covered part empties) are holes in the game.
 * Nesting is handled by `assignFillSides` and an `evenodd` path gets what it asked for, so both return nothing.
 * @returns one short reason per problem (empty when the path draws as authored)
 */
export function fillRuleProblems(subs: SubPath[], fillRule: "nonzero" | "evenodd" | undefined): string[] {
  if (fillRule === "evenodd") return [];
  const sides = assignFillSides(subs, false);
  const polys = subs.map((s, i) => (sides[i] === "none" ? null : flattenSubpath(s, 0.25)));
  const boxes = polys.map((p) => (p ? polyBox(p) : null));
  const out: string[] = [];
  polys.forEach((p, i) => {
    if (p && p.length / 2 <= FILL_RULE_SCAN_LIMIT && selfCrosses(p)) out.push(`sub-path ${i} crosses itself (the part it covers twice is empty)`);
  });
  for (let i = 0; i < polys.length; i++) {
    const a = polys[i];
    if (!a) continue;
    for (let j = i + 1; j < polys.length; j++) {
      const b = polys[j];
      if (!b || !boxesTouch(boxes[i]!, boxes[j]!)) continue;
      if (outlinesCross(a, b) || partiallyInside(a, b) || partiallyInside(b, a)) out.push(`sub-paths ${i} and ${j} partially overlap (their overlap is empty)`);
    }
  }
  return out;
}

function polyBox(p: number[]): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    const x = p[i]!, y = p[i + 1]!;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}
function boxesTouch(a: [number, number, number, number], b: [number, number, number, number]): boolean {
  return a[0] <= b[2] && b[0] <= a[2] && a[1] <= b[3] && b[1] <= a[3];
}
/** Strict orientation sign of (a → b → c); 0 when collinear. */
function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number): number {
  const v = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  return v > 1e-9 ? 1 : v < -1e-9 ? -1 : 0;
}
/** Two segments cross at an interior point of both (touching ends and collinear overlaps do not count). */
function properCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const o1 = orient(ax, ay, bx, by, cx, cy);
  const o2 = orient(ax, ay, bx, by, dx, dy);
  const o3 = orient(cx, cy, dx, dy, ax, ay);
  const o4 = orient(cx, cy, dx, dy, bx, by);
  return o1 !== 0 && o2 !== 0 && o3 !== 0 && o4 !== 0 && o1 !== o2 && o3 !== o4;
}
/** Any two non-adjacent edges of one closed flat polygon cross. */
function selfCrosses(p: number[]): boolean {
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const i2 = (i + 1) % n;
    for (let j = i + 2; j < n; j++) {
      const j2 = (j + 1) % n;
      if (j2 === i) continue;
      if (properCross(p[2 * i]!, p[2 * i + 1]!, p[2 * i2]!, p[2 * i2 + 1]!, p[2 * j]!, p[2 * j + 1]!, p[2 * j2]!, p[2 * j2 + 1]!)) return true;
    }
  }
  return false;
}
/** Any edge of `a` crosses any edge of `b` (a partial overlap; nested and disjoint outlines never cross). */
function outlinesCross(a: number[], b: number[]): boolean {
  const na = a.length / 2, nb = b.length / 2;
  if (na * nb > FILL_RULE_SCAN_LIMIT * FILL_RULE_SCAN_LIMIT) return false;
  for (let i = 0; i < na; i++) {
    const i2 = (i + 1) % na;
    for (let j = 0; j < nb; j++) {
      const j2 = (j + 1) % nb;
      if (properCross(a[2 * i]!, a[2 * i + 1]!, a[2 * i2]!, a[2 * i2 + 1]!, b[2 * j]!, b[2 * j + 1]!, b[2 * j2]!, b[2 * j2 + 1]!)) return true;
    }
  }
  return false;
}
/** Some but not all of (up to 16 sampled) vertices of `a` lie strictly inside `b` (overlaps whose outlines only share edges). */
function partiallyInside(a: number[], b: number[]): boolean {
  const n = a.length / 2;
  const step = Math.max(1, Math.floor(n / 16));
  let inside = 0, sampled = 0;
  for (let i = 0; i < n; i += step) {
    sampled++;
    if (windingNumber(a[2 * i]!, a[2 * i + 1]!, b) !== 0) inside++;
  }
  return inside > 0 && inside < sampled;
}

/**
 * Winding number of (px, py) with respect to a flat closed polygon. Positive when the
 * polygon's `signedArea` is positive and the point is inside.
 */
export function windingNumber(px: number, py: number, poly: number[]): number {
  let wn = 0;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const xi = poly[2 * i];
    const yi = poly[2 * i + 1];
    const xj = poly[2 * j];
    const yj = poly[2 * j + 1];
    const isLeft = (xj - xi) * (py - yi) - (px - xi) * (yj - yi);
    if (yi <= py) {
      if (yj > py && isLeft > 0) wn++;
    } else if (yj <= py && isLeft < 0) wn--;
  }
  return wn;
}
