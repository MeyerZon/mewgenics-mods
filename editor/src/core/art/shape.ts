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
import { parseFill, fillToRgba } from "./scene.ts";
import { BitWriter, TAG, nbitsForSigned, nbitsForUnsigned, writeRect, writeMatrix, writeRgba, tag } from "./swf-bits.ts";

/** @typedef {import('./geometry.ts').Mat} Mat */
/** @typedef {import('./geometry.ts').SubPath} SubPath */
/** @typedef {import('./geometry.ts').Edge} Edge */
/** @typedef {import('./scene.ts').SceneShape} SceneShape */
/** @typedef {import('./scene.ts').Finding} Finding */
/** @typedef {import('./swf-bits.ts').Rect} Rect */
/** @typedef {import('./swf-bits.ts').Rgba} Rgba */

/**
 * @typedef {Object} ShapeContext
 * @property {Map<string, number>} [bitmapIds]  scene bitmap id → character id of its DefineBitsLossless2
 * @property {string} [shapeName]              scene id, used in finding paths
 * @property {number} [cubicSplits]            quadratics per cubic (geometry default 4)
 */

/**
 * @typedef {Object} EncodedShape
 * @property {Uint8Array} bytes      framed DefineShape3 tag
 * @property {Rect} bounds           twips
 * @property {number} fillCount
 * @property {number} lineCount
 * @property {number} edgeCount      edge records written
 * @property {Finding[]} findings
 */

/** @typedef {{ kind: 'solid', color: Rgba } | { kind: 'bitmap', id: number, matrix: Mat }} FillDef */
/** @typedef {{ width: number, color: Rgba }} LineDef */
/** @typedef {{ fill0: number, fill1: number, line: number, start: [number, number], edges: Edge[] }} Run */

const MAX_EDGE_BITS = 17; // NumBits (4 bits) + 2

/**
 * Encode one scene shape as a DefineShape3 tag.
 * @param {number} shapeId character id
 * @param {SceneShape} shape
 * @param {ShapeContext} [ctx]
 * @returns {EncodedShape}
 */
export function encodeDefineShape3(shapeId, shape, ctx = {}) {
  /** @type {Finding[]} */
  const findings = [];
  const at = `shapes.${ctx.shapeName ?? shapeId}`;
  /** @type {FillDef[]} */
  const fillStyles = [];
  /** @type {LineDef[]} */
  const lineStyles = [];
  /** @type {Run[]} */
  const runs = [];

  (shape.paths || []).forEach((p, pi) => {
    const pat = `${at}.paths[${pi}]`;
    /** @type {SubPath[]} */
    let subs;
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
        fillStyles.push({ kind: "bitmap", id: cid, matrix: [20 * t[0], 20 * t[1], 20 * t[2], 20 * t[3], t[4], t[5]] });
        fillIdx = fillStyles.length;
      }
    } else if (pf.error) {
      findings.push({ severity: "error", code: "fill", message: pf.error, path: `${pat}.fill` });
    }
    // line style
    let lineIdx = 0;
    if (p.stroke) {
      const sw = p.strokeWidth ?? 0;
      const color = fillToRgba(parseFill(p.stroke).fill);
      if (!(sw > 0) || !color) {
        findings.push({ severity: "warning", code: "stroke-dropped", message: !(sw > 0) ? "stroke has no width; dropped" : `stroke ${p.stroke} is not a solid colour; dropped`, path: `${pat}.stroke` });
      } else {
        lineStyles.push({ width: Math.max(1, Math.round(sw * 20)), color });
        lineIdx = lineStyles.length;
      }
    }
    if (!fillIdx && !lineIdx) {
      findings.push({ severity: "info", code: "path-invisible", message: "path has neither fill nor stroke; skipped", path: pat });
      return;
    }
    const sides = fillIdx ? assignFillSides(subs, p.fillRule === "evenodd") : subs.map(() => /** @type {const} */ ("none"));
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

  // bounds in twips (+ half the widest stroke)
  const pseudo = runs.map((r) => /** @type {SubPath} */ ({ start: r.start, edges: r.edges, closed: true }));
  let bounds = subpathBounds(pseudo);
  if (!bounds) {
    bounds = { xmin: 0, ymin: 0, xmax: 0, ymax: 0 };
    findings.push({ severity: "warning", code: "shape-no-edges", message: "shape has no drawable edges", path: at });
  } else if (lineStyles.length) {
    const half = Math.ceil(Math.max(...lineStyles.map((l) => l.width)) / 2);
    bounds = { xmin: bounds.xmin - half, ymin: bounds.ymin - half, xmax: bounds.xmax + half, ymax: bounds.ymax + half };
  }

  const w = new BitWriter(1024);
  w.u16(shapeId);
  writeRect(w, bounds);
  writeStyleCount(w, fillStyles.length);
  for (const f of fillStyles) {
    if (f.kind === "solid") {
      w.u8(0x00);
      writeRgba(w, f.color);
    } else {
      w.u8(0x41); // clipped bitmap
      w.u16(f.id);
      writeMatrix(w, f.matrix);
    }
  }
  writeStyleCount(w, lineStyles.length);
  for (const l of lineStyles) {
    w.u16(l.width);
    writeRgba(w, l.color);
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
  return { bytes: tag(TAG.DefineShape3, w.finish()), bounds, fillCount: fillStyles.length, lineCount: lineStyles.length, edgeCount, findings };
}

/** @param {BitWriter} w @param {number} n */
function writeStyleCount(w, n) {
  if (n >= 0xff) {
    w.u8(0xff);
    w.u16(n);
  } else w.u8(n);
}

/**
 * px sub-path → integer twips.
 * @param {SubPath} sub
 * @returns {{ start: [number, number], edges: Edge[] }}
 */
function toTwips(sub) {
  const T = (/** @type {number} */ v) => Math.round(v * 20);
  return {
    start: [T(sub.start[0]), T(sub.start[1])],
    edges: sub.edges.map((e) => (e.t === "L" ? { t: "L", x: T(e.x), y: T(e.y) } : { t: "Q", cx: T(e.cx), cy: T(e.cy), x: T(e.x), y: T(e.y) })),
  };
}

/**
 * StraightEdgeRecord(s) for a delta; splits deltas wider than 17 bits. Returns records written.
 * @param {BitWriter} w @param {number} dx @param {number} dy
 * @returns {number}
 */
function writeStraight(w, dx, dy) {
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

/**
 * CurvedEdgeRecord(s); splits (de Casteljau) when a delta needs more than 17 bits.
 * @param {BitWriter} w
 * @param {number} x0 @param {number} y0 @param {number} cx @param {number} cy @param {number} x1 @param {number} y1
 * @returns {number}
 */
function writeCurve(w, x0, y0, cx, cy, x1, y1) {
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
 * @param {SubPath[]} subs px (any consistent unit)
 * @param {boolean} evenodd
 * @returns {Array<'left'|'right'|'none'>}
 */
export function assignFillSides(subs, evenodd) {
  const polys = subs.map((s) => flattenSubpath(s, 0.25));
  const areas = polys.map(signedArea);
  return subs.map((_, i) => {
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
 * @param {number[]} poly flat
 * @returns {[number, number]}
 */
function representativePoint(poly) {
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
 * Winding number of (px, py) with respect to a flat closed polygon. Positive when the
 * polygon's `signedArea` is positive and the point is inside.
 * @param {number} px @param {number} py @param {number[]} poly
 */
export function windingNumber(px, py, poly) {
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
