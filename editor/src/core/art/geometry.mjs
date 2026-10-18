// Pure geometry for the art pipeline. Shared by the SWF emitter (Node) and the
// WebGL preview (browser): NO node imports, NO DOM. This module owns path
// normalization — SVG `d` strings become absolute line/quadratic edges, cubics
// are subdivided to quadratics, arcs are flattened — so the emitter and the
// preview never re-interpret path data separately.
//
// Units: callers decide (the scene model is in px; the emitter multiplies by 20
// for twips at its own boundary). y grows downward, as in SVG and SWF.
//
// Matrix layout is the SVG/SWF-shared [a, b, c, d, e, f]:
//   x' = a*x + c*y + e ;  y' = b*x + d*y + f
// (SWF MATRIX: ScaleX=a, RotateSkew0=b, RotateSkew1=c, ScaleY=d, TranslateX=e, TranslateY=f.)

/** @typedef {[number, number, number, number, number, number]} Mat */

/** @type {Mat} */
export const IDENTITY = [1, 0, 0, 1, 0, 0];

/**
 * @typedef {{ t: 'L', x: number, y: number } | { t: 'Q', cx: number, cy: number, x: number, y: number }} Edge
 * @typedef {{ start: [number, number], edges: Edge[], closed: boolean }} SubPath
 */

// ---- matrices ---------------------------------------------------------------

/**
 * m1 ∘ m2: apply m2 first, then m1 (same as SVG `transform="m1 m2"`).
 * @param {Mat} m1 @param {Mat} m2 @returns {Mat}
 */
export function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

/** @param {Mat} m @param {number} x @param {number} y @returns {[number, number]} */
export function apply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** @param {Mat} m */
export function isIdentity(m) {
  return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

/**
 * Build a matrix from the scene's placement fields: translate(x,y) · rotate(rot°) ·
 * skewX(skew°) · scale(sx,sy). Rotation is clockwise-positive on screen (y down),
 * matching Flash's `rotation` property.
 * @param {{ x?: number, y?: number, sx?: number, sy?: number, rot?: number, skew?: number }} t
 * @returns {Mat}
 */
export function matrixFromTransform(t) {
  const x = t.x ?? 0;
  const y = t.y ?? 0;
  const sx = t.sx ?? 1;
  const sy = t.sy ?? 1;
  const rot = ((t.rot ?? 0) * Math.PI) / 180;
  const skew = ((t.skew ?? 0) * Math.PI) / 180;
  const cos = Math.cos(rot);
  const sin = Math.sin(rot);
  const tanS = Math.tan(skew);
  // R · K · S  where K = [1 tanS; 0 1] (skewX), S = diag(sx, sy)
  // R·K = [cos, cos*tanS - sin; sin, sin*tanS + cos]
  const a = cos * sx;
  const b = sin * sx;
  const c = (cos * tanS - sin) * sy;
  const d = (sin * tanS + cos) * sy;
  return [round6(a), round6(b), round6(c), round6(d), x, y];
}

/** @param {number} v */
function round6(v) {
  return Math.round(v * 1e6) / 1e6;
}

/**
 * Parse an SVG `transform` attribute into one matrix.
 * Supports matrix(), translate(), scale(), rotate([cx cy]), skewX(), skewY().
 * @param {string | null | undefined} str
 * @returns {Mat}
 */
export function parseSvgTransform(str) {
  /** @type {Mat} */
  let m = IDENTITY;
  if (!str) return m;
  const re = /([a-zA-Z]+)\s*\(([^)]*)\)/g;
  let match;
  while ((match = re.exec(str))) {
    const name = match[1];
    const args = match[2]
      .trim()
      .split(/[\s,]+/)
      .filter((s) => s.length)
      .map(Number);
    /** @type {Mat} */
    let t = IDENTITY;
    switch (name) {
      case "matrix":
        if (args.length === 6) t = /** @type {Mat} */ (args);
        break;
      case "translate":
        t = [1, 0, 0, 1, args[0] || 0, args[1] || 0];
        break;
      case "scale":
        t = [args[0] ?? 1, 0, 0, args.length > 1 ? args[1] : (args[0] ?? 1), 0, 0];
        break;
      case "rotate": {
        const r = ((args[0] || 0) * Math.PI) / 180;
        const cos = Math.cos(r);
        const sin = Math.sin(r);
        t = [cos, sin, -sin, cos, 0, 0];
        if (args.length === 3) {
          t = multiply(multiply([1, 0, 0, 1, args[1], args[2]], t), [1, 0, 0, 1, -args[1], -args[2]]);
        }
        break;
      }
      case "skewX":
        t = [1, 0, Math.tan(((args[0] || 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case "skewY":
        t = [1, Math.tan(((args[0] || 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
      default:
        break; // unknown function: ignored (reported by the importer, which sees the raw string)
    }
    m = multiply(m, t);
  }
  return m;
}

// ---- SVG path data ----------------------------------------------------------

/**
 * @typedef {{ t: 'M'|'L', x: number, y: number }
 *   | { t: 'Q', x1: number, y1: number, x: number, y: number }
 *   | { t: 'C', x1: number, y1: number, x2: number, y2: number, x: number, y: number }
 *   | { t: 'A', rx: number, ry: number, rot: number, large: boolean, sweep: boolean, x: number, y: number }
 *   | { t: 'Z' }} PathCmd
 */

/**
 * Tokenize + absolutize an SVG path `d` string. Relative commands, H/V, S/T
 * shorthands and implicit repeats are resolved; the output has only
 * M, L, Q, C, A, Z in absolute coordinates.
 * @param {string} d
 * @returns {PathCmd[]}
 */
export function parsePathData(d) {
  /** @type {PathCmd[]} */
  const out = [];
  const tokens = tokenizePath(d);
  let i = 0;
  let cx = 0;
  let cy = 0;
  let sx = 0; // subpath start
  let sy = 0;
  let lastCmd = "";
  let lastCtrlX = 0; // for S/T reflection
  let lastCtrlY = 0;
  let lastType = ""; // 'Q' | 'C' | ''
  const num = () => {
    const t = tokens[i++];
    if (t === undefined || t.kind !== "num") throw new Error(`path data: expected number at token ${i - 1}`);
    return t.value;
  };
  const flag = () => {
    const t = tokens[i++];
    if (t === undefined || t.kind !== "num" || (t.value !== 0 && t.value !== 1)) throw new Error(`path data: expected flag at token ${i - 1}`);
    return t.value === 1;
  };
  while (i < tokens.length) {
    const tok = tokens[i];
    let cmd;
    if (tok.kind === "cmd") {
      cmd = tok.value;
      i++;
    } else {
      // implicit repeat; M repeats as L
      if (!lastCmd) throw new Error("path data: number before any command");
      cmd = lastCmd === "M" ? "L" : lastCmd === "m" ? "l" : lastCmd;
    }
    const rel = cmd === cmd.toLowerCase() && cmd !== "z" && cmd !== "Z";
    const C = cmd.toUpperCase();
    const ox = rel ? cx : 0;
    const oy = rel ? cy : 0;
    switch (C) {
      case "M": {
        const x = num() + ox;
        const y = num() + oy;
        out.push({ t: "M", x, y });
        cx = sx = x;
        cy = sy = y;
        lastType = "";
        break;
      }
      case "L": {
        const x = num() + ox;
        const y = num() + oy;
        out.push({ t: "L", x, y });
        cx = x;
        cy = y;
        lastType = "";
        break;
      }
      case "H": {
        const x = num() + ox;
        out.push({ t: "L", x, y: cy });
        cx = x;
        lastType = "";
        break;
      }
      case "V": {
        const y = num() + oy;
        out.push({ t: "L", x: cx, y });
        cy = y;
        lastType = "";
        break;
      }
      case "Q": {
        const x1 = num() + ox;
        const y1 = num() + oy;
        const x = num() + ox;
        const y = num() + oy;
        out.push({ t: "Q", x1, y1, x, y });
        lastCtrlX = x1;
        lastCtrlY = y1;
        cx = x;
        cy = y;
        lastType = "Q";
        break;
      }
      case "T": {
        const x1 = lastType === "Q" ? 2 * cx - lastCtrlX : cx;
        const y1 = lastType === "Q" ? 2 * cy - lastCtrlY : cy;
        const x = num() + ox;
        const y = num() + oy;
        out.push({ t: "Q", x1, y1, x, y });
        lastCtrlX = x1;
        lastCtrlY = y1;
        cx = x;
        cy = y;
        lastType = "Q";
        break;
      }
      case "C": {
        const x1 = num() + ox;
        const y1 = num() + oy;
        const x2 = num() + ox;
        const y2 = num() + oy;
        const x = num() + ox;
        const y = num() + oy;
        out.push({ t: "C", x1, y1, x2, y2, x, y });
        lastCtrlX = x2;
        lastCtrlY = y2;
        cx = x;
        cy = y;
        lastType = "C";
        break;
      }
      case "S": {
        const x1 = lastType === "C" ? 2 * cx - lastCtrlX : cx;
        const y1 = lastType === "C" ? 2 * cy - lastCtrlY : cy;
        const x2 = num() + ox;
        const y2 = num() + oy;
        const x = num() + ox;
        const y = num() + oy;
        out.push({ t: "C", x1, y1, x2, y2, x, y });
        lastCtrlX = x2;
        lastCtrlY = y2;
        cx = x;
        cy = y;
        lastType = "C";
        break;
      }
      case "A": {
        const rx = num();
        const ry = num();
        const rot = num();
        const large = flag();
        const sweep = flag();
        const x = num() + ox;
        const y = num() + oy;
        out.push({ t: "A", rx, ry, rot, large, sweep, x, y });
        cx = x;
        cy = y;
        lastType = "";
        break;
      }
      case "Z": {
        out.push({ t: "Z" });
        cx = sx;
        cy = sy;
        lastType = "";
        break;
      }
      default:
        throw new Error(`path data: unknown command "${cmd}"`);
    }
    lastCmd = cmd;
  }
  return out;
}

/**
 * @param {string} d
 * @returns {Array<{kind:'cmd', value:string} | {kind:'num', value:number}>}
 */
function tokenizePath(d) {
  /** @type {Array<{kind:'cmd', value:string} | {kind:'num', value:number}>} */
  const out = [];
  const re = /([MmLlHhVvQqTtCcSsAaZz])|([-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?)/g;
  let m;
  while ((m = re.exec(d))) {
    if (m[1]) out.push({ kind: "cmd", value: m[1] });
    else out.push({ kind: "num", value: Number(m[2]) });
  }
  return out;
}

// ---- normalization: commands → line/quadratic edges -------------------------

/**
 * Normalize path commands into sub-paths of absolute line + quadratic edges,
 * applying `matrix`. Cubics are subdivided into quadratics (midpoint method, `cubicSplits`
 * pieces each — 4 is visually exact for cartoon art), arcs are converted to cubics first.
 * @param {PathCmd[] | string} cmdsOrD
 * @param {{ matrix?: Mat, cubicSplits?: number }} [opts]
 * @returns {SubPath[]}
 */
export function normalizePath(cmdsOrD, opts = {}) {
  const cmds = typeof cmdsOrD === "string" ? parsePathData(cmdsOrD) : cmdsOrD;
  const m = opts.matrix || IDENTITY;
  const splits = Math.max(1, opts.cubicSplits ?? 4);
  /** @type {SubPath[]} */
  const subs = [];
  /** @type {SubPath | null} */
  let cur = null;
  let cx = 0;
  let cy = 0;
  const T = (/** @type {number} */ x, /** @type {number} */ y) => apply(m, x, y);
  const ensure = () => {
    if (!cur) {
      cur = { start: T(cx, cy), edges: [], closed: false };
      subs.push(cur);
    }
    return cur;
  };
  const pushQuad = (/** @type {number} */ x1, /** @type {number} */ y1, /** @type {number} */ x, /** @type {number} */ y) => {
    const c = T(x1, y1);
    const p = T(x, y);
    ensure().edges.push({ t: "Q", cx: c[0], cy: c[1], x: p[0], y: p[1] });
  };
  const pushCubic = (/** @type {number[]} */ p0, /** @type {number[]} */ p1, /** @type {number[]} */ p2, /** @type {number[]} */ p3) => {
    for (const q of cubicToQuads(p0, p1, p2, p3, splits)) pushQuad(q[0], q[1], q[2], q[3]);
  };
  for (const c of cmds) {
    switch (c.t) {
      case "M":
        cur = null;
        cx = c.x;
        cy = c.y;
        ensure();
        break;
      case "L": {
        const p = T(c.x, c.y);
        ensure().edges.push({ t: "L", x: p[0], y: p[1] });
        cx = c.x;
        cy = c.y;
        break;
      }
      case "Q":
        pushQuad(c.x1, c.y1, c.x, c.y);
        cx = c.x;
        cy = c.y;
        break;
      case "C":
        pushCubic([cx, cy], [c.x1, c.y1], [c.x2, c.y2], [c.x, c.y]);
        cx = c.x;
        cy = c.y;
        break;
      case "A": {
        for (const cub of arcToCubics(cx, cy, c.rx, c.ry, c.rot, c.large, c.sweep, c.x, c.y)) {
          pushCubic([cx, cy], [cub[0], cub[1]], [cub[2], cub[3]], [cub[4], cub[5]]);
          cx = cub[4];
          cy = cub[5];
        }
        cx = c.x;
        cy = c.y;
        break;
      }
      case "Z":
        if (cur) {
          const closing = /** @type {SubPath} */ (cur);
          closing.closed = true;
          // return to subpath start; a following command without M continues from there
          const s = closing.start;
          const inv = invert(m);
          if (inv) {
            const back = apply(inv, s[0], s[1]);
            cx = back[0];
            cy = back[1];
          }
          cur = null;
        }
        break;
    }
  }
  return subs.filter((s) => s.edges.length > 0);
}

/** @param {Mat} m @returns {Mat | null} */
export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return null;
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

/**
 * Approximate a cubic Bézier with `n` quadratics using the midpoint method on each
 * subdivided piece (control point = intersection-free midpoint estimate).
 * @param {number[]} p0 @param {number[]} p1 @param {number[]} p2 @param {number[]} p3 @param {number} n
 * @returns {Array<[number, number, number, number]>} [cx, cy, x, y] per quadratic
 */
export function cubicToQuads(p0, p1, p2, p3, n) {
  /** @type {Array<[number, number, number, number]>} */
  const out = [];
  for (let i = 0; i < n; i++) {
    const t0 = i / n;
    const t1 = (i + 1) / n;
    const seg = cubicSegment(p0, p1, p2, p3, t0, t1);
    // quadratic control = (3(c1 + c2) - (a0 + a3)) / 4
    const cx = (3 * (seg[1][0] + seg[2][0]) - (seg[0][0] + seg[3][0])) / 4;
    const cy = (3 * (seg[1][1] + seg[2][1]) - (seg[0][1] + seg[3][1])) / 4;
    out.push([cx, cy, seg[3][0], seg[3][1]]);
  }
  return out;
}

/**
 * Sub-curve of a cubic between t0 and t1 (de Casteljau).
 * @param {number[]} p0 @param {number[]} p1 @param {number[]} p2 @param {number[]} p3 @param {number} t0 @param {number} t1
 * @returns {number[][]}
 */
function cubicSegment(p0, p1, p2, p3, t0, t1) {
  const left = splitCubic(p0, p1, p2, p3, t1)[0];
  const t = t1 === 0 ? 0 : t0 / t1;
  return splitCubic(left[0], left[1], left[2], left[3], t)[1];
}
/**
 * @param {number[]} p0 @param {number[]} p1 @param {number[]} p2 @param {number[]} p3 @param {number} t
 * @returns {[number[][], number[][]]}
 */
function splitCubic(p0, p1, p2, p3, t) {
  const lerp = (/** @type {number[]} */ a, /** @type {number[]} */ b) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  const p01 = lerp(p0, p1);
  const p12 = lerp(p1, p2);
  const p23 = lerp(p2, p3);
  const p012 = lerp(p01, p12);
  const p123 = lerp(p12, p23);
  const mid = lerp(p012, p123);
  return [
    [p0, p01, p012, mid],
    [mid, p123, p23, p3],
  ];
}

/**
 * SVG elliptical arc → cubic Béziers (standard endpoint→center conversion, ≤90° pieces).
 * @returns {Array<[number, number, number, number, number, number]>} [x1,y1,x2,y2,x,y] per cubic
 */
export function arcToCubics(
  /** @type {number} */ x0, /** @type {number} */ y0, /** @type {number} */ rx, /** @type {number} */ ry, /** @type {number} */ rotDeg,
  /** @type {boolean} */ large, /** @type {boolean} */ sweep, /** @type {number} */ x, /** @type {number} */ y,
) {
  /** @type {Array<[number, number, number, number, number, number]>} */
  const out = [];
  if (x0 === x && y0 === y) return out;
  rx = Math.abs(rx);
  ry = Math.abs(ry);
  if (rx === 0 || ry === 0) {
    out.push([x0, y0, x, y, x, y]);
    return out;
  }
  const phi = (rotDeg * Math.PI) / 180;
  const cosP = Math.cos(phi);
  const sinP = Math.sin(phi);
  const dx = (x0 - x) / 2;
  const dy = (y0 - y) / 2;
  const x1p = cosP * dx + sinP * dy;
  const y1p = -sinP * dx + cosP * dy;
  let lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
    lambda = 1;
  }
  const sign = large === sweep ? -1 : 1;
  const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
  const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
  const coef = sign * Math.sqrt(Math.max(0, num / den));
  const cxp = coef * ((rx * y1p) / ry);
  const cyp = coef * (-(ry * x1p) / rx);
  const cx = cosP * cxp - sinP * cyp + (x0 + x) / 2;
  const cy = sinP * cxp + cosP * cyp + (y0 + y) / 2;
  const ang = (/** @type {number} */ ux, /** @type {number} */ uy, /** @type {number} */ vx, /** @type {number} */ vy) => {
    const dot = ux * vx + uy * vy;
    const len = Math.hypot(ux, uy) * Math.hypot(vx, vy);
    let a = Math.acos(Math.max(-1, Math.min(1, dot / len)));
    if (ux * vy - uy * vx < 0) a = -a;
    return a;
  };
  const theta1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dtheta = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
  if (!sweep && dtheta > 0) dtheta -= 2 * Math.PI;
  else if (sweep && dtheta < 0) dtheta += 2 * Math.PI;
  const segs = Math.max(1, Math.ceil(Math.abs(dtheta) / (Math.PI / 2)));
  const delta = dtheta / segs;
  const kappa = (4 / 3) * Math.tan(delta / 4);
  let t = theta1;
  for (let i = 0; i < segs; i++) {
    const t2 = t + delta;
    const cos1 = Math.cos(t);
    const sin1 = Math.sin(t);
    const cos2 = Math.cos(t2);
    const sin2 = Math.sin(t2);
    // unit-circle control points, then scale/rotate/translate
    const e1x = cos1 - kappa * sin1;
    const e1y = sin1 + kappa * cos1;
    const e2x = cos2 + kappa * sin2;
    const e2y = sin2 - kappa * cos2;
    const map = (/** @type {number} */ ux, /** @type {number} */ uy) => [cosP * rx * ux - sinP * ry * uy + cx, sinP * rx * ux + cosP * ry * uy + cy];
    const c1 = map(e1x, e1y);
    const c2 = map(e2x, e2y);
    const p = i === segs - 1 ? [x, y] : map(cos2, sin2);
    out.push([c1[0], c1[1], c2[0], c2[1], p[0], p[1]]);
    t = t2;
  }
  return out;
}

// ---- flattening (preview + bounds) -----------------------------------------

/**
 * Flatten a sub-path to a polygon (array of [x, y]) with the given tolerance (same units
 * as the path). Quadratics are subdivided uniformly by an estimate of their length.
 * @param {SubPath} sub @param {number} [tolerance]
 * @returns {number[]} flat [x0, y0, x1, y1, ...]
 */
export function flattenSubpath(sub, tolerance = 0.5) {
  const pts = [sub.start[0], sub.start[1]];
  let px = sub.start[0];
  let py = sub.start[1];
  for (const e of sub.edges) {
    if (e.t === "L") {
      pts.push(e.x, e.y);
      px = e.x;
      py = e.y;
    } else {
      const chord = Math.hypot(e.x - px, e.y - py) + Math.hypot(e.cx - px, e.cy - py) + Math.hypot(e.x - e.cx, e.y - e.cy);
      const n = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(chord / Math.max(tolerance, 1e-3)) * 1.5)));
      for (let i = 1; i <= n; i++) {
        const t = i / n;
        const mt = 1 - t;
        pts.push(mt * mt * px + 2 * mt * t * e.cx + t * t * e.x, mt * mt * py + 2 * mt * t * e.cy + t * t * e.y);
      }
      px = e.x;
      py = e.y;
    }
  }
  return pts;
}

/**
 * Shoelace signed area of a flat polygon. In y-down space a positive result is a
 * path that runs clockwise on screen (interior on the RIGHT of travel).
 * @param {number[]} flat
 */
export function signedArea(flat) {
  let a = 0;
  const n = flat.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    a += flat[2 * i] * flat[2 * j + 1] - flat[2 * j] * flat[2 * i + 1];
  }
  return a / 2;
}

/**
 * @param {number[]} flat
 * @returns {{ xmin: number, ymin: number, xmax: number, ymax: number } | null}
 */
export function boundsOf(flat) {
  if (flat.length < 2) return null;
  let xmin = Infinity;
  let ymin = Infinity;
  let xmax = -Infinity;
  let ymax = -Infinity;
  for (let i = 0; i < flat.length; i += 2) {
    const x = flat[i];
    const y = flat[i + 1];
    if (x < xmin) xmin = x;
    if (x > xmax) xmax = x;
    if (y < ymin) ymin = y;
    if (y > ymax) ymax = y;
  }
  return { xmin, ymin, xmax, ymax };
}

/**
 * Union of bounds (null-safe).
 * @param {{ xmin: number, ymin: number, xmax: number, ymax: number } | null} a
 * @param {{ xmin: number, ymin: number, xmax: number, ymax: number } | null} b
 */
export function unionBounds(a, b) {
  if (!a) return b;
  if (!b) return a;
  return { xmin: Math.min(a.xmin, b.xmin), ymin: Math.min(a.ymin, b.ymin), xmax: Math.max(a.xmax, b.xmax), ymax: Math.max(a.ymax, b.ymax) };
}

/**
 * Bounds of a set of sub-paths, including quadratic control points (a safe superset,
 * which is what SWF ShapeBounds needs).
 * @param {SubPath[]} subs
 */
export function subpathBounds(subs) {
  /** @type {{ xmin: number, ymin: number, xmax: number, ymax: number } | null} */
  let b = null;
  for (const s of subs) {
    const pts = [s.start[0], s.start[1]];
    for (const e of s.edges) {
      pts.push(e.x, e.y);
      if (e.t === "Q") pts.push(e.cx, e.cy);
    }
    b = unionBounds(b, boundsOf(pts));
  }
  return b;
}
